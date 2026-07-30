"""El ranking de IA pasa de la versión al binomio marca-modelo.

`ranking_runs.car_model_id` apuntaba a una fila de `car_models`, que está partida
por acabado: rankear «Audi A3 Sportback 35 TDI» era rankear una sola oferta
contra sí misma. El objetivo pasa a ser el binomio (`marca|modelo` en
minúsculas), que es el conjunto en el que elige un comprador.

Los runs existentes se conservan y se reapuntan al binomio de su versión: sus
`offer_rankings` siguen señalando ofertas reales, y esas ofertas son un
subconjunto de las del binomio.

La migración se salta a sí misma si la tabla ya tiene la forma nueva: en la v1 el
esquema lo crea `Base.metadata.create_all` al arrancar, así que una base recién
hecha nace ya migrada y `alembic upgrade head` sobre ella no debe fallar.

Revision ID: 0001_ranking_por_binomio
Revises:
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0001_ranking_por_binomio"
down_revision = None
branch_labels = None
depends_on = None

TABLE = "ranking_runs"


def _columns() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(TABLE):
        return set()
    return {column["name"] for column in inspector.get_columns(TABLE)}


def upgrade() -> None:
    columns = _columns()
    if not columns or "make_model_key" in columns:
        return

    op.add_column(TABLE, sa.Column("make_model_key", sa.String(200), nullable=True))
    op.add_column(TABLE, sa.Column("label", sa.String(200), nullable=True))

    # Los runs que ya existían se quedan con el binomio de la versión que
    # rankearon, y con su nombre completo como etiqueta.
    op.execute(
        """
        UPDATE ranking_runs AS r
           SET make_model_key = lower(m.make) || '|' || lower(m.model),
               label = m.make || ' ' || m.model
          FROM car_models AS m
         WHERE m.id = r.car_model_id
        """
    )
    # Un run huérfano (su modelo ya no está) no tiene binomio del que colgar.
    op.execute("DELETE FROM ranking_runs WHERE make_model_key IS NULL")

    op.alter_column(TABLE, "make_model_key", nullable=False)
    op.alter_column(TABLE, "label", nullable=False, server_default="")

    op.drop_index("ix_ranking_runs_model_created", table_name=TABLE)
    op.drop_column(TABLE, "car_model_id")

    op.create_index(f"ix_{TABLE}_make_model_key", TABLE, ["make_model_key"])
    op.create_index("ix_ranking_runs_binomio_created", TABLE, ["make_model_key", "created_at"])


def downgrade() -> None:
    columns = _columns()
    if "car_model_id" in columns:
        return

    # Vuelta atrás con pérdida: un binomio no dice de qué versión salió el run,
    # así que se le asigna la primera de sus versiones por orden alfabético.
    op.add_column(TABLE, sa.Column("car_model_id", sa.Integer(), nullable=True))
    op.execute(
        """
        UPDATE ranking_runs AS r
           SET car_model_id = (
                 SELECT m.id FROM car_models AS m
                  WHERE lower(m.make) || '|' || lower(m.model) = r.make_model_key
                  ORDER BY m.trim, m.id
                  LIMIT 1
               )
        """
    )
    op.execute("DELETE FROM ranking_runs WHERE car_model_id IS NULL")
    op.alter_column(TABLE, "car_model_id", nullable=False)
    op.create_foreign_key(
        "fk_ranking_runs_car_model_id", TABLE, "car_models", ["car_model_id"], ["id"],
        ondelete="CASCADE",
    )

    op.drop_index("ix_ranking_runs_binomio_created", table_name=TABLE)
    op.drop_index(f"ix_{TABLE}_make_model_key", table_name=TABLE)
    op.drop_column(TABLE, "label")
    op.drop_column(TABLE, "make_model_key")

    op.create_index("ix_ranking_runs_model_created", TABLE, ["car_model_id", "created_at"])
