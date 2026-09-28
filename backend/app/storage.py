"""Settings -> Storage & Raw data: list stored clips, show raw records, and clear things safely.

Every delete goes through the normal DB paths, so the ledger records it and a rebuild
never resurrects cleared data.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Literal

from fastapi import HTTPException

from app import db, ledger, media, service
from app.config import get_settings

ACTIVE = service.ACTIVE
FAILED = ("failed", "rejected", "nsfw", "canceled")


def _used_asset_ids(workspace_id: str) -> set[str]:
    used: set[str] = set()
    for g in db.fetch_all("SELECT media_json FROM generations WHERE workspace_id = ?", (workspace_id,)):
        for ids in json.loads(g["media_json"] or "{}").values():
            used.update(ids)
    return used


def list_files(workspace_id: str) -> dict[str, Any]:
    rows = db.fetch_all(
        """SELECT a.*, p.name AS project_name, g.status AS generation_status, g.model AS generation_model
           FROM assets a
           JOIN projects p ON p.id = a.project_id
           LEFT JOIN generations g ON g.id = a.generation_id
           WHERE a.workspace_id = ? ORDER BY a.created_at DESC""",
        (workspace_id,),
    )
    used = _used_asset_ids(workspace_id)
    files = []
    for a in rows:
        on_disk = bool(a["local_path"]) and Path(a["local_path"]).exists()
        files.append({
            **media.to_public(a),
            "project_name": a["project_name"],
            "model": a["generation_model"],
            "on_disk": on_disk,
            "path": a["local_path"],
            "used_as_input": a["id"] in used,
            "remote_url": a["remote_url"],
        })
    return {
        "files": files,
        "total_bytes": sum(f["size_bytes"] or 0 for f in files if f["on_disk"]),
        "counts": {
            "outputs": sum(1 for f in files if f["source"] == "generation"),
            "uploads": sum(1 for f in files if f["source"] == "upload"),
        },
    }


def delete_files(workspace_id: str, asset_ids: list[str]) -> int:
    """Uploads: removed. Generated clips: the whole video (card + file) is removed."""
    n = 0
    for aid in dict.fromkeys(asset_ids):
        a = db.fetch_one("SELECT * FROM assets WHERE id = ? AND workspace_id = ?", (aid, workspace_id))
        if not a:
            continue
        if a["source"] == "generation" and a["generation_id"]:
            g = db.fetch_one("SELECT status FROM generations WHERE id = ?", (a["generation_id"],))
            if g and g["status"] in ACTIVE:
                raise HTTPException(409, "A selected video is still generating.")
            if g:
                # Make sure the file goes even if it was saved to References.
                with db.tx() as conn:
                    conn.execute("UPDATE assets SET in_library = 0 WHERE id = ?", (aid,))
                service.delete_generation(workspace_id, a["generation_id"])
                n += 1
                continue
        media.delete_many([a])
        n += 1
    return n


def clear(workspace_id: str, scope: Literal["failed", "unused_uploads", "everything"]) -> dict[str, int]:
    if scope == "failed":
        rows = db.fetch_all(
            f"SELECT id FROM generations WHERE workspace_id = ? AND status IN ({','.join('?' * len(FAILED))})",
            (workspace_id, *FAILED),
        )
        for r in rows:
            service.delete_generation(workspace_id, r["id"])
        return {"generations": len(rows)}
    if scope == "unused_uploads":
        used = _used_asset_ids(workspace_id)
        rows = [a for a in db.fetch_all("SELECT * FROM assets WHERE workspace_id = ? AND source = 'upload'", (workspace_id,))
                if a["id"] not in used]
        media.delete_many(rows)
        return {"files": len(rows)}
    # everything: all projects, videos and files for this browser. The API key stays.
    active = db.fetch_one(
        "SELECT COUNT(*) AS n FROM generations WHERE workspace_id = ? AND status IN ('submitting','queued','in_progress')",
        (workspace_id,),
    )
    if active and active["n"]:
        raise HTTPException(409, "Wait for running videos to finish (or cancel them) first.")
    projects = db.fetch_all("SELECT id FROM projects WHERE workspace_id = ?", (workspace_id,))
    from app import projects as projects_mod

    for p in projects:
        projects_mod.delete(workspace_id, p["id"])
    return {"projects": len(projects)}


# ------------------------------------------------------------------ raw data


def _redact(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return row
    out = dict(row)
    if "encrypted_key" in out:
        out["encrypted_key"] = "[encrypted — never shown]"
    if "token_hash" in out:
        out["token_hash"] = "[hidden]"
    if "webhook_token" in out:
        out["webhook_token"] = "[hidden]"
    return out


def raw_generation(workspace_id: str, generation_id: str) -> dict[str, Any]:
    g = service.get_owned(workspace_id, generation_id)
    history = []
    for rec in ledger.read(ledger.path_for(get_settings().database_path)):
        if rec.get("table") == "generations" and rec.get("key") == generation_id:
            row = rec.get("row") or {}
            history.append({"ts": rec["ts"], "op": rec["op"], "status": row.get("status"), "error": row.get("error")})
    return {
        "generation_id": g["id"],
        "higgsfield_request_id": g["hf_request_id"],
        "correlation_id": g["correlation_id"],
        "model": g["model"],
        "status": g["status"],
        "request_sent_to_higgsfield": json.loads(g["arguments_json"] or "{}"),
        "higgsfield_response": json.loads(g["output_json"]) if g["output_json"] else None,
        "status_history": history,
        "record": _redact(g),
    }


def ledger_tail(workspace_id: str, limit: int = 200) -> dict[str, Any]:
    path = ledger.path_for(get_settings().database_path)
    mine: set[str] = {workspace_id}
    entries: list[dict[str, Any]] = []
    total = 0
    for rec in ledger.read(path):
        total += 1
        row = rec.get("row") or {}
        key = rec.get("key")
        owned = key in mine or row.get("workspace_id") == workspace_id or (rec.get("table") == "workspaces" and key == workspace_id)
        if not owned:
            continue
        mine.add(key)
        entries.append({**rec, "row": _redact(row) if row else None})
    return {
        "file": path.name,
        "bytes": path.stat().st_size if path.exists() else 0,
        "total_lines": total,
        "entries": entries[-limit:][::-1],
    }


def compact_ledger() -> dict[str, Any]:
    """Rewrite the ledger as one snapshot of the current data (smaller, same safety).
    The previous ledger is kept in data/backups/."""
    settings = get_settings()
    path = ledger.path_for(settings.database_path)
    before = path.stat().st_size if path.exists() else 0
    folder = settings.database_path.parent / "backups"
    folder.mkdir(exist_ok=True)
    with db._lock:  # no writes while we swap files
        conn = db.connect()
        if path.exists():
            from datetime import datetime

            os.replace(path, folder / f"ledger-{datetime.now().strftime('%Y%m%d-%H%M%S')}.jsonl")
        tmp = path.with_suffix(".compact")
        tmp.unlink(missing_ok=True)
        ledger.baseline(conn, tmp)
        os.replace(tmp, path)
    for old in sorted(folder.glob("ledger-*.jsonl"))[:-3]:
        old.unlink(missing_ok=True)
    return {"bytes_before": before, "bytes_after": path.stat().st_size}
