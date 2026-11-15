"""Piezas del documento de metadatos que arma un trabajo (contrato, seccion 5).

Funciones puras: de la lista de exposiciones a `epochs[]` y `detectors[]`, y de
los planos a los avisos de calidad. Los umbrales de los avisos son los de la
tabla "Avisos" del contrato.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from app.contract import (
    DetectorInfo,
    EpochInfo,
    PlaneInfo,
    SaturatedRegion,
    SaturatedSourceWarning,
)
from app.domain import EpochSummary, Exposure, Grid
from app.geometry import NATIVE_PIXEL_SCALE_ARCSEC, angular_separation_deg, pixel_to_sky

# "El plano se armo con menos de 5 exposiciones" (contrato, seccion 5, avisos).
FEW_EXPOSURES_BELOW = 5
# "Menos del 90 % del plano tiene datos".
LOW_COVERAGE_BELOW = 0.90

# Rango de cada detector en micrones, para un detector que no tiene ninguna exposicion en el
# campo: `detectors[]` lleva siempre los seis y no hay de donde leer su rango real. Son los
# que informa IRSA segun SPEC.md (seccion 2, "6 detectores (bandas), con los rangos que informa
# IRSA"); coinciden con `em_min` y `em_max` de las respuestas guardadas en tests/fixtures/sia.
NOMINAL_WAVE_RANGE_UM: dict[int, tuple[float, float]] = {
    1: (0.75, 1.12),
    2: (1.10, 1.65),
    3: (1.63, 2.43),
    4: (2.40, 3.85),
    5: (3.81, 4.43),
    6: (4.41, 5.01),
}

DETECTORS: tuple[int, ...] = (1, 2, 3, 4, 5, 6)

_MJD_ZERO = datetime(1858, 11, 17, tzinfo=UTC)
_TIMESTAMP_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


def iso_date(mjd: float) -> str:
    """Fecha `AAAA-MM-DD` (UTC) de un MJD."""
    return (_MJD_ZERO + timedelta(days=float(mjd))).strftime("%Y-%m-%d")


def parse_timestamp(text: str) -> datetime | None:
    """Fecha y hora de un texto con el formato del contrato (`2026-11-15T06:21:10Z`), o `None` si no lo tiene."""
    try:
        return datetime.strptime(text, _TIMESTAMP_FORMAT).replace(tzinfo=UTC)
    except (TypeError, ValueError):
        return None


def epoch_infos(epochs: Sequence[EpochSummary]) -> list[EpochInfo]:
    """`epochs[]` del documento a partir del resumen de `assign_epochs`."""
    return [
        EpochInfo(
            epoch=item.epoch,
            start=iso_date(item.mjd_start),
            end=iso_date(item.mjd_end),
            mjd_start=round(item.mjd_start, 5),
            mjd_end=round(item.mjd_end, 5),
            mjd_mean=round(item.mjd_mean, 5),
            n_exposures=item.n_exposures,
        )
        for item in epochs
    ]


def detector_infos(exposures: Iterable[Exposure]) -> list[DetectorInfo]:
    """`detectors[]` con el rango real de cada detector: el minimo y el maximo de sus exposiciones.

    Van siempre los seis. El que no tiene exposiciones en el campo lleva el
    rango de `NOMINAL_WAVE_RANGE_UM`. `display` queda en `null` hasta que el
    detector tiene algun plano con datos.
    """
    low: dict[int, float] = {}
    high: dict[int, float] = {}
    for exposure in exposures:
        detector = exposure.detector
        low[detector] = min(low.get(detector, math.inf), exposure.wave_min_um)
        high[detector] = max(high.get(detector, -math.inf), exposure.wave_max_um)
    infos: list[DetectorInfo] = []
    for detector in DETECTORS:
        nominal = NOMINAL_WAVE_RANGE_UM[detector]
        wave_min = low.get(detector, nominal[0])
        wave_max = high.get(detector, nominal[1])
        if not (math.isfinite(wave_min) and math.isfinite(wave_max)):
            wave_min, wave_max = nominal
        infos.append(DetectorInfo(detector=detector, wave_min_um=round(wave_min, 4), wave_max_um=round(wave_max, 4)))
    return infos


# ------------------------------------------------------------ fuentes saturadas


@dataclass
class _Source:
    """Regiones saturadas de distintos planos que son la misma fuente."""

    xs: list[float] = field(default_factory=list)
    ys: list[float] = field(default_factory=list)
    radius_px: float = 0.0
    epochs: set[int] = field(default_factory=set)
    detectors: set[int] = field(default_factory=set)

    @property
    def x(self) -> float:
        return math.fsum(self.xs) / len(self.xs)

    @property
    def y(self) -> float:
        return math.fsum(self.ys) / len(self.ys)

    def add(self, plane: PlaneInfo, region: SaturatedRegion) -> None:
        self.xs.append(region.x)
        self.ys.append(region.y)
        self.radius_px = max(self.radius_px, region.radius_px)
        self.epochs.add(plane.epoch)
        self.detectors.add(plane.detector)


def saturated_sources(grid: Grid, planes: Iterable[PlaneInfo]) -> list[SaturatedSourceWarning]:
    """Un aviso `saturated_source` por fuente saturada, con las epocas y los detectores donde aparece.

    Las regiones de `planes[].saturated` de distintos planos se juntan en una
    misma fuente si sus centros estan a menos del radio de la mayor mas un
    pixel nativo: la misma estrella no cae exactamente en el mismo lugar en
    cada plano (cambia la mascara y, si tiene movimiento propio, se corre unos
    segundos de arco entre epocas). El centro es el promedio de los centros y
    el radio, el mayor.

    Usa el WCS de `grid`: hay que llamarla desde el hilo duenio de esa grilla.
    """
    margin_px = NATIVE_PIXEL_SCALE_ARCSEC / grid.pixel_scale_arcsec
    sources: list[_Source] = []
    for plane in sorted(planes, key=lambda item: (item.epoch, item.detector)):
        for region in plane.saturated:
            for source in sources:
                reach = max(source.radius_px, region.radius_px) + margin_px
                if math.hypot(source.x - region.x, source.y - region.y) <= reach:
                    source.add(plane, region)
                    break
            else:
                created = _Source()
                created.add(plane, region)
                sources.append(created)
    warnings: list[SaturatedSourceWarning] = []
    for source in sources:
        ra, dec = pixel_to_sky(grid, source.x, source.y)
        warnings.append(
            SaturatedSourceWarning(
                ra=round(ra, 5),
                dec=round(dec, 5),
                radius_arcsec=round(source.radius_px * grid.pixel_scale_arcsec, 1),
                epochs=sorted(source.epochs),
                detectors=sorted(source.detectors),
            )
        )
    return warnings


def same_source(a: SaturatedSourceWarning, b: SaturatedSourceWarning) -> bool:
    """Si dos avisos `saturated_source` hablan de la misma fuente: mismos criterios que `saturated_sources`."""
    separation = angular_separation_deg(a.ra, a.dec, b.ra, b.dec) * 3600.0
    return separation <= max(a.radius_arcsec, b.radius_arcsec) + NATIVE_PIXEL_SCALE_ARCSEC
