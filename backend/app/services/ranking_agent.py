"""Agente de IA que rankea las ofertas de un modelo concreto.

Implementación: loop agéntico manual sobre la Messages API de Anthropic. Se
eligió el loop manual (en lugar del tool runner del SDK, que está en beta)
porque aquí necesitamos control explícito sobre tres cosas:

  * un número acotado de iteraciones y de tools ejecutadas por run,
  * una tool terminal (`submit_ranking`) que cierra el loop con salida
    estructurada validada contra las ofertas candidatas reales,
  * persistencia de la traza y del consumo de tokens en `ranking_runs`.

El agente dispone de tres tools de lectura para investigar el mercado y una
cuarta para entregar el resultado.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.models import (
    CarModel,
    Offer,
    OfferRanking,
    OfferStatus,
    RankingRun,
    RunStatus,
    Verdict,
    utcnow,
)
from app.schemas.offer import MakeModelPriceStats, OfferMetrics
from app.schemas.ranking import RankingRequest
from app.services.metrics import (
    compute_metrics,
    first_seen_prices,
    make_model_key,
    make_model_price_stats,
)

logger = logging.getLogger(__name__)


class RankingError(RuntimeError):
    """El run no pudo completarse (se persiste en `RankingRun.error`)."""


# --------------------------------------------------------------------------- #
# Definición de tools
# --------------------------------------------------------------------------- #
VERDICT_VALUES = [v.value for v in Verdict]

TOOLS: list[dict[str, Any]] = [
    {
        "name": "get_market_stats",
        "description": (
            "Estadísticas agregadas del mercado del modelo que se está analizando, con "
            "todas sus versiones dentro: número de ofertas activas, cuántas versiones "
            "distintas hay, precio mínimo/mediano/máximo, kilometraje y año medios y "
            "número de dealers distintos. Úsala primero para situar el rango de precios "
            "antes de juzgar ofertas concretas."
        ),
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "list_offers",
        "description": (
            "Lista las ofertas activas candidatas con todos sus datos y las métricas ya "
            "calculadas por la plataforma (descuento sobre PVP, desviación respecto a la "
            "mediana, km/año, días publicada, bajada de precio y una puntuación heurística "
            "de referencia). Es la fuente de verdad sobre qué ofertas puedes rankear."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "sort_by": {
                    "type": "string",
                    "enum": ["price", "value_score", "mileage", "year", "days_listed"],
                    "description": "Criterio de ordenación. Por defecto 'price'.",
                }
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "get_offer_price_history",
        "description": (
            "Historial de precios de una oferta concreta, en orden cronológico. Útil para "
            "detectar bajadas recientes, coches estancados o precios que suben."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "offer_id": {"type": "integer", "description": "ID de la oferta."}
            },
            "required": ["offer_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "submit_ranking",
        "description": (
            "Entrega el ranking final. Debe incluir TODAS las ofertas candidatas, cada una "
            "con su posición, puntuación 0-100, veredicto y justificación. Llama a esta tool "
            "una sola vez, al terminar el análisis."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "summary": {
                    "type": "string",
                    "description": (
                        "2-4 frases en español sobre el estado del mercado para este modelo "
                        "y qué debería hacer el comprador."
                    ),
                },
                "rankings": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "offer_id": {"type": "integer"},
                            "rank": {
                                "type": "integer",
                                "description": "1 es la mejor oferta. Sin empates.",
                            },
                            "score": {
                                "type": "integer",
                                "description": "0-100. 100 es una oportunidad excepcional.",
                            },
                            "verdict": {"type": "string", "enum": VERDICT_VALUES},
                            "reasoning": {
                                "type": "string",
                                "description": "1-3 frases en español justificando la posición.",
                            },
                            "pros": {"type": "array", "items": {"type": "string"}},
                            "cons": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": [
                            "offer_id",
                            "rank",
                            "score",
                            "verdict",
                            "reasoning",
                            "pros",
                            "cons",
                        ],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["summary", "rankings"],
            "additionalProperties": False,
        },
    },
]

SYSTEM_PROMPT = """\
Eres un analista experto en compraventa de vehículos. Tu trabajo es rankear las \
ofertas de un mismo modelo procedentes de distintos dealers y decidir cuáles son \
realmente buenas oportunidades.

Las ofertas son de un modelo (marca + modelo), y dentro conviven sus **versiones**: \
motorizaciones, acabados y carrocerías distintas, en el campo `version` de cada \
oferta. El mercado con el que comparas es el del modelo entero —es el conjunto real \
en el que elige un comprador—, pero la versión explica buena parte de la diferencia \
de precio, así que tenla en cuenta antes de llamar cara a una y barata a otra.

Método:
1. Llama a `get_market_stats` para situar el rango de precios del modelo.
2. Llama a `list_offers` para ver las ofertas candidatas y sus métricas.
3. Si el historial de precios de alguna oferta puede cambiar tu criterio (bajadas \
recientes, coches estancados meses), consulta `get_offer_price_history`.
4. Cierra con una única llamada a `submit_ranking` incluyendo TODAS las ofertas \
candidatas.

Cómo valorar:
- El precio frente a la mediana del modelo es la señal principal, pero corrígelo \
siempre por versión, kilometraje, año, potencia y estado (nuevo / km0 / usado). Un \
coche barato con el doble de kilómetros no es una buena oferta, y una versión tope de \
gama por encima de la mediana puede seguir siéndolo.
- Desconfía del precio anormalmente bajo sin explicación: márcalo y dilo en `cons`.
- Un descuento anunciado grande sobre un PVP inflado no es un descuento real.
- La valoración del dealer y los días publicada son señales secundarias, útiles para \
desempatar y para estimar margen de negociación.
- La puntuación heurística que da la plataforma es una referencia, no una orden: si \
discrepas, explica por qué en `reasoning`.

Sé concreto y cuantitativo: cita cifras (precio, km, % sobre la mediana) en lugar de \
adjetivos. Escribe siempre en español.
"""


# --------------------------------------------------------------------------- #
# Contexto del run
# --------------------------------------------------------------------------- #
@dataclass
class _Candidate:
    offer: Offer
    metrics: OfferMetrics


@dataclass
class _AgentContext:
    label: str
    stats: MakeModelPriceStats
    candidates: dict[int, _Candidate]
    request: RankingRequest
    tool_trace: list[dict[str, Any]] = field(default_factory=list)

    def market_stats_payload(self) -> dict[str, Any]:
        return {
            "model": self.label,
            "active_offers": self.stats.count,
            # El mercado son todas las versiones del modelo, así que se dice
            # cuántas hay: un rango de 7.900 a 39.490 € se lee distinto sabiendo
            # que dentro conviven un 1.0 TFSI y un RS3.
            "distinct_versions": self.stats.versions,
            "min_price_eur": _round(self.stats.min_price),
            "median_price_eur": _round(self.stats.median_price),
            "max_price_eur": _round(self.stats.max_price),
            "avg_price_eur": _round(self.stats.avg_price),
            "avg_mileage_km": _round(self.stats.avg_mileage_km, 0),
            "avg_year": _round(self.stats.avg_year, 1),
            "distinct_dealers": self.stats.dealers_count,
        }

    def offers_payload(self, sort_by: str = "price") -> list[dict[str, Any]]:
        keys = {
            "price": lambda c: float(c.offer.price),
            "value_score": lambda c: -(c.metrics.value_score or 0),
            "mileage": lambda c: c.offer.mileage_km if c.offer.mileage_km is not None else 10**9,
            "year": lambda c: -(c.offer.year or 0),
            "days_listed": lambda c: -c.metrics.days_listed,
        }
        ordered = sorted(self.candidates.values(), key=keys.get(sort_by, keys["price"]))
        return [_offer_payload(c) for c in ordered]


def _round(value: float | None, digits: int = 2) -> float | None:
    if value is None:
        return None
    return round(float(value), digits) if digits else round(float(value))


def _offer_payload(candidate: _Candidate) -> dict[str, Any]:
    offer, metrics = candidate.offer, candidate.metrics
    return {
        "offer_id": offer.id,
        "title": offer.title,
        # La versión y su PVP son de la fila de `car_models`, no del binomio: el
        # mercado es el modelo entero, pero un RS3 y un 1.0 TFSI no se comparan
        # como si fueran el mismo coche, y el agente necesita poder distinguirlos.
        "version": (offer.car_model.trim or None) if offer.car_model else None,
        "version_reference_price_eur": (
            float(offer.car_model.reference_price)
            if offer.car_model and offer.car_model.reference_price
            else None
        ),
        "dealer": offer.dealer.name if offer.dealer else None,
        "dealer_rating": offer.dealer.rating if offer.dealer else None,
        "dealer_city": offer.dealer.city if offer.dealer else None,
        "price_eur": float(offer.price),
        "original_price_eur": float(offer.original_price) if offer.original_price else None,
        "year": offer.year,
        "mileage_km": offer.mileage_km,
        "power_hp": offer.power_hp,
        "condition": offer.condition.value,
        "fuel_type": offer.fuel_type.value if offer.fuel_type else None,
        "transmission": offer.transmission.value if offer.transmission else None,
        "location": offer.location,
        "metrics": {
            "discount_pct": metrics.discount_pct,
            "price_vs_median_pct": metrics.price_vs_median_pct,
            "price_vs_reference_pct": metrics.price_vs_reference_pct,
            "price_drop_pct": metrics.price_drop_pct,
            "km_per_year": metrics.km_per_year,
            "days_listed": metrics.days_listed,
            "platform_value_score": metrics.value_score,
        },
    }


def _user_prompt(ctx: _AgentContext) -> str:
    lines = [
        f"Analiza y rankea las ofertas de: {ctx.label}.",
        f"Hay {len(ctx.candidates)} ofertas candidatas activas, repartidas entre "
        f"{ctx.stats.versions} versiones del modelo.",
    ]
    req = ctx.request
    constraints = []
    if req.max_budget:
        constraints.append(f"presupuesto máximo {req.max_budget:.0f} EUR")
    if req.max_mileage_km:
        constraints.append(f"kilometraje máximo {req.max_mileage_km} km")
    if req.min_year:
        constraints.append(f"año mínimo {req.min_year}")
    if constraints:
        lines.append(
            "Restricciones del comprador: "
            + ", ".join(constraints)
            + ". Las ofertas que no cumplan deben bajar de posición y llevar el motivo en `cons`; "
            "no las elimines del ranking."
        )
    if req.priorities:
        lines.append(f"Prioridades del comprador: {req.priorities}")
    lines.append("Empieza consultando las tools.")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Carga de candidatos
# --------------------------------------------------------------------------- #
async def build_context(
    session: AsyncSession, key: str, label: str, request: RankingRequest
) -> _AgentContext:
    """Carga las ofertas activas del binomio y sus métricas contra ese mercado."""
    variant_ids = list(
        await session.scalars(select(CarModel.id).where(make_model_key() == key))
    )
    if not variant_ids:
        raise RankingError(f"El binomio '{key}' ya no está en el catálogo.")

    offers = list(
        (
            await session.scalars(
                select(Offer)
                .where(
                    Offer.car_model_id.in_(variant_ids),
                    Offer.status == OfferStatus.ACTIVE,
                )
                # El historial se carga por adelantado: la tool
                # `get_offer_price_history` lo lee y en async no se puede
                # resolver una relación de forma perezosa.
                .options(selectinload(Offer.price_history))
                .order_by(Offer.price)
                .limit(settings.RANKING_MAX_OFFERS)
            )
        ).unique()
    )
    if not offers:
        raise RankingError("No hay ofertas activas para este modelo.")

    # Las métricas se calculan contra el mercado del binomio, no contra el de
    # cada versión: es la mediana con la que se compara al rankear.
    stats_map = await make_model_price_stats(session, variant_ids)
    stats = stats_map.get(key) or MakeModelPriceStats(key=key, make="", model="")
    initial_prices = await first_seen_prices(session, [o.id for o in offers])

    candidates = {
        offer.id: _Candidate(
            offer=offer,
            metrics=compute_metrics(offer, stats, initial_prices.get(offer.id)),
        )
        for offer in offers
    }
    return _AgentContext(label=label, stats=stats, candidates=candidates, request=request)


# --------------------------------------------------------------------------- #
# Ejecución de tools
# --------------------------------------------------------------------------- #
async def _run_tool(
    session: AsyncSession, ctx: _AgentContext, name: str, tool_input: dict[str, Any]
) -> tuple[str, dict[str, Any] | None]:
    """Devuelve `(contenido_para_el_modelo, ranking_final_o_None)`."""
    ctx.tool_trace.append({"tool": name, "input": tool_input})

    if name == "get_market_stats":
        return json.dumps(ctx.market_stats_payload(), ensure_ascii=False), None

    if name == "list_offers":
        sort_by = tool_input.get("sort_by", "price")
        return json.dumps(ctx.offers_payload(sort_by), ensure_ascii=False), None

    if name == "get_offer_price_history":
        offer_id = tool_input.get("offer_id")
        candidate = ctx.candidates.get(offer_id)
        if candidate is None:
            return (
                json.dumps(
                    {
                        "error": f"offer_id {offer_id} no está entre las candidatas.",
                        "valid_offer_ids": sorted(ctx.candidates),
                    },
                    ensure_ascii=False,
                ),
                None,
            )
        history = [
            {"price_eur": float(point.price), "recorded_at": point.recorded_at.isoformat()}
            for point in candidate.offer.price_history
        ]
        return (
            json.dumps({"offer_id": offer_id, "history": history}, ensure_ascii=False),
            None,
        )

    if name == "submit_ranking":
        return "Ranking recibido.", tool_input

    return json.dumps({"error": f"Tool desconocida: {name}"}), None


# --------------------------------------------------------------------------- #
# Loop agéntico
# --------------------------------------------------------------------------- #
async def _call_model(client: Any, **kwargs: Any) -> Any:
    """Llama a la API. Con `fallbacks` activados usa el endpoint beta.

    Si la cuenta no tiene el beta habilitado, degradamos a la llamada normal en
    lugar de tumbar el run.
    """
    if settings.ANTHROPIC_ENABLE_FALLBACKS:
        try:
            return await client.beta.messages.create(
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                **kwargs,
            )
        except Exception as exc:  # noqa: BLE001
            message = str(exc).lower()
            if "fallback" in message or "beta" in message:
                logger.warning(
                    "Fallbacks server-side no disponibles, se continúa sin ellos: %s", exc
                )
            else:
                raise
    return await client.messages.create(**kwargs)


async def _agent_loop(
    session: AsyncSession, ctx: _AgentContext, run: RankingRun
) -> dict[str, Any]:
    try:
        from anthropic import AsyncAnthropic
    except ImportError as exc:  # pragma: no cover
        raise RankingError("El SDK de Anthropic no está instalado.") from exc

    if not settings.ANTHROPIC_API_KEY:
        raise RankingError(
            "ANTHROPIC_API_KEY no está configurada: el ranking con IA está deshabilitado."
        )

    client = AsyncAnthropic(api_key=settings.ANTHROPIC_API_KEY)
    messages: list[dict[str, Any]] = [{"role": "user", "content": _user_prompt(ctx)}]

    try:
        for iteration in range(1, settings.RANKING_MAX_ITERATIONS + 1):
            response = await _call_model(
                client,
                model=settings.ANTHROPIC_MODEL,
                max_tokens=settings.ANTHROPIC_MAX_TOKENS,
                system=SYSTEM_PROMPT,
                output_config={"effort": settings.ANTHROPIC_EFFORT},
                tools=TOOLS,
                messages=messages,
            )

            run.iterations = iteration
            run.input_tokens += getattr(response.usage, "input_tokens", 0) or 0
            run.output_tokens += getattr(response.usage, "output_tokens", 0) or 0
            run.model_used = getattr(response, "model", settings.ANTHROPIC_MODEL)

            if response.stop_reason == "refusal":
                details = getattr(response, "stop_details", None)
                category = getattr(details, "category", None) if details else None
                raise RankingError(
                    f"El modelo rechazó la petición (categoría: {category or 'desconocida'})."
                )

            # Se devuelve `response.content` íntegro: preserva los bloques de
            # thinking, que la API exige reenviar sin modificar.
            messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason == "pause_turn":
                continue

            tool_uses = [block for block in response.content if block.type == "tool_use"]
            if not tool_uses:
                if response.stop_reason == "max_tokens":
                    raise RankingError(
                        "Respuesta truncada por max_tokens antes de entregar el ranking."
                    )
                raise RankingError(
                    "El agente terminó el turno sin llamar a `submit_ranking`."
                )

            tool_results: list[dict[str, Any]] = []
            final_payload: dict[str, Any] | None = None
            for block in tool_uses:
                content, payload = await _run_tool(
                    session, ctx, block.name, dict(block.input or {})
                )
                tool_results.append(
                    {"type": "tool_result", "tool_use_id": block.id, "content": content}
                )
                if payload is not None:
                    final_payload = payload

            if final_payload is not None:
                return final_payload

            messages.append({"role": "user", "content": tool_results})

        raise RankingError(
            f"Se alcanzó el límite de {settings.RANKING_MAX_ITERATIONS} iteraciones "
            "sin ranking final."
        )
    finally:
        await client.close()


# --------------------------------------------------------------------------- #
# Persistencia del resultado
# --------------------------------------------------------------------------- #
def _persist_ranking(
    session: AsyncSession, run: RankingRun, ctx: _AgentContext, payload: dict[str, Any]
) -> None:
    raw_items = payload.get("rankings") or []
    if not raw_items:
        raise RankingError("`submit_ranking` llegó sin ofertas.")

    seen: set[int] = set()
    items: list[OfferRanking] = []
    for raw in raw_items:
        offer_id = raw.get("offer_id")
        if offer_id not in ctx.candidates or offer_id in seen:
            # IDs inventados o duplicados se descartan en silencio: el modelo no
            # define qué ofertas existen, solo cómo se ordenan.
            continue
        seen.add(offer_id)

        verdict_raw = str(raw.get("verdict", "")).lower()
        try:
            verdict = Verdict(verdict_raw)
        except ValueError:
            verdict = Verdict.FAIR

        items.append(
            OfferRanking(
                offer_id=offer_id,
                rank=int(raw.get("rank") or len(items) + 1),
                score=max(0, min(100, int(raw.get("score") or 0))),
                verdict=verdict,
                reasoning=(raw.get("reasoning") or "").strip() or None,
                pros=[str(p) for p in (raw.get("pros") or [])][:6],
                cons=[str(c) for c in (raw.get("cons") or [])][:6],
            )
        )

    if not items:
        raise RankingError("Ninguna de las ofertas devueltas por el agente es válida.")

    # Renumeramos por si el modelo dejó huecos o empates.
    items.sort(key=lambda item: (item.rank, -item.score))
    for position, item in enumerate(items, start=1):
        item.rank = position
        # Se asigna la FK y se añaden directamente en lugar de tocar
        # `run.items`: asignar la colección forzaría a SQLAlchemy a cargar su
        # valor anterior, y una carga perezosa en async rompe (MissingGreenlet).
        item.run_id = run.id
        session.add(item)

    run.summary = (payload.get("summary") or "").strip() or None
    run.offers_considered = len(ctx.candidates)
    run.tool_trace = ctx.tool_trace
    run.status = RunStatus.COMPLETED
    run.finished_at = utcnow()


# --------------------------------------------------------------------------- #
# Punto de entrada
# --------------------------------------------------------------------------- #
async def execute_ranking_run(
    session: AsyncSession, run_id: int, request: RankingRequest
) -> RankingRun:
    """Ejecuta un run ya creado. Los errores se persisten, no se propagan."""
    run = await session.get(RankingRun, run_id)
    if run is None:
        raise RankingError(f"RankingRun {run_id} no existe.")

    run.status = RunStatus.RUNNING
    run.effort = settings.ANTHROPIC_EFFORT
    run.model_used = settings.ANTHROPIC_MODEL
    await session.commit()

    try:
        ctx = await build_context(session, run.make_model_key, run.label, request)
        payload = await _agent_loop(session, ctx, run)
        _persist_ranking(session, run, ctx, payload)
    except RankingError as exc:
        run.status = RunStatus.FAILED
        run.error = str(exc)
        run.finished_at = utcnow()
        logger.warning("Ranking run %s falló: %s", run_id, exc)
    except Exception as exc:  # noqa: BLE001 — cualquier fallo debe quedar registrado
        run.status = RunStatus.FAILED
        run.error = f"{type(exc).__name__}: {exc}"
        run.finished_at = utcnow()
        logger.exception("Ranking run %s falló inesperadamente", run_id)

    await session.commit()
    await session.refresh(run)
    return run

