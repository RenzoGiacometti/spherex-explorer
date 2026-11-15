"""Arma el contexto de un campo: una capa por relevamiento y las fuentes de Gaia. Usa la red.

Lo llama `scripts/precompute_context.py`. El backend no arma contexto al
atender un pedido: sirve lo que este guardado.

Objetos de prueba (CLAUDE.md), con el mismo alias que el precalculo de campos.
El centro de cada campo es el del contrato (seccion 4.8): la posicion propagada
a la epoca 2026,0. Se resuelve con `app.resolve`; si Sesame no responde (el
2026-11-15 CDS estuvo caido) se usa la respuesta real guardada en
tests/fixtures/sesame, que es la misma que usa el servidor falso.
"""

from __future__ import annotations

import math
import re
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from astropy.time import Time
from numpy.typing import NDArray

from app import geometry
from app.api.errors import ApiError
from app.config import Settings
from app.context import gaia, surveys
from app.context.http import ContextFetchError
from app.context.reproject import compose_mosaic, read_cutout, reproject_cutout, valid_fraction
from app.context.store import (
    GAIA_FILENAME,
    ContextDocument,
    ContextObject,
    ContextStore,
    GaiaInfo,
    LayerImage,
    LayerTarget,
    SurveyLayer,
    context_key,
)
from app.contract import FieldRequestInfo
from app.domain import Grid, NormalizedRequest, ResolvedTarget
from app.pipeline.stats import detector_display
from app.resolve import motion
from app.resolve import service as resolve_service
from app.resolve.sesame import SesameResponseError, parse_sesame

# Alias -> texto que se le pregunta a Sesame. Los cinco objetos de prueba de CLAUDE.md.
TEST_OBJECTS: dict[str, str] = {
    "barnard": "Barnard's Star",
    "epsindb": "Epsilon Indi B",
    "wise0855": "WISE J085510.83-071442.5",
    "rwaur": "RW Aurigae",
    "rdra": "R Draconis",
}

BASE_FOV = geometry.FOV_STEPS[0].fov

Printer = Callable[[str], None]


class ContextBuildError(Exception):
    """No se pudo armar una parte del contexto."""


@dataclass(frozen=True)
class BuiltLayer:
    info: SurveyLayer
    image: NDArray[np.float32]


# ------------------------------------------------------------------- objetos


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def resolve_saved(query: str, settings: Settings) -> ResolvedTarget | None:
    """El objeto segun una respuesta de Sesame guardada en `settings.fake_sesame_dir`, o `None` si no hay."""
    path = Path(settings.fake_sesame_dir) / f"{_slug(query)}.xml"
    try:
        return parse_sesame(path.read_text(encoding="utf-8"), query)
    except (OSError, SesameResponseError):
        return None


def resolve_object(query: str, settings: Settings, *, offline: bool = False) -> tuple[ResolvedTarget, str]:
    """Resuelve un objeto y dice de donde salio: `"sesame"` (servicio o su cache) o `"saved"` (respuesta guardada).

    Con `offline` no se consulta Sesame. Lanza `ContextBuildError` si no se puede resolver.
    """
    if not offline:
        try:
            return resolve_service.resolve_target(query, settings), "sesame"
        except ApiError as exc:
            reason = f"{exc.code}: {exc.message}"
    else:
        reason = "sin consultar Sesame"
    saved = resolve_saved(query, settings)
    if saved is None:
        raise ContextBuildError(f"no se pudo resolver {query!r} ({reason}) y no hay una respuesta guardada")
    return saved, "saved"


def field_request(target: ResolvedTarget, settings: Settings) -> NormalizedRequest:
    """Pedido del campo base del objeto, centrado como lo centra `/api/resolve`."""
    center = resolve_service.build_resolve_response(target, settings.field_epoch).field_center
    return geometry.normalize_request(center.ra, center.dec, BASE_FOV, pipeline=settings.pipeline_version)


# --------------------------------------------------------------------- capas


def _date(mjd: float) -> str:
    return str(Time(mjd, format="mjd", scale="utc").strftime("%Y-%m-%d"))


def _year(mjd: float) -> float:
    return round(float(Time(mjd, format="mjd", scale="utc").jyear), 3)


def search_radius_deg(grid: Grid) -> float:
    """Radio del circulo de busqueda de SIA2: la mitad de la diagonal de la grilla."""
    ny, nx = grid.shape
    return round(math.hypot(nx, ny) / 2.0 * grid.pixel_scale_arcsec / 3600.0, 5)


def build_layer(
    band: surveys.SurveyBand, grid: Grid, settings: Settings, *, refresh: bool = False, out: Printer = print
) -> BuiltLayer:
    """Una capa: lista las imagenes de la banda, baja sus recortes, los reproyecta y los junta.

    Lanza `ContextBuildError` si ninguna imagen aporta datos al campo.
    """
    radius = search_radius_deg(grid)
    side = geometry.cutout_side_deg(grid.fov)
    try:
        listed, source = surveys.list_images(band, grid.ra, grid.dec, radius, settings, refresh=refresh)
    except ContextFetchError as exc:
        raise ContextBuildError(str(exc)) from exc
    images = [image for image in listed if surveys.may_overlap(image, grid.ra, grid.dec, grid.fov * 1800.0)]
    if not images:
        raise ContextBuildError(f"{band.survey} {band.band}: ninguna imagen cubre el campo (lista de {source})")

    tiles: list[tuple[float, surveys.SurveyImage, NDArray[np.float32], surveys.ObservationTimes, float]] = []
    for image in images:
        try:
            path = surveys.download_cutout(band, image, grid.ra, grid.dec, side, settings, refresh=refresh)
            cutout = read_cutout(path)
            tile, _footprint = reproject_cutout(cutout, grid, zero_flux_jy=band.zero_flux_jy)
        except (ContextFetchError, ValueError) as exc:
            out(f"      aviso: {band.survey} {band.band}, {image.file_name}: {exc}")
            continue
        coverage = valid_fraction(tile)
        times = surveys.observation_times(cutout.header, band, image)
        if coverage <= 0.0 or times is None:
            continue
        tiles.append((coverage, image, tile, times, cutout.pixel_scale_arcsec))
    if not tiles:
        raise ContextBuildError(f"{band.survey} {band.band}: ninguna de las {len(images)} imagenes aporto datos")

    # La que mas cubre el campo va primero: es la que manda en el mosaico y la que da la fecha.
    tiles.sort(key=lambda item: (-item[0], item[3].mjd, item[1].url))
    mosaic = compose_mosaic([tile for _, _, tile, _, _ in tiles])
    _, _, _, primary_times, native_scale = tiles[0]
    primary_mjd = primary_times.mjd
    start = min(times.mjd_start for _, _, _, times, _ in tiles)
    end = max(times.mjd_end for _, _, _, times, _ in tiles)
    filename = f"{band.key}.f32"
    info = SurveyLayer(
        key=band.key,
        survey=band.survey,
        band=band.band,
        wave_um=band.wave_um,
        file=filename,
        mjd=round(primary_mjd, 5),
        date=_date(primary_mjd),
        year=_year(primary_mjd),
        mjd_start=round(start, 5),
        mjd_end=round(end, 5),
        date_start=_date(start),
        date_end=_date(end),
        unit="MJy/sr",
        native_pixel_scale_arcsec=round(native_scale, 4),
        display=detector_display([mosaic]),
        valid_fraction=round(valid_fraction(mosaic), 4),
        collection=band.collection,
        images=[
            LayerImage(
                obs_id=image.obs_id,
                url=image.url,
                mjd=round(times.mjd, 5),
                date=_date(times.mjd),
                coverage=round(cov, 4),
            )
            for cov, image, _, times, _ in tiles
        ],
    )
    return BuiltLayer(info=info, image=mosaic)


def layer_target(target: ResolvedTarget, mjd: float, grid: Grid) -> LayerTarget | None:
    """Posicion esperada del objeto en la fecha de una capa, o `None` si no tiene movimiento propio."""
    if not target.has_proper_motion:
        return None
    ra, dec = motion.position_at(target, mjd)
    x, y = geometry.sky_to_pixel(grid, ra, dec)
    if not (math.isfinite(x) and math.isfinite(y)):
        return None
    return LayerTarget(
        ra=round(ra, 6), dec=round(dec, 6), x=round(x, 2), y=round(y, 2), in_field=geometry.in_grid(grid, x, y)
    )


# ------------------------------------------------------------------- contexto


def build_context(
    request: NormalizedRequest,
    settings: Settings,
    store: ContextStore,
    *,
    context_object: ContextObject | None = None,
    target: ResolvedTarget | None = None,
    layer_keys: Sequence[str] = surveys.DEFAULT_BAND_KEYS,
    with_gaia: bool = True,
    refresh: bool = False,
    out: Printer = print,
) -> ContextDocument:
    """Arma y guarda el contexto de un campo. Devuelve el documento guardado.

    Una capa que falla se informa y se saltea: el contexto queda con lo que se
    pudo armar. Lanza `ContextBuildError` solo si no quedo nada (ninguna capa y
    ninguna fuente de Gaia).
    """
    grid = geometry.build_grid(request)
    key = context_key(request.ra, request.dec, request.fov)

    layers: list[BuiltLayer] = []
    for layer_key in layer_keys:
        band = surveys.band_by_key(layer_key)
        started = time.perf_counter()
        try:
            layer = build_layer(band, grid, settings, refresh=refresh, out=out)
        except ContextBuildError as exc:
            out(f"      FALLO la capa {layer_key}: {exc}")
            continue
        if target is not None:
            position = layer_target(target, layer.info.mjd, grid)
            layer = BuiltLayer(info=layer.info.model_copy(update={"target": position}), image=layer.image)
        layers.append(layer)
        out(
            f"      {band.survey} {band.band}: {len(layer.info.images)} imagenes, fecha {layer.info.date}, "
            f"{layer.info.valid_fraction:.1%} del campo con datos, {time.perf_counter() - started:.1f} s"
        )
    layers.sort(key=lambda layer: layer.info.mjd)

    gaia_info: GaiaInfo | None = None
    sources: gaia.GaiaSources | None = None
    if with_gaia:
        started = time.perf_counter()
        try:
            sources, radius = gaia.fetch_field_sources(grid, settings, refresh=refresh)
        except ContextFetchError as exc:
            out(f"      FALLO Gaia: {exc}")
        else:
            magnitudes = sources.g_mag[np.isfinite(sources.g_mag)]
            gaia_info = GaiaInfo(
                file=GAIA_FILENAME,
                catalog=gaia.CATALOG,
                ref_epoch=sources.ref_epoch,
                n_sources=len(sources),
                radius_arcsec=round(radius, 1),
                g_mag_min=round(float(magnitudes.min()), 2) if magnitudes.size else None,
                g_mag_max=round(float(magnitudes.max()), 2) if magnitudes.size else None,
            )
            out(f"      Gaia DR3: {len(sources)} fuentes en el campo, {time.perf_counter() - started:.1f} s")

    if not layers and gaia_info is None:
        raise ContextBuildError("no se pudo armar ninguna capa ni bajar las fuentes de Gaia")

    for layer in layers:
        store.write_layer(key, layer.info.file, layer.image, grid.shape)
    if sources is not None:
        store.write_gaia(key, sources)
    document = ContextDocument(
        key=key,
        field_id=request.field_id,
        pipeline=request.pipeline,
        object=context_object,
        request=FieldRequestInfo(ra=request.ra, dec=request.dec, fov=request.fov),
        grid=geometry.grid_info(grid),
        surveys=[layer.info for layer in layers],
        gaia=gaia_info,
        generated_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
    store.write_document(document)
    store.write_index()
    return document
