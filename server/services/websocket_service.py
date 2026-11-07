# services/websocket_service.py
from services.websocket_state import (
    sio,
    get_all_socket_ids,
    get_room_members,
    session_room,
)
import traceback
from typing import Any, Dict

# 这些事件需要跨会话/跨画布可见（前端各自按 canvas_id、session_id 过滤），
# 其余高频事件（all_messages、delta、tool_call 等）只推给订阅了该会话的连接。
_CANVAS_WIDE_EVENT_TYPES = {'image_generated', 'video_generated', 'error'}


async def broadcast_session_update(session_id: str, canvas_id: str | None, event: Dict[str, Any]):
    payload: Dict[str, Any] = {
        'canvas_id': canvas_id,
        'session_id': session_id,
        **event,
    }

    try:
        room = session_room(session_id) if session_id else ''
        members = get_room_members(room) if room else set()

        # 前端尚未订阅（旧版本客户端或刚连上）时回退到原有的全局广播
        if not members:
            for socket_id in get_all_socket_ids():
                await sio.emit('session_update', payload, room=socket_id)
            return

        # 会话内事件：只推给订阅了该会话的连接
        await sio.emit('session_update', payload, room=room)

        # 画布级事件（图片/视频生成、错误通知）：还需要推给同画布的其他会话窗口
        if event.get('type') in _CANVAS_WIDE_EVENT_TYPES:
            for socket_id in get_all_socket_ids():
                if socket_id in members:
                    continue
                await sio.emit('session_update', payload, room=socket_id)
    except Exception as e:
        print(f"Error broadcasting session update for {session_id}: {e}")
        traceback.print_exc()


# compatible with legacy codes
# TODO: All Broadcast should have a canvas_id

async def send_to_websocket(session_id: str, event: Dict[str, Any]):
    await broadcast_session_update(session_id, None, event)


async def broadcast_init_done():
    try:
        await sio.emit('init_done', {
            'type': 'init_done'
        })
        print("Broadcasted init_done to all clients")
    except Exception as e:
        print(f"Error broadcasting init_done: {e}")
        traceback.print_exc()
