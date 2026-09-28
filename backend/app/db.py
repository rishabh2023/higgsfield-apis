"""SQLite persistence. Every generation row is owned by exactly one workspace."""

import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterator

from app.config import get_settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS workspaces (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
    workspace_id  TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    encrypted_key BLOB NOT NULL,
    key_hint      TEXT NOT NULL,
    verified      INTEGER NOT NULL DEFAULT 0,
    updated_at    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS generations (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    idempotency_key  TEXT NOT NULL,
    model            TEXT NOT NULL,
    arguments_json   TEXT NOT NULL,
    status           TEXT NOT NULL,
    hf_request_id    TEXT,
    video_url        TEXT,
    output_json      TEXT,
    error            TEXT,
    correlation_id   TEXT,
    webhook_token    TEXT NOT NULL,
    poll_delay       REAL NOT NULL DEFAULT 2.0,
    next_poll_at     REAL,
    poll_deadline    REAL,
    created_at       REAL NOT NULL,
    updated_at       REAL NOT NULL,
    finished_at      REAL,
    UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS projects (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    created_at   REAL NOT NULL,
    updated_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_projects_workspace ON projects (workspace_id, updated_at DESC);

-- Media files: user uploads (references) and downloaded generation outputs.
-- The local file is the source of truth; remote_url is a Higgsfield-reachable copy
-- that is refreshed (re-uploaded) whenever it may have expired.
CREATE TABLE IF NOT EXISTS assets (
    id              TEXT PRIMARY KEY,
    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,              -- image | video | audio
    source          TEXT NOT NULL,              -- upload | generation
    generation_id   TEXT,
    name            TEXT NOT NULL,
    content_type    TEXT NOT NULL,
    size_bytes      INTEGER,
    local_path      TEXT,
    remote_url      TEXT,
    remote_url_at   REAL,
    in_library      INTEGER NOT NULL DEFAULT 0, -- shown under the project's References
    status          TEXT NOT NULL,              -- ready | downloading | download_failed
    error           TEXT,
    created_at      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_assets_project ON assets (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_generations_workspace ON generations (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_generations_poll ON generations (status, next_poll_at);
CREATE UNIQUE INDEX IF NOT EXISTS ix_generations_request ON generations (hf_request_id)
    WHERE hf_request_id IS NOT NULL;
"""

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None


def connect() -> sqlite3.Connection:
    global _conn
    with _lock:
        if _conn is None:
            path = get_settings().database_path
            path.parent.mkdir(parents=True, exist_ok=True)
            _conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA journal_mode=WAL")
            _conn.execute("PRAGMA foreign_keys=ON")
            _conn.executescript(SCHEMA)
            _migrate(_conn)
        return _conn


# Columns added after the first release; ALTERed in on existing databases.
_GENERATION_COLUMNS = {
    "project_id": "TEXT REFERENCES projects(id) ON DELETE CASCADE",
    "mode": "TEXT NOT NULL DEFAULT 'text'",
    "prompt": "TEXT",
    "params_json": "TEXT",
    "media_json": "TEXT NOT NULL DEFAULT '{}'",
    "output_asset_id": "TEXT",
}


def _migrate(conn: sqlite3.Connection) -> None:
    have = {r["name"] for r in conn.execute("PRAGMA table_info(generations)")}
    for col, ddl in _GENERATION_COLUMNS.items():
        if col not in have:
            conn.execute(f"ALTER TABLE generations ADD COLUMN {col} {ddl}")
    conn.execute("CREATE INDEX IF NOT EXISTS ix_generations_project ON generations (project_id, created_at DESC)")


def close() -> None:
    global _conn
    with _lock:
        if _conn is not None:
            _conn.close()
            _conn = None


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    conn = connect()
    with _lock:
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")


def fetch_one(sql: str, params: tuple = ()) -> dict[str, Any] | None:
    with _lock:
        row = connect().execute(sql, params).fetchone()
    return dict(row) if row else None


def fetch_all(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    with _lock:
        return [dict(r) for r in connect().execute(sql, params).fetchall()]


def now() -> float:
    return time.time()
