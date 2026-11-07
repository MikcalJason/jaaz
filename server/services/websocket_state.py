# services/websocket_state.py
import socketio
from typing import Dict, Optional, Set

sio = socketio.AsyncServer(
    cors_allowed_origins="*",
    async_mode='asgi',
    ping_timeout=120,    # 2 min — don't disconnect while backend is busy generating
    ping_interval=25,    # 25 sec — default, matches client side
)

active_connections: Dict[str, dict] = {}

# room name -> 订阅该 room 的 socket id 集合
_room_members: Dict[str, Set[str]] = {}
# socket id -> 当前订阅的 room（一个连接同时只关注一个会话）
_sid_room: Dict[str, str] = {}


def session_room(session_id: str) -> str:
    """会话对应的 socket.io room 名"""
    return f'session:{session_id}'


def add_connection(socket_id: str, user_info: dict = None):
    active_connections[socket_id] = user_info or {}
    print(f"New connection added: {socket_id}, total connections: {len(active_connections)}")


def remove_connection(socket_id: str):
    active_connections.pop(socket_id, None)
    room = _sid_room.pop(socket_id, None)
    if room:
        members = _room_members.get(room)
        if members is not None:
            members.discard(socket_id)
            if not members:
                _room_members.pop(room, None)
    print(f"Connection removed: {socket_id}, total connections: {len(active_connections)}")


def join_room(socket_id: str, room: str) -> Optional[str]:
    """把连接放进 room，返回它之前所在的 room"""
    previous = _sid_room.get(socket_id)
    if previous == room:
        return previous
    if previous:
        leave_room(socket_id, previous)

    _room_members.setdefault(room, set()).add(socket_id)
    _sid_room[socket_id] = room
    return previous


def leave_room(socket_id: str, room: str):
    members = _room_members.get(room)
    if members is not None:
        members.discard(socket_id)
        if not members:
            _room_members.pop(room, None)
    if _sid_room.get(socket_id) == room:
        _sid_room.pop(socket_id, None)


def get_room_members(room: str) -> Set[str]:
    return set(_room_members.get(room, set()))


def get_all_socket_ids():
    return list(active_connections.keys())


def get_connection_count():
    return len(active_connections)
