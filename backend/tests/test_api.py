import uuid

from fastapi.testclient import TestClient

from app import db
from app.higgsfield import HFError
from tests.conftest import poll

BODY = {"input": {"prompt": "A cinematic tracking shot along a sunlit coastal road", "resolution": "720p",
                  "generate_audio": True, "duration": 5, "aspect_ratio": "16:9"}}


def save_key(client, key_id="KEYID1234abcd", secret="s3cr3tvalue"):
    return client.put("/api/settings/api-key", json={"key_id": key_id, "key_secret": secret})


def idem() -> dict:
    return {"Idempotency-Key": uuid.uuid4().hex}


def test_key_is_saved_encrypted_and_never_returned(client):
    assert client.get("/api/settings/api-key").json()["configured"] is False
    r = save_key(client)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data == {"configured": True, "key_hint": "••••abcd", "verified": True, "usable": True, "warning": None}
    assert "s3cr3tvalue" not in r.text
    raw = db.fetch_one("SELECT encrypted_key FROM credentials")["encrypted_key"]
    assert b"s3cr3tvalue" not in raw and b"KEYID1234abcd" not in raw


def test_invalid_key_is_not_saved(client, fake):
    fake.verify_result = False
    assert save_key(client).status_code == 400
    assert client.get("/api/settings/api-key").json()["configured"] is False


def test_mutations_require_csrf_header(fake):
    from app.main import app

    with TestClient(app) as c:
        r = c.put("/api/settings/api-key", json={"key_id": "abcd1234", "key_secret": "abcd1234"})
        assert r.status_code == 403


def test_generate_requires_key(client):
    r = client.post("/api/generations", json=BODY, headers=idem())
    assert r.status_code == 400 and "API key" in r.json()["detail"]


def test_input_validation_mirrors_model_schema(client):
    save_key(client)
    for bad in ({"prompt": "   "}, {"prompt": "x", "duration": 3}, {"prompt": "x", "duration": 16},
                {"prompt": "x", "resolution": "2k"}, {"prompt": "x", "aspect_ratio": "2:1"}, {"prompt": "x", "seed": 1}):
        assert client.post("/api/generations", json={"input": bad}, headers=idem()).status_code == 422, bad


def test_full_lifecycle_uses_saved_key(client, fake):
    save_key(client)
    r = client.post("/api/generations", json=BODY, headers=idem())
    assert r.status_code == 201, r.text
    job = r.json()
    assert job["status"] == "queued" and job["is_active"] and job["can_cancel"]
    api_key, model, args, webhook = fake.submits[0]
    assert api_key == "KEYID1234abcd:s3cr3tvalue"
    assert model == "bytedance/seedance-2.0/text-to-video"
    assert args == BODY["input"] and webhook is None

    poll(client, job["id"])
    assert client.get(f"/api/generations/{job['id']}").json()["status"] == "in_progress"
    poll(client, job["id"])
    done = client.get(f"/api/generations/{job['id']}").json()
    assert done["status"] == "completed" and done["video_url"].endswith(".mp4") and not done["is_active"]


def test_idempotency_key_prevents_duplicate_submission(client, fake):
    save_key(client)
    h = idem()
    a = client.post("/api/generations", json=BODY, headers=h)
    b = client.post("/api/generations", json=BODY, headers=h)
    assert a.status_code == 201 and b.status_code == 200
    assert a.json()["id"] == b.json()["id"]
    assert len(fake.submits) == 1


def test_ambiguous_submit_is_not_resubmitted(client, fake):
    save_key(client)
    fake.submit_error = HFError("ambiguous", "Network error talking to Higgsfield (ReadTimeout).")
    h = idem()
    job = client.post("/api/generations", json=BODY, headers=h).json()
    assert job["status"] == "submission_unknown" and "NOT resubmitted" in job["error"]
    # Replay (e.g. browser retry) returns the same record, no second POST upstream.
    assert client.post("/api/generations", json=BODY, headers=h).json()["id"] == job["id"]
    assert len(fake.submits) == 1
    assert client.post(f"/api/generations/{job['id']}/refresh").status_code == 409


def test_definite_rejection(client, fake):
    save_key(client)
    fake.submit_error = HFError("rejected", "Insufficient Higgsfield credits: nope", 403, "corr-1")
    job = client.post("/api/generations", json=BODY, headers=idem()).json()
    assert job["status"] == "rejected" and job["correlation_id"] == "corr-1" and not job["is_active"]


def test_other_workspace_cannot_access_jobs(client, fake):
    from app.main import app

    save_key(client)
    job = client.post("/api/generations", json=BODY, headers=idem()).json()
    with TestClient(app, headers={"X-Requested-With": "video-gen"}) as other:
        assert other.get(f"/api/generations/{job['id']}").status_code == 404
        assert other.post(f"/api/generations/{job['id']}/cancel").status_code == 404
        assert other.get("/api/generations").json() == []
        assert other.get("/api/settings/api-key").json()["configured"] is False


def test_cancel_only_when_queued(client, fake):
    save_key(client)
    job = client.post("/api/generations", json=BODY, headers=idem()).json()
    r = client.post(f"/api/generations/{job['id']}/cancel")
    assert r.status_code == 200 and r.json()["status"] == "canceled"
    assert fake.canceled == [job["request_id"]]
    assert client.post(f"/api/generations/{job['id']}/cancel").status_code == 409


def test_poll_auth_failure_stalls_then_refresh_recovers(client, fake):
    save_key(client)
    job = client.post("/api/generations", json=BODY, headers=idem()).json()
    orig = fake.status

    async def boom(api_key, rid):
        raise HFError("auth", "Invalid Higgsfield API credentials", 401)

    fake.status = boom
    poll(client, job["id"])
    assert client.get(f"/api/generations/{job['id']}").json()["status"] == "stalled"
    fake.status = orig
    r = client.post(f"/api/generations/{job['id']}/refresh")
    assert r.status_code == 200 and r.json()["status"] in ("queued", "in_progress")


def test_transient_poll_error_backs_off(client, fake):
    save_key(client)
    job = client.post("/api/generations", json=BODY, headers=idem()).json()

    async def flaky(api_key, rid):
        raise HFError("transient", "HTTP 502", 502)

    fake.status = flaky
    poll(client, job["id"])
    row = db.fetch_one("SELECT status, poll_delay FROM generations WHERE id = ?", (job["id"],))
    assert row["status"] == "queued" and row["poll_delay"] == 4.0


def test_local_timeout(client, fake):
    save_key(client)
    job = client.post("/api/generations", json=BODY, headers=idem()).json()
    with db.tx() as conn:
        conn.execute("UPDATE generations SET poll_deadline = 1 WHERE id = ?", (job["id"],))
    poll(client, job["id"])
    assert client.get(f"/api/generations/{job['id']}").json()["status"] == "timed_out"
    assert len(fake.submits) == 1


def test_webhook_only_nudges_with_valid_token(client, fake):
    save_key(client)
    job = client.post("/api/generations", json=BODY, headers=idem()).json()
    token = db.fetch_one("SELECT webhook_token FROM generations WHERE id = ?", (job["id"],))["webhook_token"]
    env = {"request_id": job["request_id"], "status": "completed", "error": None, "payload": {"video": {"url": "https://evil"}}}
    assert client.post(f"/api/webhooks/higgsfield/{job['id']}/wrong", json=env).status_code == 404
    assert client.post(f"/api/webhooks/higgsfield/{job['id']}/{token}", json=env).status_code == 200
    # Payload URL is never trusted; state only changes via authenticated polling.
    assert client.get(f"/api/generations/{job['id']}").json()["video_url"] is None
