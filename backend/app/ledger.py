"""Append-only text ledger (data/ledger.jsonl) that can rebuild the database.

Every committed change to workspaces/credentials/projects/assets/generations is written
as one JSON line holding the full row. It's plain text you can open and read, and it's
the safety net that keeps Higgsfield request IDs so a lost DB never needs a paid
regeneration: `python -m app.recover` (or an automatic startup check) replays it.

How changes are captured: SQLite triggers record (table, key, op) into `_changes` inside
the same transaction as the write; after COMMIT we drain `_changes` into the file.
A crash between commit and write leaves rows in `_changes`, drained on next start.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import shutil
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

log = logging.getLogger("app.ledger")

# table -> primary key column
TABLES = {
    "workspaces": "id",
    "credentials": "workspace_id",
    "projects": "id",
    "assets": "id",
    "generations": "id",
}
# generations get polled constantly; only log meaningful changes, not poll bookkeeping.
_GEN_WATCH = ["status", "hf_request_id", "video_url", "output_asset_id", "arguments_json", "prompt",
              "params_json", "media_json", "project_id", "error", "correlation_id", "finished_at",
              "est_credits"]

_lock = threading.Lock()


def path_for(db_path: Path) -> Path:
    return db_path.parent / "ledger.jsonl"


def trigger_sql() -> str:
    parts = ["CREATE TABLE IF NOT EXISTS _changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, key TEXT NOT NULL, op TEXT NOT NULL);"]
    for t, pk in TABLES.items():
        # Recreate on every start so trigger changes reach existing databases.
        parts += [f"DROP TRIGGER IF EXISTS _led_{t}_{k};" for k in ("ins", "upd", "del")]
        parts.append(
            f"CREATE TRIGGER IF NOT EXISTS _led_{t}_ins AFTER INSERT ON {t} "
            f"BEGIN INSERT INTO _changes (tbl, key, op) VALUES ('{t}', NEW.{pk}, 'upsert'); END;"
        )
        when = ""
        if t == "generations":
            when = " WHEN " + " OR ".join(f"OLD.{c} IS NOT NEW.{c}" for c in _GEN_WATCH)
        parts.append(
            f"CREATE TRIGGER IF NOT EXISTS _led_{t}_upd AFTER UPDATE ON {t}{when} "
            f"BEGIN INSERT INTO _changes (tbl, key, op) VALUES ('{t}', NEW.{pk}, 'upsert'); END;"
        )
        parts.append(
            f"CREATE TRIGGER IF NOT EXISTS _led_{t}_del AFTER DELETE ON {t} "
            f"BEGIN INSERT INTO _changes (tbl, key, op) VALUES ('{t}', OLD.{pk}, 'delete'); END;"
        )
    return "\n".join(parts)


def _encode(v: Any) -> Any:
    if isinstance(v, bytes):
        return {"__b64__": base64.b64encode(v).decode()}
    return v


def _decode(v: Any) -> Any:
    if isinstance(v, dict) and "__b64__" in v:
        return base64.b64decode(v["__b64__"])
    return v


def _line(op: str, table: str, key: str, row: dict[str, Any] | None) -> str:
    rec: dict[str, Any] = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "op": op,
        "table": table,
        "key": key,
    }
    if row is not None:
        if table == "generations":
            rec["status"] = row.get("status")  # easy to eyeball / grep
        rec["row"] = {k: _encode(v) for k, v in row.items()}
    return json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n"


def _append(ledger: Path, lines: list[str]) -> None:
    with _lock:
        with open(ledger, "a", encoding="utf-8") as fh:
            fh.writelines(lines)
            fh.flush()
            os.fsync(fh.fileno())


def drain(conn: sqlite3.Connection, ledger: Path) -> int:
    """Write pending captured changes to the ledger. Caller holds the DB lock, no open tx."""
    pending = conn.execute("SELECT seq, tbl, key, op FROM _changes ORDER BY seq").fetchall()
    if not pending:
        return 0
    lines = []
    for p in pending:
        tbl, key, op = p["tbl"], p["key"], p["op"]
        if op == "delete":
            lines.append(_line("delete", tbl, key, None))
            continue
        row = conn.execute(f"SELECT * FROM {tbl} WHERE {TABLES[tbl]} = ?", (key,)).fetchone()
        # Row may have been deleted later in the same batch; the delete line follows.
        if row is not None:
            lines.append(_line("upsert", tbl, key, dict(row)))
    _append(ledger, lines)
    conn.execute("DELETE FROM _changes WHERE seq <= ?", (pending[-1]["seq"],))
    return len(lines)


def baseline(conn: sqlite3.Connection, ledger: Path) -> int:
    """First run with an existing DB: snapshot every row so the ledger is complete."""
    lines = []
    for t, pk in TABLES.items():
        for row in conn.execute(f"SELECT * FROM {t}"):
            lines.append(_line("upsert", t, row[pk], dict(row)))
    if lines:
        _append(ledger, lines)
    conn.execute("DELETE FROM _changes")
    return len(lines)


def read(ledger: Path) -> Iterator[dict[str, Any]]:
    if not ledger.exists():
        return
    with open(ledger, encoding="utf-8") as fh:
        for n, raw in enumerate(fh, 1):
            raw = raw.strip()
            if not raw:
                continue
            try:
                yield json.loads(raw)
            except json.JSONDecodeError:
                # A torn final line after a crash is expected; skip it.
                log.warning("ledger line %d is not valid JSON; skipped", n)


def rebuild(db_path: Path, prepare: Callable[[sqlite3.Connection], None]) -> dict[str, int]:
    """Create a fresh database at db_path by replaying the ledger."""
    ledger = path_for(db_path)
    tmp = db_path.with_suffix(".rebuild.db")
    tmp.unlink(missing_ok=True)
    conn = sqlite3.connect(tmp, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=OFF")
    prepare(conn)
    cols = {t: [r["name"] for r in conn.execute(f"PRAGMA table_info({t})")] for t in TABLES}
    counts = {"lines": 0}
    conn.execute("BEGIN")
    for rec in read(ledger):
        t = rec.get("table")
        if t not in TABLES:
            continue
        counts["lines"] += 1
        pk = TABLES[t]
        if rec.get("op") == "delete":
            conn.execute(f"DELETE FROM {t} WHERE {pk} = ?", (rec["key"],))
            continue
        row = {k: _decode(v) for k, v in (rec.get("row") or {}).items() if k in cols[t]}
        if pk not in row:
            continue
        names = list(row)
        updates = ", ".join(f"{c} = excluded.{c}" for c in names if c != pk)
        conn.execute(
            f"INSERT INTO {t} ({', '.join(names)}) VALUES ({', '.join('?' * len(names))}) "
            f"ON CONFLICT({pk}) DO UPDATE SET {updates}",
            tuple(row.values()),
        )
    # Children of deleted parents (cascades aren't replayed with FKs off).
    conn.execute("DELETE FROM credentials WHERE workspace_id NOT IN (SELECT id FROM workspaces)")
    conn.execute("DELETE FROM projects WHERE workspace_id NOT IN (SELECT id FROM workspaces)")
    conn.execute("DELETE FROM assets WHERE project_id NOT IN (SELECT id FROM projects)")
    conn.execute("DELETE FROM generations WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)")
    # Outputs whose file is gone get re-downloaded (free) instead of being lost.
    for a in conn.execute("SELECT id, local_path, remote_url FROM assets WHERE source = 'generation'").fetchall():
        if not (a["local_path"] and Path(a["local_path"]).exists()) and a["remote_url"]:
            conn.execute("UPDATE assets SET status = 'downloading', local_path = NULL WHERE id = ?", (a["id"],))
    # Keep polling anything that was still running (status checks are free).
    conn.execute("UPDATE generations SET next_poll_at = ?, poll_delay = 2.0, poll_deadline = ? "
                 "WHERE status IN ('queued', 'in_progress')", (time.time(), time.time() + 3 * 3600))
    conn.execute("COMMIT")
    for t in TABLES:
        counts[t] = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
    conn.close()
    os.replace(tmp, db_path)
    return counts


def quarantine(db_path: Path, reason: str) -> Path:
    """Move a broken DB (and its WAL files) aside, never deleting it."""
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = db_path.with_name(f"{db_path.name}.{reason}-{stamp}")
    shutil.move(db_path, dest)
    for suffix in ("-wal", "-shm"):
        side = Path(str(db_path) + suffix)
        if side.exists():
            shutil.move(side, Path(str(dest) + suffix))
    return dest


def backup(conn: sqlite3.Connection, db_path: Path, keep: int = 7) -> Path | None:
    """One consistent DB copy per day in data/backups/, keeping the newest `keep`."""
    folder = db_path.parent / "backups"
    folder.mkdir(exist_ok=True)
    dest = folder / f"app-{datetime.now().strftime('%Y-%m-%d')}.db"
    if dest.exists():
        return None
    target = sqlite3.connect(dest)
    try:
        conn.backup(target)
    finally:
        target.close()
    for old in sorted(folder.glob("app-*.db"))[:-keep]:
        old.unlink(missing_ok=True)
    return dest
