"""La potencia pasa de una parábola a una curva en S.

`power_curve_exponent` premiaba los CV altos hundiendo el centro de la ventana:
150 CV, que es un motor perfectamente bueno, puntuaba 25. Y no había exponente
que lo arreglara, porque esa familia de curvas no puede subir el centro sin
subir también el suelo. La S sí: dura abajo (110 CV → 7), empinada al pasar de
`power_mid_hp` (150 CV → 73) y saturada arriba.

El exponente desaparece siempre: ya no significa nada y dejarlo en el JSON sería
guardar basura. La ventana (`power_zero_score_hp` / `power_full_score_hp`) solo
se toca si aún tiene los valores que dejó la 0006; quien la haya afinado a mano
se la queda.

Revision ID: 0007_power_score_s_curve
Revises: 0006_power_score_curve
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op

revision = "0007_power_score_s_curve"
down_revision = "0006_power_score_curve"
branch_labels = None
depends_on = None

_WINDOW_FROM_0006 = {"power_zero_score_hp": 100.0, "power_full_score_hp": 200.0}
_S_CURVE = {"power_mid_hp": 135.0, "power_curve_steepness": 0.07}
_EXPONENT = {"power_curve_exponent": 2.0}


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
    if params is None:
        return
    updated = {**params, **_S_CURVE}
    updated.pop("power_curve_exponent", None)
    if _matches(params, _WINDOW_FROM_0006):
        updated.update(_WINDOW_FROM_0006)
    _write(updated)


def downgrade() -> None:
    params = _stored_params()
    if params is None:
        return
    restored = {**params, **_EXPONENT}
    for key in _S_CURVE:
        restored.pop(key, None)
    _write(restored)
