"""Configuración de la puntuación de valor: leerla y editarla.

La edición requiere usuario autenticado, igual que la configuración de
scraping. La respuesta lleva siempre los defaults al lado de lo vigente para
que la UI pueda enseñar el desvío y ofrecer «restaurar» sin otro endpoint.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import CurrentUser, SessionDep
from app.schemas.scoring import ScoreConfigRead, ScoreConfigUpdate, ScoreParams, ScoreWeights
from app.services.scoring import (
    ScoringConfig,
    component_info,
    get_scoring_config,
    save_scoring_config,
)

router = APIRouter(prefix="/scoring", tags=["scoring"])


def _read(config: ScoringConfig) -> ScoreConfigRead:
    return ScoreConfigRead(
        weights=config.weights,
        params=config.params,
        components=component_info(config),
        default_weights=ScoreWeights(),
        default_params=ScoreParams(),
        updated_at=config.updated_at,
    )


@router.get("/config", response_model=ScoreConfigRead)
async def read_config(session: SessionDep, _: CurrentUser) -> ScoreConfigRead:
    """Pesos y parámetros vigentes, con la explicación de cada componente."""
    return _read(await get_scoring_config(session))


@router.put("/config", response_model=ScoreConfigRead)
async def update_config(
    session: SessionDep, _: CurrentUser, payload: ScoreConfigUpdate
) -> ScoreConfigRead:
    """Actualiza pesos y/o parámetros. Lo que no venga en el body se conserva.

    El cambio afecta a todos los usuarios: la puntuación es un atributo del
    catálogo, no una preferencia personal, y se recalcula al leer.
    """
    return _read(
        await save_scoring_config(session, weights=payload.weights, params=payload.params)
    )
