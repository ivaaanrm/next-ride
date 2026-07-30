from __future__ import annotations

# `Decimal` se importa en tiempo de ejecución: SQLAlchemy resuelve las
# anotaciones `Mapped[...]` al mapear la clase, no solo en tipado estático.
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, ForeignKey, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin

if TYPE_CHECKING:
    from app.models.offer import Offer
    from app.models.user import User


class CarModel(Base, TimestampMixin):
    """Un modelo concreto (marca + modelo, opcionalmente acabado)."""

    __tablename__ = "car_models"
    __table_args__ = (UniqueConstraint("make", "model", "trim", name="uq_car_model_identity"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(200), unique=True, index=True, nullable=False)
    make: Mapped[str] = mapped_column(String(80), index=True, nullable=False)
    model: Mapped[str] = mapped_column(String(120), index=True, nullable=False)
    trim: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    body_type: Mapped[str | None] = mapped_column(String(40))
    # Precio de referencia de mercado / PVP, sirve de ancla para el descuento.
    reference_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    offers: Mapped[list[Offer]] = relationship(back_populates="car_model")
    trackers: Mapped[list[TrackedModel]] = relationship(
        back_populates="car_model", cascade="all, delete-orphan"
    )

    @property
    def display_name(self) -> str:
        return " ".join(part for part in (self.make, self.model, self.trim) if part)


class TrackedModel(Base, TimestampMixin):
    """Modelo que un usuario decide seguir en la plataforma."""

    __tablename__ = "tracked_models"
    __table_args__ = (UniqueConstraint("user_id", "car_model_id", name="uq_tracked_model"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    car_model_id: Mapped[int] = mapped_column(
        ForeignKey("car_models.id", ondelete="CASCADE"), index=True, nullable=False
    )
    target_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    max_mileage_km: Mapped[int | None] = mapped_column()
    min_year: Mapped[int | None] = mapped_column()
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    notes: Mapped[str | None] = mapped_column(String(1000))

    user: Mapped[User] = relationship(back_populates="tracked_models")
    car_model: Mapped[CarModel] = relationship(back_populates="trackers")
