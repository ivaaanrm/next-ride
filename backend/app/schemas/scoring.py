"""Configuración y desglose de la puntuación de valor.

La puntuación es una media ponderada de componentes 0-100. Estos esquemas son
el contrato con el frontend: los pesos que se editan en Ajustes, los parámetros
del modelo de depreciación y el desglose por oferta que hace la cifra auditable.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# --------------------------------------------------------------------------- #
# Pesos
# --------------------------------------------------------------------------- #
class ScoreWeights(BaseModel):
    """Peso relativo de cada componente.

    No tienen que sumar 100: el peso final de una oferta se renormaliza sobre
    los componentes con dato (`weight_pct` en el desglose). Los ocho automáticos
    —los que salen del anuncio— sí suman 100 por defecto, para que se lean como
    porcentajes; las dos notas manuales añaden 5 cada una **por encima** de ese
    presupuesto.

    Ese «por encima» es deliberado y no un descuadre: repartir los 100 de siempre
    para hacerles sitio habría movido hoy la puntuación de todo el catálogo, y sin
    una sola nota puesta. Así no se mueve nada hasta que alguien valore un coche,
    que es cuando la nota tiene algo que decir.
    """

    model_config = ConfigDict(extra="forbid")

    price_vs_market: float = Field(default=30, ge=0, le=100)
    price_vs_expected: float = Field(default=25, ge=0, le=100)
    mileage: float = Field(default=15, ge=0, le=100)
    age: float = Field(default=10, ge=0, le=100)
    power: float = Field(default=5, ge=0, le=100)
    transmission: float = Field(default=5, ge=0, le=100)
    equipment: float = Field(default=5, ge=0, le=100)
    apparent_condition: float = Field(default=5, ge=0, le=100)
    price_drop: float = Field(default=5, ge=0, le=100)
    freshness: float = Field(default=5, ge=0, le=100)

    @model_validator(mode="after")
    def _at_least_one(self) -> ScoreWeights:
        if all(value <= 0 for value in self.model_dump().values()):
            raise ValueError("Al menos un peso debe ser mayor que cero")
        return self


# --------------------------------------------------------------------------- #
# Parámetros del modelo
# --------------------------------------------------------------------------- #
class ScoreParams(BaseModel):
    """Constantes del modelo, editables por API.

    `residual_curve[n]` es la fracción del PVP que conserva un coche de `n`
    años. La curva por defecto es la depreciación media del mercado español
    (≈ -20 % el primer año, -10 % anual hasta el quinto, más suave después);
    pasado el último punto se aplica `residual_late_decay` anual con el suelo
    `residual_floor`.
    """

    model_config = ConfigDict(extra="forbid")

    expected_km_per_year: float = Field(default=15000, gt=0, le=100000)
    residual_curve: list[float] = Field(
        default=[0.93, 0.80, 0.70, 0.62, 0.55, 0.49, 0.44, 0.40, 0.36, 0.33, 0.30],
        min_length=2,
        max_length=30,
    )
    residual_late_decay: float = Field(default=0.93, gt=0.5, lt=1)
    residual_floor: float = Field(default=0.08, gt=0, lt=0.5)
    # Cada 10.000 km por encima (o debajo) de lo esperado mueve el valor
    # esperado este porcentaje. Acotado en `expected_price` a ±15 %.
    mileage_adjustment_per_10k_pct: float = Field(default=1.5, ge=0, le=10)

    # «Escala completa»: desviación que lleva el subscore de 50 al extremo.
    market_full_scale_pct: float = Field(default=25, gt=0, le=100)
    expected_full_scale_pct: float = Field(default=40, gt=0, le=100)
    mileage_full_scale_pct: float = Field(default=100, gt=0, le=300)
    price_drop_full_scale_pct: float = Field(default=10, gt=0, le=100)

    age_zero_score_years: float = Field(default=15, gt=1, le=40)
    freshness_zero_score_days: float = Field(default=60, gt=0, le=365)
    min_market_comparables: int = Field(default=3, ge=2, le=50)

    # Potencia: rampa entre el CV que puntúa 0 y el que puntúa 100, curvada por
    # el exponente. Con 1 la rampa es lineal; por encima, la curva es plana abajo
    # y empinada arriba, así que los CV ganados cerca del tope valen más que los
    # ganados cerca del suelo (con 2, la mitad de la rampa puntúa 25 y no 50).
    power_zero_score_hp: float = Field(default=100, ge=0, le=500)
    power_full_score_hp: float = Field(default=200, gt=0, le=1000)
    power_curve_exponent: float = Field(default=2.0, ge=1, le=5)

    @model_validator(mode="after")
    def _power_ramp_ordered(self) -> ScoreParams:
        if self.power_full_score_hp <= self.power_zero_score_hp:
            raise ValueError("power_full_score_hp debe ser mayor que power_zero_score_hp")
        return self

    @field_validator("residual_curve")
    @classmethod
    def _decreasing_fractions(cls, curve: list[float]) -> list[float]:
        if any(not 0 < value <= 1 for value in curve):
            raise ValueError("Cada punto de la curva debe estar en (0, 1]")
        if any(later > earlier for earlier, later in zip(curve, curve[1:], strict=False)):
            raise ValueError("La curva residual no puede crecer con la edad")
        return curve


# --------------------------------------------------------------------------- #
# Lectura / edición
# --------------------------------------------------------------------------- #
class ScoreComponentInfo(BaseModel):
    """Qué mide un componente, contado por el backend.

    El texto vive aquí y no en el frontend para que la explicación y el cálculo
    no puedan divergir: se generan de los mismos parámetros.
    """

    key: str
    label: str
    description: str
    weight: float
    weight_pct: float
    default_weight: float


class ScoreConfigRead(BaseModel):
    weights: ScoreWeights
    params: ScoreParams
    components: list[ScoreComponentInfo]
    default_weights: ScoreWeights
    default_params: ScoreParams
    updated_at: datetime | None = None


class ScoreConfigUpdate(BaseModel):
    """PUT parcial: lo que no venga se conserva."""

    model_config = ConfigDict(extra="forbid")

    weights: ScoreWeights | None = None
    params: ScoreParams | None = None


# --------------------------------------------------------------------------- #
# Desglose por oferta
# --------------------------------------------------------------------------- #
class ScoreBreakdownItem(BaseModel):
    """La aportación de un componente a la puntuación de una oferta.

    `sum(points)` es la puntuación final: la cifra es auditable línea a línea.
    Un componente sin dato viaja igualmente con `available=False` y peso 0,
    para que el frontend pueda decir *qué* faltó, no solo que faltó algo.
    """

    key: str
    label: str
    available: bool
    # Magnitud en su unidad natural (%, años, días, CV…), para mostrarla.
    metric: float | None = None
    unit: str = ""
    # Para señales categóricas (cambio automático/manual): lo que se enseña en
    # lugar del número.
    text: str | None = None
    subscore: float | None = None
    weight: float
    weight_pct: float
    points: float | None = None
