from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# Verified 2026-09-28 against
# https://docs.higgsfield.ai/docs/models/seedance-2/text-to-video.md
SEEDANCE_2_T2V = "bytedance/seedance-2.0/text-to-video"

Resolution = Literal["480p", "720p", "1080p", "4k"]
AspectRatio = Literal["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]


class SeedanceTextToVideoInput(BaseModel):
    """Mirrors the model's JSON schema (additionalProperties: false)."""

    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(min_length=1, max_length=5000)
    duration: int = Field(default=5, ge=4, le=15)
    resolution: Resolution = "720p"
    aspect_ratio: AspectRatio = "16:9"
    generate_audio: bool = True

    @field_validator("prompt")
    @classmethod
    def _nonblank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("prompt must not be blank")
        return v


class CreateGeneration(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: Literal["bytedance/seedance-2.0/text-to-video"] = SEEDANCE_2_T2V
    input: SeedanceTextToVideoInput


class SaveApiKey(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key_id: str = Field(min_length=4, max_length=200)
    key_secret: str = Field(min_length=4, max_length=500)

    @field_validator("key_id", "key_secret")
    @classmethod
    def _clean(cls, v: str) -> str:
        v = v.strip()
        if ":" in v or any(c.isspace() for c in v):
            raise ValueError("must not contain ':' or whitespace")
        return v


class CredentialStatus(BaseModel):
    configured: bool
    key_hint: str | None = None
    verified: bool = False
    usable: bool = False


class Generation(BaseModel):
    id: str
    model: str
    input: dict
    status: str
    request_id: str | None
    video_url: str | None
    error: str | None
    correlation_id: str | None
    created_at: float
    updated_at: float
    finished_at: float | None
    is_active: bool
    can_cancel: bool
