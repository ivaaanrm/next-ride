from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.common import ORMModel

ScrapeAccess = Literal["fetch", "playwright", "browser", "manual"]


class ScrapeSourceBase(BaseModel):
    key: str = Field(min_length=1, max_length=80, pattern=r"^[a-z0-9._-]+$")
    name: str = Field(min_length=1, max_length=160)
    base_url: str = Field(min_length=1, max_length=500)
    search_url_template: str | None = Field(default=None, max_length=1000)
    listing_url: str | None = Field(default=None, max_length=1000)
    access: ScrapeAccess
    notes: str | None = None
    config: dict[str, Any] = Field(default_factory=dict)


class ScrapeSourceCreate(ScrapeSourceBase):
    pass


class ScrapeSourceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    base_url: str | None = Field(default=None, min_length=1, max_length=500)
    search_url_template: str | None = Field(default=None, max_length=1000)
    listing_url: str | None = Field(default=None, max_length=1000)
    access: ScrapeAccess | None = None
    notes: str | None = None
    config: dict[str, Any] | None = None
    is_active: bool | None = None


class ScrapeSourceRead(ORMModel):
    id: int
    key: str
    name: str
    base_url: str
    search_url_template: str | None
    listing_url: str | None
    access: ScrapeAccess
    notes: str | None
    config: dict[str, Any]
    is_active: bool
    created_at: datetime
    updated_at: datetime


class ScrapeTargetSelection(BaseModel):
    source_id: int = Field(gt=0)
    make: str = Field(min_length=1, max_length=80)
    model: str = Field(min_length=1, max_length=120)

    @field_validator("make", "model")
    @classmethod
    def normalize_spaces(cls, value: str) -> str:
        return " ".join(value.split())


class ScrapeTargetsReplace(BaseModel):
    max_per_target: int = Field(default=15, ge=1, le=100)
    targets: list[ScrapeTargetSelection] = Field(default_factory=list)

    @model_validator(mode="after")
    def reject_duplicates(self) -> "ScrapeTargetsReplace":
        identities = [
            (target.source_id, target.make.casefold(), target.model.casefold())
            for target in self.targets
        ]
        if len(identities) != len(set(identities)):
            raise ValueError("No repitas una combinación de modelo y fuente")
        return self


class ScrapeTargetPatch(BaseModel):
    search_url: str | None = Field(default=None, max_length=1000)
    search_params: dict[str, Any] | None = None
    max_results: int | None = Field(default=None, ge=1, le=100)
    is_active: bool | None = None


class ScrapeTargetRead(ORMModel):
    id: int
    source_id: int
    make_model_key: str
    make: str
    model: str
    max_results: int
    search_url: str | None
    search_params: dict[str, Any]
    is_active: bool
    created_at: datetime
    updated_at: datetime
    source: ScrapeSourceRead

    @property
    def label(self) -> str:
        return f"{self.make} {self.model}"


class ScrapeRuntimeTarget(BaseModel):
    id: int
    make_model_key: str
    make: str
    model: str
    label: str
    max_results: int
    search_url: str | None
    search_params: dict[str, Any]
    source: ScrapeSourceRead


class ScrapeRuntimeConfig(BaseModel):
    max_per_target: int
    targets: list[ScrapeRuntimeTarget]
