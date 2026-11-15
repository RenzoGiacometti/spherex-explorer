"""Del punto del cielo al documento del espectro.

Para cada exposicion con un recorte en la cache que cubre el punto:

1. Lee IMAGE, FLAGS, VARIANCE y ZODI, y la tabla de bits del encabezado de FLAGS.
2. Ubica el objeto en el recorte con el WCS (TAN-SIP), en la posicion que tenia
   en la fecha de esa exposicion si tiene movimiento propio.
3. Mide con apertura y anillo de fondo sobre IMAGE - ZODI (`photometry.py`).
4. Toma la longitud de onda y el ancho de banda del pixel del objeto
   (`wavelength.py`) y pasa el flujo a mJy con el angulo solido del pixel.

Cada exposicion bien medida es un punto. Las que no se pueden medir (fuente
saturada, pixeles descartados en la apertura, borde del recorte) no entran como
puntos: se cuentan por detector y, si es saturacion, generan un aviso. Si no
queda ningun punto por saturacion, `status` es `saturated` y `points` va vacio:
un aviso en lugar de un espectro invalido. `partial` es un espectro al que le
faltan detectores, o parte de ellos, por saturacion.

Documento (claves en snake_case, como el contrato del cubo):

    status      "ok" | "partial" | "saturated" | "empty"
    target      nombre, posicion de referencia, movimiento y posicion por epoca
    aperture    geometria de la medicion
    epochs      pasadas del relevamiento (huecos de mas de 60 dias)
    detectors   por detector: exposiciones, puntos y descartes
    points      un punto por exposicion medida
    binned      los puntos promediados por canal espectral
    warnings    avisos (`saturated_source`, `offset_source`, `masked_exposures`,
                `wave_table_version`)

`saturated_source` tiene la forma del aviso del mismo nombre del documento del
campo (docs/contrato-cubo.md, seccion 5): `ra`, `dec`, `radius_arcsec` (aca, el
radio de la apertura), `epochs` y `detectors`; suma `n_exposures` y `n_total`.

`offset_source` avisa que, en esos detectores, la luz dentro de la apertura no
esta centrada en el objeto: hay otra fuente adentro. Le pasa a WISE 0855, que
tiene una estrella de fondo a pocos segundos de arco (SPEC.md, seccion 2): por
debajo de 3,8 um lo que se mide es la estrella.

Unidades: longitud de onda en um, densidad de flujo en mJy, fechas en MJD (UTC)
y texto ISO. Sin correccion de apertura: `aperture.enclosed_fraction_gaussian`
da, como referencia, la fraccion que encerraria una PSF gaussiana del ancho que
informa cada archivo (`PSF_FWHM`).
"""

from __future__ import annotations

import logging
import math
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from app.config import FIELD_EPOCH
from app.domain import ResolvedTarget
from app.pipeline.exposure import (
    MASKED_FLAGS,
    SATURATION_FLAGS,
    SOURCE_FLAG,
    flag_mask,
    read_flag_table,
    wcs_cards,
)
from app.resolve.motion import position_at
from app.spectrum.cutouts import CachedCutout
from app.spectrum.photometry import (
    ApertureConfig,
    Measurement,
    gaussian_enclosed_fraction,
    measure_aperture,
)
from app.spectrum.wavelength import WaveTableError, WaveTables, load_wave_tables, processing_version, wavelength_at

logger = logging.getLogger(__name__)

DOCUMENT_VERSION = 1

# Exposiciones separadas por mas de estos dias caen en epocas distintas (contrato, seccion 2).
EPOCH_GAP_DAYS = 60.0
# Canales espectrales por detector: SPHEREx tiene 102 en total, 17 por detector (SPEC.md, seccion 2).
CHANNELS_PER_DETECTOR = 17
# Lado de un pixel nativo, en segundos de arco (`s_pixel_scale` de IRSA; SPEC.md, seccion 2).
NATIVE_PIXEL_ARCSEC = 6.15
# 1 MJy = 1e9 mJy: brillo superficial [MJy/sr] x angulo solido [sr] -> mJy.
MJY_PER_MEGAJY = 1.0e9
# Aviso `saturated_source`: un detector entra si al menos esta fraccion de sus exposiciones, y no
# menos de esta cantidad, tiene saturacion en la apertura.
SATURATED_MIN_FRACTION = 0.1
SATURATED_MIN_EXPOSURES = 3
# Aviso `offset_source`: la mediana del corrimiento del centroide en un detector supera este
# valor (medio pixel nativo), con al menos esta cantidad de exposiciones donde se pudo medir.
OFFSET_WARNING_ARCSEC = 3.0
OFFSET_MIN_EXPOSURES = 5
# Hilos para leer recortes del disco. No son descargas: no cuentan para el limite hacia IRSA.
READ_WORKERS = 4

_MJD_UNIX_EPOCH = 40587.0
_DEG2_TO_SR = (math.pi / 180.0) ** 2

PositionAt = Callable[[float], tuple[float, float]]


class SpectrumError(Exception):
    """No se pudo armar el espectro (sin recortes, tablas ilegibles)."""


@dataclass(frozen=True)
class SpectrumTarget:
    """Que se mide: una posicion fija o un objeto que se mueve."""

    ra: float  # posicion de referencia, grados ICRS
    dec: float
    epoch: float = FIELD_EPOCH  # anio juliano de la posicion de referencia
    name: str | None = None
    motion: ResolvedTarget | None = None  # si esta, la posicion se propaga a cada fecha

    def position_at(self, mjd: float) -> tuple[float, float]:
        if self.motion is None:
            return self.ra, self.dec
        return position_at(self.motion, mjd)


@dataclass(frozen=True)
class ExposureResult:
    """Lo que salio de un recorte: la medicion y los datos del encabezado que van al punto."""

    exposure: str
    detector: int
    mjd: float
    measurement: Measurement
    wavelength_um: float
    bandwidth_um: float
    pixel_area_sr: float
    psf_fwhm_arcsec: float | None
    flags: tuple[str, ...]
    ra: float
    dec: float
    processing: str | None
    # Corrimiento del centroide de la luz respecto del objeto, en segundos de arco (este, norte).
    offset_arcsec: tuple[float, float] | None = None

    @property
    def flux_mjy(self) -> float | None:
        flux = self.measurement.flux
        return None if flux is None else flux * self.pixel_area_sr * MJY_PER_MEGAJY

    @property
    def error_mjy(self) -> float | None:
        error = self.measurement.error
        return None if error is None else error * self.pixel_area_sr * MJY_PER_MEGAJY


@dataclass
class _Failure:
    exposure: str
    reason: str


@dataclass
class _Collected:
    results: list[ExposureResult] = field(default_factory=list)
    failures: list[_Failure] = field(default_factory=list)


# ------------------------------------------------------------------ un recorte


def _header_float(header: fits.Header, *keys: str) -> float | None:
    for key in keys:
        value = header.get(key)
        if isinstance(value, int | float) and math.isfinite(float(value)):
            return float(value)
    return None


def _pixel_area_sr(wcs: WCS, x: float, y: float) -> float:
    """Angulo solido del pixel en `(x, y)`, por diferencias finitas sobre el WCS completo (con SIP)."""
    ra, dec = wcs.all_pix2world([x - 0.5, x + 0.5, x, x], [y, y, y - 0.5, y + 0.5], 0)
    cos_dec = math.cos(math.radians(float(np.mean(dec))))

    def delta_ra(a: float, b: float) -> float:
        return ((b - a + 180.0) % 360.0 - 180.0) * cos_dec

    ax, ay = delta_ra(ra[0], ra[1]), float(dec[1] - dec[0])
    bx, by = delta_ra(ra[2], ra[3]), float(dec[3] - dec[2])
    return abs(ax * by - ay * bx) * _DEG2_TO_SR


def measure_cutout(
    cutout: CachedCutout,
    target: SpectrumTarget,
    tables: WaveTables,
    config: ApertureConfig,
) -> ExposureResult:
    """Mide el objeto en un recorte. Lanza `OSError`, `KeyError` o `ValueError` si el archivo no sirve."""
    with fits.open(cutout.path, memmap=False) as hdul:
        header = hdul["IMAGE"].header
        image = np.asarray(hdul["IMAGE"].data, dtype=np.float64)
        variance = np.asarray(hdul["VARIANCE"].data, dtype=np.float64)
        zodi = np.asarray(hdul["ZODI"].data, dtype=np.float64)
        raw_flags = np.asarray(hdul["FLAGS"].data)
        flag_bits, _descriptions = read_flag_table(hdul["FLAGS"].header)
    if image.ndim != 2 or not (image.shape == variance.shape == zodi.shape == raw_flags.shape):
        raise ValueError(f"{cutout.path.name}: las extensiones no miden lo mismo")
    if raw_flags.dtype.kind not in "iu":
        raise ValueError(f"{cutout.path.name}: FLAGS no es un entero ({raw_flags.dtype})")
    flags = (raw_flags.astype(np.int64) & 0xFFFFFFFF).astype(np.uint32)

    detector = int(header["DETECTOR"])  # 1 a 6; comentario del encabezado: "1-3: SWIR, 4-6: MWIR"
    # Punto medio de la exposicion (MJD-AVG, UTC); MJD-OBS es el inicio.
    mjd = _header_float(header, "MJD-AVG", "MJD-OBS")
    if mjd is None:
        raise ValueError(f"{cutout.path.name}: el encabezado no trae MJD-AVG ni MJD-OBS")

    radesys = str(header.get("RADESYS", "ICRS")).strip().upper()
    if radesys != "ICRS":
        raise ValueError(f"{cutout.path.name}: RADESYS={radesys!r}; solo se admite ICRS")
    # Solo las tarjetas del WCS primario: ver `wcs_cards` en app/pipeline/exposure.py.
    wcs = WCS(wcs_cards(header))
    ra, dec = target.position_at(mjd)
    x_pix, y_pix = wcs.all_world2pix([ra], [dec], 0)
    x, y = float(x_pix[0]), float(y_pix[0])

    measurement = measure_aperture(
        image - zodi,
        variance,
        flags,
        x,
        y,
        masked_bits=flag_mask(flag_bits, MASKED_FLAGS),
        saturation_bits=flag_mask(flag_bits, SATURATION_FLAGS),
        source_bits=flag_mask(flag_bits, (SOURCE_FLAG,)),
        config=config,
    )
    if measurement.status == "edge":
        wavelength, bandwidth, area = math.nan, math.nan, math.nan
    else:
        wavelength, bandwidth = wavelength_at(tables.for_detector(detector), header, x, y)
        area = _pixel_area_sr(wcs, x, y)
    offset: tuple[float, float] | None = None
    if measurement.centroid is not None:
        sky_ra, sky_dec = wcs.all_pix2world([measurement.centroid[0]], [measurement.centroid[1]], 0)
        east = ((float(sky_ra[0]) - ra + 180.0) % 360.0 - 180.0) * math.cos(math.radians(dec)) * 3600.0
        offset = (east, (float(sky_dec[0]) - dec) * 3600.0)
    names = tuple(
        name for name, bit in sorted(flag_bits.items(), key=lambda item: item[1]) if measurement.flag_bits >> bit & 1
    )
    return ExposureResult(
        exposure=str(header.get("OBSID") or cutout.exposure),
        detector=detector,
        mjd=mjd,
        measurement=measurement,
        wavelength_um=wavelength,
        bandwidth_um=bandwidth,
        pixel_area_sr=area,
        psf_fwhm_arcsec=_header_float(header, "PSF_FWHM"),
        flags=names,
        ra=ra,
        dec=dec,
        processing=processing_version(cutout.path.name),
        offset_arcsec=offset,
    )


def _collect(
    cutouts: Sequence[CachedCutout], target: SpectrumTarget, tables: WaveTables, config: ApertureConfig
) -> _Collected:
    collected = _Collected()

    def one(cutout: CachedCutout) -> ExposureResult | _Failure:
        try:
            return measure_cutout(cutout, target, tables, config)
        except (OSError, KeyError, ValueError, TypeError, IndexError, fits.VerifyError) as exc:
            # WaveTableError es ValueError. Un recorte ilegible no tumba el espectro: se cuenta.
            return _Failure(cutout.exposure, f"{type(exc).__name__}: {exc}"[:200])

    if len(cutouts) <= 1:
        outcomes = [one(cutout) for cutout in cutouts]
    else:
        with ThreadPoolExecutor(max_workers=READ_WORKERS) as pool:
            outcomes = list(pool.map(one, cutouts))
    for outcome in outcomes:
        if isinstance(outcome, _Failure):
            logger.warning("espectro: recorte %s descartado: %s", outcome.exposure, outcome.reason)
            collected.failures.append(outcome)
        else:
            collected.results.append(outcome)
    return collected


# ------------------------------------------------------------------- documento


def _iso_date(mjd: float) -> str:
    moment = datetime(1970, 1, 1, tzinfo=UTC) + timedelta(days=mjd - _MJD_UNIX_EPOCH)
    return moment.strftime("%Y-%m-%d")


def _round(value: float, decimals: int) -> float:
    return round(float(value), decimals) + 0.0


def _significant(value: float, digits: int = 5) -> float:
    """Redondeo a `digits` cifras significativas: los flujos van de microjanskys a janskys."""
    if value == 0 or not math.isfinite(value):
        return 0.0 if value == 0 else value
    return round(value, digits - 1 - math.floor(math.log10(abs(value)))) + 0.0


def assign_epochs(mjds: Sequence[float], gap_days: float = EPOCH_GAP_DAYS) -> tuple[list[int], list[dict[str, Any]]]:
    """Epoca (desde 1) de cada fecha y resumen de cada epoca: misma regla que `app/pipeline/epochs.py`."""
    order = sorted(range(len(mjds)), key=lambda index: (mjds[index], index))
    numbers = [0] * len(mjds)
    groups: list[list[float]] = []
    previous: float | None = None
    for index in order:
        if previous is None or mjds[index] - previous > gap_days:
            groups.append([])
        groups[-1].append(mjds[index])
        numbers[index] = len(groups)
        previous = mjds[index]
    epochs = [
        {
            "epoch": number,
            "start": _iso_date(group[0]),
            "end": _iso_date(group[-1]),
            "mjd_start": _round(group[0], 4),
            "mjd_end": _round(group[-1], 4),
            "mjd_mean": _round(math.fsum(group) / len(group), 4),
            "n_exposures": len(group),
        }
        for number, group in enumerate(groups, start=1)
    ]
    return numbers, epochs


def bin_points(points: Sequence[dict[str, Any]], tables: WaveTables) -> list[dict[str, Any]]:
    """Promedia los puntos por canal: 17 canales por detector, repartidos de forma logaritmica en su rango.

    Media ponderada por inversa de la varianza. El error es el formal, agrandado
    por la dispersion entre los puntos del canal cuando es mayor que la esperada
    (raiz de chi2 reducido), para que una fuente variable no salga con barras
    demasiado chicas.
    """
    binned: list[dict[str, Any]] = []
    for detector in sorted({int(point["detector"]) for point in points}):
        low, high = tables.for_detector(detector).wave_range
        edges = np.geomspace(low, high, CHANNELS_PER_DETECTOR + 1)
        members = [point for point in points if point["detector"] == detector]
        waves = np.array([point["wavelength_um"] for point in members])
        channels = np.clip(np.searchsorted(edges, waves, side="right") - 1, 0, CHANNELS_PER_DETECTOR - 1)
        for channel in range(CHANNELS_PER_DETECTOR):
            chosen = [member for member, index in zip(members, channels, strict=True) if index == channel]
            if not chosen:
                continue
            flux = np.array([point["flux_mjy"] for point in chosen])
            error = np.array([point["error_mjy"] for point in chosen])
            weight = 1.0 / np.square(error)
            mean = float(np.sum(weight * flux) / np.sum(weight))
            formal = float(1.0 / math.sqrt(float(np.sum(weight))))
            scale = 1.0
            if len(chosen) >= 3:
                chi2 = float(np.sum(weight * np.square(flux - mean))) / (len(chosen) - 1)
                scale = max(1.0, math.sqrt(chi2))
            binned.append(
                {
                    "wavelength_um": _round(float(np.sum(weight * waves[channels == channel]) / np.sum(weight)), 4),
                    "wave_min_um": _round(float(edges[channel]), 4),
                    "wave_max_um": _round(float(edges[channel + 1]), 4),
                    "flux_mjy": _significant(mean),
                    "error_mjy": _significant(formal * scale),
                    "n": len(chosen),
                    "detector": detector,
                }
            )
    return binned


def _detector_summary(results: Sequence[ExposureResult], tables: WaveTables) -> list[dict[str, Any]]:
    summary: list[dict[str, Any]] = []
    for detector in sorted({result.detector for result in results}):
        own = [result for result in results if result.detector == detector]
        low, high = tables.for_detector(detector).wave_range
        count = {status: sum(1 for result in own if result.measurement.status == status) for status in
                 ("ok", "saturated", "masked", "edge", "no_sky")}  # fmt: skip
        offsets = [result.offset_arcsec for result in own if result.offset_arcsec is not None]
        offset = None
        if len(offsets) >= OFFSET_MIN_EXPOSURES:
            east = float(np.median([item[0] for item in offsets]))
            north = float(np.median([item[1] for item in offsets]))
            offset = {"east": _round(east, 2), "north": _round(north, 2), "total": _round(math.hypot(east, north), 2)}
        summary.append(
            {
                "detector": detector,
                "wave_min_um": _round(low, 3),
                "wave_max_um": _round(high, 3),
                "n_exposures": len(own),
                "n_points": count["ok"],
                "n_saturated": count["saturated"],
                "n_masked": count["masked"],
                "n_edge": count["edge"] + count["no_sky"],
                # Mediana del corrimiento del centroide respecto del objeto; `null` si no se pudo medir.
                "offset_arcsec": offset,
            }
        )
    return summary


def _target_document(target: SpectrumTarget, epochs: Sequence[dict[str, Any]]) -> dict[str, Any]:
    motion = target.motion
    moving = motion is not None and motion.has_proper_motion
    return {
        "name": target.name,
        "ra": _round(target.ra, 6),
        "dec": _round(target.dec, 6),
        "epoch": target.epoch,
        "motion": None
        if motion is None or not moving
        else {"pm_ra": motion.pm_ra, "pm_dec": motion.pm_dec, "parallax": motion.parallax},
        # Posicion en la fecha media de cada epoca: sirve para reconocer un clic sobre el objeto.
        "track": [
            {"epoch": item["epoch"], "mjd": item["mjd_mean"], **_sky(target.position_at(item["mjd_mean"]))}
            for item in epochs
        ],
    }


def _sky(position: tuple[float, float]) -> dict[str, float]:
    return {"ra": _round(position[0], 6), "dec": _round(position[1], 6)}


def build_document(
    results: Sequence[ExposureResult],
    target: SpectrumTarget,
    tables: WaveTables,
    config: ApertureConfig,
    *,
    field_id: str | None = None,
    n_unreadable: int = 0,
) -> dict[str, Any]:
    """Arma el documento del espectro a partir de las mediciones de cada exposicion."""
    usable = [result for result in results if math.isfinite(result.mjd)]
    numbers, epochs = assign_epochs([result.mjd for result in usable])
    measured = [(result, epoch) for result, epoch in zip(usable, numbers, strict=True) if result.measurement.ok]
    measured.sort(key=lambda item: (item[0].wavelength_um, item[0].mjd))

    points = [
        {
            "wavelength_um": _round(result.wavelength_um, 4),
            "bandwidth_um": _round(result.bandwidth_um, 4),
            "flux_mjy": _significant(result.flux_mjy or 0.0),
            "error_mjy": _significant(result.error_mjy or 0.0),
            "mjd": _round(result.mjd, 5),
            "date": _iso_date(result.mjd),
            "epoch": epoch,
            "detector": result.detector,
            "flags": list(result.flags),
            "exposure": result.exposure,
        }
        for result, epoch in measured
    ]

    detectors = _detector_summary(usable, tables)
    warnings: list[dict[str, Any]] = []
    # Un detector cuenta como saturado si le pasa a una parte apreciable de sus exposiciones. Una
    # exposicion suelta con un pixel desbordado cerca (un rayo cosmico) no es una fuente saturada:
    # esa va con las descartadas por pixeles defectuosos.
    saturated_detectors = {
        item["detector"]
        for item in detectors
        if item["n_saturated"] >= max(SATURATED_MIN_EXPOSURES, SATURATED_MIN_FRACTION * item["n_exposures"])
    }
    saturated = [
        (result, epoch)
        for result, epoch in zip(usable, numbers, strict=True)
        if result.measurement.status == "saturated" and result.detector in saturated_detectors
    ]
    if saturated:
        # Misma forma que el aviso `saturated_source` del documento del campo (docs/contrato-cubo.md,
        # seccion 5): `ra`, `dec`, `radius_arcsec`, `epochs` y `detectors`. Aca el radio es el de la
        # apertura (`aperture.radius_arcsec`), que es donde se busco la saturacion. `n_exposures` y
        # `n_total` son de este modulo.
        warnings.append(
            {
                "code": "saturated_source",
                "ra": _round(target.ra, 5),
                "dec": _round(target.dec, 5),
                "radius_arcsec": _round(config.radius_px * NATIVE_PIXEL_ARCSEC, 2),
                "epochs": sorted({epoch for _, epoch in saturated}),
                "detectors": sorted(saturated_detectors),
                "n_exposures": len(saturated),
                "n_total": len(usable),
            }
        )
    shifted = [
        item for item in detectors if item["offset_arcsec"] and item["offset_arcsec"]["total"] > OFFSET_WARNING_ARCSEC
    ]
    if shifted:
        warnings.append(
            {
                "code": "offset_source",
                "detectors": [item["detector"] for item in shifted],
                "offset_arcsec": max(item["offset_arcsec"]["total"] for item in shifted),
            }
        )
    n_masked = sum(
        1
        for result in usable
        if result.measurement.status == "masked"
        or (result.measurement.status == "saturated" and result.detector not in saturated_detectors)
    )
    if n_masked:
        warnings.append({"code": "masked_exposures", "n_exposures": n_masked, "n_total": len(usable)})
    versions = sorted({result.processing for result in usable if result.processing})
    if tables.processing is not None and any(version != tables.processing for version in versions):
        # SPEC.md, seccion 2: la tabla WCS-WAVE se comprobo solo con una version de procesamiento.
        warnings.append({"code": "wave_table_version", "table": tables.processing, "files": versions})

    if points:
        status = "partial" if saturated else "ok"
    elif saturated and len(saturated) >= len(usable) / 2:
        status = "saturated"
    else:
        status = "empty"

    widths = [result.psf_fwhm_arcsec for result, _ in measured if result.psf_fwhm_arcsec]
    radius_arcsec = config.radius_px * NATIVE_PIXEL_ARCSEC
    return {
        "version": DOCUMENT_VERSION,
        "status": status,
        "target": _target_document(target, epochs),
        "field": field_id,
        "units": {"wavelength": "um", "flux": "mJy"},
        "aperture": {
            "radius_px": config.radius_px,
            "radius_arcsec": _round(radius_arcsec, 2),
            "annulus_in_px": config.annulus_in_px,
            "annulus_out_px": config.annulus_out_px,
            "correction": "none",
            "psf_fwhm_arcsec": None if not widths else [_round(min(widths), 2), _round(max(widths), 2)],
            "enclosed_fraction_gaussian": None
            if not widths
            else [
                _round(gaussian_enclosed_fraction(radius_arcsec, max(widths)), 3),
                _round(gaussian_enclosed_fraction(radius_arcsec, min(widths)), 3),
            ],
        },
        "epochs": epochs,
        "detectors": detectors,
        "points": points,
        "binned": bin_points(points, tables),
        "warnings": warnings,
        "provenance": {
            "source": "SPHEREx / IRSA",
            "n_exposures": len(usable),
            "n_points": len(points),
            "n_unreadable": n_unreadable,
            "processing": versions,
            "wave_table": tables.processing,
        },
    }


def compute_spectrum(
    cutouts: Sequence[CachedCutout],
    target: SpectrumTarget,
    *,
    config: ApertureConfig | None = None,
    tables: WaveTables | None = None,
    field_id: str | None = None,
) -> dict[str, Any]:
    """Espectro del objeto a partir de los recortes dados (uno por exposicion). No usa la red."""
    if not cutouts:
        raise SpectrumError("no hay recortes en la cache que cubran el punto")
    config = ApertureConfig() if config is None else config
    try:
        tables = load_wave_tables() if tables is None else tables
    except WaveTableError as exc:
        raise SpectrumError(str(exc)) from exc
    collected = _collect(cutouts, target, tables, config)
    if not collected.results:
        raise SpectrumError(f"ninguno de los {len(cutouts)} recortes se pudo leer")
    return build_document(
        collected.results, target, tables, config, field_id=field_id, n_unreadable=len(collected.failures)
    )


def cutout_paths(cutouts: Sequence[CachedCutout]) -> list[Path]:
    return [cutout.path for cutout in cutouts]
