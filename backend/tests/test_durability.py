"""Data-safety guarantees: ledger capture, self-healing DB, no paid regeneration."""

import json
import uuid
from pathlib import Path

from fastapi.testclient import TestClient

from app import db, ledger
from app.config import get_settings
from app.higgsfield import HFError
from tests.conftest import MP4, drain_downloads, poll
from tests.test_api import PARAMS, PROMPT, T2V, complete, generate, idem, new_project, save_key


def ledger_lines() -> list[dict]:
    return list(ledger.read(ledger.path_for(get_settings().database_path)))


def restart(client_factory):
    """Simulate an app restart (new process) against the same data directory."""
    from app.main import app

    db.close()
    return TestClient(app, headers={"X-Requested-With": "video-gen"}, cookies=client_factory.cookies)


def test_ledger_records_every_change_but_not_poll_noise(client, fake):
    save_key(client)
    pid = new_project(client)
    gid = generate(client, pid).json()["id"]
    import asyncio

    client.portal.call(asyncio.sleep, 0.05)  # let the background cost record land (a real, logged change)
    before = len(ledger_lines())
    # A poll that leaves status unchanged only updates bookkeeping -> nothing logged.
    fake.statuses[fake_rid(fake)] = ["queued"]
    poll(client, gid)
    assert len(ledger_lines()) == before
    tables = {r["table"] for r in ledger_lines()}
    assert {"workspaces", "credentials", "projects", "generations"} <= tables
    gen_lines = [r for r in ledger_lines() if r["table"] == "generations"]
    assert gen_lines[-1]["row"]["hf_request_id"] and gen_lines[-1]["status"] == "queued"


def fake_rid(fake) -> str:
    return list(fake.statuses)[-1]


def test_deleted_database_is_rebuilt_from_ledger(client, fake):
    save_key(client)
    pid = new_project(client, "Keep me")
    done = complete(client, generate(client, pid).json()["id"])
    running = generate(client, pid, {"model": T2V, "prompt": "still running", "params": PARAMS}).json()
    assert running["status"] == "queued"
    submits_before = len(fake.submits)

    path = get_settings().database_path
    client.__exit__(None, None, None)
    db.close()
    for suffix in ("", "-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)

    with restart(client) as c:
        c.portal.call(c.app.state.poller.stop)
        # Same browser cookie still maps to the same workspace, key included.
        assert c.get("/api/settings/api-key").json()["configured"] is True
        assert [p["name"] for p in c.get("/api/projects").json()] == ["Keep me"]
        gens = {g["id"]: g for g in c.get(f"/api/projects/{pid}/generations").json()}
        assert gens[done["id"]]["status"] == "completed"
        assert c.get(gens[done["id"]]["output"]["url"]).content == MP4
        # The running job resumes by its saved request ID (free status calls), nothing resubmitted.
        assert gens[running["id"]]["request_id"] == running["request_id"]
        poll(c, running["id"])
        poll(c, running["id"])
        assert c.get(f"/api/generations/{running['id']}").json()["status"] == "completed"
        assert len(fake.submits) == submits_before


def test_corrupt_database_is_quarantined_and_rebuilt(client, fake):
    pid = new_project(client, "Survivor")
    path = get_settings().database_path
    client.__exit__(None, None, None)
    db.close()
    for suffix in ("-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)
    path.write_bytes(b"this is not a sqlite database" * 100)

    with restart(client) as c:
        assert [p["id"] for p in c.get("/api/projects").json()] == [pid]
    assert list(path.parent.glob(f"{path.name}.corrupt-*")), "broken DB must be kept aside, not deleted"


def test_missing_video_file_is_redownloaded_after_rebuild(client, fake):
    save_key(client)
    pid = new_project(client)
    done = complete(client, generate(client, pid).json()["id"])
    local = Path(db.fetch_one("SELECT local_path FROM assets WHERE id = ?", (done["output"]["id"],))["local_path"])
    path = get_settings().database_path
    client.__exit__(None, None, None)
    db.close()
    for suffix in ("", "-wal", "-shm"):
        Path(str(path) + suffix).unlink(missing_ok=True)
    local.unlink()

    with restart(client) as c:
        drain_downloads(c)
        out = c.get(f"/api/generations/{done['id']}").json()["output"]
        assert out["status"] == "ready" and c.get(out["url"]).content == MP4
    assert len(fake.submits) == 1


def test_recover_cli_rebuilds_and_keeps_old_db(client, fake, capsys):
    from app import recover

    pid = new_project(client, "CLI")
    client.__exit__(None, None, None)
    db.close()
    import sys

    sys.argv = ["recover"]
    assert recover.main() == 0
    assert "Rebuilt" in capsys.readouterr().out
    assert list(get_settings().database_path.parent.glob(get_settings().database_path.name + ".before-recover-*"))
    with restart(client) as c:
        assert [p["id"] for p in c.get("/api/projects").json()] == [pid]


def test_outputs_saved_under_keyed_folder_with_sidecar(client, fake):
    save_key(client)
    pid = new_project(client, "Sidecar")
    done = complete(client, generate(client, pid).json()["id"])
    local = Path(db.fetch_one("SELECT local_path FROM assets WHERE id = ?", (done["output"]["id"],))["local_path"])
    assert local.parent.name == "outputs" and local.stem == done["id"]
    info = json.loads(local.with_suffix(".json").read_text())
    assert info["higgsfield_request_id"] == done["request_id"] and info["prompt"] == PROMPT
    assert info["project"] == "Sidecar"


def test_expired_cdn_link_is_refreshed_by_request_id(client, fake):
    save_key(client)
    pid = new_project(client)
    calls = []

    async def download(url, dest, max_bytes):
        calls.append(url)
        if "fresh" not in url:
            raise HFError("rejected", "403 expired link")
        dest.write_bytes(MP4)
        return "video/mp4", len(MP4)

    fake.download = download
    gid = generate(client, pid).json()["id"]
    rid = fake_rid(fake)
    fake.results[rid] = {"status": "completed", "request_id": rid, "video": {"url": "https://cdn.test/fresh.mp4"}}
    orig_result = fake.result
    first = {"done": False}

    async def result(api_key, request_id):  # first call (poll completion) returns the old URL
        if not first["done"]:
            first["done"] = True
            return {"status": "completed", "request_id": request_id, "video": {"url": "https://cdn.test/old.mp4"}}
        return await orig_result(api_key, request_id)

    fake.result = result
    done = complete(client, gid)
    assert done["output"]["status"] == "ready"
    assert calls == ["https://cdn.test/old.mp4", "https://cdn.test/fresh.mp4"]
    assert len(fake.submits) == 1


def test_duplicate_guard_asks_before_paying_twice(client, fake):
    save_key(client)
    pid = new_project(client)
    complete(client, generate(client, pid).json()["id"])
    r = generate(client, pid)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "duplicate"
    assert len(fake.submits) == 1
    body = {"model": T2V, "prompt": PROMPT, "params": PARAMS, "allow_duplicate": True}
    assert generate(client, pid, body).status_code == 201 and len(fake.submits) == 2
    # Different settings are not a duplicate.
    assert generate(client, pid, {"model": T2V, "prompt": PROMPT, "params": {**PARAMS, "duration": 6}}).status_code == 201


def test_failed_generation_does_not_block_retry(client, fake):
    save_key(client)
    pid = new_project(client)
    fake.submit_error = HFError("rejected", "Insufficient credits", 403)
    generate(client, pid)
    fake.submit_error = None
    assert generate(client, pid).status_code == 201


def test_stats_and_download_name(client, fake):
    save_key(client)
    pid = new_project(client)
    done = complete(client, generate(client, pid).json()["id"])
    s = client.get("/api/stats").json()
    assert s["projects"] == 1 and s["by_status"] == {"completed": 1} and s["saved_files"] == 1
    assert s["ledger"]["bytes"] > 0
    r = client.get(done["output"]["url"] + "?download=1")
    cd = r.headers["content-disposition"]
    assert cd.startswith("attachment") and "a-cinematic-tracking-shot" in cd and cd.endswith('.mp4"')


def test_backup_is_created_once_per_day(client):
    # The poller takes today's backup at startup; further calls the same day are no-ops.
    folder = get_settings().database_path.parent / "backups"
    assert len(list(folder.glob("app-*.db"))) == 1
    assert db.backup_now() is None
