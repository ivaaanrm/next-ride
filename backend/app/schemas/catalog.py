from datetime import datetime

from pydantic import BaseModel, Field, computed_field, model_validator

from app.schemas.common import ORMModel


# --------------------------------------------------------------------------- #
# Dealers
# --------------------------------------------------------------------------- #
class DealerBase(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    website: str | None = Field(default=None, max_length=500)
    city: str | None = Field(default=None, max_length=120)
    country: str | None = Field(default=None, min_length=2, max_length=2)
    rating: float | None = Field(default=None, ge=0, le=5)
    notes: str | None = Field(default=None, max_length=1000)


class DealerCreate(DealerBase):
    slug: str | None = Field(default=None, max_length=140)


class DealerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    website: str | None = Field(default=None, max_length=500)
    city: str | None = Field(default=None, max_length=120)
    country: str | None = Field(default=None, min_length=2, max_length=2)
    rating: float | None = Field(default=None, ge=0, le=5)
    is_active: bool | None = None
    notes: str | None = Field(default=None, max_length=1000)


class DealerRead(ORMModel):
    id: int
    slug: str
    name: str
    website: str | None
    city: str | None
    country: str | None
    rating: float | None
    is_active: bool
    notes: str | None
    created_at: datetime


class DealerWithStats(DealerRead):
    active_offers: int = 0
    avg_discount_pct: float | None = None
    best_price: float | None = None


# --------------------------------------------------------------------------- #
# Car models
# --------------------------------------------------------------------------- #
class CarModelBase(BaseModel):
    make: str = Field(min_length=1, max_length=80)
    model: str = Field(min_length=1, max_length=120)
    trim: str = Field(default="", max_length=120)
    body_type: str | None = Field(default=None, max_length=40)
    reference_price: float | None = Field(default=None, ge=0)


class CarModelCreate(CarModelBase):
    pass


class CarModelUpdate(BaseModel):
    body_type: str | None = Field(default=None, max_length=40)
    reference_price: float | None = Field(default=None, ge=0)
    is_active: bool | None = None


class CarModelRead(ORMModel):
    id: int
    slug: str
    make: str
    model: str
    trim: str
    body_type: str | None
    reference_price: float | None
    is_active: bool

    @computed_field
    @property
    def display_name(self) -> str:
        return " ".join(part for part in (self.make, self.model, self.trim) if part)


# --------------------------------------------------------------------------- #
# Tracked models
# --------------------------------------------------------------------------- #
class TrackedModelCriteria(BaseModel):
    """Criterios de seguimiento. Comunes a crear, actualizar y leer."""

    target_price: float | None = Field(default=None, ge=0)
    max_mileage_km: int | None = Field(default=None, ge=0)
    min_year: int | None = Field(default=None, ge=1950, le=2100)
    notes: str | None = Field(default=None, max_length=1000)


class TrackedModelCreate(TrackedModelCriteria):
    """Empieza a seguir un modelo.

    Se identifica con `car_model_id` si el modelo ya existe, o con
    `make` + `model` (+ `trim`) para crearlo en la misma llamada: seguir un
    modelo que todavía no está en el catálogo no debería ser un flujo de dos
    pasos con un 409 en medio.
    """

    car_model_id: int | None = None
    make: str | None = Field(default=None, min_length=1, max_length=80)
    model: str | None = Field(default=None, min_length=1, max_length=120)
    trim: str = Field(default="", max_length=120)
    # Solo se aplica si el modelo se crea aquí o no tenía PVP de referencia.
    reference_price: float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _require_identity(self) -> "TrackedModelCreate":
        if self.car_model_id is None and not (self.make and self.model):
            raise ValueError("Aporta 'car_model_id', o 'make' y 'model' para crear el modelo")
        return self


class TrackedModelUpdate(TrackedModelCriteria):
    is_active: bool | None = None


class TrackedModelPrefs(ORMModel):
    """Los criterios que el usuario actual tiene puestos sobre un modelo."""

    id: int
    target_price: float | None
    max_mileage_km: int | None
    min_year: int | None
    notes: str | None


class TrackedModelRead(ORMModel):
    id: int
    car_model_id: int
    target_price: float | None
    max_mileage_km: int | None
    min_year: int | None
    is_active: bool
    notes: str | None
    car_model: CarModelRead


# --------------------------------------------------------------------------- #
# Car models con agregados (se define al final: depende de TrackedModelPrefs)
# --------------------------------------------------------------------------- #
class CarModelWithStats(CarModelRead):
    active_offers: int = 0
    min_price: float | None = None
    median_price: float | None = None
    max_price: float | None = None
    dealers_count: int = 0
    is_tracked: bool = False
    # Criterios del usuario actual; `None` si no lo sigue.
    tracking: TrackedModelPrefs | None = None
    last_ranked_at: datetime | None = None
