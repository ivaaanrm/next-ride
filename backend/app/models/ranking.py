from __future__ import annotations

import enum
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    JSON,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base

if TYPE_CHECKING:
    from app.models.car_model import CarModel
    from app.models.offer import Offer


class RunStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"


class Verdict(str, enum.Enum):
    EXCELLENT = "excellent"
    GOOD = "good"
    FAIR = "fair"
    POOR = "poor"
    AVOID = "avoid"


def _enum_col(enum_cls: type[enum.Enum], name: str):
    return Enum(
        enum_cls, name=name, native_enum=False, values_callable=lambda e: [m.value for m in e]
    )


class RankingRun(Base):
    """Una ejecución del agente de IA sobre las ofertas de un modelo."""

    __tablename__ = "ranking_runs"
    __table_args__ = (Index("ix_ranking_runs_model_created", "car_model_id", "created_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    car_model_id: Mapped[int] = mapped_column(
        ForeignKey("car_models.id", ondelete="CASCADE"), index=True, nullable=False
    )
    status: Mapped[RunStatus] = mapped_column(
        _enum_col(RunStatus, "run_status"), default=RunStatus.PENDING, nullable=False
    )
    triggered_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    model_used: Mapped[str | None] = mapped_column(String(80))
    effort: Mapped[str | None] = mapped_column(String(16))
    offers_considered: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    iterations: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    summary: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    # Traza de tools usadas: [{"tool": "...", "input": {...}}]
    tool_trace: Mapped[list | None] = mapped_column(JSON)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    car_model: Mapped[CarModel] = relationship(lazy="joined")
    items: Mapped[list[OfferRanking]] = relationship(
        back_populates="run", cascade="all, delete-orphan", order_by="OfferRanking.rank"
    )


class OfferRanking(Base):
    """Veredicto del agente para una oferta concreta dentro de un run."""

    __tablename__ = "offer_rankings"
    __table_args__ = (Index("ix_offer_rankings_run_rank", "run_id", "rank"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(
        ForeignKey("ranking_runs.id", ondelete="CASCADE"), index=True, nullable=False
    )
    offer_id: Mapped[int] = mapped_column(
        ForeignKey("offers.id", ondelete="CASCADE"), index=True, nullable=False
    )
    rank: Mapped[int] = mapped_column(Integer, nullable=False)
    score: Mapped[int] = mapped_column(Integer, nullable=False)
    verdict: Mapped[Verdict] = mapped_column(_enum_col(Verdict, "verdict"), nullable=False)
    reasoning: Mapped[str | None] = mapped_column(Text)
    pros: Mapped[list | None] = mapped_column(JSON)
    cons: Mapped[list | None] = mapped_column(JSON)

    run: Mapped[RankingRun] = relationship(back_populates="items")
    offer: Mapped[Offer] = relationship(lazy="joined")
