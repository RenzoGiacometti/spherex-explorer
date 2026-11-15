"""Fotometria sobre las alas de una fuente saturada.

Cuando una estrella satura, el nucleo no tiene medicion valida (contrato,
seccion 7), pero la luz que la optica reparte lejos del centro si: las alas de
la PSF. El flujo en un anillo alrededor del nucleo, fuera de los pixeles
marcados, es una fraccion fija del flujo total mientras la PSF no cambie. Esa
fraccion no se conoce, asi que el resultado no es un flujo absoluto; sirve para
comparar una exposicion con otra de la misma longitud de onda: variacion
relativa.

Para que la fraccion sea de verdad la misma en todas las exposiciones:

- El anillo es el mismo para todas las exposiciones de un detector
  (`choose_annulus`): empieza un pixel mas alla del hueco enmascarado en el 90 %
  de ellas. Una exposicion con el hueco mas grande que eso no se mide.
- El anillo se parte en coronas de un pixel y de cada una se toma la mediana de
  sus pixeles validos por el area completa de la corona. Asi un tramo
  enmascarado, o una estrella de campo dentro del anillo, no cambia la medida:
  se supone simetria alrededor de la estrella, no que el anillo este entero.
- El fondo sale de otro anillo, mas afuera. En una estrella muy brillante ese
  anillo todavia esta dentro de las alas; no importa, porque lo que queda
  (alas del anillo menos alas del fondo) sigue siendo proporcional al flujo.

    alas  = suma_coronas area_k (mediana_k - fondo)
    error2 = suma_coronas area_k^2 (pi/2) VAR_k / n_k + (area total)^2 (pi/2) sigma_fondo^2 / n_fondo

El error es el formal, de VARIANCE. El error real de comparar dos exposicones
(la PSF cambia con la posicion en el detector y con la fase del pixel) se mide
sobre una estrella que no varia: ver `calibration.py`.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

import numpy as np
from numpy.typing import NDArray

from app.spectrum.photometry import MEDIAN_VARIANCE_FACTOR, sky_level

WingStatus = Literal["ok", "masked", "edge", "no_sky", "faint"]


@dataclass(frozen=True)
class WingAnnulus:
    """Geometria de la medicion sobre las alas, en pixeles nativos."""

    inner_px: float
    outer_px: float
    sky_inner_px: float
    sky_outer_px: float

    def __post_init__(self) -> None:
        if not 0 < self.inner_px < self.outer_px <= self.sky_inner_px < self.sky_outer_px:
            raise ValueError("hace falta 0 < inner_px < outer_px <= sky_inner_px < sky_outer_px")


@dataclass(frozen=True)
class WingConfig:
    # Ancho del anillo de alas y de cada corona, en pixeles.
    width_px: float = 4.0
    ring_px: float = 1.0
    # Separacion entre el hueco y el anillo, y entre el anillo y el del fondo.
    hole_margin_px: float = 1.0
    sky_gap_px: float = 2.0
    sky_width_px: float = 5.0
    # El hueco de una exposicion llega hasta donde menos de esta fraccion de la corona esta enmascarada.
    hole_masked_fraction: float = 0.1
    # Percentil del radio del hueco entre las exposiciones de un detector que fija el anillo.
    hole_percentile: float = 90.0
    min_inner_px: float = 2.0
    # Cada corona necesita esta fraccion de pixeles validos, y el anillo entero esta otra.
    min_ring_valid: float = 0.5
    min_valid: float = 0.8
    min_sky_pixels: int = 20
    # Las alas tienen que distinguirse del ruido para servir de medida.
    min_snr: float = 5.0


@dataclass(frozen=True)
class WingMeasurement:
    """Resultado de medir las alas en una exposicion. `flux` y `error` son `None` si `status` no es `ok`."""

    status: WingStatus
    flux: float | None  # unidades de la imagen x pixel; proporcional al flujo de la fuente
    error: float | None
    sky: float | None
    valid_fraction: float  # fraccion de pixeles validos del anillo
    n_pixels: int  # pixeles validos del anillo

    @property
    def ok(self) -> bool:
        return self.status == "ok"


def _distance(shape: tuple[int, int], x: float, y: float) -> NDArray[np.float64]:
    ny, nx = shape
    return np.hypot(np.arange(nx, dtype=np.float64)[None, :] - x, np.arange(ny, dtype=np.float64)[:, None] - y)


def edge_room(shape: tuple[int, int], x: float, y: float) -> float:
    """Distancia del punto al borde mas cercano del recorte, en pixeles (negativa si esta afuera)."""
    ny, nx = shape
    return min(x + 0.5, y + 0.5, nx - 0.5 - x, ny - 0.5 - y)


def hole_radius(
    bad: NDArray[np.bool_],
    x: float,
    y: float,
    *,
    masked_fraction: float = 0.1,
    ring_px: float = 1.0,
    max_radius_px: float = 25.0,
) -> float:
    """Radio del hueco enmascarado alrededor de `(x, y)`: donde empieza la primera corona casi limpia.

    Recorre coronas de `ring_px` desde el centro y devuelve el radio interno de
    la primera con menos de `masked_fraction` de sus pixeles en `bad`. Vale 0 si
    el centro ya esta limpio (fuente sin saturar) y NaN si no hay ninguna corona
    limpia hasta `max_radius_px`: el recorte esta enmascarado casi entero y no
    dice nada sobre el hueco de la estrella.
    """
    distance = _distance((int(bad.shape[0]), int(bad.shape[1])), x, y)
    radius = 0.0
    while radius < max_radius_px:
        ring = (distance >= radius) & (distance < radius + ring_px)
        count = int(np.count_nonzero(ring))
        if count and np.count_nonzero(bad & ring) / count < masked_fraction:
            return radius
        radius += ring_px
    return math.nan


def choose_annulus(hole_radii: Sequence[float], config: WingConfig | None = None) -> WingAnnulus:
    """El anillo comun para un grupo de exposiciones (las de un detector), a partir del hueco de cada una."""
    config = WingConfig() if config is None else config
    radii = np.asarray([radius for radius in hole_radii if math.isfinite(radius)], dtype=np.float64)
    typical = float(np.percentile(radii, config.hole_percentile)) if radii.size else 0.0
    inner = max(config.min_inner_px, math.ceil(typical) + config.hole_margin_px)
    outer = inner + config.width_px
    sky_inner = outer + config.sky_gap_px
    return WingAnnulus(
        inner_px=inner, outer_px=outer, sky_inner_px=sky_inner, sky_outer_px=sky_inner + config.sky_width_px
    )


def measure_wings(
    image: NDArray,
    variance: NDArray,
    bad: NDArray[np.bool_],
    x: float,
    y: float,
    annulus: WingAnnulus,
    *,
    config: WingConfig | None = None,
) -> WingMeasurement:
    """Flujo de las alas en `annulus` alrededor de `(x, y)` (pixeles desde 0).

    `bad` marca los pixeles que no se usan (flags que descartan, sin valor,
    varianza no positiva). `status`:

    - `edge`: el anillo de alas no entra entero en el recorte.
    - `masked`: el hueco llega al anillo, o quedan pocos pixeles validos en el
      o en alguna de sus coronas.
    - `no_sky`: el anillo de fondo no tiene suficientes pixeles validos.
    - `faint`: las alas no se distinguen del ruido.
    """
    config = WingConfig() if config is None else config
    image = np.asarray(image, dtype=np.float64)
    variance = np.asarray(variance, dtype=np.float64)
    if image.ndim != 2 or image.shape != variance.shape or image.shape != bad.shape:
        raise ValueError(
            f"imagen, varianza y mascara deben medir lo mismo: {image.shape}, {variance.shape}, {bad.shape}"
        )
    shape = (int(image.shape[0]), int(image.shape[1]))

    def failed(status: WingStatus, valid_fraction: float = 0.0, n_pixels: int = 0) -> WingMeasurement:
        return WingMeasurement(status, None, None, None, valid_fraction, n_pixels)

    if not (math.isfinite(x) and math.isfinite(y)) or edge_room(shape, x, y) < annulus.outer_px:
        return failed("edge")

    distance = _distance(shape, x, y)
    with np.errstate(invalid="ignore"):
        good = ~bad & np.isfinite(image) & np.isfinite(variance) & (variance > 0)

    in_annulus = (distance >= annulus.inner_px) & (distance < annulus.outer_px)
    total = int(np.count_nonzero(in_annulus))
    n_valid = int(np.count_nonzero(in_annulus & good))
    valid_fraction = n_valid / total if total else 0.0
    if valid_fraction < config.min_valid:
        return failed("masked", valid_fraction, n_valid)

    ring_sky = (distance >= annulus.sky_inner_px) & (distance < annulus.sky_outer_px) & good
    sky, sky_sigma, n_sky = sky_level(image[ring_sky])
    if n_sky < config.min_sky_pixels or not math.isfinite(sky):
        return failed("no_sky", valid_fraction, n_valid)

    flux = 0.0
    variance_sum = 0.0
    area_total = 0.0
    radius = annulus.inner_px
    while radius < annulus.outer_px - 1e-9:
        upper = min(radius + config.ring_px, annulus.outer_px)
        ring = (distance >= radius) & (distance < upper)
        ring_good = ring & good
        n_ring = int(np.count_nonzero(ring_good))
        if n_ring < config.min_ring_valid * max(1, int(np.count_nonzero(ring))):
            return failed("masked", valid_fraction, n_valid)
        area = math.pi * (upper * upper - radius * radius)
        flux += area * (float(np.median(image[ring_good])) - sky)
        variance_sum += area * area * MEDIAN_VARIANCE_FACTOR * float(np.mean(variance[ring_good])) / n_ring
        area_total += area
        radius = upper
    variance_sum += area_total**2 * MEDIAN_VARIANCE_FACTOR * sky_sigma**2 / n_sky
    error = math.sqrt(max(variance_sum, 0.0))
    if not (flux > config.min_snr * error):
        return failed("faint", valid_fraction, n_valid)
    return WingMeasurement("ok", flux, error, sky, valid_fraction, n_valid)
