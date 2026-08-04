"""Valoración manual de la oferta: equipamiento y estado aparente.

Dos notas de 1 a 5 que ningún anuncio trae y que solo aparecen cuando alguien ha
mirado el coche. Nacen a NULL en las ofertas que ya existen, y NULL significa
«sin nota»: la señal no puntúa y su peso se reparte entre las demás, así que las
puntuaciones de hoy no se mueven hasta que alguien valore algo.

Revision ID: 0005_offer_manual_ratings
Revises: 0004_offer_manual_edit
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0005_offer_manual_ratings"
down_revision = "0004_offer_manual_edit"
branch_labels = None
depends_on = None

_COLUMNS = ("equipment_rating", "apparent_condition_rating")


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

    for column in _COLUMNS:
        if column not in existing:
            op.add_column("offers", sa.Column(column, sa.Integer(), nullable=True))


def downgrade() -> None:
    existing = _columns()
    for column in reversed(_COLUMNS):
        if column in existing:
            op.drop_column("offers", column)
