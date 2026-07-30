"""Configuración operativa que consume el skill de captación."""

from __future__ import annotations

from string import Formatter
from typing import Any

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, IngestDep, SessionDep
from app.models import ScrapeSource, ScrapeTarget
from app.models.scraping import canonical_make_model_key
from app.schemas.scraping import (
    ScrapeRuntimeConfig,
    ScrapeRuntimeTarget,
    ScrapeSourceCreate,
    ScrapeSourceRead,
    ScrapeSourceUpdate,
    ScrapeTargetPatch,
    ScrapeTargetRead,
    ScrapeTargetsReplace,
)
from app.services.scraping_config import default_search_params

router = APIRouter(prefix="/scraping", tags=["scraping"])


def _render_search_url(
    template: str | None, params: dict[str, Any], override: str | None
) -> str | None:
    if override:
        return override
    if not template:
        return None
    fields = {
        field_name for _, field_name, _, _ in Formatter().parse(template) if field_name is not None
    }
    if not fields.issubset(params):
        return None
    try:
        return template.format(**params)
    except (KeyError, ValueError):
        return None


async def _target_or_404(session: SessionDep, target_id: int) -> ScrapeTarget:
    target = await session.scalar(
        select(ScrapeTarget)
        .where(ScrapeTarget.id == target_id)
        .options(selectinload(ScrapeTarget.source))
    )
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Target de rastreo no encontrado"
        )
    return target


@router.get("/sources", response_model=list[ScrapeSourceRead])
async def list_sources(
    session: SessionDep,
    _: CurrentUser,
    include_inactive: bool = Query(default=False),
) -> list[ScrapeSource]:
    stmt = select(ScrapeSource).order_by(ScrapeSource.name)
    if not include_inactive:
        stmt = stmt.where(ScrapeSource.is_active.is_(True))
    return list(await session.scalars(stmt))


@router.post("/sources", response_model=ScrapeSourceRead, status_code=status.HTTP_201_CREATED)
async def create_source(
    session: SessionDep, _: CurrentUser, payload: ScrapeSourceCreate
) -> ScrapeSource:
    existing = await session.scalar(select(ScrapeSource).where(ScrapeSource.key == payload.key))
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Ya existe una fuente con esa clave"
        )
    source = ScrapeSource(**payload.model_dump())
    session.add(source)
    await session.commit()
    await session.refresh(source)
    return source


@router.patch("/sources/{source_id}", response_model=ScrapeSourceRead)
async def update_source(
    session: SessionDep,
    _: CurrentUser,
    source_id: int,
    payload: ScrapeSourceUpdate,
) -> ScrapeSource:
    source = await session.get(ScrapeSource, source_id)
    if source is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Fuente de rastreo no encontrada"
        )
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(source, field, value)
    await session.commit()
    await session.refresh(source)
    return source


@router.get("/targets", response_model=list[ScrapeTargetRead])
async def list_targets(
    session: SessionDep,
    _: CurrentUser,
    include_inactive: bool = Query(default=False),
) -> list[ScrapeTarget]:
    stmt = (
        select(ScrapeTarget)
        .options(selectinload(ScrapeTarget.source))
        .order_by(ScrapeTarget.make, ScrapeTarget.model, ScrapeTarget.source_id)
    )
    if not include_inactive:
        stmt = stmt.where(ScrapeTarget.is_active.is_(True))
    return list(await session.scalars(stmt))


@router.put("/targets", response_model=list[ScrapeTargetRead])
async def replace_targets(
    session: SessionDep,
    _: CurrentUser,
    payload: ScrapeTargetsReplace,
) -> list[ScrapeTarget]:
    """Reemplaza atómicamente la selección activa, conservando mappings aprendidos."""

    source_ids = {item.source_id for item in payload.targets}
    sources = {
        source.id: source
        for source in await session.scalars(
            select(ScrapeSource).where(
                ScrapeSource.id.in_(source_ids), ScrapeSource.is_active.is_(True)
            )
        )
    }
    missing = sorted(source_ids - sources.keys())
    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Fuentes inexistentes o inactivas: {', '.join(map(str, missing))}",
        )

    existing = list(
        await session.scalars(select(ScrapeTarget).options(selectinload(ScrapeTarget.source)))
    )
    by_identity = {(target.source_id, target.make_model_key): target for target in existing}
    selected: list[ScrapeTarget] = []
    selected_ids: set[tuple[int, str]] = set()

    for item in payload.targets:
        key = canonical_make_model_key(item.make, item.model)
        identity = (item.source_id, key)
        target = by_identity.get(identity)
        if target is None:
            params = default_search_params(sources[item.source_id], item.make, item.model)
            target = ScrapeTarget(
                source_id=item.source_id,
                make_model_key=key,
                make=item.make,
                model=item.model,
                max_results=payload.max_per_target,
                search_params=params,
                is_active=True,
            )
            session.add(target)
        else:
            target.make = item.make
            target.model = item.model
            target.max_results = payload.max_per_target
            target.is_active = True
            target.search_params = {
                **default_search_params(sources[item.source_id], item.make, item.model),
                **target.search_params,
            }
        selected.append(target)
        selected_ids.add(identity)

    for target in existing:
        if (target.source_id, target.make_model_key) not in selected_ids:
            target.is_active = False

    await session.commit()
    for target in selected:
        await session.refresh(target)  # columnas expiradas por el commit
        await session.refresh(target, attribute_names=["source"])
    return selected


@router.patch("/targets/{target_id}", response_model=ScrapeTargetRead)
async def patch_target(
    session: SessionDep,
    _: IngestDep,
    target_id: int,
    payload: ScrapeTargetPatch,
) -> ScrapeTarget:
    """Permite que el skill persista una URL o IDs descubiertos en el navegador."""

    target = await _target_or_404(session, target_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(target, field, value)
    await session.commit()
    # El commit expira todos los atributos. Refrescar solo `source` deja las
    # columnas (updated_at incluido) sin cargar, y serializar la respuesta
    # intentaría un lazy load fuera del greenlet: 500 con el cambio ya escrito.
    await session.refresh(target)
    await session.refresh(target, attribute_names=["source"])
    return target


@router.get("/config", response_model=ScrapeRuntimeConfig)
async def runtime_config(session: SessionDep, _: IngestDep) -> ScrapeRuntimeConfig:
    """Configuración completa que el skill debe pedir antes de abrir ningún dealer."""

    targets = list(
        await session.scalars(
            select(ScrapeTarget)
            .join(ScrapeTarget.source)
            .where(
                ScrapeTarget.is_active.is_(True),
                ScrapeSource.is_active.is_(True),
            )
            .options(selectinload(ScrapeTarget.source))
            .order_by(ScrapeTarget.make, ScrapeTarget.model, ScrapeSource.name)
        )
    )
    runtime_targets = [
        ScrapeRuntimeTarget(
            id=target.id,
            make_model_key=target.make_model_key,
            make=target.make,
            model=target.model,
            label=f"{target.make} {target.model}",
            max_results=target.max_results,
            search_url=_render_search_url(
                target.source.search_url_template,
                target.search_params,
                target.search_url,
            ),
            search_params=target.search_params,
            source=ScrapeSourceRead.model_validate(target.source),
        )
        for target in targets
    ]
    return ScrapeRuntimeConfig(
        max_per_target=max((target.max_results for target in targets), default=15),
        targets=runtime_targets,
    )
