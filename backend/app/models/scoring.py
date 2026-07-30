from __future__ import annotations

from typing import Any

from sqlalchemy import JSON
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


class ScoreConfig(Base, TimestampMixin):
    """Configuración de la puntuación de valor: una sola fila para toda la app.

    Los pesos y parámetros van en JSON y no en columnas porque su esquema es el
    Pydantic de `app.schemas.scoring`, que ya valida en el borde de la API;
    añadir un componente nuevo no debe requerir migración. La fila puede no
    existir: en ese caso rigen los defaults del esquema.
    """

    __tablename__ = "score_config"

    id: Mapped[int] = mapped_column(primary_key=True)
    weights: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
