import asyncio
import os
import traceback
from PIL import Image, PngImagePlugin
from io import BytesIO
import base64
import json
from typing import Any, Optional, Tuple
from nanoid import generate
from utils.http_client import HttpClient
from services.config_service import FILES_DIR


def generate_image_id() -> str:
    """Generate unique image ID"""
    return generate(size=10)


def _decode_and_save_png(
    image_data: bytes,
    file_path_without_extension: str,
    metadata: Optional[dict[str, Any]],
) -> Tuple[str, int, int, str]:
    """Decode image bytes, normalize to PNG and write to disk. CPU/IO heavy — run off the event loop."""
    image = Image.open(BytesIO(image_data))
    width, height = image.size
    original_format = image.format or 'Unknown'

    file_path = f"{file_path_without_extension}.png"

    # Providers already return PNG; re-encoding only costs seconds of CPU for an identical image.
    if original_format == 'PNG' and not metadata:
        image.close()
        with open(file_path, 'wb') as f:
            f.write(image_data)
        print(f"Saved PNG as-is: {file_path} ({width}x{height})")
        return 'image/png', width, height, 'png'

    print(f"Converting {original_format} image to PNG: {width}x{height}")

    # Handle different color modes properly for PNG conversion
    if image.mode == 'P':
        # Palette mode - convert to RGBA to preserve potential transparency
        if 'transparency' in image.info:
            image = image.convert('RGBA')
        else:
            image = image.convert('RGB')
    elif image.mode == 'LA':
        # Grayscale with alpha - convert to RGBA
        image = image.convert('RGBA')
    elif image.mode == 'L':
        # Grayscale - PNG supports it natively, keep as-is
        pass
    elif image.mode == 'CMYK':
        image = image.convert('RGB')
    elif image.mode in ('RGB', 'RGBA'):
        pass
    else:
        print(f"Warning: Unusual color mode {image.mode}, converting to RGB")
        image = image.convert('RGB')

    pnginfo = PngImagePlugin.PngInfo()
    pnginfo.add_text("original_format", original_format)

    if metadata:
        for key, value in metadata.items():
            try:
                if isinstance(value, (dict, list)):
                    text_value = json.dumps(value, ensure_ascii=False)
                elif value is None:
                    text_value = "null"
                else:
                    text_value = str(value)

                pnginfo.add_text(str(key), text_value)
            except Exception as e:
                print(f"Warning: Failed to add metadata key '{key}': {e}")
                traceback.print_stack()

    image.save(file_path, format='PNG', optimize=True, pnginfo=pnginfo)
    image.close()

    print(f"Successfully saved as PNG: {file_path}")
    return 'image/png', width, height, 'png'


async def get_image_info_and_save(
    url: str,
    file_path_without_extension: str,
    is_b64: bool = False,
    metadata: Optional[dict[str, Any]] = None
) -> Tuple[str, int, int, str]:
    """
    Download image from URL or decode base64, convert to PNG and save with metadata

    Args:
        url: Image URL or base64 string
        file_path_without_extension: File path without extension
        is_b64: Whether the url is a base64 string
        metadata: Optional metadata to be saved in PNG info

    Returns:
        tuple[str, int, int, str]: (mime_type, width, height, extension) - always PNG
    """
    try:
        if is_b64:
            image_data = await asyncio.to_thread(base64.b64decode, url)
        else:
            # Fetch the image asynchronously
            async with HttpClient.create_aiohttp() as session:
                async with session.get(url) as response:
                    # Read the image content as bytes
                    image_data = await response.read()

        return await asyncio.to_thread(
            _decode_and_save_png, image_data, file_path_without_extension, metadata
        )

    except Exception as e:
        print(f"Error processing image: {e}")
        raise e


# Canvas-related utilities have been moved to tools/image_generation/image_canvas_utils.py


# Canvas element generation moved to tools/image_generation/image_canvas_utils.py


# Canvas saving functionality moved to tools/image_generation/image_canvas_utils.py


# Image generation orchestration moved to tools/image_generation/image_generation_core.py
# Notification functions moved to tools/image_generation/image_canvas_utils.py


def _encode_input_image(full_path: str, input_image: str) -> str:
    """Read an image from disk and return it as a data URL. Blocking — run off the event loop."""
    ext = os.path.splitext(input_image)[1].lower()
    mime_type_map = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp'
    }
    mime_type = mime_type_map.get(ext, 'image/jpeg')

    with open(full_path, 'rb') as f:
        image_data = f.read()

    b64_data = base64.b64encode(image_data).decode('utf-8')
    return f"data:{mime_type};base64,{b64_data}"


async def process_input_image(input_image: str | None) -> str | None:
    """
    Process input image and convert to base64 format

    Args:
        input_image: Image file path

    Returns:
        Base64 encoded image with data URL, or None if no image
    """
    if not input_image:
        return None

    try:
        full_path = os.path.join(FILES_DIR, input_image)
        if not os.path.exists(full_path):
            print(f"Warning: Image file not found: {full_path}")
            return None

        return await asyncio.to_thread(_encode_input_image, full_path, input_image)

    except Exception as e:
        print(f"Error processing image {input_image}: {e}")
        return None
