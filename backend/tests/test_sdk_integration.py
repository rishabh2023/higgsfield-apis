"""Exercises the real higgsfield-client SDK against a mocked HTTP transport (no network)."""

import httpx
import pytest

from app import higgsfield as hf


def _install(client, handler):
    client.__dict__["_client"] = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="https://api.higgsfield.ai",
        headers={"Authorization": "Key id:secret"},
    )
    client.__dict__.pop("_transport", None)


@pytest.fixture(autouse=True)
def _fresh_cache():
    hf._clients.clear()
    yield
    hf._clients.clear()


async def test_submit_is_never_retried_on_5xx():
    calls = []

    def handler(req):
        calls.append(req)
        return httpx.Response(502, json={"detail": "bad gateway"}, headers={"X-Correlation-ID": "c-9"})

    submit_client, _ = hf._clients.get("id:secret")
    _install(submit_client, handler)
    with pytest.raises(hf.HFError) as ei:
        await hf.gateway.submit("id:secret", "bytedance/seedance-2.0/text-to-video", {"prompt": "x"}, None)
    assert len(calls) == 1
    assert ei.value.kind == "ambiguous" and ei.value.correlation_id == "c-9"


async def test_submit_success_sends_expected_request():
    seen = {}

    def handler(req):
        seen["url"], seen["body"], seen["auth"] = str(req.url), req.content, req.headers["authorization"]
        rid = "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff"
        return httpx.Response(200, json={"status": "queued", "request_id": rid,
                                         "status_url": f"https://api.higgsfield.ai/requests/{rid}/status",
                                         "cancel_url": f"https://api.higgsfield.ai/requests/{rid}/cancel"})

    submit_client, _ = hf._clients.get("id:secret")
    _install(submit_client, handler)
    sub = await hf.gateway.submit("id:secret", "bytedance/seedance-2.0/text-to-video", {"prompt": "hi"},
                                  "https://example.com/hook")
    assert sub.request_id.startswith("d7e6c0f3")
    assert seen["url"].startswith("https://api.higgsfield.ai/bytedance/seedance-2.0/text-to-video?hf_webhook=")
    assert seen["auth"] == "Key id:secret"


@pytest.mark.parametrize("code,kind", [(400, "rejected"), (401, "auth"), (403, "rejected"), (422, "rejected"),
                                       (503, "rejected"), (500, "ambiguous"), (504, "ambiguous")])
async def test_submit_error_classification(code, kind):
    submit_client, _ = hf._clients.get("id:secret")
    _install(submit_client, lambda req: httpx.Response(code, json={"detail": "x"}))
    with pytest.raises(hf.HFError) as ei:
        await hf.gateway.submit("id:secret", "m", {"prompt": "x"}, None)
    assert ei.value.kind == kind and ei.value.http_status == code


async def test_submit_read_timeout_is_ambiguous():
    def handler(req):
        raise httpx.ReadTimeout("timed out", request=req)

    submit_client, _ = hf._clients.get("id:secret")
    _install(submit_client, handler)
    with pytest.raises(hf.HFError) as ei:
        await hf.gateway.submit("id:secret", "m", {"prompt": "x"}, None)
    assert ei.value.kind == "ambiguous"


async def test_status_polling_retries_5xx_then_succeeds():
    calls = []

    def handler(req):
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(503, json={"detail": "busy"})
        return httpx.Response(200, json={"status": "in_progress", "request_id": "r"})

    _, poll_client = hf._clients.get("id:secret")
    _install(poll_client, handler)
    assert await hf.gateway.status("id:secret", "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff") == "in_progress"
    assert len(calls) == 3


@pytest.mark.parametrize("code,expected", [(404, True), (401, False), (500, None)])
async def test_verify_credentials(code, expected):
    _, poll_client = hf._clients.get("id:secret")
    _install(poll_client, lambda req: httpx.Response(code, json={"detail": "x"}))
    assert await hf.gateway.verify_credentials("id:secret") is expected
