"""Hashing de contraseñas, JWT y generación/verificación de API keys."""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import bcrypt
from jose import JWTError, jwt

from app.core.config import settings

TokenType = Literal["access", "refresh"]

# bcrypt trunca silenciosamente a 72 bytes; lo hacemos explícito.
_BCRYPT_MAX_BYTES = 72
API_KEY_PREFIX = "nr"


# --------------------------------------------------------------------------- #
# Contraseñas
# --------------------------------------------------------------------------- #
def hash_password(password: str) -> str:
    payload = password.encode("utf-8")[:_BCRYPT_MAX_BYTES]
    return bcrypt.hashpw(payload, bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        payload = password.encode("utf-8")[:_BCRYPT_MAX_BYTES]
        return bcrypt.checkpw(payload, hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


# --------------------------------------------------------------------------- #
# JWT
# --------------------------------------------------------------------------- #
def _create_token(subject: str | int, token_type: TokenType, expires_delta: timedelta) -> str:
    now = datetime.now(UTC)
    payload: dict[str, Any] = {
        "sub": str(subject),
        "type": token_type,
        "iat": int(now.timestamp()),
        "exp": int((now + expires_delta).timestamp()),
        "jti": secrets.token_urlsafe(8),
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def create_access_token(subject: str | int) -> str:
    return _create_token(
        subject, "access", timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    )


def create_refresh_token(subject: str | int) -> str:
    return _create_token(subject, "refresh", timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS))


def decode_token(token: str, expected_type: TokenType) -> dict[str, Any] | None:
    """Devuelve el payload si el token es válido y del tipo esperado, si no None."""
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        return None
    if payload.get("type") != expected_type:
        return None
    if not payload.get("sub"):
        return None
    return payload


# --------------------------------------------------------------------------- #
# API keys (servicio scraper)
# --------------------------------------------------------------------------- #
def generate_api_key() -> tuple[str, str, str]:
    """Devuelve `(clave_en_claro, prefijo, hash)`.

    La clave en claro solo se muestra una vez, en la respuesta de creación.
    """
    prefix = secrets.token_hex(4)
    secret = secrets.token_urlsafe(32)
    raw = f"{API_KEY_PREFIX}_{prefix}_{secret}"
    return raw, prefix, hash_api_key(raw)


def hash_api_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def api_key_prefix(raw: str) -> str | None:
    parts = raw.split("_")
    if len(parts) < 3 or parts[0] != API_KEY_PREFIX:
        return None
    return parts[1]
