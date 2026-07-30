"""Todos los modelos se importan aquí para que `Base.metadata` esté completo."""

from app.models.base import Base, TimestampMixin, utcnow
from app.models.car_model import CarModel, TrackedModel
from app.models.dealer import Dealer
from app.models.offer import (
    FuelType,
    Offer,
    OfferFavorite,
    OfferPriceHistory,
    OfferStatus,
    Transmission,
    VehicleCondition,
)
from app.models.ranking import OfferRanking, RankingRun, RunStatus, Verdict
from app.models.user import ApiKey, User

__all__ = [
    "ApiKey",
    "Base",
    "CarModel",
    "Dealer",
    "FuelType",
    "Offer",
    "OfferFavorite",
    "OfferPriceHistory",
    "OfferRanking",
    "OfferStatus",
    "RankingRun",
    "RunStatus",
    "TimestampMixin",
    "TrackedModel",
    "Transmission",
    "User",
    "VehicleCondition",
    "Verdict",
    "utcnow",
]
