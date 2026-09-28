"""Projects group generations and their reference media."""

from __future__ import annotations

import json
import uuid
from typing import Any

from fastapi import HTTPException

from app import db, media

DEFAULT_NAME = "My videos"


def _to_public(p: dict[str, Any]) -> dict[str, Any]:
    stats = db.fetch_one(
        """SELECT
             (SELECT COUNT(*) FROM generations WHERE project_id = :id) AS generations,
             (SELECT COUNT(*) FROM generations WHERE project_id = :id AND status IN ('submitting','queued','in_progress')) AS active,
             (SELECT COUNT(*) FROM assets WHERE project_id = :id AND in_library = 1) AS references_count,
             (SELECT a.id FROM assets a WHERE a.project_id = :id AND a.kind = 'video' AND a.source = 'generation'
                ORDER BY a.created_at DESC LIMIT 1) AS cover_asset_id""".replace(":id", "?"),
        (p["id"],) * 4,
    ) or {}
    cover = stats.get("cover_asset_id")
    return {
        "id": p["id"], "name": p["name"], "description": p["description"],
        "created_at": p["created_at"], "updated_at": p["updated_at"],
        "generations": stats.get("generations", 0), "active": stats.get("active", 0),
        "references": stats.get("references_count", 0),
        "cover_url": media.asset_url(cover) if cover else None,
    }


def create(workspace_id: str, name: str, description: str = "") -> dict[str, Any]:
    pid = str(uuid.uuid4())
    now = db.now()
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO projects (id, workspace_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (pid, workspace_id, name.strip()[:120] or "Untitled project", description.strip()[:1000], now, now),
        )
    return get_owned(workspace_id, pid)


def get_owned(workspace_id: str, project_id: str) -> dict[str, Any]:
    p = db.fetch_one("SELECT * FROM projects WHERE id = ? AND workspace_id = ?", (project_id, workspace_id))
    if not p:
        raise HTTPException(404, "Project not found")
    return p


def public(workspace_id: str, project_id: str) -> dict[str, Any]:
    return _to_public(get_owned(workspace_id, project_id))


def list_all(workspace_id: str) -> list[dict[str, Any]]:
    adopt_orphans(workspace_id)
    rows = db.fetch_all("SELECT * FROM projects WHERE workspace_id = ? ORDER BY updated_at DESC", (workspace_id,))
    return [_to_public(p) for p in rows]


def update(workspace_id: str, project_id: str, name: str | None, description: str | None) -> dict[str, Any]:
    get_owned(workspace_id, project_id)
    fields: dict[str, Any] = {"updated_at": db.now()}
    if name is not None:
        fields["name"] = name.strip()[:120] or "Untitled project"
    if description is not None:
        fields["description"] = description.strip()[:1000]
    cols = ", ".join(f"{k} = ?" for k in fields)
    with db.tx() as conn:
        conn.execute(f"UPDATE projects SET {cols} WHERE id = ?", (*fields.values(), project_id))
    return public(workspace_id, project_id)


def delete(workspace_id: str, project_id: str) -> None:
    get_owned(workspace_id, project_id)
    active = db.fetch_one(
        "SELECT COUNT(*) AS n FROM generations WHERE project_id = ? AND status IN ('submitting','queued','in_progress')",
        (project_id,),
    )
    if active and active["n"]:
        raise HTTPException(409, "Wait for running videos to finish (or cancel them) before deleting this project.")
    assets = db.fetch_all("SELECT * FROM assets WHERE project_id = ?", (project_id,))
    media.delete_many(assets)
    with db.tx() as conn:
        conn.execute("DELETE FROM generations WHERE project_id = ?", (project_id,))
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))


def adopt_orphans(workspace_id: str) -> None:
    """Generations created before projects existed move into a default project, and
    their outputs are registered (and downloaded while Higgsfield still serves them)."""
    orphans = db.fetch_all(
        "SELECT * FROM generations WHERE workspace_id = ? AND project_id IS NULL", (workspace_id,)
    )
    if not orphans:
        return
    pid = create(workspace_id, DEFAULT_NAME)["id"]
    with db.tx() as conn:
        for g in orphans:
            args = json.loads(g["arguments_json"])
            conn.execute(
                "UPDATE generations SET project_id = ?, prompt = COALESCE(prompt, ?), params_json = COALESCE(params_json, ?) WHERE id = ?",
                (pid, args.pop("prompt", None), json.dumps(args), g["id"]),
            )
    for g in db.fetch_all("SELECT * FROM generations WHERE project_id = ?", (pid,)):
        if g["status"] == "completed" and g["video_url"] and not g["output_asset_id"]:
            media.register_output(g, g["video_url"])
