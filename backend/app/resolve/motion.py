"""Propagacion de la posicion de un objeto y trayectoria dentro de un campo.

Referencia probada contra los datos: `Target.position_at` en spike/field.py
(movimiento propio con `apply_space_motion` de astropy mas el desplazamiento
paralactico con la posicion baricentrica de la Tierra). Con eso Barnard quedo a
menos de 2.2" de la posicion medida en cada epoca.

Pendiente de implementar: por ahora solo estan las firmas.
"""

from __future__ import annotations

from collections.abc import Sequence

from app.config import FIELD_EPOCH
from app.domain import EpochSummary, Grid, ResolvedTarget, TrackPoint


def position_at(target: ResolvedTarget, mjd: float) -> tuple[float, float]:
    """`(ra, dec)` ICRS aparentes del objeto en la fecha `mjd`, en grados.

    Incluye movimiento propio (con velocidad radial y distancia si hay paralaje)
    y el desplazamiento paralactico. Si el objeto no tiene movimiento propio ni
    paralaje, devuelve la posicion de catalogo.
    """
    raise NotImplementedError


def field_center(target: ResolvedTarget, epoch: float = FIELD_EPOCH) -> tuple[float, float]:
    """Donde centrar el campo: la posicion del objeto en una epoca fija (anio juliano), en grados.

    Es fija a proposito (contrato, seccion 4.8): si dependiera de la fecha del
    dia, el `id` del campo cambiaria con el tiempo. Sin movimiento propio
    coincide con la posicion J2000.
    """
    raise NotImplementedError


def moved_arcsec(target: ResolvedTarget, epoch: float = FIELD_EPOCH) -> float:
    """Cuanto se aparto el objeto de su posicion de catalogo en esa epoca, en segundos de arco."""
    raise NotImplementedError


def track(target: ResolvedTarget, epochs: Sequence[EpochSummary], grid: Grid) -> list[TrackPoint]:
    """Posicion esperada del objeto en cada epoca del campo, para la mira y el rastro (contrato, seccion 4.9).

    Usa la fecha media de cada epoca. Cada punto trae la posicion en el cielo,
    el pixel `(x, y)` de la grilla con indices desde 0 y si cae dentro del
    campo. Devuelve la lista vacia si el objeto no tiene movimiento propio.
    """
    raise NotImplementedError
