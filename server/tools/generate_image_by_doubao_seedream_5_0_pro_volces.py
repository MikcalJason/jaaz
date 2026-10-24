from typing import Annotated
from pydantic import BaseModel, Field
from langchain_core.tools import tool, InjectedToolCallId  # type: ignore
from langchain_core.runnables import RunnableConfig
from tools.utils.image_generation_core import generate_image_with_provider


class GenerateImageByDoubaoSeedream5ProInputSchema(BaseModel):
    prompt: str = Field(
        description="Required. The prompt for image generation. Describe the desired image in detail. If the user wants to edit an image, describe what edits should be made."
    )
    aspect_ratio: str = Field(
        description="Required. Aspect ratio of the image, only these values are allowed: 1:1, 16:9, 4:3, 3:4, 9:16. Choose the best fitting aspect ratio according to the user's request. Best ratio for posters is 3:4, for landscape is 16:9, for portraits is 3:4."
    )
    size: str = Field(
        description="Required. The output image resolution/size. Supports two formats: (1) Named sizes: 1K, 2K, 4K — use 2K as default, 4K for high-quality, 1K for quick previews. (2) Pixel dimensions: width x height, e.g. 1024x1024, 1920x1080, 1280x720. Choose based on the user's request."
    )
    tool_call_id: Annotated[str, InjectedToolCallId]


@tool("generate_image_by_doubao_seedream_5_0_pro_volces",
      description="Generate an image by Doubao Seedream 5.0 Pro model using text prompt. This is the latest and most advanced Doubao image generation model. Supports high-resolution outputs up to 4K. Supports multiple aspect ratios. This model does NOT support input images for reference or editing — text-to-image only.",
      args_schema=GenerateImageByDoubaoSeedream5ProInputSchema)
async def generate_image_by_doubao_seedream_5_0_pro_volces(
    prompt: str,
    aspect_ratio: str,
    size: str,
    config: RunnableConfig,
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> str:
    """
    Generate an image using Doubao Seedream 5.0 Pro model via Volces provider
    """
    ctx = config.get('configurable', {})
    canvas_id = ctx.get('canvas_id', '')
    session_id = ctx.get('session_id', '')

    return await generate_image_with_provider(
        canvas_id=canvas_id,
        session_id=session_id,
        provider='volces',
        model="volces/doubao-seedream-5-0-pro-260628",
        prompt=prompt,
        aspect_ratio=aspect_ratio,
        input_images=None,
        size=size,
        watermark=True,
    )


# Export the tool for easy import
__all__ = ["generate_image_by_doubao_seedream_5_0_pro_volces"]
