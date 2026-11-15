"""Respuestas del contrato para `GET /api/resolve` (seccion 4.8) y `GET /api/field/{id}/track` (seccion 4.9).

Junta la lectura de coordenadas (`coords`), Sesame (`sesame`) y la propagacion
(`motion`), y deja armados los modelos de `app.contract`, para que cada ruta
sea una linea:

    resolve(name, settings)               -> ResolveResponse
    field_track(name, meta, settings)     -> TrackResponse

Las dos consultan Sesame si el texto no son coordenadas y el nombre no esta en
la cache: bloquean hasta `settings.sesame_timeout_s` por intento. Desde una
ruta `async` hay que llamarlas en un hilo (`run_in_threadpool`).

Redondeos de la respuesta, los de los ejemplos del contrato: `j2000` a 6
decimales (0.004"), `field_center` a 4 (los de la identidad del campo, seccion
3), `moved_arcsec` a 1, `per_year_arcsec` a 2, y movimiento propio, paralaje y
velocidad radial a 3. En la trayectoria: `mjd` a 4 decimales, `ra` y `dec` a 7
y el pixel a 3, como las trayectorias guardadas con las muestras.
"""

from __future__ import annotations

from collections.abc import Sequence

from app import geometry
from app.api.errors import invalid_request, not_ready
from app.config import FIELD_EPOCH, Settings
from app.contract import (
    EpochInfo,
    FieldCenter,
    FieldMeta,
    Motion,
    ResolveResponse,
    SkyPosition,
    TrackPosition,
    TrackResponse,
)
from app.domain import EpochSummary, Grid, ResolvedTarget
from app.resolve import motion
from app.resolve.coords import parse_coordinates
from app.resolve.sesame import normalize_query, resolve_name

J2000_DECIMALS = 6
CATALOG_DECIMALS = 3
TRACK_MJD_DECIMALS = 4
TRACK_SKY_DECIMALS = 7
TRACK_PIXEL_DECIMALS = 3


def _round(value: float, decimals: int) -> float:
    """Redondea sin dejar `-0.0`, que en JSON se escribe distinto de `0.0`."""
    return round(value, decimals) + 0.0


def _round_ra(ra: float, decimals: int) -> float:
    """`ra` redondeada, en [0, 360): un valor que el redondeo deja en 360 vuelve a 0."""
    rounded = _round(ra % 360.0, decimals)
    return 0.0 if rounded >= 360.0 else rounded


def _optional(value: float | None, decimals: int = CATALOG_DECIMALS) -> float | None:
    return None if value is None else _round(value, decimals)


def resolve_target(text: str, settings: Settings) -> ResolvedTarget:
    """El objeto que nombra un texto: unas coordenadas, si lo son, o lo que diga Sesame.

    Las coordenadas no consultan nada (contrato, seccion 4.8). Lanza `ApiError`:
    `invalid_request` (texto vacio o coordenadas fuera de rango), `not_resolved`
    (Sesame no conoce el nombre) o `upstream_unavailable` (Sesame no responde y
    no hay copia en cache).
    """
    query = normalize_query(text)
    if not query:
        raise invalid_request("name no puede estar vacio")
    coordinates = parse_coordinates(query)
    if coordinates is not None:
        ra, dec = coordinates
        return ResolvedTarget(query=query, ra=ra, dec=dec, source="coordinates")
    return resolve_name(query, settings)


def build_resolve_response(target: ResolvedTarget, epoch: float = FIELD_EPOCH) -> ResolveResponse:
    """La respuesta de `GET /api/resolve` para un objeto ya resuelto.

    `motion` va en `null` si el catalogo no trae movimiento propio; dentro de
    `motion`, `parallax` y `radial_velocity` van en `null` si el catalogo no
    los trae. `field_center` es la posicion propagada a `epoch`, con los 4
    decimales de la identidad del campo.
    """
    info: Motion | None = None
    if target.pm_ra is not None and target.pm_dec is not None:
        info = Motion(
            pm_ra=_round(target.pm_ra, CATALOG_DECIMALS),
            pm_dec=_round(target.pm_dec, CATALOG_DECIMALS),
            parallax=_optional(target.parallax),
            radial_velocity=_optional(target.radial_velocity),
            per_year_arcsec=_round(motion.per_year_arcsec(target), 2),
        )
    center_ra, center_dec = motion.field_center(target, epoch)
    return ResolveResponse(
        query=target.query,
        name=target.name,
        source=target.source,
        object_type=target.object_type,
        j2000=SkyPosition(ra=_round_ra(target.ra, J2000_DECIMALS), dec=_round(target.dec, J2000_DECIMALS)),
        motion=info,
        field_center=FieldCenter(
            ra=_round_ra(center_ra, geometry.COORD_DECIMALS),
            dec=_round(center_dec, geometry.COORD_DECIMALS),
            epoch=epoch,
        ),
        moved_arcsec=_round(motion.moved_arcsec(target, epoch), 1),
    )


def resolve(text: str, settings: Settings) -> ResolveResponse:
    """`GET /api/resolve?name=`: resuelve el texto y arma la respuesta del contrato."""
    return build_resolve_response(resolve_target(text, settings), settings.field_epoch)


# ---------------------------------------------------------------- trayectoria


def epoch_summaries(epochs: Sequence[EpochInfo]) -> list[EpochSummary]:
    """Las epocas del documento de metadatos (`epochs[]`) como las usa `motion.track`."""
    return [
        EpochSummary(
            epoch=item.epoch,
            mjd_start=item.mjd_start,
            mjd_end=item.mjd_end,
            mjd_mean=item.mjd_mean,
            n_exposures=item.n_exposures,
        )
        for item in epochs
    ]


def build_track_response(target: ResolvedTarget, epochs: Sequence[EpochSummary], grid: Grid) -> TrackResponse:
    """La respuesta de `GET /api/field/{id}/track` para un objeto ya resuelto.

    `positions` va vacio si el objeto no tiene movimiento propio (unas
    coordenadas nunca lo tienen). `name` es el nombre principal del catalogo o,
    si no hay, el texto buscado.
    """
    positions = [
        TrackPosition(
            epoch=point.epoch,
            mjd=_round(point.mjd, TRACK_MJD_DECIMALS),
            ra=_round_ra(point.ra, TRACK_SKY_DECIMALS),
            dec=_round(point.dec, TRACK_SKY_DECIMALS),
            x=_round(point.x, TRACK_PIXEL_DECIMALS),
            y=_round(point.y, TRACK_PIXEL_DECIMALS),
            in_field=point.in_field,
        )
        for point in motion.track(target, epochs, grid)
    ]
    return TrackResponse(name=target.name or target.query, positions=positions)


def field_track(name: str, meta: FieldMeta, settings: Settings) -> TrackResponse:
    """`GET /api/field/{id}/track?name=`: trayectoria de un objeto sobre la grilla y las epocas de un campo.

    Usa `grid` y `epochs` del documento de metadatos, que existen desde el
    evento `listed`. Antes de eso lanza `not_ready`: sin epocas no hay nada que
    calcular, y una lista vacia querria decir que el objeto no se mueve.
    """
    if not normalize_query(name):
        raise invalid_request("name no puede estar vacio")
    if meta.grid is None or meta.epochs is None:
        raise not_ready(
            f"el campo {meta.id} todavia no tiene grilla ni epocas: la trayectoria sale despues de `listed`"
        )
    target = resolve_target(name, settings)
    return build_track_response(target, epoch_summaries(meta.epochs), geometry.grid_from_info(meta.grid))
