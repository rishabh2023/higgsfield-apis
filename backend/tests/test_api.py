import io
import uuid

from fastapi.testclient import TestClient

from app import db
from app.higgsfield import HFError
from tests.conftest import MP4, PNG, WAV, drain_downloads, poll

T2V = "bytedance/seedance-2.0/text-to-video"
PARAMS = {"resolution": "720p", "generate_audio": True, "duration": 5, "aspect_ratio": "16:9"}
PROMPT = "A cinematic tracking shot along a sunlit coastal road"


def save_key(client, key_id="KEYID1234abcd", secret="s3cr3tvalue"):
    return client.put("/api/settings/api-key", json={"key_id": key_id, "key_secret": secret})


def idem() -> dict:
    return {"Idempotency-Key": uuid.uuid4().hex}


def new_project(client, name="Launch film") -> str:
    r = client.post("/api/projects", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def generate(client, pid, body=None, headers=None):
    body = body or {"model": T2V, "prompt": PROMPT, "params": PARAMS}
    return client.post(f"/api/projects/{pid}/generations", json=body, headers=headers or idem())


def upload(client, pid, data, name):
    return client.post(f"/api/projects/{pid}/assets", files={"file": (name, io.BytesIO(data), "application/octet-stream")})


def complete(client, gid):
    poll(client, gid)  # in_progress
    poll(client, gid)  # completed -> output registered + download scheduled
    drain_downloads(client)
    return client.get(f"/api/generations/{gid}").json()


# ------------------------------------------------------------------ credentials


def test_key_is_saved_encrypted_and_never_returned(client):
    assert client.get("/api/settings/api-key").json()["configured"] is False
    r = save_key(client)
    assert r.status_code == 200, r.text
    assert r.json() == {"configured": True, "key_hint": "••••abcd", "verified": True, "usable": True, "warning": None}
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
        assert c.post("/api/projects", json={"name": "x"}).status_code == 403


# ------------------------------------------------------------------ catalog + validation


def test_catalog_lists_modes_and_models(client):
    data = client.get("/api/models").json()
    assert {m["id"] for m in data["modes"]} == {"text", "image", "reference", "edit", "extend"}
    ids = {m["id"] for m in data["models"]}
    assert {"bytedance/seedance-2.5/video-edit", "kling-video/o3/video-edit", "bytedance/seedance-2.5/video-extend"} <= ids


def test_generate_requires_key(client):
    pid = new_project(client)
    r = generate(client, pid)
    assert r.status_code == 400 and "API key" in r.json()["detail"]


def test_input_validation_follows_model_spec(client):
    save_key(client)
    pid = new_project(client)
    bad = [
        {"model": T2V, "prompt": "   ", "params": {}},
        {"model": T2V, "prompt": "x", "params": {"duration": 3}},
        {"model": T2V, "prompt": "x", "params": {"duration": 16}},
        {"model": T2V, "prompt": "x", "params": {"resolution": "2k"}},
        {"model": T2V, "prompt": "x", "params": {"seed": 1}},
        {"model": T2V, "prompt": "x", "media": {"image_urls": ["a"]}},
        {"model": "nope/model", "prompt": "x"},
        {"model": "bytedance/seedance-2.5/video-edit", "prompt": "make it snow"},  # missing source video
        {"model": "bytedance/seedance-2.0/reference-to-video", "prompt": "x"},    # needs a reference
        {"model": "bytedance/seedance-2.5/text-to-video", "prompt": "x", "params": {"resolution": "1080p"}},
    ]
    for body in bad:
        assert generate(client, pid, body).status_code == 422, body


# ------------------------------------------------------------------ projects + assets


def test_projects_crud_and_isolation(client, fake):
    from app.main import app

    pid = new_project(client, "Ad spot")
    assert client.patch(f"/api/projects/{pid}", json={"name": "Ad spot v2"}).json()["name"] == "Ad spot v2"
    assert [p["name"] for p in client.get("/api/projects").json()] == ["Ad spot v2"]
    with TestClient(app, headers={"X-Requested-With": "video-gen"}) as other:
        assert other.get(f"/api/projects/{pid}").status_code == 404
        assert other.get(f"/api/projects/{pid}/generations").status_code == 404
        assert upload(other, pid, PNG, "x.png").status_code == 404
    assert client.delete(f"/api/projects/{pid}").status_code == 204
    assert client.get("/api/projects").json() == []


def test_upload_sniffs_type_and_serves_file(client):
    pid = new_project(client)
    img = upload(client, pid, PNG, "look.png").json()
    vid = upload(client, pid, MP4, "clip.mp4").json()
    aud = upload(client, pid, WAV, "vo.wav").json()
    assert (img["kind"], vid["kind"], aud["kind"]) == ("image", "video", "audio")
    assert img["in_library"] is True
    # Content is identified by bytes, not by the filename.
    assert upload(client, pid, b"hello world, not media", "fake.mp4").status_code == 400
    mov = b"\x00\x00\x00\x14ftypqt  " + b"\x00" * 32
    assert "MP4" in upload(client, pid, mov, "clip.mov").json()["detail"]
    r = client.get(vid["url"])
    assert r.status_code == 200 and r.content == MP4 and r.headers["content-type"] == "video/mp4"
    assert len(client.get(f"/api/projects/{pid}/assets?scope=library").json()) == 3


def test_asset_kind_must_match_slot(client, fake):
    save_key(client)
    pid = new_project(client)
    img = upload(client, pid, PNG, "look.png").json()
    r = generate(client, pid, {"model": "bytedance/seedance-2.5/video-edit", "prompt": "x",
                               "media": {"video_url": [img["id"]]}})
    assert r.status_code == 422 and "expected video" in r.json()["detail"]


# ------------------------------------------------------------------ generation lifecycle


def test_text_to_video_lifecycle_saves_output_locally(client, fake):
    save_key(client)
    pid = new_project(client)
    r = generate(client, pid)
    assert r.status_code == 201, r.text
    job = r.json()
    assert job["status"] == "queued" and job["is_active"] and job["can_cancel"]
    api_key, model, args, webhook = fake.submits[0]
    assert api_key == "KEYID1234abcd:s3cr3tvalue" and model == T2V
    assert args == {**PARAMS, "prompt": PROMPT} and webhook is None

    done = complete(client, job["id"])
    assert done["status"] == "completed" and not done["is_active"]
    out = done["output"]
    assert out["status"] == "ready" and out["kind"] == "video" and out["in_library"] is False
    assert client.get(out["url"]).content == MP4  # served from local storage, not the CDN
    assert client.get(f"/api/projects/{pid}").json()["cover_url"] == out["url"]


def test_output_falls_back_to_cdn_while_download_fails(client, fake):
    save_key(client)
    pid = new_project(client)
    fake.download_error = HFError("rejected", "403 from CDN")
    done = complete(client, generate(client, pid).json()["id"])
    assert done["output"]["status"] == "download_failed"
    r = client.get(done["output"]["url"], follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"].startswith("https://cdn.test/")


def test_edit_a_generated_video_reuses_its_url(client, fake):
    save_key(client)
    pid = new_project(client)
    first = complete(client, generate(client, pid).json()["id"])
    src = first["output"]["id"]

    r = generate(client, pid, {"model": "bytedance/seedance-2.5/video-edit", "prompt": "Make it snow",
                               "params": {"resolution": "720p"}, "media": {"video_url": [src]}})
    assert r.status_code == 201, r.text
    _, model, args, _ = fake.submits[-1]
    assert model == "bytedance/seedance-2.5/video-edit"
    assert args["video_url"] == first["remote_video_url"] and "duration" not in args
    assert fake.uploads == []  # still-valid CDN URL reused, nothing re-uploaded
    assert r.json()["media"]["video_url"][0]["id"] == src


def test_expired_output_is_reuploaded_from_local_copy(client, fake):
    save_key(client)
    pid = new_project(client)
    src = complete(client, generate(client, pid).json()["id"])["output"]["id"]
    fake.alive = False
    r = generate(client, pid, {"model": "bytedance/seedance-2.5/video-extend", "prompt": "Keep driving",
                               "params": {"duration": 8}, "media": {"video_url": [src]}})
    assert r.status_code == 201, r.text
    assert fake.uploads == [("video/mp4", len(MP4))]
    assert fake.submits[-1][2]["video_url"] == "https://upload.test/1"


def test_reference_to_video_uploads_library_files(client, fake):
    save_key(client)
    pid = new_project(client)
    img = upload(client, pid, PNG, "hero.png").json()["id"]
    vid = upload(client, pid, MP4, "motion.mp4").json()["id"]
    r = generate(client, pid, {"model": "bytedance/seedance-2.0/reference-to-video", "prompt": "Hero runs",
                               "params": {"duration": 6}, "media": {"image_urls": [img], "video_urls": [vid]}})
    assert r.status_code == 201, r.text
    args = fake.submits[-1][2]
    assert args["image_urls"] == ["https://upload.test/1"] and args["video_urls"] == ["https://upload.test/2"]
    # A second generation reuses the (still alive) uploaded URLs.
    generate(client, pid, {"model": "bytedance/seedance-2.0/reference-to-video", "prompt": "Again",
                           "media": {"image_urls": [img]}})
    assert len(fake.uploads) == 2


def test_upload_failure_rejects_without_submitting(client, fake):
    save_key(client)
    pid = new_project(client)
    img = upload(client, pid, PNG, "start.png").json()["id"]

    async def broken(*a):
        raise HFError("transient", "storage unavailable")

    fake.upload = broken
    job = generate(client, pid, {"model": "bytedance/seedance-2.0/image-to-video",
                                 "media": {"image_url": [img]}}).json()
    assert job["status"] == "rejected" and "reference files" in job["error"]
    assert fake.submits == []


def test_add_output_to_references_and_delete_generation_keeps_it(client, fake):
    save_key(client)
    pid = new_project(client)
    done = complete(client, generate(client, pid).json()["id"])
    out = done["output"]["id"]
    assert client.patch(f"/api/assets/{out}", json={"in_library": True}).json()["in_library"] is True
    assert client.delete(f"/api/generations/{done['id']}").status_code == 204
    lib = client.get(f"/api/projects/{pid}/assets?scope=library").json()
    assert [a["id"] for a in lib] == [out] and client.get(lib[0]["url"]).status_code == 200


def test_delete_generation_removes_unreferenced_output(client, fake):
    save_key(client)
    pid = new_project(client)
    done = complete(client, generate(client, pid).json()["id"])
    assert client.delete(f"/api/generations/{done['id']}").status_code == 204
    assert client.get(done["output"]["url"]).status_code == 404


# ------------------------------------------------------------------ safety properties (unchanged)


def test_idempotency_key_prevents_duplicate_submission(client, fake):
    save_key(client)
    pid = new_project(client)
    h = idem()
    a, b = generate(client, pid, headers=h), generate(client, pid, headers=h)
    assert (a.status_code, b.status_code) == (201, 200) and a.json()["id"] == b.json()["id"]
    assert len(fake.submits) == 1


def test_ambiguous_submit_is_not_resubmitted(client, fake):
    save_key(client)
    pid = new_project(client)
    fake.submit_error = HFError("ambiguous", "Network error talking to Higgsfield (ReadTimeout).")
    h = idem()
    job = generate(client, pid, headers=h).json()
    assert job["status"] == "submission_unknown" and "NOT resubmitted" in job["error"]
    assert generate(client, pid, headers=h).json()["id"] == job["id"]
    assert len(fake.submits) == 1
    assert client.post(f"/api/generations/{job['id']}/refresh").status_code == 409


def test_definite_rejection(client, fake):
    save_key(client)
    pid = new_project(client)
    fake.submit_error = HFError("rejected", "Insufficient Higgsfield credits: nope", 403, "corr-1")
    job = generate(client, pid).json()
    assert job["status"] == "rejected" and job["correlation_id"] == "corr-1" and not job["is_active"]


def test_other_workspace_cannot_access_jobs_or_files(client, fake):
    from app.main import app

    save_key(client)
    pid = new_project(client)
    done = complete(client, generate(client, pid).json()["id"])
    with TestClient(app, headers={"X-Requested-With": "video-gen"}) as other:
        assert other.get(f"/api/generations/{done['id']}").status_code == 404
        assert other.post(f"/api/generations/{done['id']}/cancel").status_code == 404
        assert other.get(done["output"]["url"]).status_code == 404
        other.put("/api/settings/api-key", json={"key_id": "OTHERKEY1", "key_secret": "othersecret"})
        other_pid = new_project(other)
        r = generate(other, other_pid, {"model": "bytedance/seedance-2.5/video-edit", "prompt": "steal",
                                        "media": {"video_url": [done["output"]["id"]]}})
        assert r.status_code == 422 and "not found" in r.json()["detail"]


def test_cancel_only_when_queued(client, fake):
    save_key(client)
    pid = new_project(client)
    job = generate(client, pid).json()
    r = client.post(f"/api/generations/{job['id']}/cancel")
    assert r.status_code == 200 and r.json()["status"] == "canceled"
    assert client.post(f"/api/generations/{job['id']}/cancel").status_code == 409


def test_poll_auth_failure_stalls_then_refresh_recovers(client, fake):
    save_key(client)
    pid = new_project(client)
    job = generate(client, pid).json()
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
    pid = new_project(client)
    job = generate(client, pid).json()

    async def flaky(api_key, rid):
        raise HFError("transient", "HTTP 502", 502)

    fake.status = flaky
    poll(client, job["id"])
    row = db.fetch_one("SELECT status, poll_delay FROM generations WHERE id = ?", (job["id"],))
    assert row["status"] == "queued" and row["poll_delay"] == 4.0


def test_local_timeout(client, fake):
    save_key(client)
    pid = new_project(client)
    job = generate(client, pid).json()
    with db.tx() as conn:
        conn.execute("UPDATE generations SET poll_deadline = 1 WHERE id = ?", (job["id"],))
    poll(client, job["id"])
    assert client.get(f"/api/generations/{job['id']}").json()["status"] == "timed_out"


def test_webhook_only_nudges_with_valid_token(client, fake):
    save_key(client)
    pid = new_project(client)
    job = generate(client, pid).json()
    token = db.fetch_one("SELECT webhook_token FROM generations WHERE id = ?", (job["id"],))["webhook_token"]
    env = {"request_id": job["request_id"], "status": "completed", "error": None, "payload": {"video": {"url": "https://evil"}}}
    assert client.post(f"/api/webhooks/higgsfield/{job['id']}/wrong", json=env).status_code == 404
    assert client.post(f"/api/webhooks/higgsfield/{job['id']}/{token}", json=env).status_code == 200
    assert client.get(f"/api/generations/{job['id']}").json()["remote_video_url"] is None


def test_legacy_generations_are_adopted_into_a_project(client, fake):
    """Rows created before projects existed get a default project and their output registered."""
    save_key(client)
    client.get("/api/projects")  # creates the workspace
    ws = db.fetch_one("SELECT id FROM workspaces")["id"]
    now = db.now()
    with db.tx() as conn:
        conn.execute(
            """INSERT INTO generations (id, workspace_id, idempotency_key, model, arguments_json, status,
                   video_url, webhook_token, created_at, updated_at)
               VALUES ('old1', ?, 'legacykey1', ?, ?, 'completed', 'https://cdn.test/old.mp4', 't', ?, ?)""",
            (ws, T2V, '{"prompt": "old shot", "duration": 5}', now, now),
        )
    projs = client.get("/api/projects").json()
    assert [p["name"] for p in projs] == ["My videos"]
    drain_downloads(client)
    gens = client.get(f"/api/projects/{projs[0]['id']}/generations").json()
    assert gens[0]["prompt"] == "old shot" and gens[0]["params"] == {"duration": 5}
    assert gens[0]["output"]["status"] == "ready"
