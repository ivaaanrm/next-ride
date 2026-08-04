"""Puntuación de valor 0-100: algoritmo, configuración y desglose.

La puntuación es la **media ponderada de subscores 0-100**, uno por componente,
renormalizada sobre los componentes con dato. Ese diseño da tres garantías que
la heurística anterior (50 ± sumandos acotados) no daba:

- El rango es 0-100 de verdad, no un clamp de una suma que casi nunca llega.
- Dos ofertas con datos distintos son comparables: faltar un dato reparte su
  peso, no congela puntos en la mitad de la escala.
- Cada punto del resultado es rastreable: `sum(points)` del desglose **es** la
  puntuación, y los pesos finales viajan con cada oferta.

Casi todos los subscores son lineales con topes: 50 es neutro, la «escala
completa» de cada uno dice qué desviación lo lleva al extremo. La potencia es la
excepción: su rampa va curvada para premiar más los CV altos. Determinista
siempre: los mismos datos y la misma fecha dan la misma cifra.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from statistics import median
from typing import TYPE_CHECKING

from pydantic import BaseModel, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Transmission, VehicleCondition
from app.models.scoring import ScoreConfig
from app.schemas.scoring import (
    ScoreBreakdownItem,
    ScoreComponentInfo,
    ScoreParams,
    ScoreWeights,
)

if TYPE_CHECKING:
    from app.models import Offer
    from app.schemas.offer import OfferMetrics, PriceStats

logger = logging.getLogger(__name__)

_SINGLETON_ID = 1


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


# --------------------------------------------------------------------------- #
# Configuración
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ScoringConfig:
    weights: ScoreWeights
    params: ScoreParams
    updated_at: datetime | None = None


DEFAULT_CONFIG = ScoringConfig(weights=ScoreWeights(), params=ScoreParams())


def _validated[T: BaseModel](model_cls: type[T], stored: dict) -> T:
    """Lo guardado, validado contra el esquema actual.

    Filtra claves que ya no existan (un componente retirado no debe romper la
    lectura) y cae a los defaults si el JSON no valida: una configuración
    corrupta deja la app puntuando, no caída.
    """
    known = {key: value for key, value in stored.items() if key in model_cls.model_fields}
    try:
        return model_cls(**known)
    except ValidationError:
        logger.warning("Configuración de %s inválida en BD; se usan defaults", model_cls.__name__)
        return model_cls()


async def get_scoring_config(session: AsyncSession) -> ScoringConfig:
    """La configuración vigente; sin fila en BD rigen los defaults del esquema."""
    row = await session.get(ScoreConfig, _SINGLETON_ID)
    if row is None:
        return DEFAULT_CONFIG
    return ScoringConfig(
        weights=_validated(ScoreWeights, row.weights),
        params=_validated(ScoreParams, row.params),
        updated_at=row.updated_at,
    )


async def save_scoring_config(
    session: AsyncSession, weights: ScoreWeights | None, params: ScoreParams | None
) -> ScoringConfig:
    """Guarda lo que venga y conserva el resto. Crea la fila singleton si no existe."""
    row = await session.get(ScoreConfig, _SINGLETON_ID)
    current = await get_scoring_config(session)
    merged = ScoringConfig(
        weights=weights or current.weights,
        params=params or current.params,
    )
    if row is None:
        row = ScoreConfig(id=_SINGLETON_ID)
        session.add(row)
    row.weights = merged.weights.model_dump()
    row.params = merged.params.model_dump()
    await session.commit()
    # `updated_at` lo pone el servidor (`onupdate`), así que tras el commit ese
    # atributo queda expirado; sin refresh explícito, leerlo dispararía una
    # carga perezosa fuera de `await` (MissingGreenlet).
    await session.refresh(row)
    return await get_scoring_config(session)


# --------------------------------------------------------------------------- #
# Modelo de depreciación
# --------------------------------------------------------------------------- #
def residual_fraction(age_years: int, params: ScoreParams) -> float:
    """Fracción del PVP que conserva un coche usado de esa edad."""
    curve = params.residual_curve
    last = len(curve) - 1
    if age_years <= last:
        value = curve[max(age_years, 0)]
    else:
        value = curve[-1] * params.residual_late_decay ** (age_years - last)
    return max(value, params.residual_floor)


def _residual_for(condition: VehicleCondition, age_years: int, params: ScoreParams) -> float:
    """Un coche a estrenar no ha entrado aún en la curva; el resto sí."""
    if condition == VehicleCondition.NEW:
        return 1.0
    return residual_fraction(age_years, params)


def market_new_price(
    rows: Iterable[tuple[float, int | None, VehicleCondition]],
    params: ScoreParams,
    now_year: int,
) -> float | None:
    """PVP estimado del binomio: la curva de depreciación, invertida.

    Cada oferta con año implica un precio de nuevo (`precio / residual(edad)`);
    la mediana de esas implicaciones es un ancla robusta del modelo cuando nadie
    ha curado `reference_price`. Exige los mismos comparables mínimos que la
    mediana de mercado: con dos coches no se estima el PVP de nada.
    """
    implied = [
        price / _residual_for(condition, max(now_year - year, 0), params)
        for price, year, condition in rows
        if price > 0 and year
    ]
    if len(implied) < params.min_market_comparables:
        return None
    return round(median(implied), 2)


def expected_price(
    offer: Offer, anchor: float | None, params: ScoreParams, now_year: int
) -> float | None:
    """Valor teórico hoy: el ancla de precio nuevo depreciada por edad y km.

    El ancla es el PVP curado de la versión o, en su defecto, el estimado del
    mercado (`market_new_price`). Sin ancla o sin año no se estima nada: mejor
    un componente ausente que uno inventado.
    """
    if not anchor or anchor <= 0 or not offer.year:
        return None

    age = max(now_year - offer.year, 0)
    value = anchor * _residual_for(offer.condition, age, params)

    if offer.mileage_km is not None:
        # La media anual es también la esperanza de km del coche; medio año de
        # rodaje mínimo para que un coche del año en curso no espere 0 km.
        expected_km = max(age, 0.5) * params.expected_km_per_year
        excess = offer.mileage_km - expected_km
        adjustment = _clamp(
            -excess / 10000 * params.mileage_adjustment_per_10k_pct / 100, -0.15, 0.15
        )
        value *= 1 + adjustment

    return round(value, 2)


# --------------------------------------------------------------------------- #
# Componentes
# --------------------------------------------------------------------------- #
# (key, label): el orden es el del desglose y el de la pantalla de Ajustes.
COMPONENT_LABELS: tuple[tuple[str, str], ...] = (
    ("price_vs_market", "Precio vs mercado"),
    ("price_vs_expected", "Precio vs valor esperado"),
    ("mileage", "Kilometraje"),
    ("age", "Antigüedad"),
    ("power", "Potencia"),
    ("transmission", "Cambio"),
    ("equipment", "Equipamiento"),
    ("apparent_condition", "Estado aparente"),
    ("price_drop", "Bajada de precio"),
    ("freshness", "Frescura del anuncio"),
)

#: Las señales que no salen del anuncio: las pone una persona, de 1 a 5 estrellas.
#: `(clave del componente, columna de `Offer`)`.
MANUAL_RATINGS: tuple[tuple[str, str], ...] = (
    ("equipment", "equipment_rating"),
    ("apparent_condition", "apparent_condition_rating"),
)


def component_descriptions(params: ScoreParams) -> dict[str, str]:
    """Explicaciones generadas de los propios parámetros: no pueden quedar viejas."""
    km_year = f"{params.expected_km_per_year:,.0f}".replace(",", ".")
    # La mitad de la rampa de potencia, para enseñar cuánto la hunde la curva.
    power_mid_hp = (params.power_zero_score_hp + params.power_full_score_hp) / 2
    power_mid_score = 0.5**params.power_curve_exponent * 100
    return {
        "price_vs_market": (
            "Desviación del precio frente a la mediana de las ofertas activas del mismo "
            f"marca-modelo (mínimo {params.min_market_comparables} comparables). "
            f"Un {params.market_full_scale_pct:.0f} % por debajo de la mediana es un 100."
        ),
        "price_vs_expected": (
            "Precio frente al valor teórico del coche: un precio de nuevo —el PVP de la versión "
            "o, si falta, el estimado del mercado invirtiendo la curva— depreciado por edad "
            "según la curva media y ajustado por kilometraje "
            f"(±{params.mileage_adjustment_per_10k_pct:.1f} % por cada 10.000 km de desvío). "
            f"Un {params.expected_full_scale_pct:.0f} % por debajo del valor esperado es un 100."
        ),
        "mileage": (
            f"Kilómetros frente a los esperados por su edad ({km_year} km/año). "
            "La mitad de lo esperado puntúa 75; el doble, 0."
        ),
        "age": (
            "Más nuevo puntúa más alto, linealmente: un coche de este año es un 100 y uno de "
            f"{params.age_zero_score_years:.0f} años un 0."
        ),
        "power": (
            f"Más potencia puntúa más alto: {params.power_zero_score_hp:.0f} CV o menos es "
            f"un 0 y {params.power_full_score_hp:.0f} CV o más un 100. Fuera de esa ventana "
            "la señal se agota: ni un utilitario pierde más por ser aún menos potente ni un "
            "deportivo gana más por serlo aún más. Dentro, la rampa va curvada "
            f"(exponente {params.power_curve_exponent:g}) para premiar más los CV altos: "
            f"{power_mid_hp:.0f} CV, la mitad de la rampa, puntúa {power_mid_score:.0f}."
        ),
        "transmission": "Cambio automático puntúa 100 y manual 0; otros tipos, 50.",
        "equipment": (
            "Nota manual del equipamiento que trae el coche, de 1 a 5 estrellas: "
            "3 ★ es un 50 neutro, 5 ★ un 100 y 1 ★ un 0. No sale del anuncio, la pone "
            "una persona en la ficha de la oferta; sin nota, su peso se reparte."
        ),
        "apparent_condition": (
            "Nota manual del estado en que aparenta estar el coche —fotos, descripción, "
            "lo que se vio al verlo—, de 1 a 5 estrellas: 3 ★ es un 50 neutro, 5 ★ un 100 "
            "y 1 ★ un 0. Sin nota, su peso se reparte entre las demás señales."
        ),
        "price_drop": (
            "Descenso del precio desde que la plataforma vio la oferta por primera vez. "
            f"Una bajada del {params.price_drop_full_scale_pct:.0f} % es un 100; sin cambios, 50."
        ),
        "freshness": (
            "Los anuncios recién publicados puntúan más alto: a los "
            f"{params.freshness_zero_score_days:.0f} días la señal se agota y puntúa 0."
        ),
    }


def component_info(config: ScoringConfig) -> list[ScoreComponentInfo]:
    """Componentes con su peso vigente y el % que representa: para Ajustes."""
    weights = config.weights.model_dump()
    defaults = ScoreWeights().model_dump()
    descriptions = component_descriptions(config.params)
    total = sum(weights.values())
    return [
        ScoreComponentInfo(
            key=key,
            label=label,
            description=descriptions[key],
            weight=weights[key],
            weight_pct=round(weights[key] / total * 100, 1) if total > 0 else 0.0,
            default_weight=defaults[key],
        )
        for key, label in COMPONENT_LABELS
    ]


@dataclass(frozen=True)
class _Component:
    key: str
    metric: float | None  # magnitud en su unidad natural, para enseñarla
    unit: str
    subscore: float | None  # None = sin dato: su peso se reparte
    text: str | None = None  # señales categóricas: lo que se enseña en vez del número

    @property
    def available(self) -> bool:
        return self.subscore is not None


def _linear(deviation_pct: float, full_scale_pct: float) -> float:
    """50 en el centro; `full_scale_pct` de desviación favorable llega a 100."""
    return _clamp(50 + deviation_pct / full_scale_pct * 50, 0, 100)


def _components(
    offer: Offer,
    stats: PriceStats | None,
    metrics: OfferMetrics,
    initial_price: float | None,
    params: ScoreParams,
    now_year: int,
) -> list[_Component]:
    out: list[_Component] = []

    # Precio contra la mediana del binomio. Con menos comparables que el mínimo
    # la mediana es poco más que el propio coche: mejor repartir el peso.
    pvm = metrics.price_vs_median_pct
    has_market = (
        pvm is not None and stats is not None and stats.count >= params.min_market_comparables
    )
    out.append(
        _Component(
            "price_vs_market",
            pvm,
            "%",
            _linear(-pvm, params.market_full_scale_pct) if has_market else None,
        )
    )

    # Precio contra el valor esperado por depreciación.
    pve = metrics.price_vs_expected_pct
    out.append(
        _Component(
            "price_vs_expected",
            pve,
            "%",
            _linear(-pve, params.expected_full_scale_pct) if pve is not None else None,
        )
    )

    # Kilometraje contra el esperado por edad (absoluto, no contra el cohorte:
    # no depende de lo sesgado que esté el mercado que haya hoy).
    if offer.mileage_km is not None and offer.year:
        age = max(now_year - offer.year, 0)
        expected_km = max(age, 0.5) * params.expected_km_per_year
        km_deviation = (offer.mileage_km - expected_km) / expected_km * 100
        out.append(
            _Component(
                "mileage",
                round(km_deviation, 1),
                "%",
                _linear(-km_deviation, params.mileage_full_scale_pct),
            )
        )
    else:
        out.append(_Component("mileage", None, "%", None))

    # Antigüedad: preferencia por coche reciente, independiente del precio.
    if offer.year:
        age = max(now_year - offer.year, 0)
        out.append(
            _Component(
                "age",
                float(age),
                "años",
                _clamp(100 - age / params.age_zero_score_years * 100, 0, 100),
            )
        )
    else:
        out.append(_Component("age", None, "años", None))

    # Potencia: rampa acotada entre el CV que puntúa 0 y el que puntúa 100,
    # curvada por el exponente. La posición en la rampa se acota *antes* de
    # elevarla, así que fuera de la ventana la curva no dispara ni se hunde:
    # todo lo que baja del suelo es un 0 y todo lo que pasa del techo, un 100.
    if offer.power_hp:
        ramp = params.power_full_score_hp - params.power_zero_score_hp
        position = _clamp((offer.power_hp - params.power_zero_score_hp) / ramp, 0, 1)
        out.append(
            _Component(
                "power",
                float(offer.power_hp),
                "CV",
                position**params.power_curve_exponent * 100,
            )
        )
    else:
        out.append(_Component("power", None, "CV", None))

    # Cambio: automático mejor que manual; «otro» no dice nada y queda neutro.
    if offer.transmission is not None:
        subscore, label = {
            Transmission.AUTOMATIC: (100.0, "Automático"),
            Transmission.MANUAL: (0.0, "Manual"),
        }.get(offer.transmission, (50.0, "Otro"))
        out.append(_Component("transmission", None, "", subscore, text=label))
    else:
        out.append(_Component("transmission", None, "", None))

    # Las dos notas manuales. La escala 1-5 se estira a 0-100 dejando el 3 ★ en el
    # 50 neutro, que es lo que hace comparable una nota a mano con las señales
    # calculadas: quien pone tres estrellas está diciendo «normal», no «regular».
    #
    # Sin nota el componente no existe —no puntúa 0—: un coche que nadie ha mirado
    # no puede perder puntos por no haberlo mirado.
    for key, column in MANUAL_RATINGS:
        rating = getattr(offer, column)
        out.append(
            _Component(
                key,
                float(rating) if rating is not None else None,
                "★",
                _clamp((rating - 1) / 4 * 100, 0, 100) if rating is not None else None,
            )
        )

    # Bajada de precio. Con primer precio conocido y sin cambios, es un 50
    # legítimo (sabemos que no ha bajado); sin historial, no hay dato.
    if initial_price and initial_price > 0:
        drop = metrics.price_drop_pct or 0.0
        out.append(
            _Component(
                "price_drop", drop, "%", _linear(drop, params.price_drop_full_scale_pct)
            )
        )
    else:
        out.append(_Component("price_drop", None, "%", None))

    # Frescura: un buen precio recién publicado es el chollo que vuela.
    days = metrics.days_listed
    out.append(
        _Component(
            "freshness",
            float(days),
            "días",
            _clamp(100 - days / params.freshness_zero_score_days * 100, 0, 100),
        )
    )

    return out


def score_offer(
    offer: Offer,
    stats: PriceStats | None,
    metrics: OfferMetrics,
    initial_price: float | None,
    config: ScoringConfig,
    now: datetime | None = None,
) -> tuple[float | None, list[ScoreBreakdownItem]]:
    """La puntuación 0-100 y su desglose auditable.

    Media ponderada de los subscores disponibles: los pesos configurados se
    renormalizan sobre lo que esta oferta puede acreditar, y `weight_pct` deja
    escrito el peso final que se usó de verdad.
    """
    now_year = (now or datetime.now(UTC)).year
    weights = config.weights.model_dump()
    labels = dict(COMPONENT_LABELS)
    components = _components(offer, stats, metrics, initial_price, config.params, now_year)

    total_weight = sum(weights[c.key] for c in components if c.available)
    score = None
    if total_weight > 0:
        score = round(
            sum(c.subscore * weights[c.key] for c in components if c.available) / total_weight,
            1,
        )

    breakdown = [
        ScoreBreakdownItem(
            key=c.key,
            label=labels[c.key],
            available=c.available,
            metric=c.metric if c.available else None,
            unit=c.unit,
            text=c.text if c.available else None,
            subscore=round(c.subscore, 1) if c.available else None,
            weight=weights[c.key],
            weight_pct=(
                round(weights[c.key] / total_weight * 100, 1)
                if c.available and total_weight > 0
                else 0.0
            ),
            points=(
                round(c.subscore * weights[c.key] / total_weight, 2)
                if c.available and total_weight > 0
                else None
            ),
        )
        for c in components
    ]
    return score, breakdown
