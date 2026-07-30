from fastapi import APIRouter

from app.api.v1 import (
    analytics,
    api_keys,
    auth,
    car_models,
    dealers,
    offers,
    rankings,
    stats,
    tracking,
)

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(api_keys.router)
api_router.include_router(dealers.router)
api_router.include_router(car_models.router)
api_router.include_router(tracking.router)
api_router.include_router(offers.router)
api_router.include_router(rankings.router)
api_router.include_router(stats.router)
api_router.include_router(analytics.router)
