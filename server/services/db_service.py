import asyncio
import base64
import sqlite3
import json
import os
from io import BytesIO
from typing import List, Dict, Any, Optional
import aiosqlite
from PIL import Image
from .config_service import USER_DATA_DIR
from .migrations.manager import MigrationManager, CURRENT_VERSION

DB_PATH = os.path.join(USER_DATA_DIR, "localmanus.db")

# Legacy rows stored the full image data URL as a preview, ~4MB each; the canvas list endpoint
# used to ship every one of them to the home page.
_THUMBNAIL_MAX_SIZE = (480, 480)
_THUMBNAIL_STALE_LENGTH = 128_000


def _build_canvas_response(raw_data: Optional[str], name: Any, sessions: List[Dict[str, Any]]) -> bytes:
    """Splice the raw canvas JSON into the response body. Blocking for large blobs."""
    body = (
        '{"data":' + (raw_data or "{}")
        + ',"name":' + json.dumps(name, ensure_ascii=False)
        + ',"sessions":' + json.dumps(sessions, ensure_ascii=False)
        + '}'
    )
    return body.encode("utf-8")

def _shrink_thumbnail(thumbnail: str) -> Optional[str]:
    """Downscale a legacy full-resolution preview. Returns None if it cannot be decoded."""
    try:
        _, b64 = thumbnail.split(",", 1)
        image = Image.open(BytesIO(base64.b64decode(b64)))
    except Exception:
        return None

    image.thumbnail(_THUMBNAIL_MAX_SIZE)
    canvas = Image.new("RGB", image.size, (255, 255, 255))
    image = image.convert("RGBA") if image.mode in ("RGBA", "LA", "P") else image.convert("RGB")
    canvas.paste(image, mask=image.split()[-1] if image.mode == "RGBA" else None)

    buffer = BytesIO()
    canvas.save(buffer, format="JPEG", quality=75, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("utf-8")


class DatabaseService:
    def __init__(self):
        self.db_path = DB_PATH
        self._ensure_db_directory()
        self._migration_manager = MigrationManager()
        self._init_db()

    def _ensure_db_directory(self):
        """Ensure the database directory exists"""
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)

    def _init_db(self):
        """Initialize the database with the current schema"""
        with sqlite3.connect(self.db_path) as conn:
            # WAL 允许读写并发，避免写写冲突直接报 database is locked
            conn.execute("PRAGMA journal_mode=WAL")
            # Create version table if it doesn't exist
            conn.execute("""
                CREATE TABLE IF NOT EXISTS db_version (
                    version INTEGER PRIMARY KEY
                )
            """)
            
            # Get current version
            cursor = conn.execute("SELECT version FROM db_version")
            current_version = cursor.fetchone()
            print('local db version', current_version, 'latest version', CURRENT_VERSION)
            
            if current_version is None:
                # First time setup - start from version 0
                conn.execute("INSERT INTO db_version (version) VALUES (0)")
                self._migration_manager.migrate(conn, 0, CURRENT_VERSION)
            elif current_version[0] < CURRENT_VERSION:
                print('Migrating database from version', current_version[0], 'to', CURRENT_VERSION)
                # Need to migrate
                self._migration_manager.migrate(conn, current_version[0], CURRENT_VERSION)

    async def create_canvas(self, id: str, name: str):
        """Create a new canvas"""
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            await db.execute("""
                INSERT INTO canvases (id, name)
                VALUES (?, ?)
            """, (id, name))
            await db.commit()

    async def list_canvases(self) -> List[Dict[str, Any]]:
        """Get all canvases, shrinking and persisting legacy oversized previews"""
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            db.row_factory = sqlite3.Row
            cursor = await db.execute("""
                SELECT id, name, description, thumbnail, created_at, updated_at
                FROM canvases
                ORDER BY updated_at DESC
            """)
            rows = await cursor.fetchall()

            canvases = []
            updated = []
            for row in rows:
                item = dict(row)
                thumbnail = item.get("thumbnail")
                if thumbnail and len(thumbnail) > _THUMBNAIL_STALE_LENGTH:
                    shrunk = await asyncio.to_thread(_shrink_thumbnail, thumbnail)
                    if shrunk:
                        item["thumbnail"] = shrunk
                        updated.append((shrunk, item["id"]))
                canvases.append(item)

            if updated:
                # The read must not fail because the write-back could not be persisted
                try:
                    await db.executemany(
                        "UPDATE canvases SET thumbnail = ? WHERE id = ?", updated
                    )
                    await db.commit()
                except sqlite3.Error as exc:
                    print(f"Could not persist normalized canvas thumbnails: {exc}")

            return canvases

    async def create_chat_session(self, id: str, model: str, provider: str, canvas_id: str, title: Optional[str] = None):
        """Save a new chat session"""
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            await db.execute("""
                INSERT INTO chat_sessions (id, model, provider, canvas_id, title)
                VALUES (?, ?, ?, ?, ?)
            """, (id, model, provider, canvas_id, title))
            await db.commit()

    async def create_message(self, session_id: str, role: str, message: str):
        """Save a chat message"""
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            await db.execute("""
                INSERT INTO chat_messages (session_id, role, message)
                VALUES (?, ?, ?)
            """, (session_id, role, message))
            await db.commit()

    async def get_chat_history(self, session_id: str) -> List[Dict[str, Any]]:
        """Get chat history for a session"""
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            db.row_factory = sqlite3.Row
            cursor = await db.execute("""
                SELECT role, message, id
                FROM chat_messages
                WHERE session_id = ?
                ORDER BY id ASC
            """, (session_id,))
            rows = await cursor.fetchall()
            
            messages = []
            for row in rows:
                row_dict = dict(row)
                if row_dict['message']:
                    try:
                        msg = json.loads(row_dict['message'])
                        messages.append(msg)
                    except:
                        pass
                
            return messages

    async def list_sessions(self, canvas_id: str = "") -> List[Dict[str, Any]]:
        """List all chat sessions"""
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            db.row_factory = sqlite3.Row
            if canvas_id:
                cursor = await db.execute("""
                    SELECT id, title, model, provider, created_at, updated_at
                    FROM chat_sessions
                    WHERE canvas_id = ?
                    ORDER BY updated_at DESC
                """, (canvas_id,))
            else:
                cursor = await db.execute("""
                    SELECT id, title, model, provider, created_at, updated_at
                    FROM chat_sessions
                    ORDER BY updated_at DESC
                """)
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

    async def get_session_title(self, session_id: str) -> str:
        """Get session title by session id"""
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            cursor = await db.execute(
                "SELECT title FROM chat_sessions WHERE id = ?",
                (session_id,)
            )
            row = await cursor.fetchone()
            return row[0] if row and row[0] else "untitled"

    async def save_canvas_data(self, id: str, data: str, thumbnail: Optional[str] = None):
        """Save canvas data, keeping the stored thumbnail when none is supplied"""
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            if thumbnail is None:
                await db.execute("""
                    UPDATE canvases
                    SET data = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ?
                """, (data, id))
            else:
                await db.execute("""
                    UPDATE canvases
                    SET data = ?, thumbnail = ?, updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')
                    WHERE id = ?
                """, (data, thumbnail, id))
            await db.commit()

    async def get_canvas_data(self, id: str) -> Optional[Dict[str, Any]]:
        """Get canvas data"""
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            db.row_factory = sqlite3.Row
            cursor = await db.execute("""
                SELECT data, name
                FROM canvases
                WHERE id = ?
            """, (id,))
            row = await cursor.fetchone()

        if row is None:
            return None

        sessions = await self.list_sessions(id)

        raw_data = row["data"]
        # Canvas blobs can be hundreds of MB — parsing must not block the loop
        parsed_data = await asyncio.to_thread(json.loads, raw_data) if raw_data else {}
        return {
            'data': parsed_data,
            'name': row['name'],
            'sessions': sessions
        }

    async def get_canvas_response_json(self, id: str) -> Optional[bytes]:
        """Build the GET /api/canvas/{id} body without parsing the canvas blob.

        The stored blob can be hundreds of MB; parsing and re-serializing it would stall
        the event loop for seconds, so the raw JSON text is spliced straight into the body.
        """
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            db.row_factory = sqlite3.Row
            cursor = await db.execute("SELECT data, name FROM canvases WHERE id = ?", (id,))
            row = await cursor.fetchone()

        if row is None:
            return None

        sessions = await self.list_sessions(id)
        return await asyncio.to_thread(_build_canvas_response, row["data"], row["name"], sessions)

    async def delete_canvas(self, id: str):
        """Delete canvas and related data"""
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            await db.execute("DELETE FROM canvases WHERE id = ?", (id,))
            await db.commit()

    async def rename_canvas(self, id: str, name: str):
        """Rename canvas — also syncs the session title for file naming"""
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            await db.execute("UPDATE canvases SET name = ? WHERE id = ?", (name, id))
            # Sync session titles so image files are named after the current canvas title
            await db.execute(
                "UPDATE chat_sessions SET title = ? WHERE canvas_id = ?",
                (name, id),
            )
            await db.commit()

    async def create_comfy_workflow(self, name: str, api_json: str, description: str, inputs: str, outputs: str = None):
        """Create a new comfy workflow"""
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            await db.execute("""
                INSERT INTO comfy_workflows (name, api_json, description, inputs, outputs)
                VALUES (?, ?, ?, ?, ?)
            """, (name, api_json, description, inputs, outputs))
            await db.commit()

    async def list_comfy_workflows(self) -> List[Dict[str, Any]]:
        """List all comfy workflows"""
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            db.row_factory = sqlite3.Row
            cursor = await db.execute("SELECT id, name, description, api_json, inputs, outputs FROM comfy_workflows ORDER BY id DESC")
            rows = await cursor.fetchall()
            return [dict(row) for row in rows]

    async def delete_comfy_workflow(self, id: int):
        """Delete a comfy workflow"""
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            await db.execute("DELETE FROM comfy_workflows WHERE id = ?", (id,))
            await db.commit()

    async def get_comfy_workflow(self, id: int):
        """Get comfy workflow dict"""
        async with aiosqlite.connect(self.db_path, timeout=5) as db:
            db.row_factory = sqlite3.Row
            cursor = await db.execute(
                "SELECT api_json FROM comfy_workflows WHERE id = ?", (id,)
            )
            row = await cursor.fetchone()
        if row is None or row["api_json"] is None:
            raise ValueError(f"Comfy workflow {id} not found")
        try:
            workflow_json = (
                row["api_json"]
                if isinstance(row["api_json"], dict)
                else json.loads(row["api_json"])
            )
            return workflow_json
        except json.JSONDecodeError as exc:
            raise ValueError(f"Stored workflow api_json is not valid JSON: {exc}")

# Create a singleton instance
db_service = DatabaseService()
