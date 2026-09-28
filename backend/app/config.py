from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    # SQLite file holding workspaces, encrypted credentials and generation jobs.
    database_path: Path = BACKEND_DIR / "data" / "app.db"

    # Fernet key used to encrypt saved Higgsfield credentials at rest.
    # Leave empty to auto-generate one into data/secret.key (fine for local use).
    app_encryption_key: str = ""

    # Public HTTPS base URL of this backend (e.g. an ngrok/Cloudflare tunnel).
    # When set, submissions include an hf_webhook URL; polling remains the recovery path.
    public_webhook_base_url: str = ""

    # Stop polling a job locally after this many seconds (the job is NOT resubmitted).
    generation_timeout_seconds: int = 45 * 60

    # Comma-separated origins allowed by CORS (the Vite dev server proxies /api, so
    # this is only needed when the frontend is served from a different origin).
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    cookie_secure: bool = False


@lru_cache
def get_settings() -> Settings:
    return Settings()
