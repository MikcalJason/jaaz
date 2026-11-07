import os
import traceback
import platform
import subprocess
import mimetypes
import hashlib
import threading
import asyncio
import time
from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import FileResponse
from services.config_service import USER_DATA_DIR
from typing import List, Dict, Optional

router = APIRouter(prefix="/api")

WORKSPACE_ROOT = os.path.join(USER_DATA_DIR, "workspace")
THUMBNAIL_CACHE_DIR = os.path.join(USER_DATA_DIR, "cache", "thumbnails")

IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.webp', '.svg', '.ico'}
VIDEO_EXTENSIONS = {'.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.3gp'}
AUDIO_EXTENSIONS = {'.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a'}
DOCUMENT_EXTENSIONS = {'.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt', '.pages'}
ARCHIVE_EXTENSIONS = {'.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'}
CODE_EXTENSIONS = {'.py', '.js', '.html', '.css', '.java', '.cpp', '.c', '.php', '.rb', '.go', '.rs'}
MEDIA_TYPES = ("image", "video")

@router.post("/update_file")
async def update_file(request: Request):
    try:
        data = await request.json()
        path = data["path"]
        full_path = os.path.join(WORKSPACE_ROOT, path)
        content = data["content"]
        with open(full_path, "w") as f:
            f.write(content)
        return {"success": True}
    except Exception as e:
        return {"error": str(e), "path": path}

@router.post("/create_file")
async def create_file(request: Request):
    data = await request.json()
    rel_dir = data["rel_dir"]
    path = os.path.join(WORKSPACE_ROOT, rel_dir, 'Untitled.md')
    # Split the path into directory, filename, and extension
    dir_name, base_name = os.path.split(path)
    name, ext = os.path.splitext(base_name)

    candidate_path = path
    counter = 1
    while os.path.exists(candidate_path):
        # Generate new filename with incremented counter
        new_base = f"{name} {counter}{ext}"
        candidate_path = os.path.join(dir_name, new_base)
        counter += 1
    print('candidate_path', candidate_path)
    os.makedirs(os.path.dirname(candidate_path), exist_ok=True)
    with open(candidate_path, "w") as f:
        f.write("")
    return {"path": os.path.relpath(candidate_path, WORKSPACE_ROOT)}

@router.post("/delete_file")
async def delete_file(request: Request):
    data = await request.json()
    path = data["path"]
    os.remove(path)
    return {"success": True}

@router.post("/rename_file")
async def rename_file(request: Request):
    try:
        data = await request.json()
        old_path = data["old_path"]
        old_path = os.path.join(WORKSPACE_ROOT, old_path)
        new_title = data["new_title"]
        if os.path.exists(old_path):
            new_path = os.path.join(os.path.dirname(old_path), new_title)
            os.rename(old_path, new_path)
            return {"success": True, "path": new_path}
        else:
            return {"error": f"File {old_path} does not exist", "path": old_path}
    except Exception as e:
        traceback.print_exc()
        return {"error": str(e)}

@router.post("/read_file")
async def read_file(request: Request):
    try:
        data = await request.json()
        path = data["path"]
        full_path = os.path.join(WORKSPACE_ROOT, path)
        if os.path.exists(full_path):
            with open(full_path, "r") as f:
                content = f.read()
                return {"content": content}
        else:
            return {"error": f"File {path} does not exist", "path": path}
    except Exception as e:
        return {"error": str(e), "path": path}

@router.get("/list_files_in_dir")
def list_files_in_dir(rel_path: str):
    """同步 def：FastAPI 会放到线程池执行，避免阻塞事件循环。"""
    try:
        full_path = os.path.join(WORKSPACE_ROOT, rel_path)
        file_nodes = []
        with os.scandir(full_path) as entries:
            for entry in entries:
                try:
                    file_nodes.append({
                        "name": entry.name,
                        "is_dir": entry.is_dir(),
                        "rel_path": os.path.join(rel_path, entry.name),
                        "mtime": entry.stat().st_mtime,  # Get modification time
                    })
                except OSError:
                    continue
        # Sort by modification time in descending order
        file_nodes.sort(key=lambda x: x["mtime"], reverse=True)
        # Remove mtime from response as it was only used for sorting
        for node in file_nodes:
            node.pop("mtime")
        return file_nodes
    except Exception as e:
        return []

@router.post("/open_folder_in_explorer")
async def open_folder_in_explorer(request: Request):
    """
    在系统文件浏览器中打开指定文件夹
    
    Args:
        request: 包含文件夹路径的请求
    
    Returns:
        操作结果
    """
    try:
        data = await request.json()
        folder_path = data.get("path")
        
        if not folder_path:
            raise HTTPException(status_code=400, detail="Missing folder path")
        
        # 验证路径是否存在且为文件夹
        if not os.path.exists(folder_path):
            raise HTTPException(status_code=404, detail="Folder not found")
        
        if not os.path.isdir(folder_path):
            raise HTTPException(status_code=400, detail="Path is not a directory")
        
        # 根据不同操作系统打开文件管理器
        system = platform.system()

        if system == "Windows":
            # Windows
            cmd = ["explorer", folder_path]
        elif system == "Darwin":
            # macOS
            cmd = ["open", folder_path]
        elif system == "Linux":
            cmd = ["xdg-open", folder_path]
        else:
            raise HTTPException(status_code=500, detail=f"Unsupported operating system: {system}")

        # 子进程放到线程池执行，避免阻塞事件循环
        await asyncio.to_thread(subprocess.run, cmd, check=True)
        
        return {"success": True, "message": "Folder opened in system explorer"}
        
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"Failed to open folder: {str(e)}")
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Error opening folder: {str(e)}")

@router.get("/browse_filesystem")
def browse_filesystem(path: str = ""):
    """
    浏览电脑任意位置的文件系统

    使用同步 def：FastAPI 会把这类接口放到线程池执行，
    否则这里的 os.scandir/stat 会阻塞事件循环，
    连带把同进程的图片/视频服务（serve_file）一起卡住。

    Args:
        path: 要浏览的路径，如果为空则从用户家目录开始

    Returns:
        包含文件夹和文件信息的列表
    """
    try:
        # 如果path为空，从用户家目录开始
        if not path:
            path = os.path.expanduser("~")

        # 确保路径存在且可访问
        if not os.path.exists(path):
            raise HTTPException(status_code=404, detail="Path not found")

        if not os.path.isdir(path):
            raise HTTPException(status_code=400, detail="Path is not a directory")

        items = []

        try:
            # os.scandir 会缓存 stat 结果，比 listdir + stat + isdir 少 2 次系统调用
            with os.scandir(path) as entries:
                for entry in entries:
                    name = entry.name

                    # 跳过隐藏文件（可选）
                    if name.startswith('.'):
                        continue

                    try:
                        is_dir = entry.is_dir()
                        stat = entry.stat()

                        # 获取文件类型（已知 is_dir，避免重复 stat）
                        file_type = "folder" if is_dir else get_file_type(name, is_dir=False)
                        is_media = file_type in MEDIA_TYPES

                        items.append({
                            "name": name,
                            "path": entry.path,
                            "type": file_type,
                            "size": None if is_dir else stat.st_size,
                            "mtime": stat.st_mtime,
                            "is_directory": is_dir,
                            "is_media": is_media,
                            "has_thumbnail": is_media,
                        })

                    except (OSError, PermissionError):
                        # 跳过无法访问的文件
                        continue

        except PermissionError:
            raise HTTPException(status_code=403, detail="Permission denied")

        # 按类型和名称排序：文件夹在前，然后按名称排序
        items.sort(key=lambda x: (not x["is_directory"], x["name"].lower()))

        return {
            "current_path": path,
            "parent_path": os.path.dirname(path) if path != os.path.dirname(path) else None,
            "items": items
        }

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/get_media_files")
def get_media_files(path: str):
    """
    获取指定文件夹下的所有媒体文件（图片和视频）
    
    Args:
        path: 文件夹路径
    
    Returns:
        媒体文件列表
    """
    try:
        if not os.path.exists(path) or not os.path.isdir(path):
            raise HTTPException(status_code=400, detail="Invalid directory path")

        media_files = []

        try:
            with os.scandir(path) as entries:
                for entry in entries:
                    try:
                        if not entry.is_file():
                            continue

                        file_type = get_file_type(entry.name, is_dir=False)
                        if file_type not in MEDIA_TYPES:
                            continue

                        stat = entry.stat()

                        media_files.append({
                            "name": entry.name,
                            "path": entry.path,
                            "type": file_type,
                            "size": stat.st_size,
                            "mtime": stat.st_mtime,
                        })
                    except (OSError, PermissionError):
                        continue

        except PermissionError:
            raise HTTPException(status_code=403, detail="Permission denied")

        # 按修改时间排序
        media_files.sort(key=lambda x: x["mtime"], reverse=True)

        return media_files

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/get_images_recursive")
def get_images_recursive(path: str):
    """
    递归获取指定目录及其子目录下的所有图片文件

    Args:
        path: 根目录路径

    Returns:
        图片文件路径列表（字符串数组）
    """
    try:
        if not os.path.exists(path) or not os.path.isdir(path):
            raise HTTPException(status_code=400, detail="Invalid directory path")

        image_paths: List[str] = []

        def walk(directory: str):
            try:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        try:
                            if entry.is_dir():
                                walk(entry.path)
                            elif get_file_type(entry.name, is_dir=False) == "image":
                                image_paths.append(entry.path)
                        except OSError:
                            continue
            except (PermissionError, OSError):
                pass

        walk(path)
        return image_paths

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/get_file_thumbnail")
def get_file_thumbnail(file_path: str):
    """
    获取文件的缩略图信息
    
    Args:
        file_path: 文件路径
    
    Returns:
        缩略图信息或文件信息
    """
    try:
        if not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail="File not found")
        
        file_type = get_file_type(file_path)
        
        return {
            "path": file_path,
            "type": file_type,
            "exists": True,
            "can_preview": file_type in MEDIA_TYPES
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


_prune_lock = threading.Lock()
_last_prune_at = 0.0
_PRUNE_INTERVAL = 30 * 60  # 30 分钟最多清理一次
_PRUNE_MAX_FILES = 4000
_PRUNE_MAX_AGE = 30 * 24 * 3600  # 30 天未访问的缓存直接删除
# 限制同时进行的解码数量：PIL 解码大图是 CPU 密集操作，
# 不限制时打开大目录会瞬间抢满 CPU，反而拖慢文件响应。
_thumbnail_semaphore = threading.BoundedSemaphore(4)


def _read_image_size(file_path: str) -> Optional[Dict[str, int]]:
    """只读取图片头部获取宽高，不做像素解码（毫秒级）。"""
    try:
        from PIL import Image

        with Image.open(file_path) as img:
            return {"width": img.width, "height": img.height}
    except Exception:
        return None


def _thumbnail_cache_path(file_path: str, size: int, mtime: float) -> str:
    key = f"{os.path.abspath(file_path)}|{int(mtime)}|{size}"
    digest = hashlib.sha1(key.encode("utf-8", "ignore")).hexdigest()
    return os.path.join(THUMBNAIL_CACHE_DIR, f"{digest}.webp")


def _prune_thumbnail_cache():
    """按时间与数量清理缓存，最多每 30 分钟执行一次。"""
    global _last_prune_at
    now = time.time()
    if now - _last_prune_at < _PRUNE_INTERVAL:
        return

    with _prune_lock:
        now = time.time()
        if now - _last_prune_at < _PRUNE_INTERVAL:
            return
        _last_prune_at = now

        try:
            if not os.path.isdir(THUMBNAIL_CACHE_DIR):
                return
            entries = []
            with os.scandir(THUMBNAIL_CACHE_DIR) as it:
                for entry in it:
                    try:
                        if not entry.is_file():
                            continue
                        mtime = entry.stat().st_mtime
                        # 过期缓存直接删除
                        if now - mtime > _PRUNE_MAX_AGE:
                            try:
                                os.remove(entry.path)
                            except OSError:
                                pass
                            continue
                        entries.append((mtime, entry.path))
                    except OSError:
                        continue

            if len(entries) <= _PRUNE_MAX_FILES:
                return
            entries.sort()
            for _, cached_file in entries[: len(entries) - _PRUNE_MAX_FILES]:
                try:
                    os.remove(cached_file)
                except OSError:
                    pass
        except Exception:
            pass


def _build_image_thumbnail(file_path: str, size: int, mtime: float) -> str:
    """生成（或复用）图片缩略图，返回缓存文件路径。"""
    cache_path = _thumbnail_cache_path(file_path, size, mtime)
    if os.path.exists(cache_path):
        return cache_path

    from PIL import Image, ImageOps

    os.makedirs(THUMBNAIL_CACHE_DIR, exist_ok=True)
    # 不加全局锁：不同图片应并行生成；同一张图的并发生成
    # 由唯一临时文件名 + 原子 replace 保证安全。
    _prune_thumbnail_cache()

    tmp_path = f"{cache_path}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        with _thumbnail_semaphore:
            with Image.open(file_path) as img:
                img = ImageOps.exif_transpose(img)
                img.thumbnail((size, size), Image.LANCZOS)
                if img.mode not in ("RGB", "RGBA"):
                    img = img.convert("RGBA")
                img.save(tmp_path, "WEBP", quality=80, method=4)
        os.replace(tmp_path, cache_path)
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass

    return cache_path


@router.get("/serve_thumbnail")
def serve_thumbnail(file_path: str, size: int = 320):
    """
    提供图片缩略图（磁盘缓存），用于网格/列表预览。

    网格里直接加载原图会带来几十 MB 的解码与内存开销，
    缩略图可显著降低首屏渲染时间。
    """
    try:
        if not os.path.isfile(file_path):
            raise HTTPException(status_code=404, detail="File not found")

        file_type = get_file_type(file_path, is_dir=False)
        if file_type != "image":
            raise HTTPException(status_code=400, detail="File type not supported")

        size = max(48, min(int(size), 1024))
        mtime = os.stat(file_path).st_mtime

        try:
            cache_path = _build_image_thumbnail(file_path, size, mtime)
            return FileResponse(
                cache_path,
                media_type="image/webp",
                headers={"Cache-Control": "public, max-age=31536000, immutable"},
            )
        except Exception:
            # 无法解码（如 svg / 损坏文件），回退原图
            traceback.print_exc()
            mime_type, _ = mimetypes.guess_type(file_path)
            return FileResponse(
                file_path,
                media_type=mime_type or "application/octet-stream",
                headers={"Cache-Control": "no-cache"},
            )

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


def get_file_type(file_path: str, is_dir: Optional[bool] = None) -> str:
    """
    根据文件扩展名判断文件类型
    
    Args:
        file_path: 文件路径或文件名
        is_dir: 已知是否为目录时传入，避免多余的 stat 系统调用
    
    Returns:
        文件类型: 'image', 'video', 'audio', 'document', 'archive', 'code', 'file'
    """
    if is_dir is None:
        is_dir = os.path.isdir(file_path)

    if is_dir:
        return "folder"

    _, ext = os.path.splitext(file_path.lower())

    if ext in IMAGE_EXTENSIONS:
        return "image"
    elif ext in VIDEO_EXTENSIONS:
        return "video"
    elif ext in AUDIO_EXTENSIONS:
        return "audio"
    elif ext in DOCUMENT_EXTENSIONS:
        return "document"
    elif ext in ARCHIVE_EXTENSIONS:
        return "archive"
    elif ext in CODE_EXTENSIONS:
        return "code"
    else:
        return "file"

@router.get("/serve_file")
def serve_file(file_path: str):
    """
    提供文件内容服务，用于在浏览器中预览图片和视频
    
    Args:
        file_path: 文件路径
    
    Returns:
        文件内容
    """
    try:
        if not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail="File not found")
        
        if not os.path.isfile(file_path):
            raise HTTPException(status_code=400, detail="Path is not a file")
        
        # 检查文件类型
        file_type = get_file_type(file_path, is_dir=False)
        if file_type not in MEDIA_TYPES:
            raise HTTPException(status_code=400, detail="File type not supported for preview")
        
        # 获取MIME类型
        mime_type, _ = mimetypes.guess_type(file_path)
        if not mime_type:
            mime_type = "application/octet-stream"
        
        # FileResponse 自带 ETag/Last-Modified/304 协商缓存与 Range 支持
        return FileResponse(
            file_path,
            media_type=mime_type,
            filename=os.path.basename(file_path),
            headers={"Cache-Control": "private, max-age=0, must-revalidate"},
        )
        
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/get_file_info")
def get_file_info(file_path: str):
    """
    获取文件详细信息
    
    Args:
        file_path: 文件路径
    
    Returns:
        文件详细信息
    """
    try:
        if not os.path.exists(file_path):
            raise HTTPException(status_code=404, detail="File not found")
        
        stat = os.stat(file_path)
        file_type = get_file_type(file_path, is_dir=False)
        
        return {
            "name": os.path.basename(file_path),
            "path": file_path,
            "type": file_type,
            "size": stat.st_size,
            "mtime": stat.st_mtime,
            "ctime": stat.st_ctime,
            "is_directory": False,
            "is_media": file_type in MEDIA_TYPES,
            "mime_type": mimetypes.guess_type(file_path)[0] or "application/octet-stream",
            # 图片宽高由后端读文件头得到，前端无需再下载原图解析
            "dimensions": _read_image_size(file_path) if file_type == "image" else None,
        }
        
    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
