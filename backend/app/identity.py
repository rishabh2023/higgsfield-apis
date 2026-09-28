"""Anonymous workspace identity.

There is no login system, so each browser gets a random workspace token in an
HttpOnly cookie. Saved API keys and generations are owned by that workspace, and
every lookup is filtered by it (another browser cannot see or poll your jobs).
"""

import hashlib
import secrets
import uuid

from fastapi import Header, HTTPException, Request, Response

from app import db
from app.config import get_settings

COOKIE = "vg_workspace"
CSRF_HEADER_VALUE = "video-gen"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def current_workspace(request: Request, response: Response) -> str:
    token = request.cookies.get(COOKIE)
    if token:
        row = db.fetch_one("SELECT id FROM workspaces WHERE token_hash = ?", (_hash(token),))
        if row:
            return row["id"]

    token = secrets.token_urlsafe(32)
    workspace_id = str(uuid.uuid4())
    with db.tx() as conn:
        conn.execute(
            "INSERT INTO workspaces (id, token_hash, created_at) VALUES (?, ?, ?)",
            (workspace_id, _hash(token), db.now()),
        )
    response.set_cookie(
        COOKIE,
        token,
        max_age=60 * 60 * 24 * 365,
        httponly=True,
        samesite="lax",
        secure=get_settings().cookie_secure,
        path="/",
    )
    return workspace_id


def require_app_header(x_requested_with: str | None = Header(default=None)) -> None:
    """CSRF guard for cookie-authenticated mutations: cross-site forms can't set this header."""
    if x_requested_with != CSRF_HEADER_VALUE:
        raise HTTPException(status_code=403, detail="Missing X-Requested-With header")
