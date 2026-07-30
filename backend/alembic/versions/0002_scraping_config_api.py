"""Fuentes y combinaciones de rastreo administradas por la API.

Revision ID: 0002_scraping_config_api
Revises: 0001_ranking_por_binomio
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0002_scraping_config_api"
down_revision = "0001_ranking_por_binomio"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(name)


def upgrade() -> None:
    if not _has_table("scrape_sources"):
        op.create_table(
            "scrape_sources",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("key", sa.String(80), nullable=False),
            sa.Column("name", sa.String(160), nullable=False),
            sa.Column("base_url", sa.String(500), nullable=False),
            sa.Column("search_url_template", sa.String(1000)),
            sa.Column("listing_url", sa.String(1000)),
            sa.Column("access", sa.String(24), nullable=False),
            sa.Column("notes", sa.Text()),
            sa.Column("config", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.UniqueConstraint("key", name="uq_scrape_sources_key"),
        )
        op.create_index("ix_scrape_sources_key", "scrape_sources", ["key"], unique=True)

    if not _has_table("scrape_targets"):
        op.create_table(
            "scrape_targets",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "source_id",
                sa.Integer(),
                sa.ForeignKey("scrape_sources.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("make_model_key", sa.String(200), nullable=False),
            sa.Column("make", sa.String(80), nullable=False),
            sa.Column("model", sa.String(120), nullable=False),
            sa.Column("max_results", sa.Integer(), nullable=False, server_default="15"),
            sa.Column("search_url", sa.String(1000)),
            sa.Column("search_params", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.UniqueConstraint(
                "source_id", "make_model_key", name="uq_scrape_target_source_model"
            ),
        )
        op.create_index("ix_scrape_targets_source_id", "scrape_targets", ["source_id"])
        op.create_index("ix_scrape_targets_make_model_key", "scrape_targets", ["make_model_key"])
        op.create_index("ix_scrape_targets_active", "scrape_targets", ["is_active", "source_id"])


def downgrade() -> None:
    if _has_table("scrape_targets"):
        op.drop_table("scrape_targets")
    if _has_table("scrape_sources"):
        op.drop_table("scrape_sources")
