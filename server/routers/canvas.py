from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import Response
#from routers.agent import chat
from fastapi.concurrency import run_in_threadpool
from services.chat_service import handle_chat
from services.db_service import db_service
import asyncio
import json
import base64
import io
import numpy as np
import cv2
from PIL import Image
from services.config_service import FILES_DIR
import os

router = APIRouter(prefix="/api/canvas")


def _inpaint_sync(image_b64: str, mask_b64: str) -> str:
    """Decode mask + run OpenCV inpaint + re-encode. CPU bound: runs in a thread."""

    def decode_b64(data_url: str) -> np.ndarray:
        if ',' in data_url:
            data_url = data_url.split(',', 1)[1]
        img_bytes = base64.b64decode(data_url)
        img = Image.open(io.BytesIO(img_bytes))
        if img.mode == 'RGBA':
            img = img.convert('RGB')
        elif img.mode == 'L':
            img = img.convert('RGB')
        return np.array(img)

    def decode_mask(data_url: str) -> np.ndarray:
        if ',' in data_url:
            data_url = data_url.split(',', 1)[1]
        img_bytes = base64.b64decode(data_url)
        img = Image.open(io.BytesIO(img_bytes))
        if img.mode == 'RGBA':
            img = img.convert('L')
        elif img.mode == 'RGB':
            img = img.convert('L')
        return np.array(img)

    image_np = decode_b64(image_b64)
    mask_np = decode_mask(mask_b64)

    if image_np.shape[:2] != mask_np.shape[:2]:
        mask_img = Image.fromarray(mask_np)
        mask_img = mask_img.resize((image_np.shape[1], image_np.shape[0]), Image.LANCZOS)
        mask_np = np.array(mask_img)

    _, mask_binary = cv2.threshold(mask_np, 127, 255, cv2.THRESH_BINARY)

    mask_area = np.sum(mask_binary > 0)
    total_area = mask_binary.shape[0] * mask_binary.shape[1]
    coverage = mask_area / total_area

    if coverage < 0.02:
        kernel_size, dilate_iters, inpaint_radius = 3, 1, 5
    elif coverage < 0.05:
        kernel_size, dilate_iters, inpaint_radius = 5, 1, 8
    else:
        kernel_size, dilate_iters, inpaint_radius = 7, 2, 12

    print(f"Inpaint adaptive params: coverage={coverage:.4f}, kernel={kernel_size}, iters={dilate_iters}, radius={inpaint_radius}")

    kernel = np.ones((kernel_size, kernel_size), np.uint8)
    mask_dilated = cv2.dilate(mask_binary, kernel, iterations=dilate_iters)
    result_np = cv2.inpaint(image_np, mask_dilated, inpaintRadius=inpaint_radius, flags=cv2.INPAINT_NS)

    result_img = Image.fromarray(result_np).convert('RGB')
    buf = io.BytesIO()
    result_img.save(buf, format='PNG')
    return f"data:image/png;base64,{base64.b64encode(buf.getvalue()).decode('utf-8')}"

@router.get("/list")
async def list_canvases():
    return await db_service.list_canvases()

@router.post("/create")
async def create_canvas(request: Request):
    data = await request.json()
    id = data.get('canvas_id')
    name = data.get('name')

    asyncio.create_task(handle_chat(data))
    await db_service.create_canvas(id, name)
    return {"id": id }

@router.get("/{id}")
async def get_canvas(id: str):
    body = await db_service.get_canvas_response_json(id)
    return Response(content=body if body is not None else b"null", media_type="application/json")

@router.post("/{id}/save")
async def save_canvas(id: str, request: Request):
    body = await request.body()
    # Canvas payloads embed every generated image as base64 and can reach hundreds of MB;
    # both the parse and the re-serialize would otherwise stall the event loop.
    payload = await run_in_threadpool(json.loads, body)
    data_str = await run_in_threadpool(json.dumps, payload['data'])
    await db_service.save_canvas_data(id, data_str, payload.get('thumbnail'))
    return {"id": id }

@router.post("/{id}/rename")
async def rename_canvas(id: str, request: Request):
    data = await request.json()
    name = data.get('name')
    await db_service.rename_canvas(id, name)
    return {"id": id }

@router.delete("/{id}/delete")
async def delete_canvas(id: str):
    await db_service.delete_canvas(id)
    return {"id": id }


@router.post("/{id}/inpaint")
async def inpaint_region(id: str, request: Request):
    """
    Inpaint a region of an image using OpenCV.

    Request body:
        image_b64: base64 data URL of the original image
        mask_b64: base64 data URL of the mask (black background, white strokes = area to inpaint)

    Returns:
        JSON with inpainted base64 data URL
    """
    try:
        data = await request.json()
        image_b64 = data.get('image_b64', '')
        mask_b64 = data.get('mask_b64', '')

        if not image_b64 or not mask_b64:
            raise HTTPException(status_code=400, detail="Both image_b64 and mask_b64 are required")

        inpainted_b64 = await run_in_threadpool(_inpaint_sync, image_b64, mask_b64)

        return {"inpainted_b64": inpainted_b64}

    except HTTPException:
        raise
    except Exception as e:
        print(f"Inpaint error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Inpaint failed: {str(e)}")
