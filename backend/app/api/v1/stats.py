from fastapi import APIRouter
from sqlalchemy import Float, case, cast, func, select

from app.api.deps import CurrentUser, SessionDep
from app.core.config import settings
from app.models import CarModel, Dealer, Offer, OfferFavorite, OfferStatus, TrackedModel
from app.schemas.offer import ModelPriceStats, OverviewStats
from app.services.metrics import enrich_offers, model_price_stats

router = APIRouter(prefix="/stats", tags=["stats"])


@router.get("/overview", response_model=OverviewStats)
async def overview(session: SessionDep, user: CurrentUser) -> OverviewStats:
    active_offers = await session.scalar(
        select(func.count(Offer.id)).where(Offer.status == OfferStatus.ACTIVE)
    )
    dismissed_offers = await session.scalar(
        select(func.count(Offer.id)).where(Offer.status == OfferStatus.DISMISSED)
    )
    favorite_offers = await session.scalar(
        select(func.count(OfferFavorite.id)).where(OfferFavorite.user_id == user.id)
    )
    dealers = await session.scalar(
        select(func.count(Dealer.id)).where(Dealer.is_active.is_(True))
    )
    car_models = await session.scalar(
        select(func.count(CarModel.id)).where(CarModel.is_active.is_(True))
    )
    tracked = await session.scalar(
        select(func.count(TrackedModel.id)).where(
            TrackedModel.user_id == user.id, TrackedModel.is_active.is_(True)
        )
    )

    discount = case(
        (
            (Offer.original_price.isnot(None)) & (Offer.original_price > 0),
            (cast(Offer.original_price, Float) - cast(Offer.price, Float))
            / cast(Offer.original_price, Float)
            * 100,
        ),
        else_=None,
    )
    avg_discount = await session.scalar(
        select(func.avg(discount)).where(Offer.status == OfferStatus.ACTIVE)
    )

    # "Mejor chollo": la oferta activa con mayor puntuación heurística entre las
    # de mayor descuento (evita puntuar todo el catálogo en cada petición).
    candidates = list(
        (
            await session.scalars(
                select(Offer)
                .where(Offer.status == OfferStatus.ACTIVE)
                .order_by(Offer.last_seen_at.desc())
                .limit(120)
            )
        ).unique()
    )
    best_deal = None
    if candidates:
        offers, metrics = await enrich_offers(session, candidates)
        top = max(offers, key=lambda o: metrics[o.id].value_score or 0)
        from app.schemas.offer import OfferRead

        best_deal = OfferRead.model_validate(top)
        best_deal.metrics = metrics[top.id]
        best_deal.is_favorite = bool(
            await session.scalar(
                select(OfferFavorite.id).where(
                    OfferFavorite.user_id == user.id, OfferFavorite.offer_id == top.id
                )
            )
        )

    return OverviewStats(
        active_offers=active_offers or 0,
        dismissed_offers=dismissed_offers or 0,
        favorite_offers=favorite_offers or 0,
        dealers=dealers or 0,
        car_models=car_models or 0,
        tracked_models=tracked or 0,
        avg_discount_pct=round(avg_discount, 2) if avg_discount is not None else None,
        best_deal=best_deal,
        ai_enabled=settings.ai_enabled,
    )


@router.get("/car-models/{car_model_id}", response_model=ModelPriceStats)
async def model_stats(session: SessionDep, _: CurrentUser, car_model_id: int) -> ModelPriceStats:
    stats = await model_price_stats(session, [car_model_id])
    return stats.get(car_model_id) or ModelPriceStats(car_model_id=car_model_id, count=0)
