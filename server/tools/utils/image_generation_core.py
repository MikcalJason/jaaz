"""
Image generation core module
Contains the main orchestration logic for image generation across different providers
"""

import os
import re
from datetime import datetime
from typing import Optional, Dict, Any
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


def _sanitize_filename(name: str) -> str:
    """Sanitize a string for use in filenames: replace non-alphanumeric chars with underscore"""
    safe = re.sub(r'[^\w一-鿿]', '_', name)
    # collapse multiple underscores
    safe = re.sub(r'_+', '_', safe).strip('_')
    return safe if safe else 'untitled'


async def _rename_to_structured(session_id: str, old_filename: str) -> str:
    """Rename the generated image file to structured naming convention"""
    ext = os.path.splitext(old_filename)[1] or '.png'
    date_str = datetime.now().strftime('%Y%m%d')

    # Get session title
    try:
        title = await db_service.get_session_title(session_id)
    except Exception:
        title = 'untitled'
    safe_title = _sanitize_filename(title)

    # Determine sequence number by scanning existing files
    prefix = f'{date_str}_{safe_title}_'
    seq = 1
    if os.path.isdir(FILES_DIR):
        existing = [f for f in os.listdir(FILES_DIR) if f.startswith(prefix)]
        if existing:
            nums = []
            for f in existing:
                match = re.match(r'.*_(\d{4})\.', f)
                if match:
                    nums.append(int(match.group(1)))
            if nums:
                seq = max(nums) + 1

    new_filename = f'{prefix}{seq:04d}{ext}'

    # Rename file on disk
    old_path = os.path.join(FILES_DIR, old_filename)
    new_path = os.path.join(FILES_DIR, new_filename)
    if not os.path.exists(old_path):
        print(f'⚠️ Source file not found for rename: {old_path}, keeping original name')
        return old_filename

    try:
        os.rename(old_path, new_path)
        print(f'📝 Renamed: {old_filename} → {new_filename}')
    except OSError as e:
        print(f'⚠️ Rename failed: {e}, keeping original name')
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

    # Generate image using the selected provider
    mime_type, width, height, filename = await provider_instance.generate(
        prompt=prompt,
        model=model,
        aspect_ratio=aspect_ratio,
        input_images=processed_input_images,
        metadata=metadata,
        **kwargs,
    )

    # Rename to structured filename: yyyyMMdd_title_seq.ext
    filename = await _rename_to_structured(session_id, filename)

    # Save image to canvas
    image_url = await save_image_to_canvas(
        session_id, canvas_id, filename, mime_type, width, height
    )

    return f"image generated successfully ![image_id: {filename}](http://localhost:{DEFAULT_PORT}{image_url})"
