import logging
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app import db, service
from app.config import get_settings
from app.identity import current_workspace, require_app_header
from app.poller import Poller
from app.schemas import SEEDANCE_2_T2V, CreateGeneration, CredentialStatus, Generation, SaveApiKey

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


# ------------------------------------------------------------------ models

MODELS = [
    {
        "id": SEEDANCE_2_T2V,
        "name": "Seedance 2.0 — Text to video",
        "provider": "ByteDance via Higgsfield",
        "docs": "https://docs.higgsfield.ai/docs/models/seedance-2/text-to-video",
        "params": {
            "duration": {"min": 4, "max": 15, "default": 5},
            "resolution": {"options": ["480p", "720p", "1080p", "4k"], "default": "720p"},
            "aspect_ratio": {"options": ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"], "default": "16:9"},
            "generate_audio": {"default": True},
        },
    }
]


@app.get("/api/models")
def list_models() -> list[dict]:
    return MODELS


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


# ------------------------------------------------------------------ generations


@app.get("/api/generations", response_model=list[Generation])
def list_generations(workspace_id: str = Depends(current_workspace)):
    return [service.to_schema(r) for r in service.list_generations(workspace_id)]


@app.post("/api/generations", response_model=Generation, dependencies=[Mutation])
async def create_generation(
    body: CreateGeneration,
    response: Response,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    workspace_id: str = Depends(current_workspace),
):
    row, created = await service.create_generation(workspace_id, body, idempotency_key)
    response.status_code = 201 if created else 200
    return service.to_schema(row)


@app.get("/api/generations/{generation_id}", response_model=Generation)
def get_generation(generation_id: str, workspace_id: str = Depends(current_workspace)):
    return service.to_schema(service.get_owned(workspace_id, generation_id))


@app.post("/api/generations/{generation_id}/cancel", response_model=Generation, dependencies=[Mutation])
async def cancel_generation(generation_id: str, workspace_id: str = Depends(current_workspace)):
    return service.to_schema(await service.cancel_generation(workspace_id, generation_id))


@app.post("/api/generations/{generation_id}/refresh", response_model=Generation, dependencies=[Mutation])
async def refresh_generation(generation_id: str, workspace_id: str = Depends(current_workspace)):
    return service.to_schema(await service.refresh_generation(workspace_id, generation_id))


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
