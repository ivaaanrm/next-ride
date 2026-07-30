from datetime import datetime

from pydantic import BaseModel, Field

from app.models.ranking import RunStatus, Verdict
from app.schemas.common import ORMModel
from app.schemas.offer import OfferRead


class RankingRequest(BaseModel):
    """Parámetros opcionales para orientar al agente."""

    max_budget: float | None = Field(default=None, gt=0)
    max_mileage_km: int | None = Field(default=None, ge=0)
    min_year: int | None = Field(default=None, ge=1950, le=2100)
    priorities: str | None = Field(
        default=None,
        max_length=1000,
        description="Qué prioriza el usuario, en lenguaje natural. Ej: 'bajo kilometraje y garantía'",
    )


class RankedOffer(ORMModel):
    id: int
    offer_id: int
    rank: int
    score: int
    verdict: Verdict
    reasoning: str | None
    pros: list[str] | None
    cons: list[str] | None
    offer: OfferRead | None = None


class RankingRunRead(ORMModel):
    id: int
    # El run es de un binomio marca-modelo, no de una fila de `car_models`.
    make_model_key: str
    label: str
    status: RunStatus
    model_used: str | None
    effort: str | None
    offers_considered: int
    iterations: int
    input_tokens: int
    output_tokens: int
    summary: str | None
    error: str | None
    created_at: datetime
    finished_at: datetime | None


class RankingRunDetail(RankingRunRead):
    items: list[RankedOffer] = Field(default_factory=list)
    tool_trace: list[dict] | None = None
