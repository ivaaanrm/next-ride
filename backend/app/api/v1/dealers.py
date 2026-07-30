from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import Float, case, cast, func, select

from app.api.deps import CurrentUser, SessionDep
from app.models import Dealer, Offer, OfferStatus
from app.schemas.catalog import DealerCreate, DealerRead, DealerUpdate, DealerWithStats
from app.services.catalog import slugify

router = APIRouter(prefix="/dealers", tags=["dealers"])


@router.get("", response_model=list[DealerWithStats])
async def list_dealers(
    session: SessionDep,
    _: CurrentUser,
    q: Annotated[str | None, Query(description="Busca por nombre o ciudad")] = None,
    include_inactive: Annotated[bool, Query()] = False,
) -> list[DealerWithStats]:
    discount = case(
        (
            (Offer.original_price.isnot(None)) & (Offer.original_price > 0),
            (cast(Offer.original_price, Float) - cast(Offer.price, Float))
            / cast(Offer.original_price, Float)
            * 100,
        ),
        else_=None,
    )

    stmt = (
        select(
            Dealer,
            func.count(Offer.id).label("active_offers"),
            func.avg(discount).label("avg_discount"),
            func.min(cast(Offer.price, Float)).label("best_price"),
        )
        .outerjoin(
            Offer, (Offer.dealer_id == Dealer.id) & (Offer.status == OfferStatus.ACTIVE)
        )
        .group_by(Dealer.id)
        .order_by(func.count(Offer.id).desc(), Dealer.name)
    )
    if not include_inactive:
        stmt = stmt.where(Dealer.is_active.is_(True))
    if q:
        pattern = f"%{q.lower()}%"
        stmt = stmt.where(
            func.lower(Dealer.name).like(pattern) | func.lower(Dealer.city).like(pattern)
        )

    rows = (await session.execute(stmt)).all()
    return [
        DealerWithStats(
            **DealerRead.model_validate(dealer).model_dump(),
            active_offers=active_offers or 0,
            avg_discount_pct=round(avg_discount, 2) if avg_discount is not None else None,
            best_price=best_price,
        )
        for dealer, active_offers, avg_discount, best_price in rows
    ]


@router.post("", response_model=DealerRead, status_code=status.HTTP_201_CREATED)
async def create_dealer(session: SessionDep, _: CurrentUser, payload: DealerCreate) -> Dealer:
    slug = payload.slug or slugify(payload.name)
    if await session.scalar(select(Dealer.id).where(Dealer.slug == slug)):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=f"Ya existe un dealer con slug '{slug}'"
        )

    dealer = Dealer(**payload.model_dump(exclude={"slug"}), slug=slug)
    session.add(dealer)
    await session.commit()
    await session.refresh(dealer)
    return dealer


@router.get("/{dealer_id}", response_model=DealerRead)
async def get_dealer(session: SessionDep, _: CurrentUser, dealer_id: int) -> Dealer:
    dealer = await session.get(Dealer, dealer_id)
    if dealer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dealer no encontrado")
    return dealer


@router.patch("/{dealer_id}", response_model=DealerRead)
async def update_dealer(
    session: SessionDep, _: CurrentUser, dealer_id: int, payload: DealerUpdate
) -> Dealer:
    dealer = await session.get(Dealer, dealer_id)
    if dealer is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dealer no encontrado")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(dealer, field, value)
    await session.commit()
    await session.refresh(dealer)
    return dealer
