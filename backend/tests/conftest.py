import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app import db, higgsfield, service
from app.config import get_settings
from app.crypto import _fernet
from app.higgsfield import HFError, Submission


class FakeGateway:
    def __init__(self) -> None:
        self.submits: list[tuple[str, str, dict, str | None]] = []
        self.submit_error: HFError | None = None
        self.statuses: dict[str, list[str]] = {}
        self.results: dict[str, dict] = {}
        self.verify_result: bool | None = True
        self.canceled: list[str] = []

    async def submit(self, api_key, model, arguments, webhook_url):
        self.submits.append((api_key, model, arguments, webhook_url))
        if self.submit_error:
            raise self.submit_error
        rid = f"00000000-0000-0000-0000-{len(self.submits):012d}"
        self.statuses[rid] = ["in_progress", "completed"]
        self.results[rid] = {"status": "completed", "request_id": rid, "video": {"url": f"https://cdn.test/{rid}.mp4"}}
        return Submission(request_id=rid)

    async def status(self, api_key, request_id):
        seq = self.statuses[request_id]
        return seq.pop(0) if len(seq) > 1 else seq[0]

    async def result(self, api_key, request_id):
        return self.results[request_id]

    async def cancel(self, api_key, request_id):
        self.canceled.append(request_id)

    async def verify_credentials(self, api_key):
        return self.verify_result


@pytest.fixture
def fake(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("APP_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("PUBLIC_WEBHOOK_BASE_URL", "")
    get_settings.cache_clear()
    _fernet.cache_clear()
    db.close()
    gw = FakeGateway()
    monkeypatch.setattr(higgsfield, "gateway", gw)
    yield gw
    db.close()
    get_settings.cache_clear()
    _fernet.cache_clear()


@pytest.fixture
def client(fake):
    from app.main import app

    with TestClient(app, headers={"X-Requested-With": "video-gen"}) as c:
        # Stop the background poller so tests drive polling deterministically.
        c.portal.call(app.state.poller.stop)
        yield c


def poll(client, gid: str) -> None:
    client.portal.call(service.poll_one, gid)
