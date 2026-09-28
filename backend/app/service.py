"""Credential storage, generation submission and status polling.

Local job statuses:
    submitting          row persisted, POST in flight
    queued/in_progress  accepted by Higgsfield, being polled
    completed/failed/nsfw/canceled   Higgsfield terminal states
    rejected            Higgsfield definitively refused the submission (nothing billed)
    submission_unknown  POST outcome ambiguous (timeout/5xx) — NEVER auto-resubmitted
    timed_out           local polling deadline passed; user can refresh
    stalled             polling blocked (credentials rejected / request not found)
"""

from __future__ import annotations

import json
import logging
import random
import re
import sqlite3
import uuid
from typing import Any

from fastapi import HTTPException

from app import crypto, db
from app.config import get_settings
from app.higgsfield import TERMINAL_REMOTE, HFError
from app import higgsfield
from app.schemas import CreateGeneration, CredentialStatus, Generation

log = logging.getLogger("app.service")

POLLABLE = {"queued", "in_progress"}
ACTIVE = {"submitting", "queued", "in_progress"}
REFRESHABLE = {"queued", "in_progress", "timed_out", "stalled"}
LOCAL_TERMINAL = TERMINAL_REMOTE | {"rejected"}
_IDEMPOTENCY_RE = re.compile(r"^[A-Za-z0-9_-]{8,100}$")

UNKNOWN_MSG = (
    "Higgsfield did not confirm whether this submission was accepted ({detail}). "
    "It was NOT resubmitted automatically to avoid a duplicate charge — check your "
    "Higgsfield console before trying again."
)


# ---------------------------------------------------------------- credentials


def credential_status(workspace_id: str) -> CredentialStatus:
    row = db.fetch_one("SELECT * FROM credentials WHERE workspace_id = ?", (workspace_id,))
    if not row:
        return CredentialStatus(configured=False)
    usable = crypto.decrypt(row["encrypted_key"]) is not None
    return CredentialStatus(configured=True, key_hint=row["key_hint"], verified=bool(row["verified"]), usable=usable)


def get_api_key(workspace_id: str) -> str | None:
    row = db.fetch_one("SELECT encrypted_key FROM credentials WHERE workspace_id = ?", (workspace_id,))
    return crypto.decrypt(row["encrypted_key"]) if row else None


async def save_api_key(workspace_id: str, key_id: str, key_secret: str) -> tuple[CredentialStatus, str | None]:
    api_key = f"{key_id}:{key_secret}"
    verified = await higgsfield.gateway.verify_credentials(api_key)
    if verified is False:
        raise HTTPException(status_code=400, detail="Higgsfield rejected these credentials (401). Nothing was saved.")
    warning = None if verified else "Saved, but Higgsfield could not be reached to verify the key right now."
    with db.tx() as conn:
        conn.execute(
            """INSERT INTO credentials (workspace_id, encrypted_key, key_hint, verified, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(workspace_id) DO UPDATE SET
                 encrypted_key = excluded.encrypted_key, key_hint = excluded.key_hint,
                 verified = excluded.verified, updated_at = excluded.updated_at""",
            (workspace_id, crypto.encrypt(api_key), crypto.key_hint(key_id), int(bool(verified)), db.now()),
        )
    return credential_status(workspace_id), warning


def delete_api_key(workspace_id: str) -> None:
    with db.tx() as conn:
        conn.execute("DELETE FROM credentials WHERE workspace_id = ?", (workspace_id,))


def _mark_key_unverified(workspace_id: str) -> None:
    with db.tx() as conn:
        conn.execute("UPDATE credentials SET verified = 0 WHERE workspace_id = ?", (workspace_id,))


# ---------------------------------------------------------------- generations


def to_schema(row: dict[str, Any]) -> Generation:
    return Generation(
        id=row["id"],
        model=row["model"],
        input=json.loads(row["arguments_json"]),
        status=row["status"],
        request_id=row["hf_request_id"],
        video_url=row["video_url"],
        error=row["error"],
        correlation_id=row["correlation_id"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        finished_at=row["finished_at"],
        is_active=row["status"] in ACTIVE,
        can_cancel=row["status"] == "queued" and bool(row["hf_request_id"]),
    )


def get_owned(workspace_id: str, generation_id: str) -> dict[str, Any]:
    row = db.fetch_one(
        "SELECT * FROM generations WHERE id = ? AND workspace_id = ?", (generation_id, workspace_id)
    )
    if not row:
        # Same response whether it doesn't exist or belongs to someone else.
        raise HTTPException(status_code=404, detail="Generation not found")
    return row


def list_generations(workspace_id: str, limit: int = 50) -> list[dict[str, Any]]:
    return db.fetch_all(
        "SELECT * FROM generations WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?",
        (workspace_id, limit),
    )


def _update(generation_id: str, **fields: Any) -> None:
    fields["updated_at"] = db.now()
    cols = ", ".join(f"{k} = ?" for k in fields)
    with db.tx() as conn:
        conn.execute(f"UPDATE generations SET {cols} WHERE id = ?", (*fields.values(), generation_id))


def _webhook_url(generation_id: str, token: str) -> str | None:
    base = get_settings().public_webhook_base_url.rstrip("/")
    if not base.startswith("https://"):
        return None
    return f"{base}/api/webhooks/higgsfield/{generation_id}/{token}"


async def create_generation(workspace_id: str, body: CreateGeneration, idempotency_key: str) -> tuple[dict[str, Any], bool]:
    """Returns (row, created). Replaying an Idempotency-Key returns the original job."""
    if not _IDEMPOTENCY_RE.match(idempotency_key or ""):
        raise HTTPException(status_code=400, detail="Idempotency-Key header must be 8-100 chars of [A-Za-z0-9_-]")

    existing = db.fetch_one(
        "SELECT * FROM generations WHERE workspace_id = ? AND idempotency_key = ?", (workspace_id, idempotency_key)
    )
    if existing:
        return existing, False

    api_key = get_api_key(workspace_id)
    if not api_key:
        raise HTTPException(status_code=400, detail="Save your Higgsfield API key before generating.")

    settings = get_settings()
    generation_id = str(uuid.uuid4())
    token = uuid.uuid4().hex
    arguments = body.input.model_dump()
    now = db.now()
    try:
        with db.tx() as conn:
            conn.execute(
                """INSERT INTO generations (id, workspace_id, idempotency_key, model, arguments_json, status,
                       webhook_token, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, 'submitting', ?, ?, ?)""",
                (generation_id, workspace_id, idempotency_key, body.model, json.dumps(arguments), token, now, now),
            )
    except sqlite3.IntegrityError:
        # Concurrent request with the same Idempotency-Key won the race.
        row = db.fetch_one(
            "SELECT * FROM generations WHERE workspace_id = ? AND idempotency_key = ?", (workspace_id, idempotency_key)
        )
        assert row is not None
        return row, False

    try:
        submission = await higgsfield.gateway.submit(api_key, body.model, arguments, _webhook_url(generation_id, token))
    except HFError as err:
        log.warning("submit %s failed kind=%s http=%s corr=%s", generation_id, err.kind, err.http_status, err.correlation_id)
        if err.kind == "ambiguous":
            _update(generation_id, status="submission_unknown", error=UNKNOWN_MSG.format(detail=err.message),
                    correlation_id=err.correlation_id)
        else:
            if err.kind == "auth":
                _mark_key_unverified(workspace_id)
            _update(generation_id, status="rejected", error=err.message, correlation_id=err.correlation_id,
                    finished_at=db.now())
        return get_owned(workspace_id, generation_id), True

    now = db.now()
    _update(
        generation_id,
        status="queued",
        hf_request_id=submission.request_id,
        poll_delay=2.0,
        next_poll_at=now + 2.0,
        poll_deadline=now + settings.generation_timeout_seconds,
    )
    log.info("submitted %s request_id=%s", generation_id, submission.request_id)
    return get_owned(workspace_id, generation_id), True


async def cancel_generation(workspace_id: str, generation_id: str) -> dict[str, Any]:
    row = get_owned(workspace_id, generation_id)
    if row["status"] != "queued" or not row["hf_request_id"]:
        raise HTTPException(status_code=409, detail="Only queued generations can be canceled.")
    api_key = get_api_key(workspace_id)
    if not api_key:
        raise HTTPException(status_code=400, detail="No API key saved.")
    try:
        await higgsfield.gateway.cancel(api_key, row["hf_request_id"])
    except HFError as err:
        if err.http_status == 400:
            raise HTTPException(status_code=409, detail="Generation already started and can no longer be canceled.")
        raise HTTPException(status_code=502, detail=err.message)
    _update(generation_id, status="canceled", finished_at=db.now())
    return get_owned(workspace_id, generation_id)


def delete_generation(workspace_id: str, generation_id: str) -> None:
    row = get_owned(workspace_id, generation_id)
    if row["status"] in ACTIVE:
        raise HTTPException(status_code=409, detail="Cannot remove a generation that is still running.")
    with db.tx() as conn:
        conn.execute("DELETE FROM generations WHERE id = ? AND workspace_id = ?", (generation_id, workspace_id))


async def refresh_generation(workspace_id: str, generation_id: str) -> dict[str, Any]:
    """Re-arm polling for a timed-out/stalled job and poll it once right now."""
    row = get_owned(workspace_id, generation_id)
    if row["status"] not in REFRESHABLE or not row["hf_request_id"]:
        raise HTTPException(status_code=409, detail="This generation cannot be refreshed.")
    now = db.now()
    fields: dict[str, Any] = {"next_poll_at": now, "poll_delay": 2.0}
    if row["status"] in ("timed_out", "stalled"):
        fields.update(status="queued", error=None, poll_deadline=now + get_settings().generation_timeout_seconds)
    _update(generation_id, **fields)
    await poll_one(generation_id)
    return get_owned(workspace_id, generation_id)


def nudge_from_webhook(generation_id: str, token: str, request_id: str) -> bool:
    """Webhook payloads are unauthenticated, so they only trigger an authenticated re-poll."""
    import hmac

    row = db.fetch_one("SELECT webhook_token, hf_request_id, status FROM generations WHERE id = ?", (generation_id,))
    if not row or not hmac.compare_digest(row["webhook_token"], token) or row["hf_request_id"] != request_id:
        return False
    if row["status"] in POLLABLE:
        _update(generation_id, next_poll_at=db.now())
    return True


# ---------------------------------------------------------------- polling


async def poll_one(generation_id: str) -> None:
    row = db.fetch_one("SELECT * FROM generations WHERE id = ?", (generation_id,))
    if not row or row["status"] not in POLLABLE:
        return
    now = db.now()
    if row["poll_deadline"] and now > row["poll_deadline"]:
        _update(generation_id, status="timed_out", next_poll_at=None,
                error="Stopped waiting locally (timeout). The job was not resubmitted; use Refresh to check again.")
        return

    api_key = get_api_key(row["workspace_id"])
    if not api_key:
        _update(generation_id, status="stalled", next_poll_at=None, error="No usable API key saved; save it and refresh.")
        return

    request_id = row["hf_request_id"]
    try:
        remote = await higgsfield.gateway.status(api_key, request_id)
        if remote in TERMINAL_REMOTE:
            body = await higgsfield.gateway.result(api_key, request_id)
            video = body.get("video") or {}
            error = body.get("error")
            if remote == "nsfw" and not error:
                error = "Rejected by content moderation (not charged)."
            elif remote == "failed" and not error:
                error = "Generation failed (not charged)."
            _update(generation_id, status=remote, video_url=video.get("url"), output_json=json.dumps(body),
                    error=error, next_poll_at=None, finished_at=db.now())
            log.info("generation %s finished status=%s", generation_id, remote)
            return
        delay = min(row["poll_delay"] * 1.5, 10.0)
        _update(generation_id, status=remote, poll_delay=delay, next_poll_at=now + delay + random.uniform(0, 0.5))
    except HFError as err:
        if err.kind in ("auth", "not_found", "rejected"):
            if err.kind == "auth":
                _mark_key_unverified(row["workspace_id"])
            _update(generation_id, status="stalled", next_poll_at=None, error=f"Polling stopped: {err.message}",
                    correlation_id=err.correlation_id)
        else:
            delay = min(row["poll_delay"] * 2, 30.0)
            _update(generation_id, poll_delay=delay, next_poll_at=now + delay + random.uniform(0, 1))
            log.info("transient poll error for %s: %s (retry in %.0fs)", generation_id, err.message, delay)


def due_for_poll(limit: int = 25) -> list[str]:
    rows = db.fetch_all(
        "SELECT id FROM generations WHERE status IN ('queued','in_progress') AND next_poll_at <= ? "
        "ORDER BY next_poll_at LIMIT ?",
        (db.now(), limit),
    )
    return [r["id"] for r in rows]


def recover_orphaned_submissions() -> int:
    """On startup, any row still 'submitting' lost its in-flight POST: outcome unknown."""
    with db.tx() as conn:
        cur = conn.execute(
            "UPDATE generations SET status = 'submission_unknown', error = ?, updated_at = ? WHERE status = 'submitting'",
            (UNKNOWN_MSG.format(detail="server restarted mid-submission"), db.now()),
        )
        return cur.rowcount
