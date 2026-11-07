"""
Image generation core module
Contains the main orchestration logic for image generation across different providers
"""

import asyncio
import os
import re
import time
from datetime import datetime
from typing import Optional, Dict, Any, Tuple, Set
from common import DEFAULT_PORT
from tools.utils.image_utils import process_input_image
from ..image_providers.image_base_provider import ImageProviderBase

# 导入所有提供商以确保自动注册 (不要删除这些导入)
from ..image_providers.jaaz_provider import JaazImageProvider
from ..image_providers.openai_provider import OpenAIImageProvider
from ..image_providers.replicate_provider import ReplicateImageProvider
from ..image_providers.volces_provider import VolcesProvider
from ..image_providers.wavespeed_provider import WavespeedProvider

# from ..image_providers.comfyui_provider import ComfyUIProvider
from .image_canvas_utils import (
    save_image_to_canvas,
    send_image_error_notification,
)
from services.config_service import FILES_DIR
from services.db_service import db_service

IMAGE_PROVIDERS: dict[str, ImageProviderBase] = {
    "jaaz": JaazImageProvider(),
    "openai": OpenAIImageProvider(),
    "replicate": ReplicateImageProvider(),
    "volces": VolcesProvider(),
    "wavespeed": WavespeedProvider(),
}


def _read_image_concurrency() -> int:
    try:
        return max(1, int(os.getenv("IMAGE_GEN_CONCURRENCY", "3")))
    except ValueError:
        return 3


# 批量生图时 LangGraph 会并发执行同一条 AI 消息里的多个 tool_calls。
# 这里统一限制同时在途的生图请求数，避免被上游并发限流导致“已计费但拿不到图”。
_IMAGE_GEN_CONCURRENCY = _read_image_concurrency()
_image_gen_semaphore: Optional[asyncio.Semaphore] = None


def _get_image_gen_semaphore() -> asyncio.Semaphore:
    global _image_gen_semaphore
    if _image_gen_semaphore is None:
        _image_gen_semaphore = asyncio.Semaphore(_IMAGE_GEN_CONCURRENCY)
        print(f'🖼️ Image generation concurrency limit: {_IMAGE_GEN_CONCURRENCY}')
    return _image_gen_semaphore


# 每个会话本轮的生成配额，用于挡住模型超出用户要求的额外调用
_request_quota: Dict[str, Dict[str, Any]] = {}

# 取消后继续在后台跑的任务：必须保留强引用，
# 否则调用方退出后事件循环里没有引用，任务可能被 GC 提前取消
_background_tasks: Set[asyncio.Task[Any]] = set()


def set_request_quantity(session_id: str, requested: int) -> object:
    """记录本轮用户期望的生成数量（0 表示不限制）

    返回本次记录的 token，清理时带上是哪个请求的配额，
    避免"旧请求收尾"把后来新请求刚写入的配额一起清掉。
    """
    token = object()
    _request_quota[session_id] = {
        'requested': requested,
        'called': 0,
        'token': token,
    }
    return token


def clear_request_quantity(session_id: str, token: Optional[object] = None) -> None:
    """清理配额；带 token 时只清理仍属于该 token 的记录"""
    quota = _request_quota.get(session_id)
    if quota is None:
        return
    if token is None or quota.get('token') is token:
        _request_quota.pop(session_id, None)


def _consume_quota(session_id: str) -> Optional[str]:
    """消耗一次生成配额，超出时返回提示信息"""
    quota = _request_quota.get(session_id)
    if not quota:
        return None

    requested = quota['requested']
    quota['called'] += 1
    if requested > 0 and quota['called'] > requested:
        quota['called'] = requested
        return (
            f'error: this request only asked for {requested} image(s), and that quota '
            'has already been used. Do not call any more image tools; summarise the '
            'results you already have instead.'
        )
    return None


def _refund_quota(session_id: str) -> None:
    """请求根本没生成出图时退回一次配额，允许模型重试

    只在"上游确定没有产出"时退回；已经出图但保存失败的不退，避免重复扣费。
    """
    quota = _request_quota.get(session_id)
    if quota and quota['called'] > 0:
        quota['called'] -= 1


def _log_background_error(t: asyncio.Task[Any]) -> None:
    """后台任务的兜底回调：取走异常，避免 'Task exception was never retrieved'"""
    if t.cancelled():
        return
    exc = t.exception()
    if exc:
        print(f'⚠️ Background task failed: {exc}')


def _spawn_background(coro: Any) -> None:
    """登记后台协程任务，保证有强引用且异常不丢"""
    t = asyncio.create_task(coro)
    _background_tasks.add(t)
    t.add_done_callback(_background_tasks.discard)
    t.add_done_callback(_log_background_error)


async def wait_for_background_generation(timeout: float = 10.0) -> None:
    """服务关闭前给后台生图任务留一段收尾时间

    这些任务对应的请求已经发出去、费用已经产生，
    进程直接退出就等于"扣了钱却看不到图"。
    """
    pending = [t for t in _background_tasks if not t.done()]
    if not pending:
        return
    print(
        f'⏳ Waiting up to {timeout:.0f}s for {len(pending)} background image task(s)')
    _, still_pending = await asyncio.wait(pending, timeout=timeout)
    for task in still_pending:
        task.cancel()
    if still_pending:
        # 等取消真正落地，避免退出时还留着 pending task
        await asyncio.gather(*still_pending, return_exceptions=True)
        print(
            f'⚠️ {len(still_pending)} background image task(s) cancelled at shutdown')


def _sanitize_filename(name: str) -> str:
    """Sanitize a string for use in filenames: replace non-alphanumeric chars with underscore"""
    # 会话标题取自用户消息，可能带 <quantity>4</quantity>、<aspect_ratio>16:9</aspect_ratio> 等标记，
    # 这些是给模型的指令，不该进文件名（整段连内容一起去掉）
    name = re.sub(r'<[^>]+>[^<]*</[^>]+>', ' ', name)
    name = re.sub(r'<[^>]+>', ' ', name)
    safe = re.sub(r'[^\w一-鿿]', '_', name)
    # collapse multiple underscores
    safe = re.sub(r'_+', '_', safe).strip('_')
    # 限制长度，避免超长文件名（中文按字符算，40 字已足够区分）
    safe = safe[:40].strip('_')
    return safe if safe else 'untitled'


def _reserve_target_path(prefix: str, start_seq: int, ext: str) -> Optional[Tuple[str, str, int]]:
    """原子地占用一个带序号的目标文件名，避免并发生图时相互覆盖

    使用 O_CREAT|O_EXCL 创建占位文件：多个协程同时抢同一个序号时，
    只有第一个能成功，其余会顺延到下一个序号。
    """
    seq = start_seq
    for _ in range(10000):
        new_filename = f'{prefix}{seq:04d}{ext}'
        new_path = os.path.join(FILES_DIR, new_filename)
        try:
            fd = os.open(new_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            seq += 1
            continue
        except OSError as e:
            print(f'⚠️ Failed to reserve filename {new_filename}: {e}')
            return None
        os.close(fd)
        return new_filename, new_path, seq
    return None


# 会话标题缓存：每张图都要查库，但标题变化很少
_title_cache: Dict[str, Tuple[str, float]] = {}
_TITLE_CACHE_TTL = 60.0
_TITLE_CACHE_MAX = 256

# 每个命名前缀的下一个序号：首次扫描目录后缓存在进程内，避免每张图都 listdir
_next_seq_cache: Dict[str, int] = {}
_SEQ_CACHE_MAX = 512


async def _get_session_title_cached(session_id: str) -> str:
    """带 TTL 的会话标题缓存"""
    now = time.monotonic()
    cached = _title_cache.get(session_id)
    if cached is not None and now - cached[1] < _TITLE_CACHE_TTL:
        return cached[0]

    try:
        title = await db_service.get_session_title(session_id)
    except Exception:
        title = 'untitled'

    if len(_title_cache) >= _TITLE_CACHE_MAX:
        for key in list(_title_cache.keys())[: _TITLE_CACHE_MAX // 2]:
            _title_cache.pop(key, None)
    _title_cache[session_id] = (title, now)
    return title


def _next_sequence(prefix: str) -> int:
    """取下一个可用序号，首次扫描目录后缓存"""
    cached = _next_seq_cache.get(prefix)
    if cached is not None:
        return cached

    seq = 1
    if os.path.isdir(FILES_DIR):
        nums = []
        with os.scandir(FILES_DIR) as entries:
            for entry in entries:
                name = entry.name
                if not name.startswith(prefix):
                    continue
                match = re.match(r'.*_(\d{4,})\.', name)
                if match:
                    nums.append(int(match.group(1)))
        if nums:
            seq = max(nums) + 1

    if len(_next_seq_cache) >= _SEQ_CACHE_MAX:
        _next_seq_cache.clear()
    _next_seq_cache[prefix] = seq
    return seq


async def _rename_to_structured(session_id: str, old_filename: str) -> str:
    """Rename the generated image file to structured naming convention"""
    ext = os.path.splitext(old_filename)[1] or '.png'
    date_str = datetime.now().strftime('%Y%m%d')

    title = await _get_session_title_cached(session_id)
    safe_title = _sanitize_filename(title)

    prefix = f'{date_str}_{safe_title}_'
    seq = _next_sequence(prefix)

    old_path = os.path.join(FILES_DIR, old_filename)
    if not os.path.exists(old_path):
        print(f'⚠️ Source file not found for rename: {old_path}, keeping original name')
        return old_filename

    # 先原子占位再替换，避免并发请求算出同一个序号后互相覆盖
    reserved = _reserve_target_path(prefix, seq, ext)
    if not reserved:
        return old_filename
    new_filename, new_path, reserved_seq = reserved
    # 并发下用 max 更新，避免缓存被较小的序号覆盖而倒退
    _next_seq_cache[prefix] = max(_next_seq_cache.get(prefix, 1), reserved_seq + 1)

    try:
        os.replace(old_path, new_path)
        print(f'📝 Renamed: {old_filename} → {new_filename}')
    except OSError as e:
        print(f'⚠️ Rename failed: {e}, keeping original name')
        try:
            os.remove(new_path)
        except OSError:
            pass
        return old_filename

    return new_filename


async def generate_image_with_provider(
    canvas_id: str,
    session_id: str,
    provider: str,
    model: str,
    # image generator args
    prompt: str,
    aspect_ratio: str = "1:1",
    input_images: Optional[list[str]] = None,
    **kwargs,
) -> str:
    """
    通用图像生成函数，支持不同的模型和提供商

    Args:
        prompt: 图像生成提示词
        aspect_ratio: 图像长宽比
        model_name: 内部模型名称 (如 'gpt-image-1', 'imagen-4')
        model: 模型标识符 (如 'openai/gpt-image-1', 'google/imagen-4')
        tool_call_id: 工具调用ID
        config: 上下文运行配置，包含canvas_id，session_id，model_info，由langgraph注入
        input_images: 可选的输入参考图像列表

    Returns:
        str: 生成结果消息
    """

    provider_instance = IMAGE_PROVIDERS.get(provider)
    if not provider_instance:
        raise ValueError(f"Unknown provider: {provider}")

    # Process input images for the provider
    processed_input_images: list[str] | None = None
    if input_images:
        processed_input_images = []
        for image_path in input_images:
            processed_image = await process_input_image(image_path)
            if processed_image:
                processed_input_images.append(processed_image)

        print(f"Using {len(processed_input_images)} input images for generation")

    # Prepare metadata with all generation parameters
    metadata: Dict[str, Any] = {
        "prompt": prompt,
        "model": model,
        "provider": provider,
        "aspect_ratio": aspect_ratio,
        "input_images": input_images or [],
    }

    # 超出用户要求数量的调用直接拦截，避免多扣一张
    # （放在参数校验/图片预处理之后：这些步骤失败不该消耗用户的配额）
    quota_error = _consume_quota(session_id)
    if quota_error:
        print(f'🚫 Image quota exceeded for session {session_id}')
        return quota_error

    # 记录上游是否"完全没出图"：只有这种情况才退回配额，允许模型重试
    generation_failed = {'provider': False}
    # 请求是否已经真正发给上游：还在排队时取消是安全的，不该继续烧钱
    request_sent = {'value': False}

    async def _generate_and_save() -> Tuple[str, str]:
        """生成 + 重命名 + 落画布，整体可被 shield 保护"""
        # 并发上限防止批量生图时把上游打爆（限流失败会白扣一次生成费用）
        async with _get_image_gen_semaphore():
            # 拿到并发名额后到真正发起请求之间没有 await，
            # 所以这个标记为 True 时一定已经进入计费请求
            request_sent['value'] = True
            try:
                mime, w, h, fname = await provider_instance.generate(
                    prompt=prompt,
                    model=model,
                    aspect_ratio=aspect_ratio,
                    input_images=processed_input_images,
                    metadata=metadata,
                    **kwargs,
                )
            except asyncio.CancelledError:
                raise
            except Exception:
                generation_failed['provider'] = True
                raise

        # Rename to structured filename: yyyyMMdd_title_seq.ext
        fname = await _rename_to_structured(session_id, fname)

        # Save image to canvas
        url = await save_image_to_canvas(
            session_id, canvas_id, fname, mime, w, h
        )
        return fname, url

    task = asyncio.create_task(_generate_and_save())

    def _log_background_result(t: asyncio.Task[Any]) -> None:
        try:
            name, _ = t.result()
            print(f'✅ Generation finished in background and saved: {name}')
        except asyncio.CancelledError:
            print('⚠️ Background generation was cancelled')
        except Exception as e:
            print(f'⚠️ Background generation failed: {e}')
            # 前台已经停了，失败必须让用户看到，否则就是"扣了钱什么都没有"
            _spawn_background(send_image_error_notification(session_id, str(e)))

    try:
        filename, image_url = await asyncio.shield(task)
    except asyncio.CancelledError:
        if not request_sent['value']:
            # 还在并发队列里排队，请求没发出去，取消不会产生费用
            print(
                f'🛑 Cancelled before request was sent for session {session_id}; task dropped')
            _background_tasks.add(task)
            task.add_done_callback(_background_tasks.discard)
            task.cancel()
            raise

        # 用户点了停止，但请求已经发出、费用已经产生，
        # 让它继续跑完并落盘，避免"扣了钱却看不到图"
        print(
            f'🛑 Cancelled while generating for session {session_id}; finishing in background')
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
        task.add_done_callback(_log_background_result)
        raise
    except Exception:
        # 上游直接失败（没有产出图），把刚才占用的配额退回去
        if generation_failed['provider']:
            _refund_quota(session_id)
        raise

    return f"image generated successfully ![image_id: {filename}](http://localhost:{DEFAULT_PORT}{image_url})"
