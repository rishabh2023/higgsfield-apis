import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel

from app import catalog, db, media, projects, service
from app.config import get_settings
from app.identity import current_workspace, require_app_header
from app.poller import Poller
from app.schemas import AssetPatch, CreateGeneration, CredentialStatus, ProjectIn, ProjectPatch, SaveApiKey

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
# httpx logs full request lines at INFO; keep it quiet (URLs carry no secrets, but be conservative).
logging.getLogger("httpx").setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.connect()
    poller = Poller()
    poller.start()
    app.state.poller = poller
    yield
    await poller.stop()
    db.close()


app = FastAPI(title="Video Generation API", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in get_settings().cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

Mutation = Depends(require_app_header)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/stats")
def get_stats(workspace_id: str = Depends(current_workspace)):
    return service.stats(workspace_id)


# ------------------------------------------------------------------ models


@app.get("/api/models")
def list_models() -> dict:
    return catalog.catalog()


# ------------------------------------------------------------------ settings


@app.get("/api/settings/api-key", response_model=CredentialStatus)
def get_api_key_status(workspace_id: str = Depends(current_workspace)):
    return service.credential_status(workspace_id)


class SaveKeyResponse(CredentialStatus):
    warning: str | None = None


@app.put("/api/settings/api-key", response_model=SaveKeyResponse, dependencies=[Mutation])
async def save_api_key(body: SaveApiKey, workspace_id: str = Depends(current_workspace)):
    status, warning = await service.save_api_key(workspace_id, body.key_id, body.key_secret)
    return SaveKeyResponse(**status.model_dump(), warning=warning)


@app.delete("/api/settings/api-key", status_code=204, dependencies=[Mutation])
def delete_api_key(workspace_id: str = Depends(current_workspace)):
    service.delete_api_key(workspace_id)
    return Response(status_code=204)


# ------------------------------------------------------------------ projects


@app.get("/api/projects")
def list_projects(workspace_id: str = Depends(current_workspace)):
    return projects.list_all(workspace_id)


@app.post("/api/projects", status_code=201, dependencies=[Mutation])
def create_project(body: ProjectIn, workspace_id: str = Depends(current_workspace)):
    return projects.public(workspace_id, projects.create(workspace_id, body.name, body.description)["id"])


@app.get("/api/projects/{project_id}")
def get_project(project_id: str, workspace_id: str = Depends(current_workspace)):
    return projects.public(workspace_id, project_id)


@app.patch("/api/projects/{project_id}", dependencies=[Mutation])
def update_project(project_id: str, body: ProjectPatch, workspace_id: str = Depends(current_workspace)):
    return projects.update(workspace_id, project_id, body.name, body.description)


@app.delete("/api/projects/{project_id}", status_code=204, dependencies=[Mutation])
def delete_project(project_id: str, workspace_id: str = Depends(current_workspace)):
    projects.delete(workspace_id, project_id)
    return Response(status_code=204)


# ------------------------------------------------------------------ assets (reference library + outputs)


@app.get("/api/projects/{project_id}/assets")
def list_assets(project_id: str, scope: Literal["library", "all"] = "all", workspace_id: str = Depends(current_workspace)):
    projects.get_owned(workspace_id, project_id)
    return [media.to_public(a) for a in media.list_for_project(workspace_id, project_id, scope == "library")]


@app.post("/api/projects/{project_id}/assets", status_code=201, dependencies=[Mutation])
async def upload_asset(project_id: str, file: UploadFile, workspace_id: str = Depends(current_workspace)):
    projects.get_owned(workspace_id, project_id)
    a = await run_in_threadpool(media.save_upload, workspace_id, project_id, file.filename or "", file.file, file.size)
    return media.to_public(a)


@app.patch("/api/assets/{asset_id}", dependencies=[Mutation])
def update_asset(asset_id: str, body: AssetPatch, workspace_id: str = Depends(current_workspace)):
    return media.to_public(media.update(workspace_id, asset_id, name=body.name, in_library=body.in_library))


@app.delete("/api/assets/{asset_id}", status_code=204, dependencies=[Mutation])
def delete_asset(asset_id: str, workspace_id: str = Depends(current_workspace)):
    media.delete(workspace_id, asset_id)
    return Response(status_code=204)


@app.post("/api/assets/{asset_id}/retry-download", dependencies=[Mutation])
async def retry_asset_download(asset_id: str, workspace_id: str = Depends(current_workspace)):
    return media.to_public(await media.retry_download(workspace_id, asset_id))


@app.get("/api/assets/{asset_id}/file")
def asset_file(asset_id: str, download: bool = False, workspace_id: str = Depends(current_workspace)):
    a = media.get_owned(workspace_id, asset_id)
    if a["local_path"] and Path(a["local_path"]).exists():
        filename = media.download_name(a)
        return FileResponse(
            a["local_path"], media_type=a["content_type"],
            filename=filename if download else None,
            content_disposition_type="attachment" if download else "inline",
        )
    if a["remote_url"]:
        # Local copy still downloading (or failed): fall back to Higgsfield's CDN copy.
        return RedirectResponse(a["remote_url"], status_code=307)
    raise HTTPException(404, "File not available")


# ------------------------------------------------------------------ generations


@app.get("/api/projects/{project_id}/generations")
def list_generations(project_id: str, workspace_id: str = Depends(current_workspace)):
    projects.get_owned(workspace_id, project_id)
    return [service.to_public(r) for r in service.list_generations(workspace_id, project_id)]


@app.post("/api/projects/{project_id}/generations", dependencies=[Mutation])
async def create_generation(
    project_id: str,
    body: CreateGeneration,
    response: Response,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    workspace_id: str = Depends(current_workspace),
):
    row, created = await service.create_generation(workspace_id, project_id, body, idempotency_key)
    response.status_code = 201 if created else 200
    return service.to_public(row)


@app.get("/api/generations/{generation_id}")
def get_generation(generation_id: str, workspace_id: str = Depends(current_workspace)):
    return service.to_public(service.get_owned(workspace_id, generation_id))


@app.post("/api/generations/{generation_id}/cancel", dependencies=[Mutation])
async def cancel_generation(generation_id: str, workspace_id: str = Depends(current_workspace)):
    return service.to_public(await service.cancel_generation(workspace_id, generation_id))


@app.post("/api/generations/{generation_id}/refresh", dependencies=[Mutation])
async def refresh_generation(generation_id: str, workspace_id: str = Depends(current_workspace)):
    return service.to_public(await service.refresh_generation(workspace_id, generation_id))


@app.delete("/api/generations/{generation_id}", status_code=204, dependencies=[Mutation])
def delete_generation(generation_id: str, workspace_id: str = Depends(current_workspace)):
    service.delete_generation(workspace_id, generation_id)
    return Response(status_code=204)


# ------------------------------------------------------------------ webhooks


class WebhookEnvelope(BaseModel):
    request_id: str
    status: Literal["completed", "failed", "nsfw", "canceled"]
    error: str | None = None
    payload: dict | None = None


@app.post("/api/webhooks/higgsfield/{generation_id}/{token}")
def higgsfield_webhook(generation_id: str, token: str, body: WebhookEnvelope):
    # Deliveries may repeat; nudging an already-terminal job is a no-op, so duplicates get 200.
    if not service.nudge_from_webhook(generation_id, token, body.request_id):
        raise HTTPException(status_code=404, detail="Unknown webhook target")
    return {"ok": True}
