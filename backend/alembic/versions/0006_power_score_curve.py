"""La ventana de potencia pasa a 100-200 CV y la rampa se curva.

Antes la potencia era una rampa lineal de 50 a 250 CV: un utilitario de 90 CV ya
se llevaba 20 puntos y un coche de 200 CV se quedaba en 75. Ahora la señal vive
entre 100 y 200 CV —por debajo es un 0, por encima un 100— y dentro va elevada al
cuadrado, así que los CV ganados cerca del tope valen mucho más que los de abajo.

La configuración guardada gana siempre a los defaults del esquema, así que sin
esta revisión el cambio no se vería. Solo se toca la fila si aún tiene los
defaults viejos: quien ya afinó la ventana a mano no quiere que se la muevan.

Revision ID: 0006_power_score_curve
Revises: 0005_offer_manual_ratings
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op

revision = "0006_power_score_curve"
down_revision = "0005_offer_manual_ratings"
branch_labels = None
depends_on = None

_OLD = {"power_zero_score_hp": 50.0, "power_full_score_hp": 250.0}
_NEW = {"power_zero_score_hp": 100.0, "power_full_score_hp": 200.0, "power_curve_exponent": 2.0}


def _stored_params() -> dict | None:
    """Los parámetros de la fila singleton, o None si no hay nada que migrar."""
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("score_config"):
        return None
    row = bind.execute(sa.text("SELECT params FROM score_config WHERE id = 1")).scalar()
    if row is None:
        return None
    # Según el driver, una columna JSON vuelve ya decodificada o como texto.
    return json.loads(row) if isinstance(row, str) else dict(row)


def _matches(params: dict, expected: dict) -> bool:
    try:
        return all(float(params.get(key, "nan")) == value for key, value in expected.items())
    except (TypeError, ValueError):
        return False


def _write(params: dict) -> None:
    op.get_bind().execute(
        sa.text("UPDATE score_config SET params = :params WHERE id = 1"),
        {"params": json.dumps(params)},
    )


def upgrade() -> None:
    params = _stored_params()
    if params is None or not _matches(params, _OLD):
        return
    _write({**params, **_NEW})


def downgrade() -> None:
    params = _stored_params()
    if params is None or not _matches(params, _NEW):
        return
    restored = {**params, **_OLD}
    restored.pop("power_curve_exponent", None)
    _write(restored)
