"""Local media library: reference uploads and downloaded generation outputs.

Why local copies:
* Higgsfield keeps outputs for "at least seven days" and tags presigned uploads
  ``retention=temporary`` — neither is durable. The local file is the source of truth.
* Model inputs must be public URLs, so before each submission we reuse the asset's
  remote URL only if it still responds, otherwise re-upload the local file.
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import uuid
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app import db, higgsfield
from app.config import get_settings
from app.higgsfield import HFError

log = logging.getLogger("app.media")

MB = 1024 * 1024
# Higgsfield presigned uploads accept exactly these types (docs: concepts/file-uploads).
LIMITS = {"image": 30 * MB, "audio": 50 * MB, "video": 200 * MB}
OUTPUT_MAX_BYTES = 2048 * MB
REMOTE_MAX_AGE = 6 * 24 * 3600  # outputs are guaranteed for >= 7 days
EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
       "audio/wav": ".wav", "video/mp4": ".mp4", "video/quicktime": ".mov"}

_tasks: set[asyncio.Task] = set()
_loop: asyncio.AbstractEventLoop | None = None


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Remember the app's event loop so sync (threadpool) code can schedule downloads."""
    global _loop
    _loop = loop


def media_dir(workspace_id: str) -> Path:
    d = get_settings().database_path.parent / "media" / workspace_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def sniff(head: bytes) -> tuple[str, str]:
    """Identify the file from its magic bytes -> (kind, content_type). Raises 400 if unsupported."""
    if head.startswith(b"\xff\xd8\xff"):
        return "image", "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image", "image/png"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image", "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image", "image/webp"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio", "audio/wav"
    if head[4:8] == b"ftyp":
        if head[8:12] == b"qt  ":
            raise HTTPException(400, "QuickTime .mov files aren't accepted by Higgsfield — export as MP4.")
        return "video", "video/mp4"
    raise HTTPException(400, "Unsupported file. Use JPG, PNG, WEBP or GIF images, WAV audio, or MP4 video.")


def asset_url(asset_id: str) -> str:
    return f"/api/assets/{asset_id}/file"


def to_public(a: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": a["id"], "project_id": a["project_id"], "kind": a["kind"], "source": a["source"],
        "generation_id": a["generation_id"], "name": a["name"], "content_type": a["content_type"],
        "size_bytes": a["size_bytes"], "in_library": bool(a["in_library"]), "status": a["status"],
        "error": a["error"], "created_at": a["created_at"], "url": asset_url(a["id"]),
    }


def get_owned(workspace_id: str, asset_id: str) -> dict[str, Any]:
    a = db.fetch_one("SELECT * FROM assets WHERE id = ? AND workspace_id = ?", (asset_id, workspace_id))
    if not a:
        raise HTTPException(404, "File not found")
    return a


def list_for_project(workspace_id: str, project_id: str, library_only: bool) -> list[dict[str, Any]]:
    sql = "SELECT * FROM assets WHERE workspace_id = ? AND project_id = ?"
    if library_only:
        sql += " AND in_library = 1"
    return db.fetch_all(sql + " ORDER BY created_at DESC", (workspace_id, project_id))


def save_upload(workspace_id: str, project_id: str, filename: str, fileobj, declared_size: int | None) -> dict[str, Any]:
    head = fileobj.read(16)
    kind, ctype = sniff(head)
    limit = LIMITS[kind]
    if declared_size and declared_size > limit:
        raise HTTPException(413, f"{kind.title()} files can be at most {limit // MB} MB.")
    asset_id = str(uuid.uuid4())
    path = media_dir(workspace_id) / f"{asset_id}{EXT[ctype]}"
    size = len(head)
    try:
        with open(path, "wb") as out:
            out.write(head)
            while chunk := fileobj.read(MB):
                size += len(chunk)
                if size > limit:
                    raise HTTPException(413, f"{kind.title()} files can be at most {limit // MB} MB.")
                out.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    name = Path(filename or f"upload{EXT[ctype]}").name[:200]
    now = db.now()
    with db.tx() as conn:
        conn.execute(
            """INSERT INTO assets (id, workspace_id, project_id, kind, source, name, content_type, size_bytes,
                   local_path, in_library, status, created_at)
               VALUES (?, ?, ?, ?, 'upload', ?, ?, ?, ?, 1, 'ready', ?)""",
            (asset_id, workspace_id, project_id, kind, name, ctype, size, str(path), now),
        )
        conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id))
    return get_owned(workspace_id, asset_id)


def update(workspace_id: str, asset_id: str, *, name: str | None = None, in_library: bool | None = None) -> dict[str, Any]:
    get_owned(workspace_id, asset_id)
    fields: dict[str, Any] = {}
    if name is not None:
        fields["name"] = name.strip()[:200] or "Untitled"
    if in_library is not None:
        fields["in_library"] = int(in_library)
    if fields:
        cols = ", ".join(f"{k} = ?" for k in fields)
        with db.tx() as conn:
            conn.execute(f"UPDATE assets SET {cols} WHERE id = ?", (*fields.values(), asset_id))
    return get_owned(workspace_id, asset_id)


def delete(workspace_id: str, asset_id: str) -> None:
    a = get_owned(workspace_id, asset_id)
    if a["source"] == "generation":
        # Output files belong to their generation; just take them out of References.
        update(workspace_id, asset_id, in_library=False)
        return
    _delete_rows_and_files([a])


def _delete_rows_and_files(rows: list[dict[str, Any]]) -> None:
    with db.tx() as conn:
        for a in rows:
            conn.execute("DELETE FROM assets WHERE id = ?", (a["id"],))
    for a in rows:
        if a["local_path"]:
            Path(a["local_path"]).unlink(missing_ok=True)


def delete_many(rows: list[dict[str, Any]]) -> None:
    _delete_rows_and_files(rows)


# ------------------------------------------------------------------ outputs


def register_output(gen: dict[str, Any], url: str) -> str:
    """Create the asset for a completed generation and start downloading it."""
    existing = db.fetch_one("SELECT id FROM assets WHERE generation_id = ? AND source = 'generation'", (gen["id"],))
    if existing:
        return existing["id"]
    asset_id = str(uuid.uuid4())
    label = (gen.get("prompt") or "Generated video").strip().replace("\n", " ")
    name = (label[:57] + "…") if len(label) > 58 else label
    guessed = mimetypes.guess_type(url.split("?")[0])[0] or "video/mp4"
    now = db.now()
    with db.tx() as conn:
        conn.execute(
            """INSERT INTO assets (id, workspace_id, project_id, kind, source, generation_id, name, content_type,
                   remote_url, remote_url_at, in_library, status, created_at)
               VALUES (?, ?, ?, 'video', 'generation', ?, ?, ?, ?, ?, 0, 'downloading', ?)""",
            (asset_id, gen["workspace_id"], gen["project_id"], gen["id"], name, guessed, url, now, now),
        )
        conn.execute("UPDATE generations SET output_asset_id = ? WHERE id = ?", (asset_id, gen["id"]))
    schedule_download(asset_id)
    return asset_id


def schedule_download(asset_id: str) -> None:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        # Called from a threadpool (sync route): hand off to the app's loop.
        if _loop is not None and not _loop.is_closed():
            _loop.call_soon_threadsafe(_spawn, asset_id)
        return  # otherwise it's resumed on next startup
    _spawn(asset_id)


def _spawn(asset_id: str) -> None:
    task = asyncio.get_running_loop().create_task(download_output(asset_id))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def download_output(asset_id: str, attempts: int = 4) -> None:
    a = db.fetch_one("SELECT * FROM assets WHERE id = ?", (asset_id,))
    if not a or a["status"] == "ready" or not a["remote_url"]:
        return
    ext = EXT.get(a["content_type"], ".mp4")
    dest = media_dir(a["workspace_id"]) / f"{asset_id}{ext}"
    delay = 2.0
    for attempt in range(1, attempts + 1):
        try:
            ctype, size = await higgsfield.gateway.download(a["remote_url"], dest, OUTPUT_MAX_BYTES)
            if ctype.startswith("video/"):
                a_ct = ctype
            else:
                a_ct = a["content_type"]
            with db.tx() as conn:
                conn.execute(
                    "UPDATE assets SET local_path = ?, size_bytes = ?, content_type = ?, status = 'ready', error = NULL WHERE id = ?",
                    (str(dest), size, a_ct, asset_id),
                )
            log.info("saved output %s (%d bytes)", asset_id, size)
            return
        except HFError as err:
            log.warning("download %s attempt %d failed: %s", asset_id, attempt, err.message)
            if err.kind != "transient" or attempt == attempts:
                with db.tx() as conn:
                    conn.execute("UPDATE assets SET status = 'download_failed', error = ? WHERE id = ?",
                                 (f"Couldn't save a local copy: {err.message}", asset_id))
                return
            await asyncio.sleep(delay)
            delay *= 3


def resume_downloads() -> None:
    for a in db.fetch_all("SELECT id FROM assets WHERE status = 'downloading'"):
        schedule_download(a["id"])


async def retry_download(workspace_id: str, asset_id: str) -> dict[str, Any]:
    a = get_owned(workspace_id, asset_id)
    if a["source"] != "generation" or a["status"] == "ready":
        raise HTTPException(409, "Nothing to retry.")
    with db.tx() as conn:
        conn.execute("UPDATE assets SET status = 'downloading', error = NULL WHERE id = ?", (asset_id,))
    await download_output(asset_id, attempts=1)
    return get_owned(workspace_id, asset_id)


# ------------------------------------------------------------------ inputs


async def ensure_remote_url(api_key: str, a: dict[str, Any]) -> str:
    """A public URL Higgsfield can fetch for this asset, re-uploading if needed."""
    url, at = a["remote_url"], a["remote_url_at"]
    if url and at and db.now() - at < REMOTE_MAX_AGE and await higgsfield.gateway.url_alive(url):
        return url
    path = Path(a["local_path"]) if a["local_path"] else None
    if not path or not path.exists():
        raise HFError("rejected", f"'{a['name']}' has no local copy and its online copy expired. Re-upload it.")
    if a["content_type"] not in ("image/jpeg", "image/png", "image/webp", "image/gif", "audio/wav", "video/mp4"):
        raise HFError("rejected", f"'{a['name']}' ({a['content_type']}) can't be sent to Higgsfield.")
    data = await asyncio.to_thread(path.read_bytes)
    url = await higgsfield.gateway.upload(api_key, data, a["content_type"])
    with db.tx() as conn:
        conn.execute("UPDATE assets SET remote_url = ?, remote_url_at = ? WHERE id = ?", (url, db.now(), a["id"]))
    return url
