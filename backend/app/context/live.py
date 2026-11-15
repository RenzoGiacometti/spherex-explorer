"""Contexto en vivo para un campo que no esta precalculado: WISE y Gaia en pocos segundos, o "no disponible".

Cuando alguien abre un campo nuevo, SPHEREx tarda minutos. Este modulo da, para
cualquier centro, dos cosas que IRSA entrega rapido:

- un recorte de WISE (W2 por defecto) ya en la grilla del campo, para usar de
  vista provisoria. Reemplaza al de hips2fits de CDS (app/preview/hips2fits.py),
  que el 2026-11-15 estuvo caido todo el dia;
- las fuentes de Gaia DR3 del campo.

Los servicios son los mismos del contexto precalculado (docs/contexto.md): la
tabla `allwise_p3am_cdd` por Gator para saber que mosaico cubre el centro, el
recorte por coordenadas del IBE y `gaia_dr3_source` por Gator. Lo que cambia es
la paciencia:

- cada pedido se hace una sola vez, sin reintentos;
- todo el intercambio tiene un plazo total corto (`LIVE_TIMEOUT_S`): si IRSA no
  llega, se lanza `LiveUnavailable` y quien llama sigue sin esa parte. Nunca
  sale otra excepcion;
- los pedidos van de a uno, en serie, y cada uno ocupa un lugar del limite
  global de conexiones hacia IRSA (CLAUDE.md), igual que los recortes de SPHEREx;
- lo que se baja queda en la misma cache que usa el precalculo
  (`cache/context`): la segunda vez no toca la red.

Tiempos medidos el 2026-11-15, con la cache vacia: la lista de mosaicos, 1 a
2 s; el recorte de WISE, 2 a 7 s; las fuentes de Gaia, 1 a 9 s segun cuantas
haya (11 729 en el campo de Proxima).

`fetch_preview` tiene la firma de `app.preview.hips2fits.fetch_preview`, asi
que se puede pasar tal cual como `JobDeps.fetch_preview`. Diferencias con la
vista de hips2fits: la imagen viene en MJy/sr y con el fondo restado (como un
plano de SPHEREx), y `PreviewImage.hips` trae el identificador del mosaico de
AllWISE en lugar de un HiPS.
"""

from __future__ import annotations

import contextlib
import logging
import math
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, replace

import numpy as np
from astropy.time import Time
from numpy.typing import NDArray

from app import geometry
from app.config import Settings
from app.context import gaia, surveys
from app.context.http import ContextFetchError, get_bytes
from app.context.reproject import compose_mosaic, read_cutout, reproject_cutout, valid_fraction
from app.context.store import LayerImage, SurveyLayer
from app.domain import Grid, PreviewImage
from app.irsa import transport
from app.irsa.limits import get_limiter
from app.pipeline.stats import detector_display
from app.preview.hips2fits import PreviewUnavailable, preview_band

logger = logging.getLogger(__name__)

# Plazo total de cada parte (la capa de WISE o las fuentes de Gaia), en segundos.
LIVE_TIMEOUT_S = 12.0
# Tope para conectar: si IRSA no acepta la conexion en este tiempo, no tiene sentido esperar el resto.
CONNECT_TIMEOUT_S = 4.0
# Con menos que esto por delante no se empieza otro pedido: no llegaria a terminar.
MIN_REQUEST_S = 1.5
# Fraccion del campo que tiene que quedar cubierta para no pedir otro mosaico.
ENOUGH_COVERAGE = 0.995

DEFAULT_LAYER = "wise_w2"


class LiveUnavailable(Exception):
    """IRSA no entrego a tiempo, o lo que entrego no sirve. No es un error: el campo sigue sin esa parte."""


@dataclass(frozen=True, eq=False)
class LiveLayer:
    """Una capa armada en vivo: su descripcion, con el formato del contexto guardado, y la imagen."""

    info: SurveyLayer
    image: NDArray[np.float32]


# ---------------------------------------------------------------------- plazos


def _hurried(settings: Settings, deadline: transport.Deadline) -> Settings:
    """La configuracion con los tiempos de espera acotados a lo que queda del plazo.

    Lanza `LiveUnavailable` si no queda tiempo para un pedido.
    """
    remaining = deadline.remaining()
    if remaining is None:
        return settings
    if remaining < MIN_REQUEST_S:
        raise LiveUnavailable(f"no queda tiempo para otro pedido a IRSA ({remaining:.1f} s)")
    return replace(
        settings,
        irsa_connect_timeout_s=min(CONNECT_TIMEOUT_S, remaining),
        irsa_read_timeout_s=remaining,
        irsa_total_timeout_s=remaining,
    )


def _within[T](timeout_s: float, what: str, work: Callable[[transport.Deadline], T]) -> T:
    """Corre `work` en un hilo aparte y espera, como mucho, `timeout_s` segundos.

    El plazo que recibe `work` acota cada lectura del socket, pero resolver el
    nombre del servidor no tiene timeout en `requests`: por eso ademas se espera
    al hilo desde afuera y, si no termino, se lo abandona (no queda colgado:
    su proximo pedido ya no tiene plazo y falla enseguida). Cualquier excepcion
    que no sea `LiveUnavailable` se convierte en una.
    """
    deadline = transport.Deadline(timeout_s)
    box: list[T | BaseException] = []

    def run() -> None:
        try:
            box.append(work(deadline))
        except BaseException as exc:
            box.append(exc)

    thread = threading.Thread(target=run, name=f"contexto-vivo-{what}", daemon=True)
    thread.start()
    thread.join(timeout_s + 0.5)
    if not box:
        raise LiveUnavailable(f"{what}: IRSA no respondio en {timeout_s:g} s")
    result = box[0]
    if isinstance(result, LiveUnavailable):
        raise result
    if isinstance(result, ContextFetchError | ValueError | OSError):
        raise LiveUnavailable(f"{what}: {result}") from result
    if isinstance(result, BaseException):
        logger.warning("contexto en vivo, %s: fallo inesperado: %s: %s", what, type(result).__name__, result)
        raise LiveUnavailable(f"{what}: {type(result).__name__}: {result}") from result
    return result


# ------------------------------------------------------------------- capa WISE


def _list_tiles(
    band: surveys.SurveyBand, grid: Grid, settings: Settings, deadline: transport.Deadline
) -> list[surveys.SurveyImage]:
    """Mosaicos Atlas de AllWISE que pueden tocar el campo, del mas cercano al centro al mas lejano."""
    radius = round(math.hypot(*grid.shape) / 2.0 * grid.pixel_scale_arcsec / 3600.0, 5)
    number = int(band.band[1:])
    path = surveys.list_cache_path(band, "gator", grid.ra, grid.dec, radius, settings)
    payload: bytes | None = None
    if path.is_file():
        with contextlib.suppress(OSError):
            payload = path.read_bytes()
    tiles: list[surveys.SurveyImage] | None = None
    if payload is not None:
        with contextlib.suppress(ValueError):
            tiles = surveys.parse_wise_list(payload, number)
    if tiles is None:
        payload = get_bytes(
            surveys.GATOR_URL,
            _hurried(settings, deadline),
            slot=get_limiter(settings).sia_slot,
            what=f"Gator {surveys.WISE_ATLAS_TABLE}",
            params={
                "catalog": surveys.WISE_ATLAS_TABLE,
                "spatial": "None",
                "outfmt": "1",
                "selcols": ",".join(surveys.WISE_ATLAS_COLUMNS),
                "constraints": surveys.wise_constraints(number, grid.ra, grid.dec, surveys.WISE_TILE_HALF_DEG + radius),
            },
            attempts=1,
            max_bytes=surveys.MAX_LIST_BYTES,
        )
        tiles = surveys.parse_wise_list(payload, number)
        with contextlib.suppress(OSError):
            surveys._write_atomic(path, payload)
    near = [tile for tile in tiles if surveys.may_overlap(tile, grid.ra, grid.dec, grid.fov * 1800.0)]

    def distance(tile: surveys.SurveyImage) -> float:
        if tile.center_ra is None or tile.center_dec is None:
            return math.inf
        return geometry.angular_separation_deg(grid.ra, grid.dec, tile.center_ra, tile.center_dec)

    return sorted(near, key=lambda tile: (distance(tile), tile.url))


def _ensure_cutout(
    band: surveys.SurveyBand, tile: surveys.SurveyImage, grid: Grid, settings: Settings, deadline: transport.Deadline
) -> None:
    """Deja en la cache el recorte de un mosaico: si no esta, lo baja de IRSA con un solo intento."""
    side = geometry.cutout_side_deg(grid.fov)
    path = surveys.cutout_cache_path(band, tile, grid.ra, grid.dec, side, settings)
    if path.is_file():
        with contextlib.suppress(OSError):
            if surveys._is_whole_fits(path.read_bytes()):
                return
    payload = get_bytes(
        surveys.cutout_url(tile, grid.ra, grid.dec, side),
        _hurried(settings, deadline),
        slot=get_limiter(settings).cutout_slot,
        what=f"recorte de {tile.file_name}",
        attempts=1,
        max_bytes=surveys.MAX_CUTOUT_BYTES,
    )
    if not surveys._is_whole_fits(payload):
        raise ContextFetchError(f"recorte de {tile.file_name}: la respuesta no es un FITS entero")
    surveys._write_atomic(path, payload)


def _date(mjd: float) -> str:
    return str(Time(mjd, format="mjd", scale="utc").strftime("%Y-%m-%d"))


def _build_layer(band: surveys.SurveyBand, grid: Grid, settings: Settings, deadline: transport.Deadline) -> LiveLayer:
    tiles = _list_tiles(band, grid, settings, deadline)
    if not tiles:
        raise LiveUnavailable(f"{band.survey} {band.band}: ningun mosaico cubre el campo")
    side = geometry.cutout_side_deg(grid.fov)
    used: list[tuple[float, surveys.SurveyImage, NDArray[np.float32], surveys.ObservationTimes, float]] = []
    covered = np.zeros(grid.shape, dtype=bool)
    last_error: Exception | None = None
    for tile in tiles:
        try:
            _ensure_cutout(band, tile, grid, settings, deadline)
            cutout = read_cutout(surveys.cutout_cache_path(band, tile, grid.ra, grid.dec, side, settings))
            image, _footprint = reproject_cutout(cutout, grid, zero_flux_jy=band.zero_flux_jy)
        except (ContextFetchError, ValueError, LiveUnavailable) as exc:
            # Un 500 puede ser "no toca la imagen", y el plazo puede vencer en el segundo mosaico:
            # con lo que ya se armo alcanza para una vista provisoria.
            last_error = exc
            if used:
                break
            continue
        times = surveys.observation_times(cutout.header, band, tile)
        coverage = valid_fraction(image)
        if coverage <= 0.0 or times is None:
            continue
        used.append((coverage, tile, image, times, cutout.pixel_scale_arcsec))
        covered |= np.isfinite(image)
        if covered.mean() >= ENOUGH_COVERAGE:
            break
    if not used:
        raise LiveUnavailable(f"{band.survey} {band.band}: no se pudo bajar ningun recorte ({last_error})")

    used.sort(key=lambda item: (-item[0], item[1].url))
    mosaic = compose_mosaic([image for _, _, image, _, _ in used])
    display = detector_display([mosaic])
    if display is None:
        raise LiveUnavailable(f"{band.survey} {band.band}: el recorte no trae ningun pixel con datos")
    _, _, _, primary, native_scale = used[0]
    start = min(times.mjd_start for _, _, _, times, _ in used)
    end = max(times.mjd_end for _, _, _, times, _ in used)
    info = SurveyLayer(
        key=band.key,
        survey=band.survey,
        band=band.band,
        wave_um=band.wave_um,
        file=f"{band.key}.f32",
        mjd=round(primary.mjd, 5),
        date=_date(primary.mjd),
        year=round(float(Time(primary.mjd, format="mjd", scale="utc").jyear), 3),
        mjd_start=round(start, 5),
        mjd_end=round(end, 5),
        date_start=_date(start),
        date_end=_date(end),
        unit="MJy/sr",
        native_pixel_scale_arcsec=round(native_scale, 4),
        display=display,
        valid_fraction=round(valid_fraction(mosaic), 4),
        collection=band.collection,
        images=[
            LayerImage(
                obs_id=tile.obs_id,
                url=tile.url,
                mjd=round(times.mjd, 5),
                date=_date(times.mjd),
                coverage=round(coverage, 4),
            )
            for coverage, tile, _, times, _ in used
        ],
    )
    return LiveLayer(info=info, image=mosaic)


def fetch_layer(
    grid: Grid, settings: Settings, *, layer: str = DEFAULT_LAYER, timeout_s: float = LIVE_TIMEOUT_S
) -> LiveLayer:
    """Una capa de WISE en la grilla del campo, en `timeout_s` segundos como mucho.

    `layer` es `wise_w2` o `wise_w1`. Lanza `LiveUnavailable` si IRSA no llega a
    tiempo o no hay mosaico; ninguna otra excepcion. Bloquea: desde codigo
    `async` va en un hilo.
    """
    try:
        band = surveys.band_by_key(layer)
    except KeyError as exc:
        raise LiveUnavailable(f"no existe la capa {layer!r}") from exc
    if band.survey != "WISE":
        # 2MASS llega en franjas angostas y un campo suele tocar cuatro o cinco imagenes: no entra en el plazo.
        raise LiveUnavailable(f"en vivo solo se arman capas de WISE, no {layer!r}")
    return _within(timeout_s, band.key, lambda deadline: _build_layer(band, grid, settings, deadline))


# ------------------------------------------------------------------------ Gaia


def _fetch_gaia(grid: Grid, settings: Settings, deadline: transport.Deadline) -> tuple[gaia.GaiaSources, float]:
    radius = gaia.cone_radius_arcsec(grid)
    path = gaia.cache_path(grid.ra, grid.dec, radius, settings)
    sources: gaia.GaiaSources | None = None
    if path.is_file():
        with contextlib.suppress(OSError, ValueError):
            sources = gaia.parse_sources(path.read_bytes())
    if sources is None:
        payload = get_bytes(
            gaia.GATOR_URL,
            _hurried(settings, deadline),
            slot=get_limiter(settings).sia_slot,
            what=f"Gator {gaia.CATALOG}",
            params=gaia.query_params(grid.ra, grid.dec, radius),
            attempts=1,
            max_bytes=gaia.MAX_RESPONSE_BYTES,
        )
        sources = gaia.parse_sources(payload)
        with contextlib.suppress(OSError):
            surveys._write_atomic(path, payload)
    return gaia.select_in_field(sources, grid), radius


def fetch_gaia(grid: Grid, settings: Settings, *, timeout_s: float = LIVE_TIMEOUT_S) -> tuple[gaia.GaiaSources, float]:
    """Fuentes de Gaia DR3 del campo y el radio consultado, en `timeout_s` segundos como mucho.

    Lanza `LiveUnavailable` si IRSA no llega a tiempo; ninguna otra excepcion.
    """
    return _within(timeout_s, "gaia", lambda deadline: _fetch_gaia(grid, settings, deadline))


# ------------------------------------------------------------ vista provisoria


def _as_preview(layer: LiveLayer) -> PreviewImage:
    band = "W2" if layer.info.band == "W2" else "W1"
    tile = layer.info.images[0].obs_id if layer.info.images else "?"
    # La longitud de onda nominal del contrato (3,4 y 4,6), no la isofotal de la capa.
    return PreviewImage(
        image=layer.image,
        band=band,  # type: ignore[arg-type]
        wave_um=4.6 if band == "W2" else 3.4,
        hips=f"IRSA/allwise_p3am_cdd/{tile}/{band.lower()}",
    )


def _preview(grid: Grid, layer: str, settings: Settings) -> PreviewImage:
    timeout = min(LIVE_TIMEOUT_S, settings.preview_timeout_s) if settings.preview_timeout_s > 0 else LIVE_TIMEOUT_S
    started = time.perf_counter()
    try:
        return _as_preview(fetch_layer(grid, settings, layer=layer, timeout_s=timeout))
    except LiveUnavailable as exc:
        raise PreviewUnavailable(f"{exc} ({time.perf_counter() - started:.1f} s)") from exc


def fetch_preview(grid: Grid, band: int, settings: Settings) -> PreviewImage:
    """Vista provisoria de un campo nuevo: WISE W2 desde el IBE de IRSA. Reemplaza a la de hips2fits.

    Misma firma que `app.preview.hips2fits.fetch_preview`, para pasarla como
    `JobDeps.fetch_preview`. Siempre W2, sea cual sea el detector pedido: es la
    banda donde se ven los objetos mas frios (`fetch_preview_by_band` sigue la
    regla del contrato). Lanza `PreviewUnavailable`, y nada mas, si IRSA no
    responde en el plazo: el campo carga igual.
    """
    del band  # la firma lo pide; esta version no lo usa
    return _preview(grid, "wise_w2", settings)


def fetch_preview_by_band(grid: Grid, band: int, settings: Settings) -> PreviewImage:
    """Como `fetch_preview`, con la banda que fija el contrato (seccion 4.10): W1, o W2 si el detector es 5 o 6."""
    return _preview(grid, "wise_w2" if preview_band(band)[0] == "W2" else "wise_w1", settings)
