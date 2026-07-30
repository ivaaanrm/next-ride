from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin

if TYPE_CHECKING:
    from collections.abc import Sequence


class ScrapeSource(Base, TimestampMixin):
    """Portal o dealer desde el que el scraper obtiene inventario.

    No es ``Dealer``: ese modelo representa al vendedor real que aparece en una
    oferta. Una fuente puede contener anuncios de muchos vendedores.
    """

    __tablename__ = "scrape_sources"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(80), unique=True, index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    base_url: Mapped[str] = mapped_column(String(500), nullable=False)
    search_url_template: Mapped[str | None] = mapped_column(String(1000))
    listing_url: Mapped[str | None] = mapped_column(String(1000))
    access: Mapped[str] = mapped_column(String(24), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    targets: Mapped[list[ScrapeTarget]] = relationship(
        back_populates="source", cascade="all, delete-orphan"
    )


class ScrapeTarget(Base, TimestampMixin):
    """Una combinación concreta de binomio marca-modelo y fuente."""

    __tablename__ = "scrape_targets"
    __table_args__ = (
        UniqueConstraint("source_id", "make_model_key", name="uq_scrape_target_source_model"),
        Index("ix_scrape_targets_active", "is_active", "source_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    source_id: Mapped[int] = mapped_column(
        ForeignKey("scrape_sources.id", ondelete="CASCADE"), index=True, nullable=False
    )
    make_model_key: Mapped[str] = mapped_column(String(200), index=True, nullable=False)
    make: Mapped[str] = mapped_column(String(80), nullable=False)
    model: Mapped[str] = mapped_column(String(120), nullable=False)
    max_results: Mapped[int] = mapped_column(Integer, default=15, nullable=False)
    # Si la URL no sale de la plantilla de la fuente, el skill la descubre y
    # persiste aquí. Los ids/slugs específicos del portal viven en search_params.
    search_url: Mapped[str | None] = mapped_column(String(1000))
    search_params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    source: Mapped[ScrapeSource] = relationship(back_populates="targets")


def canonical_make_model_key(make: str, model: str) -> str:
    """Clave estable y legible compartida por API, UI y skill."""

    clean_make = " ".join(make.split()).casefold()
    clean_model = " ".join(model.split()).casefold()
    return f"{clean_make}|{clean_model}"


def target_pairs(targets: Sequence[ScrapeTarget]) -> set[tuple[int, str]]:
    """Identidad de una colección, útil al reemplazar la selección activa."""

    return {(target.source_id, target.make_model_key) for target in targets}
