# How it works (developer notes)

```
Browser (React + shadcn/ui)  ──/api──▶  Vite proxy  ──▶  FastAPI  ──higgsfield-client SDK──▶  api.higgsfield.ai
                                                            │
                                                            └── SQLite (backend/data/app.db)
                                                                 workspaces · encrypted keys · generations
```

## Layout

| Path | Purpose |
|---|---|
| `backend/app/main.py` | Routes: `/api/settings/api-key`, `/api/generations[/{id}[/cancel\|/refresh]]`, `/api/webhooks/higgsfield/…` |
| `backend/app/service.py` | Credential storage, submission, polling state machine |
| `backend/app/higgsfield.py` | SDK wrapper: per-user clients, no-retry submission, error classification |
| `backend/app/poller.py` | In-process background poller (state persisted in SQLite) |
| `backend/app/identity.py` | Anonymous workspace cookie and CSRF header check |
| `backend/app/schemas.py` | Request validation that mirrors the Seedance 2.0 JSON schema |
| `frontend/src/` | `App.tsx`, `components/` (API key card, form, generation card), `lib/api.ts` |

## Model

`bytedance/seedance-2.0/text-to-video`, verified against the
[model docs](https://docs.higgsfield.ai/docs/models/seedance-2/text-to-video):
`prompt` (required), `duration` 4–15, `resolution` 480p/720p/1080p/4k, `aspect_ratio`
16:9/4:3/1:1/3:4/9:16/21:9, `generate_audio`. Extra fields are rejected.

## Design decisions

| Concern | Implementation |
|---|---|
| Credentials | Each workspace saves `key_id:secret`, Fernet-encrypted in SQLite. Only a hint (`••••abcd`) is returned. Verified before saving with a free status lookup (404 = valid key, 401 = invalid) |
| Identity / ownership | A random token in an HttpOnly cookie. Every query is filtered by workspace, and a foreign ID returns 404 |
| Duplicate submissions | The client sends an `Idempotency-Key`, enforced by a UNIQUE `(workspace_id, idempotency_key)` constraint. A replay returns the original job |
| Ambiguous POST failures | Timeouts and 500/502/504 lead to `submission_unknown`, and the job is **never** resubmitted. Submissions use the SDK's `NoRetry` strategy because its default transport retries POSTs |
| Polling | Backoff 2s → 10s with jitter, and up to 30s on transient errors. The SDK's default retry is kept for GETs. It resumes after a restart. Rows orphaned mid-POST become `submission_unknown` |
| Terminal states | `completed`, `failed`, `nsfw`, `canceled`, plus local `rejected`, `timed_out` (after `GENERATION_TIMEOUT_SECONDS`, refreshable), and `stalled` (401/404 while polling, refreshable) |
| Webhooks | Optional `PUBLIC_WEBHOOK_BASE_URL` (HTTPS). Each job gets a URL with a secret token. A webhook only triggers an authenticated re-poll, and the payload is never trusted |
| CSRF | Mutating routes require `X-Requested-With: video-gen` |
| Logging | httpx is set to WARNING. Keys are never logged |

## Configuration (optional): `backend/.env`

See `backend/.env.example`. Everything has a working default:
`APP_ENCRYPTION_KEY` (set this in production; otherwise `data/secret.key` is auto-created),
`PUBLIC_WEBHOOK_BASE_URL`, `GENERATION_TIMEOUT_SECONDS`, `DATABASE_PATH`, `CORS_ORIGINS`, `COOKIE_SECURE`.

## Tests

`cd backend && uv run pytest`: 29 tests, all offline. They cover the API flow with a fake gateway, plus
the real SDK against `httpx.MockTransport`: POST sent once on a 5xx, error classification, and GET retries.
