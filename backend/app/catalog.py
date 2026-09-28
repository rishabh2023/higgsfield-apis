"""Supported Higgsfield models, as declarative specs.

Single source of truth for (a) server-side validation and (b) the form the UI renders.
Every entry was checked on 2026-09-28 against the model's "Complete JSON schema" in
https://docs.higgsfield.ai/docs/models/<model>/<workflow>.md — update both together.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

Mode = Literal["text", "image", "reference", "edit", "extend"]
MediaKind = Literal["image", "video", "audio"]

MODES: list[dict[str, str]] = [
    {"id": "text", "name": "Text to video", "description": "Describe a shot and generate it from scratch."},
    {"id": "image", "name": "Image to video", "description": "Animate a still image (optionally ending on another)."},
    {"id": "reference", "name": "References to video", "description": "Guide a new video with reference images, videos or audio."},
    {"id": "edit", "name": "Edit video", "description": "Change an existing video with a prompt, keeping its timing and framing."},
    {"id": "extend", "name": "Extend video", "description": "Continue an existing video for more seconds."},
]

RES_4K = ["480p", "720p", "1080p", "4k"]
RES_720 = ["480p", "720p"]
ASPECTS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]


@dataclass(frozen=True)
class Param:
    name: str
    label: str
    type: Literal["int", "enum", "bool"]
    default: Any
    min: int | None = None
    max: int | None = None
    options: list[str] | None = None
    help: str | None = None


@dataclass(frozen=True)
class MediaSlot:
    name: str           # API field name
    label: str
    kind: MediaKind
    multiple: bool       # array field vs single URL
    required: bool = False
    max: int = 1
    help: str | None = None


@dataclass(frozen=True)
class Model:
    id: str
    name: str
    mode: Mode
    docs: str
    prompt_required: bool = True
    prompt_max: int = 5000
    params: list[Param] = field(default_factory=list)
    media: list[MediaSlot] = field(default_factory=list)
    # At least one of these media slots must be non-empty.
    require_one_of: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def public(self) -> dict[str, Any]:
        return asdict(self)


def _duration(lo: int, hi: int) -> Param:
    return Param("duration", "Duration (seconds)", "int", 5, min=lo, max=hi)


def _resolution(options: list[str]) -> Param:
    return Param("resolution", "Resolution", "enum", "720p", options=options)


ASPECT = Param("aspect_ratio", "Aspect ratio", "enum", "16:9", options=ASPECTS)
AUDIO = Param("generate_audio", "Generate audio", "bool", True, help="Soundtrack and ambience with the video")
BITRATE = Param("bitrate_mode", "Bitrate", "enum", "high", options=["standard", "high"])

DOCS = "https://docs.higgsfield.ai/docs/models/"

MODELS: list[Model] = [
    Model(
        "bytedance/seedance-2.0/text-to-video", "Seedance 2.0", "text", DOCS + "seedance-2/text-to-video",
        params=[_duration(4, 15), _resolution(RES_4K), ASPECT, AUDIO],
    ),
    Model(
        "bytedance/seedance-2.5/text-to-video", "Seedance 2.5", "text", DOCS + "seedance-2-5/text-to-video",
        params=[_duration(4, 30), _resolution(RES_720), ASPECT, BITRATE, AUDIO],
        notes=["Up to 30 seconds; max 720p."],
    ),
    Model(
        "bytedance/seedance-2.0/image-to-video", "Seedance 2.0", "image", DOCS + "seedance-2/image-to-video",
        prompt_required=False,
        params=[_duration(4, 15), _resolution(RES_4K), AUDIO],
        media=[
            MediaSlot("image_url", "Start frame", "image", multiple=False, required=True),
            MediaSlot("end_image_url", "End frame (optional)", "image", multiple=False),
        ],
        notes=["Framing follows the start image. Prompt is optional."],
    ),
    Model(
        "bytedance/seedance-2.0/reference-to-video", "Seedance 2.0", "reference", DOCS + "seedance-2/reference-to-video",
        prompt_required=False,
        params=[_duration(4, 15), _resolution(RES_4K), ASPECT, AUDIO],
        media=[
            MediaSlot("image_urls", "Reference images", "image", multiple=True, max=9),
            MediaSlot("video_urls", "Reference videos", "video", multiple=True, max=3,
                      help="Each is trimmed to 15 seconds."),
            MediaSlot("audio_urls", "Reference audio", "audio", multiple=True, max=3),
        ],
        require_one_of=["image_urls", "video_urls"],
        notes=["Needs at least one reference image or video (audio alone isn't enough)."],
    ),
    Model(
        "bytedance/seedance-2.5/reference-to-video", "Seedance 2.5", "reference", DOCS + "seedance-2-5/reference-to-video",
        prompt_required=False,
        params=[_duration(4, 30), _resolution(RES_720), ASPECT, BITRATE, AUDIO],
        media=[
            MediaSlot("image_urls", "Reference images", "image", multiple=True, max=30),
            MediaSlot("video_urls", "Reference videos", "video", multiple=True, max=10),
            MediaSlot("audio_urls", "Reference audio", "audio", multiple=True, max=10),
        ],
        require_one_of=["image_urls", "video_urls", "audio_urls"],
        notes=["Up to 30 images, 10 videos, 10 audio (50 total). Max 720p."],
    ),
    Model(
        "bytedance/seedance-2.5/video-edit", "Seedance 2.5 Edit", "edit", DOCS + "seedance-2-5/video-edit",
        params=[_resolution(RES_720), BITRATE, AUDIO],
        media=[
            MediaSlot("video_url", "Video to edit", "video", multiple=False, required=True),
            MediaSlot("image_urls", "Reference images", "image", multiple=True, max=30),
            MediaSlot("video_urls", "Reference videos", "video", multiple=True, max=9),
            MediaSlot("audio_urls", "Reference audio", "audio", multiple=True, max=10),
        ],
        notes=["Output length and framing follow the source video."],
    ),
    Model(
        "kling-video/o3/video-edit", "Kling O3 Edit", "edit", DOCS + "kling-o3/video-edit",
        prompt_max=2500,
        params=[Param("mode", "Quality", "enum", "pro", options=["std", "pro", "4k"])],
        media=[
            MediaSlot("video_urls", "Video to edit", "video", multiple=True, required=True, max=1,
                      help="3–15.5 seconds, up to 200 MB."),
            MediaSlot("image_urls", "Reference images", "image", multiple=True, max=4),
        ],
        notes=["Source video must be 3–15.5 s. Prompt up to 2,500 characters."],
    ),
    Model(
        "bytedance/seedance-2.5/video-extend", "Seedance 2.5 Extend", "extend", DOCS + "seedance-2-5/video-extend",
        params=[_duration(4, 30), _resolution(RES_720), BITRATE, AUDIO],
        media=[
            MediaSlot("video_url", "Video to extend", "video", multiple=False, required=True),
            MediaSlot("image_urls", "Reference images", "image", multiple=True, max=30),
            MediaSlot("video_urls", "Reference videos", "video", multiple=True, max=9),
            MediaSlot("audio_urls", "Reference audio", "audio", multiple=True, max=10),
        ],
    ),
]

BY_ID: dict[str, Model] = {m.id: m for m in MODELS}


def catalog() -> dict[str, Any]:
    return {"modes": MODES, "models": [m.public() for m in MODELS]}


class SpecError(ValueError):
    pass


def validate(model: Model, prompt: str | None, params: dict[str, Any], media: dict[str, list[str]]) -> tuple[str | None, dict[str, Any]]:
    """Validate user input against the spec. Returns (clean_prompt, clean_params)."""
    prompt = (prompt or "").strip() or None
    if model.prompt_required and not prompt:
        raise SpecError("Prompt is required for this model.")
    if prompt and len(prompt) > model.prompt_max:
        raise SpecError(f"Prompt must be at most {model.prompt_max} characters.")

    known = {p.name: p for p in model.params}
    unknown = set(params) - set(known)
    if unknown:
        raise SpecError(f"Unsupported parameters for {model.id}: {', '.join(sorted(unknown))}")
    clean: dict[str, Any] = {}
    for p in model.params:
        v = params.get(p.name, p.default)
        if p.type == "int":
            if isinstance(v, bool) or not isinstance(v, int):
                raise SpecError(f"{p.label} must be a whole number.")
            if not (p.min <= v <= p.max):  # type: ignore[operator]
                raise SpecError(f"{p.label} must be between {p.min} and {p.max}.")
        elif p.type == "enum":
            if v not in (p.options or []):
                raise SpecError(f"{p.label} must be one of {', '.join(p.options or [])}.")
        elif p.type == "bool" and not isinstance(v, bool):
            raise SpecError(f"{p.label} must be true or false.")
        clean[p.name] = v

    slots = {s.name: s for s in model.media}
    unknown = {k for k, v in media.items() if v} - set(slots)
    if unknown:
        raise SpecError(f"Unsupported media for {model.id}: {', '.join(sorted(unknown))}")
    for s in model.media:
        ids = media.get(s.name) or []
        if len(set(ids)) != len(ids):
            raise SpecError(f"{s.label}: the same file was selected twice.")
        if s.required and not ids:
            raise SpecError(f"{s.label} is required.")
        limit = s.max if s.multiple else 1
        if len(ids) > limit:
            raise SpecError(f"{s.label}: at most {limit} file(s).")
    if model.require_one_of and not any(media.get(n) for n in model.require_one_of):
        labels = [slots[n].label.lower() for n in model.require_one_of]
        raise SpecError(f"Add at least one of: {', '.join(labels)}.")
    return prompt, clean
