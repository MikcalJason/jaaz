"""
Video generation core module
Contains the main orchestration logic for video generation across different providers
"""

import asyncio
import traceback
from typing import List, cast, Optional, Any, Set
from models.config_model import ModelInfo
from ..video_providers.video_base_provider import get_default_provider, VideoProviderBase
# Import all providers to ensure automatic registration (don't delete these imports)
from ..video_providers.volces_provider import VolcesVideoProvider  # type: ignore
from .video_canvas_utils import (
    send_video_start_notification,
    send_video_error_notification,
    process_video_result,
)

# 取消后继续在后台跑的任务：必须保留强引用，
# 否则调用方退出后事件循环里没有引用，任务可能被 GC 提前取消
_background_tasks: Set[asyncio.Task[Any]] = set()


def _log_background_error(t: asyncio.Task[Any]) -> None:
    """后台任务兜底回调：取走异常，避免 'Task exception was never retrieved'"""
    if t.cancelled():
        return
    exc = t.exception()
    if exc:
        print(f'⚠️ Background video task failed: {exc}')


async def wait_for_background_video_generation(timeout: float = 10.0) -> None:
    """服务关闭前给后台生视频任务留一段收尾时间"""
    pending = [t for t in _background_tasks if not t.done()]
    if not pending:
        return
    print(
        f'⏳ Waiting up to {timeout:.0f}s for {len(pending)} background video task(s)')
    _, still_pending = await asyncio.wait(pending, timeout=timeout)
    for task in still_pending:
        task.cancel()
    if still_pending:
        # 等取消真正落地，避免退出时还留着 pending task
        await asyncio.gather(*still_pending, return_exceptions=True)
        print(
            f'⚠️ {len(still_pending)} background video task(s) cancelled at shutdown')


async def generate_video_with_provider(
    prompt: str,
    resolution: str,
    duration: int,
    aspect_ratio: str,
    model: str,
    tool_call_id: str,
    config: Any,
    input_images: Optional[list[str]] = None,
    camera_fixed: bool = True,
    **kwargs: Any
) -> str:
    """
    Universal video generation function supporting different models and providers

    Args:
        prompt: Video generation prompt
        resolution: Video resolution (480p, 1080p)
        duration: Video duration in seconds (5, 10)
        aspect_ratio: Video aspect ratio (1:1, 16:9, 4:3, 21:9)
        model: Model identifier (e.g., 'doubao-seedance-1-0-pro')
        tool_call_id: Tool call ID
        config: Context runtime configuration containing canvas_id, session_id, model_info, injected by langgraph
        input_images: Optional input reference images list
        camera_fixed: Whether to keep camera fixed

    Returns:
        str: Generation result message
    """
    model_name = model.split(
        # Some model names contain "/", like "openai/gpt-image-1", need to handle
        '/')[-1]
    print(f'🛠️ Video Generation {model_name} tool_call_id', tool_call_id)
    ctx = config.get('configurable', {})
    canvas_id = ctx.get('canvas_id', '')
    session_id = ctx.get('session_id', '')
    print(f'🛠️ canvas_id {canvas_id} session_id {session_id}')

    # Inject the tool call id into the context
    ctx['tool_call_id'] = tool_call_id

    try:
        # Determine provider selection
        model_info_list: List[ModelInfo] = cast(
            List[ModelInfo], ctx.get('model_info', {}).get(model_name, []))

        if model_info_list == []:
            # video registed as tool
            model_info_list: List[ModelInfo] = cast(
                List[ModelInfo], ctx.get('tool_list', {}))

        # Use get_default_provider which already handles Jaaz prioritization
        provider_name = get_default_provider(model_info_list)

        print(f"🎥 Using provider: {provider_name} for {model_name}")

        # Create provider instance
        provider_instance = VideoProviderBase.create_provider(provider_name)

        # Send start notification
        await send_video_start_notification(
            session_id,
            f"Starting video generation using {model_name} via {provider_name}..."
        )

        # Process input images for the provider
        processed_input_images = None
        if input_images:
            # For some providers, we might need to process input images differently
            # For now, just pass them as is
            processed_input_images = input_images

        # 请求是否已经真正发给上游：还没发出时取消是安全的，不该继续烧钱
        request_sent = {'value': False}

        async def _generate_and_save() -> str:
            """生成 + 落画布 + 通知，整体可被 shield 保护"""
            # 设置后紧跟第一个 await，所以为 True 时一定已经进入计费请求
            request_sent['value'] = True
            video_url = await provider_instance.generate(
                prompt=prompt,
                model=model,
                resolution=resolution,
                duration=duration,
                aspect_ratio=aspect_ratio,
                input_images=processed_input_images,
                camera_fixed=camera_fixed,
                **kwargs
            )

            # Process video result (save, update canvas, notify)
            return await process_video_result(
                video_url=video_url,
                session_id=session_id,
                canvas_id=canvas_id,
                provider_name=f"{model_name} ({provider_name})"
            )

        task = asyncio.create_task(_generate_and_save())

        def _log_background_result(t: asyncio.Task[Any]) -> None:
            try:
                t.result()
                print(f'✅ Video generation finished in background: {session_id}')
            except asyncio.CancelledError:
                print('⚠️ Background video generation was cancelled')
            except Exception as e:
                print(f'⚠️ Background video generation failed: {e}')
                # 前台已经停了，失败必须让用户看到，否则就是"扣了钱什么都没有"
                notification = asyncio.create_task(
                    send_video_error_notification(session_id, str(e)))
                _background_tasks.add(notification)
                notification.add_done_callback(_background_tasks.discard)
                notification.add_done_callback(_log_background_error)

        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            if not request_sent['value']:
                # 任务还没真正发起请求，直接取消，不会产生费用
                print(
                    f'🛑 Cancelled before video request was sent for session {session_id}; task dropped')
                _background_tasks.add(task)
                task.add_done_callback(_background_tasks.discard)
                task.cancel()
                raise

            # 用户点了停止，但请求已经发出、费用已经产生，
            # 让它继续跑完并落盘，避免"扣了钱却看不到视频"
            print(
                f'🛑 Cancelled while generating video for session {session_id}; finishing in background')
            _background_tasks.add(task)
            task.add_done_callback(_background_tasks.discard)
            task.add_done_callback(_log_background_result)
            raise

    except Exception as e:
        error_message = str(e)
        print(f"🎥 Error generating video with {model_name}: {error_message}")
        traceback.print_exc()

        # Send error notification
        await send_video_error_notification(session_id, error_message)

        # Re-raise the exception for proper error handling
        raise Exception(
            f"{model_name} video generation failed: {error_message}")
