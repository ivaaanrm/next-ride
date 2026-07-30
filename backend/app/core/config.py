from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False
    )

    # --- App ---
    PROJECT_NAME: str = "next-ride"
    ENVIRONMENT: Literal["local", "staging", "production"] = "local"
    API_V1_PREFIX: str = "/api/v1"
    LOG_LEVEL: str = "INFO"

    # --- Database ---
    POSTGRES_HOST: str = "db"
    POSTGRES_PORT: int = 5432
    POSTGRES_USER: str = "nextride"
    POSTGRES_PASSWORD: str = "nextride"
    POSTGRES_DB: str = "nextride"
    DB_ECHO: bool = False
    # v1: crea el esquema al arrancar. Alembic queda configurado para cuando
    # el esquema empiece a evolucionar (ver README).
    AUTO_CREATE_TABLES: bool = True

    # --- Auth ---
    SECRET_KEY: str = "change-me-in-production"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 12
    REFRESH_TOKEN_EXPIRE_DAYS: int = 14
    ALGORITHM: str = "HS256"
    ALLOW_REGISTRATION: bool = True

    FIRST_SUPERUSER_EMAIL: str | None = "admin@next-ride.dev"
    FIRST_SUPERUSER_PASSWORD: str | None = "changeme123"

    # Clave de API con la que arranca el scraper (opcional). Si se define, se
    # crea/reactiva al arrancar para que el servicio externo pueda ingestar ya.
    BOOTSTRAP_SCRAPER_API_KEY: str | None = None

    # --- CORS ---
    # Se guarda como cadena separada por comas: pydantic-settings intentaría
    # parsear un `list[str]` como JSON al leerlo del entorno.
    CORS_ORIGINS: str = "http://localhost:5173,http://localhost:3000,http://localhost:8080"

    # --- Agente de IA ---
    ANTHROPIC_API_KEY: str | None = None
    ANTHROPIC_MODEL: str = "claude-opus-5"
    ANTHROPIC_MAX_TOKENS: int = 16000
    # low | medium | high | xhigh | max
    ANTHROPIC_EFFORT: Literal["low", "medium", "high", "xhigh", "max"] = "high"
    ANTHROPIC_ENABLE_FALLBACKS: bool = True
    RANKING_MAX_ITERATIONS: int = 10
    RANKING_MAX_OFFERS: int = 40

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",") if origin.strip()]

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}"
            f"@{self.POSTGRES_HOST}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"
        )

    @property
    def ai_enabled(self) -> bool:
        return bool(self.ANTHROPIC_API_KEY)


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
