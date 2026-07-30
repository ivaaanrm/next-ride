"""Disparo y consulta de los rankings generados por el agente de IA."""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, status
from sqlalchemy import desc, func, select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, SessionDep
from app.core.config import settings
from app.db.session import SessionFactory
from app.models import CarModel, OfferRanking, RankingRun, RunStatus
from app.schemas.offer import OfferRead
from app.schemas.ranking import (
    RankedOffer,
    RankingRequest,
    RankingRunDetail,
    RankingRunRead,
)
from app.services.metrics import enrich_offers, make_model_key
from app.services.offers import favorite_offer_ids
from app.services.ranking_agent import execute_ranking_run

logger = logging.getLogger(__name__)

router = APIRouter(tags=["rankings"])


async def _run_in_background(run_id: int, request: RankingRequest) -> None:
    """El agente se ejecuta con su propia sesión: la del request ya está cerrada."""
    async with SessionFactory() as session:
        try:
            await execute_ranking_run(session, run_id, request)
        except Exception:  # noqa: BLE001 — nunca debe tumbar el worker
            logger.exception("Fallo no controlado en el ranking run %s", run_id)


async def _load_detail(session: SessionDep, run_id: int, user_id: int) -> RankingRunDetail:
    run = await session.get(
        RankingRun,
        run_id,
        options=[selectinload(RankingRun.items).selectinload(OfferRanking.offer)],
    )
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run no encontrado")

    detail = RankingRunDetail.model_validate(run)
    offers = [item.offer for item in run.items if item.offer is not None]
    _, metrics = await enrich_offers(session, offers)
    favorites = await favorite_offer_ids(session, user_id, [offer.id for offer in offers])

    items = []
    for item in run.items:
        ranked = RankedOffer.model_validate(item)
        if item.offer is not None:
            offer_read = OfferRead.model_validate(item.offer)
            offer_read.metrics = metrics[item.offer.id]
            offer_read.is_favorite = item.offer.id in favorites
            ranked.offer = offer_read
        items.append(ranked)

    detail.items = items
    return detail


async def _resolve_binomio(session: SessionDep, key: str) -> str:
    """Comprueba que el binomio existe y devuelve su etiqueta («Audi A3»).

    La etiqueta sale de `mode()`, la grafía más frecuente, igual que en el
    listado agrupado: la clave viene en minúsculas y no vale para enseñarla.
    """
    row = (
        await session.execute(
            select(
                func.mode().within_group(CarModel.make),
                func.mode().within_group(CarModel.model),
            ).where(make_model_key() == key)
        )
    ).first()
    if row is None or row[0] is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"Binomio '{key}' no encontrado"
        )
    return f"{row[0]} {row[1]}"


# El binomio va en query y no en la ruta: la clave lleva una barra vertical y
# espacios («audi|a4 allroad quattro»), y un segmento de ruta con eso dentro
# depende de que nadie normalice el porcentaje por el camino.
@router.post(
    "/car-model-groups/rank",
    response_model=RankingRunRead,
    status_code=status.HTTP_202_ACCEPTED,
)
async def trigger_ranking(
    session: SessionDep,
    user: CurrentUser,
    background: BackgroundTasks,
    key: Annotated[str, Query(description="Binomio marca-modelo, `marca|modelo` en minúsculas")],
    payload: RankingRequest | None = None,
) -> RankingRun:
    """Lanza el agente de IA sobre las ofertas activas del binomio marca-modelo.

    Responde 202 de inmediato: el run se completa en segundo plano y se consulta
    con `GET /ranking-runs/{id}`.
    """
    if not settings.ai_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="El ranking con IA no está configurado (falta ANTHROPIC_API_KEY)",
        )

    label = await _resolve_binomio(session, key)

    in_flight = await session.scalar(
        select(RankingRun.id).where(
            RankingRun.make_model_key == key,
            RankingRun.status.in_([RunStatus.PENDING, RunStatus.RUNNING]),
        )
    )
    if in_flight:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Ya hay un ranking en curso para este modelo (run {in_flight})",
        )

    run = RankingRun(
        make_model_key=key,
        label=label,
        triggered_by_id=user.id,
        status=RunStatus.PENDING,
        model_used=settings.ANTHROPIC_MODEL,
        effort=settings.ANTHROPIC_EFFORT,
    )
    session.add(run)
    await session.commit()
    await session.refresh(run)

    background.add_task(_run_in_background, run.id, payload or RankingRequest())
    return run


@router.get("/car-model-groups/ranking", response_model=RankingRunDetail)
async def get_latest_ranking(
    session: SessionDep,
    user: CurrentUser,
    key: Annotated[str, Query(description="Binomio marca-modelo, `marca|modelo` en minúsculas")],
) -> RankingRunDetail:
    """Último ranking completado del binomio, con todas las ofertas valoradas."""
    run_id = await session.scalar(
        select(RankingRun.id)
        .where(
            RankingRun.make_model_key == key,
            RankingRun.status == RunStatus.COMPLETED,
        )
        .order_by(desc(RankingRun.created_at))
        .limit(1)
    )
    if run_id is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Este modelo no tiene todavía ningún ranking completado",
        )
    return await _load_detail(session, run_id, user.id)


@router.get("/car-model-groups/ranking-runs", response_model=list[RankingRunRead])
async def list_runs_for_binomio(
    session: SessionDep,
    _: CurrentUser,
    key: Annotated[str, Query(description="Binomio marca-modelo, `marca|modelo` en minúsculas")],
    limit: int = 20,
) -> list[RankingRun]:
    stmt = (
        select(RankingRun)
        .where(RankingRun.make_model_key == key)
        .order_by(desc(RankingRun.created_at))
        .limit(min(limit, 100))
    )
    return list((await session.scalars(stmt)).unique())


@router.get("/ranking-runs/{run_id}", response_model=RankingRunDetail)
async def get_run(session: SessionDep, user: CurrentUser, run_id: int) -> RankingRunDetail:
    """Estado y resultado de un run concreto. Se usa para hacer polling tras el 202."""
    return await _load_detail(session, run_id, user.id)
