from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

class CreateGeneration(BaseModel):
    """Validated against the model's spec in app/catalog.py."""

    model_config = ConfigDict(extra="forbid")

    model: str = Field(max_length=200)
    prompt: str | None = Field(default=None, max_length=10000)
    params: dict[str, Any] = Field(default_factory=dict)
    # media slot name -> asset ids (from the project's library or earlier outputs)
    media: dict[str, list[str]] = Field(default_factory=dict)
    # Set after the user confirms they really want to pay for an identical generation again.
    allow_duplicate: bool = False


class ProjectIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)


class ProjectPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=1000)


class AssetPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=200)
    in_library: bool | None = None


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
