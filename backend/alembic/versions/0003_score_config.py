"""Configuración de la puntuación de valor (pesos y parámetros editables).

Revision ID: 0003_score_config
Revises: 0002_scraping_config_api
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0003_score_config"
down_revision = "0002_scraping_config_api"
branch_labels = None
depends_on = None


def _has_table(name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(name)


def upgrade() -> None:
    # Se salta a sí misma si `create_all` ya creó la tabla en el arranque.
    if _has_table("score_config"):
        return
    op.create_table(
        "score_config",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("weights", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("params", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
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
    )


def downgrade() -> None:
    if _has_table("score_config"):
        op.drop_table("score_config")
