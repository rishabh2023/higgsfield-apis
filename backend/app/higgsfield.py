"""Thin wrapper over the official Higgsfield Python SDK (higgsfield-client).

Why a wrapper:
* Credentials are per workspace (saved from the UI), so we build SDK clients with an
  explicit ``api_key`` instead of the process-wide ``HF_KEY`` env var.
* The SDK's default transport retries *every* request on 408/429/5xx, including the
  generation POST. Submissions have no idempotency key, so a retried POST after an
  ambiguous failure could create (and bill) a duplicate video. Submissions therefore
  go through a client using the SDK's ``NoRetry`` strategy; status polling keeps the
  SDK's default exponential-backoff retries.
* SDK errors carry only a message; we recover the HTTP status and X-Correlation-ID
  from the chained ``httpx.HTTPStatusError`` to classify them.
"""

from __future__ import annotations

import hashlib
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from functools import cached_property
from typing import Any

import httpx
import higgsfield_client
from higgsfield_client import HiggsfieldClientError
from higgsfield_client.http.retry import NoRetry
from higgsfield_client.http.transport import AsyncHttpTransport

TERMINAL_REMOTE = {"completed", "failed", "nsfw", "canceled"}
_STATUS_NAMES = {
    higgsfield_client.Queued: "queued",
    higgsfield_client.InProgress: "in_progress",
    higgsfield_client.Completed: "completed",
    higgsfield_client.Failed: "failed",
    higgsfield_client.NSFW: "nsfw",
    higgsfield_client.Cancelled: "canceled",
}

# Submission failures where Higgsfield may or may not have accepted the request.
_AMBIGUOUS_HTTP = {408, 500, 502, 504}


class _SubmitClient(higgsfield_client.AsyncClient):
    """SDK AsyncClient whose transport never retries (used only for generation POSTs)."""

    @cached_property
    def _transport(self) -> AsyncHttpTransport:  # type: ignore[override]
        return AsyncHttpTransport(self._client, NoRetry())


@dataclass
class HFError(Exception):
    kind: str  # "rejected" | "ambiguous" | "auth" | "not_found" | "transient"
    message: str
    http_status: int | None = None
    correlation_id: str | None = None

    def __str__(self) -> str:
        return self.message


def _classify(exc: Exception, *, submitting: bool) -> HFError:
    if isinstance(exc, HiggsfieldClientError) and isinstance(exc.__cause__, httpx.HTTPStatusError):
        resp = exc.__cause__.response
        code = resp.status_code
        corr = resp.headers.get("x-correlation-id")
        msg = _friendly(code, str(exc))
        if code == 401:
            return HFError("auth", msg, code, corr)
        if code == 404 and not submitting:
            return HFError("not_found", msg, code, corr)
        if submitting:
            kind = "ambiguous" if code in _AMBIGUOUS_HTTP else "rejected"
        else:
            kind = "transient" if code >= 500 or code in (408, 429) else "rejected"
        return HFError(kind, msg, code, corr)

    if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout)):
        # Connection never established: the request was not sent.
        return HFError("rejected" if submitting else "transient", "Could not reach the Higgsfield API.")
    if isinstance(exc, httpx.TransportError):
        # Timeout / dropped connection after sending: outcome unknown.
        return HFError(
            "ambiguous" if submitting else "transient",
            f"Network error talking to Higgsfield ({type(exc).__name__}).",
        )
    if isinstance(exc, (KeyError, ValueError)):
        return HFError("ambiguous" if submitting else "transient", "Unexpected response from Higgsfield.")
    return HFError("ambiguous" if submitting else "transient", f"Unexpected error: {type(exc).__name__}")


def _friendly(code: int, detail: str) -> str:
    prefix = {
        400: "Higgsfield rejected the request",
        401: "Invalid Higgsfield API credentials",
        403: "Insufficient Higgsfield credits",
        404: "Not found for this Higgsfield account",
        422: "Invalid generation parameters",
        423: "Model is temporarily blocked — try later",
        429: "Rate limited by Higgsfield — try later",
        503: "Model is disabled or not ready — try later",
    }.get(code, f"Higgsfield returned HTTP {code}")
    detail = (detail or "").strip()
    if len(detail) > 300:
        detail = detail[:300] + "…"
    return f"{prefix}: {detail}" if detail else prefix


class _ClientCache:
    """Reuse SDK clients (and their connection pools) per credential, bounded LRU."""

    def __init__(self, size: int = 32) -> None:
        self._size = size
        self._items: OrderedDict[str, tuple[_SubmitClient, higgsfield_client.AsyncClient]] = OrderedDict()

    def get(self, api_key: str) -> tuple[_SubmitClient, higgsfield_client.AsyncClient]:
        k = hashlib.sha256(api_key.encode()).hexdigest()
        if k in self._items:
            self._items.move_to_end(k)
            return self._items[k]
        pair = (_SubmitClient(api_key=api_key), higgsfield_client.AsyncClient(api_key=api_key))
        self._items[k] = pair
        while len(self._items) > self._size:
            self._items.popitem(last=False)  # GC closes idle pools
        return pair

    def clear(self) -> None:
        self._items.clear()


_clients = _ClientCache()


@dataclass
class Submission:
    request_id: str


class HiggsfieldGateway:
    """Operations the app needs. Swapped for a fake in tests."""

    async def submit(self, api_key: str, model: str, arguments: dict[str, Any], webhook_url: str | None) -> Submission:
        submit_client, _ = _clients.get(api_key)
        try:
            controller = await submit_client.submit(model, arguments, webhook_url=webhook_url)
        except Exception as exc:  # noqa: BLE001 - classified below
            raise _classify(exc, submitting=True) from exc
        return Submission(request_id=controller.request_id)

    async def status(self, api_key: str, request_id: str) -> str:
        _, client = _clients.get(api_key)
        try:
            st = await client.status(request_id)
        except Exception as exc:  # noqa: BLE001
            raise _classify(exc, submitting=False) from exc
        return _STATUS_NAMES.get(type(st), "in_progress")

    async def result(self, api_key: str, request_id: str) -> dict[str, Any]:
        """Full status body. Only call once status() reported a terminal state."""
        _, client = _clients.get(api_key)
        try:
            return await client.result(request_id)
        except Exception as exc:  # noqa: BLE001
            raise _classify(exc, submitting=False) from exc

    async def cancel(self, api_key: str, request_id: str) -> None:
        _, client = _clients.get(api_key)
        try:
            await client.cancel(request_id)
        except Exception as exc:  # noqa: BLE001
            raise _classify(exc, submitting=False) from exc

    async def verify_credentials(self, api_key: str) -> bool | None:
        """Cheap, non-billable check: look up a random request ID.

        404 => credentials accepted (the request just doesn't exist); 401 => invalid.
        Returns None when the check itself was inconclusive (network / 5xx).
        """
        try:
            await self.status(api_key, str(uuid.uuid4()))
        except HFError as err:
            if err.kind == "not_found":
                return True
            if err.kind == "auth":
                return False
            return None
        return True


gateway: HiggsfieldGateway = HiggsfieldGateway()
