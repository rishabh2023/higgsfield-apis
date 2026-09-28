"""Encryption of saved Higgsfield credentials at rest."""

import os
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings


@lru_cache
def _fernet() -> Fernet:
    settings = get_settings()
    if settings.app_encryption_key:
        return Fernet(settings.app_encryption_key.encode())

    key_path = settings.database_path.parent / "secret.key"
    key_path.parent.mkdir(parents=True, exist_ok=True)
    if not key_path.exists():
        fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(Fernet.generate_key())
    return Fernet(key_path.read_bytes().strip())


def encrypt(plaintext: str) -> bytes:
    return _fernet().encrypt(plaintext.encode())


def decrypt(token: bytes) -> str | None:
    try:
        return _fernet().decrypt(token).decode()
    except InvalidToken:
        # Encryption key changed since the credential was saved.
        return None


def key_hint(key_id: str) -> str:
    """Non-secret preview of a key ID for the UI (never reveals the secret)."""
    tail = key_id[-4:] if len(key_id) >= 8 else ""
    return f"••••{tail}"
