"""Settings -> Storage / Raw data endpoints."""

from pathlib import Path

from fastapi.testclient import TestClient

from app import db, ledger
from app.config import get_settings
from app.higgsfield import HFError
from tests.conftest import MP4, PNG
from tests.test_api import PROMPT, complete, generate, new_project, save_key, upload


def test_health_and_version_report_api_version(client):
    assert client.get("/api/health").json()["api_version"] >= 4
    assert client.get("/api/version").json()["api_version"] >= 4


def test_storage_lists_clips_with_usage(client, fake):
    save_key(client)
    pid = new_project(client, "Clips")
    img = upload(client, pid, PNG, "ref.png").json()
    done = complete(client, generate(client, pid).json()["id"])
    s = client.get("/api/storage").json()
    kinds = {f["source"]: f for f in s["files"]}
    assert s["counts"] == {"outputs": 1, "uploads": 1}
    assert kinds["generation"]["project_name"] == "Clips" and kinds["generation"]["on_disk"]
    assert kinds["upload"]["id"] == img["id"] and kinds["upload"]["used_as_input"] is False
    assert s["total_bytes"] == len(MP4) + len(PNG)
    assert done["output"]["id"] == kinds["generation"]["id"]


def test_delete_generated_clip_removes_video_file_and_sidecar(client, fake):
    save_key(client)
    pid = new_project(client)
    done = complete(client, generate(client, pid).json()["id"])
    out = done["output"]["id"]
    client.patch(f"/api/assets/{out}", json={"in_library": True})  # even if saved to References
    local = Path(db.fetch_one("SELECT local_path FROM assets WHERE id = ?", (out,))["local_path"])
    assert local.exists() and local.with_suffix(".json").exists()
    assert client.post("/api/storage/delete", json={"asset_ids": [out]}).json() == {"deleted": 1}
    assert not local.exists() and not local.with_suffix(".json").exists()
    assert client.get(f"/api/generations/{done['id']}").status_code == 404


def test_clear_failed_and_unused_uploads(client, fake):
    save_key(client)
    pid = new_project(client)
    used = upload(client, pid, PNG, "used.png").json()["id"]
    upload(client, pid, PNG, "unused.png")
    generate(client, pid, {"model": "bytedance/seedance-2.0/image-to-video", "media": {"image_url": [used]}})
    fake.submit_error = HFError("rejected", "no credits", 403)
    generate(client, pid, {"model": "bytedance/seedance-2.0/text-to-video", "prompt": "fails"})
    assert client.post("/api/storage/clear", json={"scope": "failed"}).json() == {"generations": 1}
    assert client.post("/api/storage/clear", json={"scope": "unused_uploads"}).json() == {"files": 1}
    names = [f["name"] for f in client.get("/api/storage").json()["files"]]
    assert names == ["used.png"]


def test_clear_everything_keeps_api_key_and_survives_rebuild(client, fake):
    save_key(client)
    pid = new_project(client)
    complete(client, generate(client, pid).json()["id"])
    assert client.post("/api/storage/clear", json={"scope": "everything"}).json() == {"projects": 1}
    assert client.get("/api/projects").json() == []
    assert client.get("/api/settings/api-key").json()["configured"] is True
    # Cleared data must not come back when the DB is rebuilt from the ledger.
    path = get_settings().database_path
    client.__exit__(None, None, None)
    db.close()
    for suffix in ("", "-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)
    from app.main import app

    with TestClient(app, headers={"X-Requested-With": "video-gen"}, cookies=client.cookies) as c:
        assert c.get("/api/projects").json() == []


def test_raw_generation_shows_request_response_and_history(client, fake):
    save_key(client)
    pid = new_project(client)
    done = complete(client, generate(client, pid).json()["id"])
    raw = client.get(f"/api/generations/{done['id']}/raw").json()
    assert raw["request_sent_to_higgsfield"]["prompt"] == PROMPT
    assert raw["higgsfield_response"]["video"]["url"].startswith("https://cdn.test/")
    assert [h["status"] for h in raw["status_history"]][-1] == "completed"
    assert raw["record"]["webhook_token"] == "[hidden]"


def test_ledger_view_is_scoped_and_redacted(client, fake):
    from app.main import app

    save_key(client)
    new_project(client, "Mine")
    with TestClient(app, headers={"X-Requested-With": "video-gen"}) as other:
        new_project(other, "Theirs")
        theirs = other.get("/api/ledger").json()["entries"]
    mine = client.get("/api/ledger").json()
    blob = str(mine["entries"])
    assert "Mine" in blob and "Theirs" not in blob
    assert "[encrypted — never shown]" in blob and "s3cr3t" not in blob
    assert "Mine" not in str(theirs)


def test_compact_ledger_keeps_rebuildability(client, fake):
    save_key(client)
    pid = new_project(client, "Compact me")
    for i in range(3):
        client.patch(f"/api/projects/{pid}", json={"name": f"Compact me {i}"})
    r = client.post("/api/ledger/compact").json()
    assert r["bytes_after"] < r["bytes_before"]
    assert list((get_settings().database_path.parent / "backups").glob("ledger-*.jsonl"))
    lines = list(ledger.read(ledger.path_for(get_settings().database_path)))
    assert any(l["table"] == "projects" and l["row"]["name"] == "Compact me 2" for l in lines)
