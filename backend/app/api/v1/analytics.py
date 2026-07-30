"""Agregados por binomio marca-modelo para la vista Analítica.

Comparte los filtros del listado de ofertas (`OfferFilters`) por la misma razón
que `/offers/stats`: si divergieran, los gráficos describirían un conjunto
distinto del que enseña la tabla. Es la misma dependencia, no una copia.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query
from sqlalchemy import Float, Select, case, cast, func, select, tuple_
from sqlalchemy.sql.elements import ColumnElement

from app.api.deps import CurrentUser, SessionDep

# Importar el aplicador de filtros del listado es deliberado: es lo que garantiza
# que la analítica describa exactamente las mismas ofertas que la tabla.
from app.api.v1.offers import FiltersDep, _apply_filters
from app.models import CarModel, Dealer, Offer
from app.schemas.analytics import (
    AnalyticsSegments,
    DealerPoint,
    MixSlice,
    PriceTrend,
    Segment,
    SegmentMix,
    SegmentPoint,
    YearPoint,
)
from app.services.metrics import enrich_offers

router = APIRouter(prefix="/analytics", tags=["analytics"])

# Binomios que devuelve el selector. Cortar en 40 evita que un catálogo grande
# convierta una lista de opciones en una descarga.
_SEGMENT_CAP = 40

# Binomios con detalle. No es una cifra redonda: son las ranuras de color que la
# paleta puede separar bajo daltonismo con *todos* los pares en juego, que es lo
# que exige el gráfico de dispersión. Un cuarto color no supera el umbral.
_DETAIL_CAP = 3

# Ofertas puntuadas por binomio. `value_score` se calcula en Python, así que se
# acota igual que el orden por puntuación del listado.
_POINT_CAP = 600

# Dealers por binomio en la barra de stock. Más allá de ocho la barra deja de
# comparar y pasa a ser una lista con colores.
_DEALER_CAP = 8


def _round(value: float | None, digits: int = 2) -> float | None:
    return round(value, digits) if value is not None else None


def _make_key() -> ColumnElement[str]:
    return func.lower(CarModel.make)


def _model_key() -> ColumnElement[str]:
    return func.lower(CarModel.model)


def _km_per_year() -> ColumnElement[float | None]:
    """Mismo cálculo que `compute_metrics`: km entre la edad, con un año de suelo."""
    now_year = datetime.now(UTC).year
    return case(
        (
            (Offer.mileage_km.isnot(None)) & (Offer.year.isnot(None)),
            cast(Offer.mileage_km, Float)
            / func.greatest(cast(now_year - Offer.year, Float), 1.0),
        ),
        else_=None,
    )


def _discount() -> ColumnElement[float | None]:
    return case(
        (
            (Offer.original_price.isnot(None)) & (Offer.original_price > 0),
            (cast(Offer.original_price, Float) - cast(Offer.price, Float))
            / cast(Offer.original_price, Float)
            * 100,
        ),
        else_=None,
    )


def _percentile(fraction: float) -> ColumnElement[float]:
    return func.percentile_cont(fraction).within_group(cast(Offer.price, Float))


def _segmented(stmt: Select, filters: Any, user_id: int) -> Select:
    """Aplica los filtros del listado y cuelga `car_models` para poder agrupar."""
    return _apply_filters(
        stmt.select_from(Offer).join(CarModel, CarModel.id == Offer.car_model_id),
        filters,
        user_id,
    )


def _fit_trend(points: list[SegmentPoint]) -> PriceTrend | None:
    """Mínimos cuadrados de precio sobre kilómetros.

    Se hace aquí y no en el navegador para que la cifra que sale en la tabla y la
    recta que se dibuja sean la misma cuenta. Con menos de cuatro ofertas no se
    devuelve nada: una recta por dos puntos siempre ajusta perfecto y no dice nada.
    """
    sample = [(float(p.mileage_km), p.price) for p in points if p.mileage_km is not None]
    n = len(sample)
    if n < 4:
        return None

    mean_x = sum(x for x, _ in sample) / n
    mean_y = sum(y for _, y in sample) / n
    sxx = sum((x - mean_x) ** 2 for x, _ in sample)
    if sxx == 0:
        return None

    sxy = sum((x - mean_x) * (y - mean_y) for x, y in sample)
    slope = sxy / sxx
    intercept = mean_y - slope * mean_x

    syy = sum((y - mean_y) ** 2 for _, y in sample)
    r2 = (sxy**2) / (sxx * syy) if syy > 0 else 0.0

    return PriceTrend(
        slope=slope,
        intercept=intercept,
        r2=round(r2, 3),
        n=n,
        # Lo que el mercado cobra por cada 10.000 km *menos*: la pendiente es
        # negativa en un mercado normal, así que se le da la vuelta para que el
        # número se lea como lo que cuesta el kilometraje bajo.
        price_per_10k_km=round(-slope * 10_000, 0),
    )


@router.get("/segments", response_model=AnalyticsSegments)
async def segments(
    session: SessionDep,
    user: CurrentUser,
    filters: FiltersDep,
    keys: Annotated[
        str | None,
        Query(description=f"Binomios con detalle, separados por coma (máx. {_DETAIL_CAP})"),
    ] = None,
) -> AnalyticsSegments:
    """Un binomio marca-modelo por fila, con el detalle de unos pocos."""
    # ---- Cabecera: agregados de todos los binomios ------------------------- #
    make_key, model_key = _make_key(), _model_key()
    rows = (
        await session.execute(
            _segmented(
                select(
                    make_key,
                    model_key,
                    # `mode()` y no `min()`: la etiqueta debe ser la grafía más
                    # frecuente, no la que gane alfabéticamente.
                    func.mode().within_group(CarModel.make),
                    func.mode().within_group(CarModel.model),
                    func.count(Offer.id),
                    func.count(func.distinct(Offer.dealer_id)),
                    func.count(func.distinct(Offer.car_model_id)),
                    func.min(cast(Offer.price, Float)),
                    _percentile(0.25),
                    _percentile(0.5),
                    _percentile(0.75),
                    func.max(cast(Offer.price, Float)),
                    func.avg(cast(Offer.price, Float)),
                    func.avg(cast(Offer.mileage_km, Float)),
                    func.avg(cast(Offer.year, Float)),
                    func.avg(_km_per_year()),
                    func.avg(_discount()),
                ),
                filters,
                user.id,
            )
            .group_by(make_key, model_key)
            .order_by(func.count(Offer.id).desc(), make_key, model_key)
            .limit(_SEGMENT_CAP)
        )
    ).all()

    by_key: dict[str, Segment] = {}
    for row in rows:
        key = f"{row[0]}|{row[1]}"
        by_key[key] = Segment(
            key=key,
            make=row[2],
            model=row[3],
            label=f"{row[2]} {row[3]}",
            offers=row[4] or 0,
            dealers=row[5] or 0,
            trims=row[6] or 0,
            min_price=_round(row[7]),
            p25_price=_round(row[8]),
            median_price=_round(row[9]),
            p75_price=_round(row[10]),
            max_price=_round(row[11]),
            avg_price=_round(row[12]),
            avg_mileage_km=_round(row[13], 0),
            avg_year=_round(row[14], 1),
            avg_km_per_year=_round(row[15], 0),
            avg_discount_pct=_round(row[16]),
        )

    requested = [k.strip() for k in (keys or "").split(",") if k.strip()]
    detail_keys = [k for k in requested if k in by_key][:_DETAIL_CAP]
    if not detail_keys:
        # Sin selección explícita, los binomios con más oferta: es lo que se está
        # mirando de todas formas y evita una segunda petición para pintar algo.
        detail_keys = list(by_key)[:_DETAIL_CAP]

    result = AnalyticsSegments(
        segments=list(by_key.values()),
        detail_keys=detail_keys,
        offers=sum(segment.offers for segment in by_key.values()),
        max_detail=_DETAIL_CAP,
    )
    if not detail_keys:
        return result

    pairs = [tuple(key.split("|", 1)) for key in detail_keys]
    detail_only = tuple_(make_key, model_key).in_(pairs)
    for key in detail_keys:
        by_key[key].detailed = True

    # ---- Precio por año de matriculación ----------------------------------- #
    year_rows = (
        await session.execute(
            _segmented(
                select(make_key, model_key, Offer.year, func.count(Offer.id), _percentile(0.5)),
                filters,
                user.id,
            )
            .where(detail_only, Offer.year.isnot(None))
            .group_by(make_key, model_key, Offer.year)
            .order_by(Offer.year)
        )
    ).all()
    for row in year_rows:
        by_key[f"{row[0]}|{row[1]}"].by_year.append(
            YearPoint(year=row[2], offers=row[3] or 0, median_price=round(row[4], 2))
        )

    # ---- Stock por dealer --------------------------------------------------- #
    dealer_rows = (
        await session.execute(
            _segmented(
                select(
                    make_key,
                    model_key,
                    Offer.dealer_id,
                    Dealer.name,
                    func.count(Offer.id),
                    _percentile(0.5),
                    func.min(cast(Offer.price, Float)),
                ),
                filters,
                user.id,
            )
            .join(Dealer, Dealer.id == Offer.dealer_id)
            .where(detail_only)
            .group_by(make_key, model_key, Offer.dealer_id, Dealer.name)
            .order_by(func.count(Offer.id).desc(), func.min(cast(Offer.price, Float)))
        )
    ).all()
    for row in dealer_rows:
        segment = by_key[f"{row[0]}|{row[1]}"]
        if len(segment.by_dealer) >= _DEALER_CAP:
            continue
        segment.by_dealer.append(
            DealerPoint(
                dealer_id=row[2],
                dealer=row[3],
                offers=row[4] or 0,
                median_price=round(row[5], 2),
                min_price=round(row[6], 2),
            )
        )

    # ---- Composición: combustible, cambio y estado -------------------------- #
    # Una sola consulta con las tres dimensiones a la vez y el pliegue en Python:
    # son tres recuentos sobre las mismas filas, no tres preguntas distintas.
    mix_rows = (
        await session.execute(
            _segmented(
                select(
                    make_key,
                    model_key,
                    Offer.fuel_type,
                    Offer.transmission,
                    Offer.condition,
                    func.count(Offer.id),
                ),
                filters,
                user.id,
            )
            .where(detail_only)
            .group_by(make_key, model_key, Offer.fuel_type, Offer.transmission, Offer.condition)
        )
    ).all()

    def _empty_mix() -> dict[str, dict[str, int]]:
        return {dimension: defaultdict(int) for dimension in ("fuel", "transmission", "condition")}

    tally: dict[str, dict[str, dict[str, int]]] = defaultdict(_empty_mix)
    for row in mix_rows:
        key = f"{row[0]}|{row[1]}"
        count = row[5] or 0
        for dimension, value in (
            ("fuel", row[2]),
            ("transmission", row[3]),
            ("condition", row[4]),
        ):
            tally[key][dimension][value.value if value else "unknown"] += count

    for key, dimensions in tally.items():
        by_key[key].mix = SegmentMix(
            **{
                dimension: [
                    MixSlice(key=name, offers=offers)
                    for name, offers in sorted(counts.items(), key=lambda kv: -kv[1])
                ]
                for dimension, counts in dimensions.items()
            }
        )

    # ---- Nube de puntos y puntuación de valor ------------------------------- #
    # Aquí sí se traen las ofertas enteras: `value_score` se calcula en Python y
    # necesita el modelo y el dealer. Por eso esto va acotado y `offers_sampled`
    # lo dice, en vez de dar a entender que describe todo el binomio.
    offers = list(
        (
            await session.scalars(
                _segmented(select(Offer), filters, user.id)
                .where(detail_only)
                .order_by(Offer.price.asc(), Offer.id)
                .limit(_POINT_CAP * _DETAIL_CAP)
            )
        ).unique()
    )
    _, metrics = await enrich_offers(session, offers)

    for offer in offers:
        key = f"{offer.car_model.make.lower()}|{offer.car_model.model.lower()}"
        segment = by_key.get(key)
        if segment is None or len(segment.points) >= _POINT_CAP:
            continue
        metric = metrics[offer.id]
        segment.points.append(
            SegmentPoint(
                id=offer.id,
                price=float(offer.price),
                mileage_km=offer.mileage_km,
                year=offer.year,
                km_per_year=metric.km_per_year,
                value_score=metric.value_score,
                discount_pct=metric.discount_pct,
                dealer=offer.dealer.name,
                trim=offer.car_model.trim,
                title=offer.title,
            )
        )

    for key in detail_keys:
        segment = by_key[key]
        segment.offers_sampled = len(segment.points)
        scores = [p.value_score for p in segment.points if p.value_score is not None]
        segment.avg_value_score = _round(sum(scores) / len(scores), 1) if scores else None
        segment.trend = _fit_trend(segment.points)

    return result
