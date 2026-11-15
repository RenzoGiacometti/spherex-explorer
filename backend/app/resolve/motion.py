"""Propagacion de la posicion de un objeto y trayectoria dentro de un campo.

Referencia probada contra los datos: `Target.position_at` en spike/field.py
(movimiento propio con `apply_space_motion` de astropy mas el desplazamiento
paralactico con la posicion baricentrica de la Tierra). Con eso Barnard quedo a
menos de 2.2" de la posicion medida en cada epoca.

Aca el movimiento propio se propaga con la misma funcion de ERFA que usa
`SkyCoord.apply_space_motion` (`pmsafe`) y con los mismos argumentos, pero
llamada directamente (ver `_space_motion`): asi no hace falta apagar el aviso
que ERFA da cuando no hay paralaje, y `position_at` se puede llamar desde varios
hilos. `tests/test_motion_propagation.py` compara los dos caminos.

No baja nada: la posicion de la Tierra sale de la efemeride incluida en astropy
(`get_body_barycentric` con la efemeride por defecto, `builtin`), y pasar de
UTC a TDB no necesita las tablas IERS.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Sequence

import astropy.units as u
import erfa
from astropy.coordinates import get_body_barycentric
from astropy.time import Time

from app import geometry
from app.config import FIELD_EPOCH
from app.domain import EpochSummary, Grid, ResolvedTarget, TrackPoint

logger = logging.getLogger(__name__)

MAS_PER_DEG = 3.6e6
_RAD_PER_MAS = math.pi / 180.0 / MAS_PER_DEG

# Estado que devuelve `pmsafe` (documentado en `erfa.pmsafe`): 0 sin avisos; 1 "distance
# overridden", ERFA uso una paralaje minima en lugar de la indicada (lo normal sin paralaje);
# 2 "excessive velocity" y 4 "solution didn't converge"; negativo, error.
_PMSAFE_DISTANCE_OVERRIDDEN = 1


def _moves(target: ResolvedTarget) -> bool:
    """Si hay algo que propagar: movimiento propio o paralaje distintos de cero."""
    return bool(target.pm_ra or target.pm_dec or target.parallax)


def _space_motion(target: ResolvedTarget, parallax: float, when: Time) -> tuple[float, float]:
    """Posicion baricentrica `(ra, dec)` en grados tras el movimiento propio, del `ref_epoch` del objeto a `when`.

    Es la cuenta de `SkyCoord.apply_space_motion` de astropy: `erfa.pmsafe` con
    la posicion en radianes, el movimiento propio en radianes por anio (el de
    ascension recta sin el factor cos(dec)), la paralaje en segundos de arco,
    la velocidad radial en km/s y las dos fechas en TDB. Con paralaje entra la
    velocidad radial (aceleracion de perspectiva; 0 km/s si el catalogo no la
    trae); sin paralaje van 0 y 0, y es movimiento propio puro.

    Se llama al ufunc (`erfa.ufunc.pmsafe`, el mismo que usa astropy por
    debajo) y no a `erfa.pmsafe` porque el ufunc devuelve el estado como un
    numero, mientras que la funcion lo convierte en un `ErfaWarning`. Sin
    paralaje ese aviso sale en cada llamada ("distance overridden": ERFA
    propaga con una distancia muy grande, que es lo que se quiere), y la unica
    forma de callarlo, `warnings.catch_warnings`, no es segura entre hilos:
    cambia los filtros de avisos de todo el proceso y puede dejarlos cambiados.
    """
    dec_rad = math.radians(target.dec)
    start = Time(target.ref_epoch, format="jyear").tdb
    end = when.tdb
    ra_rad, dec_rad, _pm_ra, _pm_dec, _parallax, _velocity, status = erfa.ufunc.pmsafe(
        math.radians(target.ra),
        dec_rad,
        (target.pm_ra or 0.0) * _RAD_PER_MAS / math.cos(dec_rad),
        (target.pm_dec or 0.0) * _RAD_PER_MAS,
        parallax / 1000.0,
        (target.radial_velocity or 0.0) if parallax > 0 else 0.0,
        start.jd1,
        start.jd2,
        end.jd1,
        end.jd2,
    )
    status = int(status)
    if status < 0:
        raise erfa.ErfaError(f'ERFA function "pmsafe" yielded {status}')
    if status & ~_PMSAFE_DISTANCE_OVERRIDDEN:
        # Velocidad excesiva o cuenta que no converge: datos de catalogo sin sentido. Se sigue con
        # lo que dio ERFA, como antes, pero queda dicho en el log (que si es seguro entre hilos).
        logger.warning("ERFA pmsafe devolvio el estado %d al propagar %r", status, target.query)
    return math.degrees(float(ra_rad)), math.degrees(float(dec_rad))


def _position_at_time(target: ResolvedTarget, when: Time) -> tuple[float, float]:
    """Misma cuenta que `Target.position_at` en spike/field.py, para un instante de astropy."""
    if not _moves(target):
        return target.ra % 360.0, target.dec

    parallax = target.parallax if target.parallax is not None and target.parallax > 0 else 0.0
    ra, dec = _space_motion(target, parallax, when)

    if parallax > 0:
        # Desplazamiento paralactico = -paralaje x (posicion baricentrica del
        # observador proyectada sobre el plano del cielo). SPHEREx esta en
        # orbita baja: se usa la Tierra.
        x, y, z = get_body_barycentric("earth", when).xyz.to_value(u.au)
        a, d = math.radians(ra), math.radians(dec)
        east = parallax * (x * math.sin(a) - y * math.cos(a))
        north = parallax * (x * math.cos(a) * math.sin(d) + y * math.sin(a) * math.sin(d) - z * math.cos(d))
        ra += float(east) / MAS_PER_DEG / math.cos(d)
        dec += float(north) / MAS_PER_DEG
    return ra % 360.0, dec


def position_at(target: ResolvedTarget, mjd: float) -> tuple[float, float]:
    """`(ra, dec)` ICRS aparentes del objeto en la fecha `mjd`, en grados.

    Incluye movimiento propio (con velocidad radial y distancia si hay paralaje)
    y el desplazamiento paralactico. Si el objeto no tiene movimiento propio ni
    paralaje, devuelve la posicion de catalogo. `mjd` es UTC, como todas las
    fechas del contrato; `ra` queda en [0, 360).

    Se puede llamar desde varios hilos a la vez: no toca los filtros de avisos
    del proceso ni guarda nada entre llamadas.
    """
    return _position_at_time(target, Time(mjd, format="mjd", scale="utc"))


def field_center(target: ResolvedTarget, epoch: float = FIELD_EPOCH) -> tuple[float, float]:
    """Donde centrar el campo: la posicion del objeto en una epoca fija (anio juliano), en grados.

    Es fija a proposito (contrato, seccion 4.8): si dependiera de la fecha del
    dia, el `id` del campo cambiaria con el tiempo. Sin movimiento propio
    coincide con la posicion J2000, aunque el catalogo traiga paralaje: el
    contrato lo fija asi, y sin movimiento propio tampoco hay trayectoria.
    Devuelve la posicion sin redondear; a los 4 decimales del contrato la lleva
    quien arma la respuesta (`app.resolve.service`).
    """
    if not target.has_proper_motion:
        return target.ra % 360.0, target.dec
    return _position_at_time(target, Time(epoch, format="jyear"))


def moved_arcsec(target: ResolvedTarget, epoch: float = FIELD_EPOCH) -> float:
    """Cuanto se aparto el objeto de su posicion de catalogo en esa epoca, en segundos de arco."""
    ra, dec = field_center(target, epoch)
    return geometry.angular_separation_deg(target.ra, target.dec, ra, dec) * 3600.0


def per_year_arcsec(target: ResolvedTarget) -> float:
    """Modulo del movimiento propio, en segundos de arco por anio (0 si el catalogo no lo trae)."""
    return math.hypot(target.pm_ra or 0.0, target.pm_dec or 0.0) / 1000.0


def track(target: ResolvedTarget, epochs: Sequence[EpochSummary], grid: Grid) -> list[TrackPoint]:
    """Posicion esperada del objeto en cada epoca del campo, para la mira y el rastro (contrato, seccion 4.9).

    Usa la fecha media de cada epoca. Cada punto trae la posicion en el cielo,
    el pixel `(x, y)` de la grilla con indices desde 0 y si cae dentro del
    campo. Devuelve la lista vacia si el objeto no tiene movimiento propio.

    Un objeto a mas de 90 grados del centro del campo no tiene pixel en la
    proyeccion TAN de la grilla (da `NaN`, que no entra en JSON): esos puntos
    se omiten. Uno que esta lejos pero del mismo lado del cielo si sale, con
    `in_field` en falso.
    """
    if not target.has_proper_motion:
        return []
    points: list[TrackPoint] = []
    for item in epochs:
        ra, dec = position_at(target, item.mjd_mean)
        x, y = geometry.sky_to_pixel(grid, ra, dec)
        if not (math.isfinite(x) and math.isfinite(y)):
            continue
        points.append(
            TrackPoint(
                epoch=item.epoch, mjd=item.mjd_mean, ra=ra, dec=dec, x=x, y=y, in_field=geometry.in_grid(grid, x, y)
            )
        )
    return points
