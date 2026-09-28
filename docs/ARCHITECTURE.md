# How it works (developer notes)

```
Browser (React + react-router + shadcn/ui)
   │  /api (Vite proxy, same-origin cookie)
   ▼
FastAPI ──higgsfield-client SDK──▶ api.higgsfield.ai  (submit · status · result · cancel · presigned upload)
   │     └─httpx──▶ Higgsfield CDN  (download outputs, check that remote media URLs still work)
   ├── SQLite  backend/data/app.db   workspaces · credentials · projects · assets · generations
   └── Files   backend/data/media/<workspace>/<asset>.{mp4,png,…}
```

## Layout

| Path | Purpose |
|---|---|
| `backend/app/catalog.py` | **Model catalog.** Declarative specs (params, media slots, limits) for 8 endpoints across 5 modes. Used for server validation and served to the UI at `GET /api/models` |
| `backend/app/service.py` | Credentials, generation submission (validate → resolve media → submit), polling state machine |
| `backend/app/media.py` | Asset storage: upload sniffing and limits, output download, `ensure_remote_url` |
| `backend/app/projects.py` | Project CRUD and adopting pre-project generations |
| `backend/app/higgsfield.py` | SDK wrapper: per-key clients, no-retry submit, error classification, upload, download |
| `backend/app/poller.py` | Background poller. Also resumes pending downloads on startup |
| `backend/app/main.py` | Routes |
| `frontend/src/pages/` | `projects-page`, `project-page` (Create / Videos / References tabs), `settings-page` |
| `frontend/src/components/create-panel.tsx` | Form rendered from the catalog, including deep links (`?mode=edit&source=<asset>`) |

## Models (checked against the docs on 2026-09-28)

| Mode | Endpoint | Key inputs |
|---|---|---|
| text | `bytedance/seedance-2.0/text-to-video` | duration 4–15, 480p–4k |
| text | `bytedance/seedance-2.5/text-to-video` | duration 4–30, 480p/720p, bitrate |
| image | `bytedance/seedance-2.0/image-to-video` | `image_url` (required), `end_image_url` |
| reference | `bytedance/seedance-2.0/reference-to-video` | `image_urls` ≤9 / `video_urls` ≤3 / `audio_urls` ≤3. Needs an image or a video |
| reference | `bytedance/seedance-2.5/reference-to-video` | ≤30 / 10 / 10. Any one of them |
| edit | `bytedance/seedance-2.5/video-edit` | `video_url` + refs. No duration (it follows the source) |
| edit | `kling-video/o3/video-edit` | `video_urls[1]` (3–15.5s), `image_urls` ≤4, mode std/pro/4k, prompt ≤2500 |
| extend | `bytedance/seedance-2.5/video-extend` | `video_url` + refs, duration 4–30 |

To add a model, add one `Model(...)` entry in `catalog.py`. The API validation and the UI form both come from it.

## API

```
GET    /api/models                              catalog (modes + model specs)
GET    /api/stats                               counts, disk use, ledger size, last backup
GET|PUT|DELETE /api/settings/api-key
GET|POST       /api/projects                    GET|PATCH|DELETE /api/projects/{id}
GET|POST       /api/projects/{id}/assets        multipart upload; ?scope=library|all
PATCH|DELETE   /api/assets/{id}                 rename, add to or remove from References
GET            /api/assets/{id}/file            local file (Range support), 307 to CDN if not local; ?download=1
POST           /api/assets/{id}/retry-download
GET|POST       /api/projects/{id}/generations   POST {model, prompt, params, media:{slot:[asset_id]}} + Idempotency-Key
GET|DELETE     /api/generations/{id}            POST …/cancel, …/refresh
POST           /api/webhooks/higgsfield/{id}/{token}
```

## Design decisions

| Concern | Implementation |
|---|---|
| **Output durability** | Higgsfield keeps outputs for "at least 7 days". On `completed`, an asset row is created and the MP4 is streamed to disk in the background (retried, and resumed on restart). The UI plays `/api/assets/{id}/file` and falls back to the CDN URL until the copy exists |
| **Media as model input** | Inputs must be public URLs. `ensure_remote_url` reuses an asset's remote URL if it's under 6 days old **and** still responds to a 1-byte Range GET. Otherwise it re-uploads the local file through the SDK's presigned upload (`retention=temporary`). This is how edit and extend keep working on old videos |
| **Ledger (durability)** | SQLite triggers record every change to workspaces, credentials, projects, assets and generations into `_changes` inside the same transaction. After commit it's appended with fsync to `data/ledger.jsonl` (one JSON row per line; poll-only bookkeeping isn't logged). On startup a DB that fails `PRAGMA quick_check` is quarantined, and a missing DB is rebuilt by replaying the ledger (`app/ledger.py`). The first run on an existing DB writes a baseline. `python -m app.recover` does the same by hand. The encrypted API key is included, so it's as protected as in the DB |
| **Backups** | `sqlite3.backup` to `data/backups/app-YYYY-MM-DD.db` once a day (checked hourly by the poller), keeping 7 |
| **Output files** | `data/media/<ws>/outputs/<generation_id>.mp4` plus a `.json` sidecar (prompt, model, params, request ID). Uploads go in `data/media/<ws>/uploads/`. If the CDN link has expired, the download asks for a fresh URL via `GET /requests/{id}/status` (free), never a regeneration |
| **Spend guard** | `fingerprint = sha256(model, prompt, params, media ids)`. An identical request that's active or completed returns `409 {code: duplicate}` unless `allow_duplicate: true`. Failed or rejected attempts don't block a retry |
| **Draft persistence** | The Create form, including its pending `Idempotency-Key`, is kept in `localStorage` per project, so a refresh mid-submit replays the same key instead of paying again |
| **Cost** | `POST /api/estimate` calls Higgsfield's documented `POST /estimate/{model}` (direct REST, since the SDK has no helper), cached for 5 minutes per settings. It only uses media URLs already on Higgsfield (never uploads just to price). After each accepted submit, the price is recorded in the background (`est_credits`, `est_usd`) for "spent here". There's no balance endpoint in the API, so the UI links to the Console |
| **Voice prompt** | Browser Web Speech API (`webkitSpeechRecognition`), free and keyless (Google in Chrome and Edge). `frontend/src/lib/use-speech.ts` |
| **Uploads** | The type is identified from magic bytes (the extension is ignored) and must be one Higgsfield accepts: jpeg/png/webp/gif, wav, mp4. `.mov` is rejected with a hint. Limits are 30/50/200 MB |
| **Submission order** | Validate spec → check asset ownership and kind → insert `submitting` row → resolve media URLs (a failure here means `rejected`, nothing sent) → submit with no retry |
| Credentials | Fernet-encrypted `key_id:secret` per workspace. Only a hint is returned. Verified with a free status lookup |
| Ownership | A random workspace cookie. Every project, asset, generation and file query is filtered by workspace. A foreign ID gives 404, including asset IDs used as generation inputs |
| Duplicates / ambiguity | `Idempotency-Key`, backed by a UNIQUE constraint. Ambiguous POST failures become `submission_unknown` and are never resubmitted, because the SDK's POST retry is disabled |
| Polling | 2s → 10s backoff with jitter, and up to 30s on transient errors. Timeout gives `timed_out`, and 401/404 gives `stalled`. Both can be refreshed |
| Webhooks | Optional `PUBLIC_WEBHOOK_BASE_URL`. A webhook only triggers an authenticated re-poll |
| Migrations | New `generations` columns are added with `ALTER TABLE` at startup. Pre-project generations move into a "My videos" project |

## Tests

`cd backend && uv run pytest`: all offline. The API flow uses a fake gateway (uploads, downloads, URL liveness).
The real SDK is tested against `httpx.MockTransport`.
