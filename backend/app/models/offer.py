from __future__ import annotations

import enum
from datetime import datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy import (
    JSON,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Numeric,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin

if TYPE_CHECKING:
    from app.models.car_model import CarModel
    from app.models.dealer import Dealer
    from app.models.user import User


class OfferStatus(str, enum.Enum):
    ACTIVE = "active"
    #  Descartada manualmente por un usuario desde la plataforma.
    DISMISSED = "dismissed"
    #  El scraper la marcó como ya no disponible en el origen.
    EXPIRED = "expired"


class VehicleCondition(str, enum.Enum):
    NEW = "new"
    KM0 = "km0"
    USED = "used"
    DEMO = "demo"


class FuelType(str, enum.Enum):
    PETROL = "petrol"
    DIESEL = "diesel"
    HYBRID = "hybrid"
    PLUGIN_HYBRID = "plugin_hybrid"
    ELECTRIC = "electric"
    LPG = "lpg"
    OTHER = "other"


class Transmission(str, enum.Enum):
    MANUAL = "manual"
    AUTOMATIC = "automatic"
    OTHER = "other"


def _enum_col(enum_cls: type[enum.Enum], name: str):
    """VARCHAR + CHECK en vez de tipo ENUM nativo: migraciones menos dolorosas."""
    return Enum(enum_cls, name=name, native_enum=False, values_callable=lambda e: [m.value for m in e])


class Offer(Base, TimestampMixin):
    __tablename__ = "offers"
    __table_args__ = (
        Index("ix_offers_model_status_price", "car_model_id", "status", "price"),
        Index("ix_offers_dealer_status", "dealer_id", "status"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)

    # Identidad en el origen. `url` es la clave natural para el upsert.
    url: Mapped[str] = mapped_column(String(1000), unique=True, nullable=False)
    external_id: Mapped[str | None] = mapped_column(String(200), index=True)
    source: Mapped[str | None] = mapped_column(String(80))

    dealer_id: Mapped[int] = mapped_column(
        ForeignKey("dealers.id", ondelete="RESTRICT"), index=True, nullable=False
    )
    car_model_id: Mapped[int] = mapped_column(
        ForeignKey("car_models.id", ondelete="RESTRICT"), index=True, nullable=False
    )

    title: Mapped[str] = mapped_column(String(400), nullable=False)
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    # PVP / precio antes de descuento anunciado por el dealer.
    original_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    currency: Mapped[str] = mapped_column(String(3), default="EUR", nullable=False)

    year: Mapped[int | None] = mapped_column()
    mileage_km: Mapped[int | None] = mapped_column()
    power_hp: Mapped[int | None] = mapped_column()
    condition: Mapped[VehicleCondition] = mapped_column(
        _enum_col(VehicleCondition, "vehicle_condition"),
        default=VehicleCondition.USED,
        nullable=False,
    )
    fuel_type: Mapped[FuelType | None] = mapped_column(_enum_col(FuelType, "fuel_type"))
    transmission: Mapped[Transmission | None] = mapped_column(
        _enum_col(Transmission, "transmission")
    )
    location: Mapped[str | None] = mapped_column(String(160))
    image_url: Mapped[str | None] = mapped_column(String(1000))

    status: Mapped[OfferStatus] = mapped_column(
        _enum_col(OfferStatus, "offer_status"), default=OfferStatus.ACTIVE, nullable=False
    )
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    dismissed_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    dismiss_reason: Mapped[str | None] = mapped_column(String(500))

    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    # Corrección manual: qué columnas ha escrito una persona a mano.
    #
    # No es metadato decorativo, es lo único que hace que corregir sirva de algo:
    # `upsert_offer` reescribe la fila entera en cada pase del scraper, así que un
    # año arreglado a mano duraría hasta el siguiente rastreo. Los campos que
    # están en esta lista el scraper no los toca; el resto los sigue mandando él.
    #
    # Es de la oferta y no del usuario —al contrario que los favoritos—: la
    # corrección afirma algo sobre el coche («este anuncio dice 2019 y el coche es
    # de 2018»), no sobre quien la escribió.
    manual_fields: Mapped[list[str]] = mapped_column(
        JSON, default=list, server_default=text("'[]'"), nullable=False
    )
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    edited_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))

    # Payload crudo del scraper, para depurar y para re-procesar sin re-scrapear.
    raw: Mapped[dict[str, Any] | None] = mapped_column(JSON)

    dealer: Mapped[Dealer] = relationship(back_populates="offers", lazy="joined")
    car_model: Mapped[CarModel] = relationship(back_populates="offers", lazy="joined")
    dismissed_by: Mapped[User | None] = relationship(foreign_keys=[dismissed_by_id])
    price_history: Mapped[list[OfferPriceHistory]] = relationship(
        back_populates="offer",
        cascade="all, delete-orphan",
        order_by="OfferPriceHistory.recorded_at",
    )


class OfferPriceHistory(Base):
    """Se anota un registro cada vez que el scraper reporta un precio distinto."""

    __tablename__ = "offer_price_history"

    id: Mapped[int] = mapped_column(primary_key=True)
    offer_id: Mapped[int] = mapped_column(
        ForeignKey("offers.id", ondelete="CASCADE"), index=True, nullable=False
    )
    price: Mapped[Decimal] = mapped_column(Numeric(12, 2), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    offer: Mapped[Offer] = relationship(back_populates="price_history")


class OfferFavorite(Base):
    """Oferta marcada por un usuario concreto.

    Es una marca *personal*, no un estado de la oferta: dos usuarios ven la
    misma oferta con favoritos distintos. Por eso vive en su propia tabla y no
    como columna de `offers` (que es compartida y la alimenta el scraper).
    """

    __tablename__ = "offer_favorites"
    __table_args__ = (UniqueConstraint("user_id", "offer_id", name="uq_offer_favorite"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    offer_id: Mapped[int] = mapped_column(
        ForeignKey("offers.id", ondelete="CASCADE"), index=True, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    user: Mapped[User] = relationship(back_populates="favorites")
