from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, HttpUrl, field_validator

from app.models.offer import FuelType, OfferStatus, Transmission, VehicleCondition
from app.schemas.catalog import CarModelRead, DealerRead
from app.schemas.common import ORMModel


class OfferMetrics(BaseModel):
    """Métricas derivadas, calculadas por el backend (no se persisten)."""

    discount_pct: float | None = None
    price_vs_median_pct: float | None = None
    price_vs_reference_pct: float | None = None
    price_drop_pct: float | None = None
    days_listed: int = 0
    km_per_year: float | None = None
    value_score: float | None = None


class OfferRankSummary(BaseModel):
    """Último veredicto del agente para esta oferta."""

    rank: int
    score: int
    verdict: str
    reasoning: str | None = None
    run_id: int
    ranked_at: datetime


class OfferRead(ORMModel):
    id: int
    url: str
    external_id: str | None
    source: str | None
    title: str
    price: float
    original_price: float | None
    currency: str
    year: int | None
    mileage_km: int | None
    power_hp: int | None
    condition: VehicleCondition
    fuel_type: FuelType | None
    transmission: Transmission | None
    location: str | None
    image_url: str | None
    status: OfferStatus
    first_seen_at: datetime
    last_seen_at: datetime
    dismissed_at: datetime | None
    dismiss_reason: str | None
    dealer: DealerRead
    car_model: CarModelRead

    metrics: OfferMetrics = Field(default_factory=OfferMetrics)
    ai: OfferRankSummary | None = None
    # Marca del usuario que hace la petición, no un atributo de la oferta.
    is_favorite: bool = False


# --------------------------------------------------------------------------- #
# Ingesta (la usa el servicio scraper)
# --------------------------------------------------------------------------- #
class OfferIngest(BaseModel):
    """Una oferta encontrada. El dealer y el modelo se resuelven (o se crean) por nombre."""

    url: HttpUrl
    title: str = Field(min_length=1, max_length=400)
    price: float = Field(gt=0)

    dealer_name: str = Field(min_length=1, max_length=200)
    dealer_website: str | None = Field(default=None, max_length=500)
    dealer_city: str | None = Field(default=None, max_length=120)
    dealer_country: str | None = Field(default=None, min_length=2, max_length=2)

    make: str = Field(min_length=1, max_length=80)
    model: str = Field(min_length=1, max_length=120)
    trim: str = Field(default="", max_length=120)

    original_price: float | None = Field(default=None, gt=0)
    currency: str = Field(default="EUR", min_length=3, max_length=3)
    external_id: str | None = Field(default=None, max_length=200)
    source: str | None = Field(default=None, max_length=80)
    year: int | None = Field(default=None, ge=1950, le=2100)
    mileage_km: int | None = Field(default=None, ge=0)
    power_hp: int | None = Field(default=None, ge=0)
    condition: VehicleCondition = VehicleCondition.USED
    fuel_type: FuelType | None = None
    transmission: Transmission | None = None
    location: str | None = Field(default=None, max_length=160)
    image_url: str | None = Field(default=None, max_length=1000)
    raw: dict[str, Any] | None = None

    @field_validator("currency")
    @classmethod
    def _upper_currency(cls, value: str) -> str:
        return value.upper()

    @field_validator("dealer_country")
    @classmethod
    def _upper_country(cls, value: str | None) -> str | None:
        return value.upper() if value else value


class OfferBulkIngest(BaseModel):
    """Lote de ofertas.

    Cada elemento se valida por separado contra `OfferIngest`: una oferta mal
    formada se reporta en `IngestResult.errors` en lugar de invalidar el lote
    completo. Es lo que necesita un scraper que ataca muchos dealers a la vez.
    """

    offers: list[dict[str, Any]] = Field(
        min_length=1,
        max_length=500,
        description="Ofertas con el mismo esquema que el body de POST /offers (OfferIngest).",
    )


class IngestResult(BaseModel):
    created: int = 0
    updated: int = 0
    skipped: int = 0
    errors: list[str] = Field(default_factory=list)
    offer_ids: list[int] = Field(default_factory=list)


class OfferDismiss(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


class OfferPricePoint(ORMModel):
    price: float
    recorded_at: datetime


class OfferRawRead(ORMModel):
    """Payload tal cual lo mandó el scraper.

    Vive en su propio endpoint y no en `OfferRead` a propósito: un listado de 50
    ofertas con su `raw` dentro pesa lo que no está escrito, y casi nunca se mira.
    """

    raw: dict[str, Any] | None = None


# --------------------------------------------------------------------------- #
# Estadísticas
# --------------------------------------------------------------------------- #
class ModelPriceStats(BaseModel):
    car_model_id: int
    count: int
    min_price: float | None = None
    median_price: float | None = None
    max_price: float | None = None
    avg_price: float | None = None
    avg_mileage_km: float | None = None
    avg_year: float | None = None
    dealers_count: int = 0


class OverviewStats(BaseModel):
    active_offers: int
    dismissed_offers: int
    favorite_offers: int
    dealers: int
    car_models: int
    tracked_models: int
    avg_discount_pct: float | None = None
    best_deal: OfferRead | None = None
    ai_enabled: bool


class OfferAggregateStats(BaseModel):
    """Agregados sobre el conjunto **filtrado**, no sobre todo el catálogo.

    Comparten los filtros exactos del listado (`OfferFilters`), así que describen
    justo las filas que se están viendo: filtrar por modelo y ver la media de
    precio de todo el catálogo sería peor que no ver nada.

    Las medias salen de un `AVG` en SQL sobre el conjunto entero. `best_deal` no:
    la puntuación de valor se calcula en Python, así que se acota igual que el
    orden por puntuación del listado y puede quedarse corta en catálogos grandes.
    """

    count: int
    car_models: int
    avg_price: float | None = None
    avg_mileage_km: float | None = None
    avg_km_per_year: float | None = None
    avg_discount_pct: float | None = None
    best_deal: OfferRead | None = None
    ai_enabled: bool

    # Extremos del conjunto para los controles de rango, calculados **ignorando**
    # cada uno su propio filtro (`min_price`/`max_price` para el precio,
    # `min_year`/`max_year` para el año). No son un agregado de lo que se ve, son
    # el dominio del deslizador: si se recalcularan con el filtro puesto, el
    # carril se encogería a la propia selección en cada arrastre y no habría
    # vuelta atrás. Los demás filtros sí cuentan, incluido el del otro rango:
    # acotar a un modelo, o al precio, sí debe recortar el carril de los años.
    price_floor: float | None = None
    price_ceiling: float | None = None
    year_floor: int | None = None
    year_ceiling: int | None = None
