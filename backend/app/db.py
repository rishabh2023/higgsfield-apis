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
        return _conn


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
