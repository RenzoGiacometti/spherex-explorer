"""Medidas por exposicion para la curva de luz: apertura y alas, sobre los recortes en cache.

Lee cada recorte una sola vez y lo deja en memoria (59 x 59 px, cuatro planos:
unos 50 kB por exposicion), porque las alas se miden en dos pasadas: primero se
mira el hueco saturado de todas las exposiciones de un detector para elegir un
anillo comun, y despues se mide cada una con ese anillo.

La apertura es la del espectro (`app.spectrum.photometry`), con la misma
posicion del objeto en la fecha de cada exposicion y la misma longitud de onda
del pixel. Las alas se miden solo en los detectores donde la fuente satura.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from numpy.typing import NDArray

from app.lightcurve.wings import (
    WingAnnulus,
    WingConfig,
    WingMeasurement,
    choose_annulus,
    edge_room,
    hole_radius,
    measure_wings,
)
from app.pipeline.exposure import (
    MASKED_FLAGS,
    SATURATION_FLAGS,
    SOURCE_FLAG,
    flag_mask,
    read_flag_table,
    wcs_cards,
)
from app.spectrum.cutouts import CachedCutout
from app.spectrum.photometry import ApertureConfig, Measurement, measure_aperture
from app.spectrum.service import (
    MJY_PER_MEGAJY,
    READ_WORKERS,
    SATURATED_MIN_EXPOSURES,
    SATURATED_MIN_FRACTION,
    SpectrumTarget,
)
from app.spectrum.wavelength import WaveTables, processing_version, wavelength_at

logger = logging.getLogger(__name__)

_DEG2_TO_SR = (math.pi / 180.0) ** 2
# Un hueco solo se mide si el objeto esta a mas de esto del borde del recorte.
MIN_EDGE_ROOM_PX = 3.0


@dataclass(frozen=True)
class Frame:
    """Un recorte en memoria, con el objeto ya ubicado."""

    exposure: str
    detector: int
    mjd: float
    x: float  # posicion del objeto en el recorte, pixeles desde 0
    y: float
    image: NDArray[np.float64]  # IMAGE - ZODI, MJy/sr
    variance: NDArray[np.float64]
    flags: NDArray[np.uint32]
    bad: NDArray[np.bool_]  # pixeles que no se usan
    masked_bits: int
    saturation_bits: int
    source_bits: int
    wavelength_um: float
    bandwidth_um: float
    pixel_area_sr: float
    processing: str | None
    wcs: WCS

    @property
    def inside(self) -> bool:
        """Si el objeto cae dentro del recorte con algo de aire."""
        shape = (int(self.image.shape[0]), int(self.image.shape[1]))
        return math.isfinite(self.x) and math.isfinite(self.y) and edge_room(shape, self.x, self.y) >= MIN_EDGE_ROOM_PX


@dataclass(frozen=True)
class ExposureMeasure:
    """Lo que se midio en una exposicion."""

    exposure: str
    detector: int
    mjd: float
    wavelength_um: float
    bandwidth_um: float
    pixel_area_sr: float
    aperture: Measurement
    wings: WingMeasurement | None  # `None` si en ese detector no se miden alas
    hole_px: float  # radio del hueco enmascarado; 0 si el centro esta limpio
    offset_arcsec: tuple[float, float] | None  # corrimiento del centroide (este, norte)
    processing: str | None

    def _mjy(self, value: float | None) -> float | None:
        if value is None or not math.isfinite(self.pixel_area_sr):
            return None
        return value * self.pixel_area_sr * MJY_PER_MEGAJY

    @property
    def aperture_mjy(self) -> float | None:
        return self._mjy(self.aperture.flux)

    @property
    def aperture_error_mjy(self) -> float | None:
        return self._mjy(self.aperture.error)

    @property
    def wings_mjy(self) -> float | None:
        """Flujo de las alas en mJy. No es el flujo de la fuente: es la parte que cae en el anillo."""
        return None if self.wings is None else self._mjy(self.wings.flux)

    @property
    def wings_error_mjy(self) -> float | None:
        return None if self.wings is None else self._mjy(self.wings.error)


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


def load_frame(cutout: CachedCutout, target: SpectrumTarget, tables: WaveTables) -> Frame:
    """Lee un recorte y ubica el objeto. Lanza `OSError`, `KeyError` o `ValueError` si el archivo no sirve."""
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

    detector = int(header["DETECTOR"])
    mjd = _header_float(header, "MJD-AVG", "MJD-OBS")  # punto medio de la exposicion, UTC
    if mjd is None:
        raise ValueError(f"{cutout.path.name}: el encabezado no trae MJD-AVG ni MJD-OBS")
    radesys = str(header.get("RADESYS", "ICRS")).strip().upper()
    if radesys != "ICRS":
        raise ValueError(f"{cutout.path.name}: RADESYS={radesys!r}; solo se admite ICRS")
    wcs = WCS(wcs_cards(header))  # solo el WCS primario: ver app/pipeline/exposure.py
    ra, dec = target.position_at(mjd)
    x_pix, y_pix = wcs.all_world2pix([ra], [dec], 0)
    x, y = float(x_pix[0]), float(y_pix[0])

    data = image - zodi
    masked_bits = flag_mask(flag_bits, MASKED_FLAGS)
    with np.errstate(invalid="ignore"):
        bad = ~np.isfinite(data) | ~np.isfinite(variance) | (variance <= 0) | ((flags & masked_bits) != 0)
    shape = (int(data.shape[0]), int(data.shape[1]))
    if math.isfinite(x) and math.isfinite(y) and edge_room(shape, x, y) > -1.0:
        wavelength, bandwidth = wavelength_at(tables.for_detector(detector), header, x, y)
        area = _pixel_area_sr(wcs, x, y)
    else:
        wavelength, bandwidth, area = math.nan, math.nan, math.nan
    return Frame(
        exposure=str(header.get("OBSID") or cutout.exposure),
        detector=detector,
        mjd=mjd,
        x=x,
        y=y,
        image=data,
        variance=variance,
        flags=flags,
        bad=bad,
        masked_bits=masked_bits,
        saturation_bits=flag_mask(flag_bits, SATURATION_FLAGS),
        source_bits=flag_mask(flag_bits, (SOURCE_FLAG,)),
        wavelength_um=wavelength,
        bandwidth_um=bandwidth,
        pixel_area_sr=area,
        processing=processing_version(cutout.path.name),
        wcs=wcs,
    )


def load_frames(cutouts: Sequence[CachedCutout], target: SpectrumTarget, tables: WaveTables) -> tuple[list[Frame], int]:
    """Lee los recortes en paralelo. Devuelve los que se pudieron leer y cuantos no."""

    def one(cutout: CachedCutout) -> Frame | None:
        try:
            return load_frame(cutout, target, tables)
        except (OSError, KeyError, ValueError, TypeError, IndexError, fits.VerifyError) as exc:
            logger.warning("curva de luz: recorte %s descartado: %s", cutout.exposure, str(exc)[:200])
            return None

    if len(cutouts) <= 1:
        loaded = [one(cutout) for cutout in cutouts]
    else:
        with ThreadPoolExecutor(max_workers=READ_WORKERS) as pool:
            loaded = list(pool.map(one, cutouts))
    frames = [frame for frame in loaded if frame is not None]
    return frames, len(loaded) - len(frames)


def _offset(frame: Frame, measurement: Measurement) -> tuple[float, float] | None:
    if measurement.centroid is None:
        return None
    sky_ra, sky_dec = frame.wcs.all_pix2world([measurement.centroid[0]], [measurement.centroid[1]], 0)
    ra, dec = frame.wcs.all_pix2world([frame.x], [frame.y], 0)
    east = ((float(sky_ra[0]) - float(ra[0]) + 180.0) % 360.0 - 180.0) * math.cos(math.radians(float(dec[0]))) * 3600.0
    return east, (float(sky_dec[0]) - float(dec[0])) * 3600.0


def saturating_detectors(apertures: Sequence[tuple[int, Measurement]]) -> set[int]:
    """Detectores donde la fuente satura: misma regla que el aviso `saturated_source` del espectro."""
    total: dict[int, int] = {}
    saturated: dict[int, int] = {}
    for detector, measurement in apertures:
        total[detector] = total.get(detector, 0) + 1
        if measurement.status == "saturated":
            saturated[detector] = saturated.get(detector, 0) + 1
    return {
        detector
        for detector, count in saturated.items()
        if count >= max(SATURATED_MIN_EXPOSURES, SATURATED_MIN_FRACTION * total[detector])
    }


def measure_frames(
    frames: Sequence[Frame],
    *,
    aperture_config: ApertureConfig | None = None,
    wing_config: WingConfig | None = None,
    wing_detectors: set[int] | None = None,
) -> tuple[list[ExposureMeasure], dict[int, WingAnnulus]]:
    """Mide apertura y alas en cada exposicion.

    Las alas se miden en `wing_detectors`; por defecto, en los detectores donde
    la fuente satura. Devuelve las medidas, en el orden de `frames`, y el anillo
    de alas elegido para cada detector.
    """
    aperture_config = ApertureConfig() if aperture_config is None else aperture_config
    wing_config = WingConfig() if wing_config is None else wing_config

    apertures = [
        measure_aperture(
            frame.image,
            frame.variance,
            frame.flags,
            frame.x,
            frame.y,
            masked_bits=frame.masked_bits,
            saturation_bits=frame.saturation_bits,
            source_bits=frame.source_bits,
            config=aperture_config,
        )
        for frame in frames
    ]
    holes = [
        hole_radius(frame.bad, frame.x, frame.y, masked_fraction=wing_config.hole_masked_fraction)
        if frame.inside
        else math.nan
        for frame in frames
    ]
    if wing_detectors is None:
        wing_detectors = saturating_detectors(
            [(frame.detector, aperture) for frame, aperture in zip(frames, apertures, strict=True)]
        )
    annuli = {
        detector: choose_annulus(
            [hole for frame, hole in zip(frames, holes, strict=True) if frame.detector == detector], wing_config
        )
        for detector in sorted(wing_detectors)
    }

    measures: list[ExposureMeasure] = []
    for frame, aperture, hole in zip(frames, apertures, holes, strict=True):
        wings: WingMeasurement | None = None
        annulus = annuli.get(frame.detector)
        if annulus is not None:
            if math.isfinite(hole) and hole + wing_config.hole_margin_px > annulus.inner_px:
                # El hueco de esta exposicion llega al anillo comun: no se puede comparar con las demas.
                wings = WingMeasurement("masked", None, None, None, 0.0, 0)
            else:
                wings = measure_wings(
                    frame.image, frame.variance, frame.bad, frame.x, frame.y, annulus, config=wing_config
                )
        measures.append(
            ExposureMeasure(
                exposure=frame.exposure,
                detector=frame.detector,
                mjd=frame.mjd,
                wavelength_um=frame.wavelength_um,
                bandwidth_um=frame.bandwidth_um,
                pixel_area_sr=frame.pixel_area_sr,
                aperture=aperture,
                wings=wings,
                hole_px=hole,
                offset_arcsec=_offset(frame, aperture),
                processing=frame.processing,
            )
        )
    return measures, annuli
