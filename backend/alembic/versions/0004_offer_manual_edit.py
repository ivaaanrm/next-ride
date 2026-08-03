"""Corrección manual de ofertas: campos anclados y firma de la edición.

`manual_fields` es la lista de columnas que ha escrito una persona a mano y que
el scraper ya no debe pisar. Nace vacía en las ofertas que ya existen: hasta que
alguien corrija algo, el origen sigue mandando en todo, que es como estaba.

Revision ID: 0004_offer_manual_edit
Revises: 0003_score_config
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0004_offer_manual_edit"
down_revision = "0003_score_config"
branch_labels = None
depends_on = None


def _columns() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("offers"):
        return set()
    return {column["name"] for column in inspector.get_columns("offers")}


def upgrade() -> None:
    # Cada columna se salta a sí misma si `create_all` ya la creó al arrancar,
    # igual que el resto de revisiones de este proyecto.
    existing = _columns()
    if not existing:
        return

    if "manual_fields" not in existing:
        op.add_column(
            "offers",
            sa.Column(
                "manual_fields",
                sa.JSON(),
                nullable=False,
                server_default=sa.text("'[]'"),
            ),
        )
    if "edited_at" not in existing:
        op.add_column("offers", sa.Column("edited_at", sa.DateTime(timezone=True)))
    if "edited_by_id" not in existing:
        op.add_column(
            "offers",
            sa.Column(
                "edited_by_id",
                sa.Integer(),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
            ),
        )


def downgrade() -> None:
    existing = _columns()
    for column in ("edited_by_id", "edited_at", "manual_fields"):
        if column in existing:
            op.drop_column("offers", column)
