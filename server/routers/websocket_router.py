# routers/websocket_router.py
from services.websocket_state import (
    sio,
    add_connection,
    remove_connection,
    join_room,
    leave_room,
    session_room,
)


@sio.event
async def connect(sid, environ, auth):
    print(f"Client {sid} connected")

    user_info = auth or {}
    add_connection(sid, user_info)

    await sio.emit('connected', {'status': 'connected'}, room=sid)


@sio.event
async def disconnect(sid):
    print(f"Client {sid} disconnected")
    remove_connection(sid)


@sio.event
async def join_session(sid, data):
    """前端切换会话时订阅对应 room，服务端只把该会话的事件推给订阅者"""
    session_id = data.get('session_id') if isinstance(data, dict) else None
    if not session_id:
        return

    room = session_room(session_id)
    previous = join_room(sid, room)
    await sio.enter_room(sid, room)
    if previous and previous != room:
        await sio.leave_room(sid, previous)
    await sio.emit('joined_session', {'session_id': session_id}, room=sid)


@sio.event
async def leave_session(sid, data):
    session_id = data.get('session_id') if isinstance(data, dict) else None
    if not session_id:
        return

    room = session_room(session_id)
    leave_room(sid, room)
    await sio.leave_room(sid, room)


@sio.event
async def ping(sid, data):
    await sio.emit('pong', data, room=sid)
