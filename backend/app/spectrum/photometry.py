"""Fotometria de apertura sobre un recorte de una exposicion de SPHEREx.

Funciones puras sobre arreglos de numpy: no leen archivos ni conocen el WCS. La
apertura es un circulo centrado en la posicion del objeto, con pixeles
fraccionarios; el fondo sale de un anillo alrededor (mediana con recorte de
valores atipicos); el error sale de la extension VARIANCE mas la incertidumbre
del fondo.

    flujo  = suma_i w_i (I_i - fondo)
    error2 = suma_i w_i^2 VAR_i + (suma_i w_i)^2 (pi/2) sigma_fondo^2 / n_fondo

con `w_i` la fraccion del pixel `i` que cae dentro de la apertura. El resultado
queda en unidades de la imagen por pixel (MJy/sr x pixel); quien llama lo pasa
a densidad de flujo multiplicando por el angulo solido del pixel.

Una medicion no sale como numero cuando no seria valida (contrato, seccion 7,
"Limite conocido": la suma de apertura sobre un nucleo saturado varia de 160 a
1014 mJy solo por como cae la mascara). En ese caso `status` dice por que:

- `saturated`: hay pixeles con flags de saturacion (OVERFLOW, BLOOM) en la
  apertura o pegados a ella.
- `masked`: hay pixeles descartados por otros flags, o sin valor, en el nucleo
  de la apertura o en mas de una pequena fraccion de ella.
- `edge`: la apertura no entra entera en el recorte.
- `no_sky`: el anillo no tiene suficientes pixeles validos para el fondo.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

import numpy as np
from numpy.typing import NDArray

MeasurementStatus = Literal["ok", "saturated", "masked", "edge", "no_sky"]

# Factor entre la desviacion absoluta mediana y sigma en una distribucion normal.
MAD_TO_SIGMA = 1.4826
# Varianza de la mediana respecto de la de la media, para muchas muestras normales.
MEDIAN_VARIANCE_FACTOR = math.pi / 2.0


@dataclass(frozen=True)
class ApertureConfig:
    """Geometria de la medicion, en pixeles nativos (6,15" cada uno)."""

    # 1,5 px = 9,2": el radio de la Etapa 0. La PSF mide de 7,5" a 9" de ancho (PSF_FWHM de los
    # archivos); con 2 px entra un 3 % mas de flujo, pero tambien un 40 % mas de ruido y mas luz
    # de fuentes vecinas, que es lo que limita a un objeto debil como WISE 0855.
    radius_px: float = 1.5
    annulus_in_px: float = 4.0
    annulus_out_px: float = 8.0
    # Un pixel saturado a menos de esta distancia del borde de la apertura tambien invalida la
    # medicion: las alas de una estrella saturada no son el flujo de la estrella.
    saturation_margin_px: float = 1.0
    # Fraccion maxima del peso de la apertura que puede caer sobre pixeles descartados. Admite
    # una astilla en el borde, que casi no tiene flujo; lo que falta no se corrige.
    max_masked_fraction: float = 0.02
    # Ningun pixel descartado puede tener el centro a menos de esto del objeto.
    core_radius_px: float = 1.0
    # Senal sobre ruido minima para calcular el centroide de la luz dentro de la apertura.
    centroid_min_snr: float = 3.0
    # Subdivision de cada pixel para calcular la fraccion dentro del circulo.
    subsample: int = 10
    min_sky_pixels: int = 20
    sky_clip_sigma: float = 3.0
    sky_clip_iterations: int = 5

    def __post_init__(self) -> None:
        if not 0 < self.radius_px < self.annulus_in_px < self.annulus_out_px:
            raise ValueError("hace falta 0 < radius_px < annulus_in_px < annulus_out_px")
        if self.subsample < 1 or self.min_sky_pixels < 3:
            raise ValueError("subsample debe ser al menos 1 y min_sky_pixels al menos 3")


@dataclass(frozen=True)
class Measurement:
    """Resultado de medir una exposicion. `flux` y `error` son `None` si `status` no es `ok`."""

    status: MeasurementStatus
    flux: float | None  # unidades de la imagen x pixel, fondo restado
    error: float | None
    sky: float | None  # fondo por pixel, unidades de la imagen
    sky_sigma: float | None  # dispersion robusta del anillo
    n_sky: int  # pixeles del anillo que entraron al fondo
    aperture_pixels: float  # suma de los pesos: area de la apertura en pixeles
    flag_bits: int  # OR de FLAGS sobre los pixeles que toca la apertura
    masked_fraction: float  # fraccion del peso de la apertura sobre pixeles descartados
    saturated_pixels: int  # pixeles con flags de saturacion dentro del radio de control
    # Centroide de la luz dentro de la apertura, en pixeles desde 0. `None` si la senal no alcanza.
    # Si queda lejos de la posicion pedida, lo que se midio es sobre todo otra fuente.
    centroid: tuple[float, float] | None = None

    @property
    def ok(self) -> bool:
        return self.status == "ok"


def aperture_weights(shape: tuple[int, int], x: float, y: float, radius: float, subsample: int = 10) -> NDArray:
    """Fraccion de cada pixel de un arreglo de forma `shape` que cae dentro del circulo.

    `(x, y)` es el centro en pixeles contados desde 0 (el centro del primer pixel
    es 0,0) y `radius` el radio en pixeles. Cada pixel del borde se divide en
    `subsample x subsample` partes; la suma de los pesos aproxima `pi r^2`.
    """
    ny, nx = shape
    weights = np.zeros(shape, dtype=np.float64)
    x0 = max(0, math.floor(x - radius + 0.5))
    x1 = min(nx - 1, math.ceil(x + radius - 0.5))
    y0 = max(0, math.floor(y - radius + 0.5))
    y1 = min(ny - 1, math.ceil(y + radius - 0.5))
    if x0 > x1 or y0 > y1:
        return weights
    offsets = (np.arange(subsample, dtype=np.float64) + 0.5) / subsample - 0.5
    xs = np.arange(x0, x1 + 1, dtype=np.float64)[:, None] + offsets[None, :]  # [pixel, subpixel]
    ys = np.arange(y0, y1 + 1, dtype=np.float64)[:, None] + offsets[None, :]
    dx2 = (xs - x) ** 2
    dy2 = (ys - y) ** 2
    inside = dy2[:, None, :, None] + dx2[None, :, None, :] <= radius * radius  # [py, px, sy, sx]
    weights[y0 : y1 + 1, x0 : x1 + 1] = inside.mean(axis=(2, 3))
    return weights


def _distance(shape: tuple[int, int], x: float, y: float) -> NDArray:
    """Distancia del centro de cada pixel a `(x, y)`, en pixeles."""
    ny, nx = shape
    return np.hypot(np.arange(nx, dtype=np.float64)[None, :] - x, np.arange(ny, dtype=np.float64)[:, None] - y)


def sky_level(values: NDArray, clip_sigma: float = 3.0, iterations: int = 5) -> tuple[float, float, int]:
    """Fondo de un conjunto de pixeles: `(mediana, sigma robusta, cantidad usada)` con recorte iterativo.

    Descarta en cada vuelta lo que se aparta de la mediana mas de `clip_sigma`
    veces la sigma robusta (1,4826 x MAD), para que una estrella dentro del
    anillo no suba el fondo. Nunca descarta mas de la mitad de los pixeles: si
    el recorte quisiera hacerlo, la distribucion no es ruido alrededor de un
    nivel (un fondo casi sin dispersion, o una fuente que ocupa medio anillo) y
    se queda con lo que tenia.
    """
    kept = np.asarray(values, dtype=np.float64)
    kept = kept[np.isfinite(kept)]
    minimum = kept.size / 2.0
    median, sigma = math.nan, math.nan
    for _ in range(max(1, iterations)):
        if kept.size == 0:
            break
        median = float(np.median(kept))
        sigma = MAD_TO_SIGMA * float(np.median(np.abs(kept - median)))
        if sigma <= 0:
            break
        keep = np.abs(kept - median) <= clip_sigma * sigma
        if keep.all() or np.count_nonzero(keep) < minimum:
            break
        kept = kept[keep]
    return median, sigma, int(kept.size)


def measure_aperture(
    image: NDArray,
    variance: NDArray,
    flags: NDArray,
    x: float,
    y: float,
    *,
    masked_bits: int = 0,
    saturation_bits: int = 0,
    source_bits: int = 0,
    config: ApertureConfig | None = None,
) -> Measurement:
    """Mide el flujo de una fuente en `(x, y)` (pixeles desde 0) sobre un recorte.

    `image` y `variance` van en las unidades del archivo; `flags` es el mapa de
    bits. `masked_bits` son los bits que descartan un pixel, `saturation_bits`
    los que cuentan como saturacion y `source_bits` los que marcan pixeles de
    fuentes conocidas, que se dejan fuera del anillo de fondo si quedan
    suficientes sin ellos. Ver el encabezado del modulo para `status`.
    """
    config = ApertureConfig() if config is None else config
    image = np.asarray(image, dtype=np.float64)
    variance = np.asarray(variance, dtype=np.float64)
    flags = np.asarray(flags)
    if image.ndim != 2 or image.shape != variance.shape or image.shape != flags.shape:
        raise ValueError(
            f"imagen, varianza y flags deben medir lo mismo: {image.shape}, {variance.shape}, {flags.shape}"
        )
    shape = (int(image.shape[0]), int(image.shape[1]))
    ny, nx = shape

    def failed(status: MeasurementStatus, **values: float | int) -> Measurement:
        return Measurement(
            status=status,
            flux=None,
            error=None,
            sky=values.get("sky"),  # type: ignore[arg-type]
            sky_sigma=values.get("sky_sigma"),  # type: ignore[arg-type]
            n_sky=int(values.get("n_sky", 0)),
            aperture_pixels=float(values.get("aperture_pixels", 0.0)),
            flag_bits=int(values.get("flag_bits", 0)),
            masked_fraction=float(values.get("masked_fraction", 0.0)),
            saturated_pixels=int(values.get("saturated_pixels", 0)),
        )

    radius = config.radius_px
    if not (math.isfinite(x) and math.isfinite(y)):
        return failed("edge")
    if x - radius < -0.5 or x + radius > nx - 0.5 or y - radius < -0.5 or y + radius > ny - 0.5:
        return failed("edge")

    weights = aperture_weights(shape, x, y, radius, config.subsample)
    touched = weights > 0
    total_weight = float(weights.sum())
    flag_bits = int(np.bitwise_or.reduce(flags[touched].astype(np.int64) & 0xFFFFFFFF)) if touched.any() else 0
    distance = _distance(shape, x, y)

    with np.errstate(invalid="ignore"):
        bad = ~np.isfinite(image) | ~np.isfinite(variance) | (variance <= 0)
    if masked_bits:
        bad |= (flags & masked_bits) != 0

    saturated_pixels = 0
    if saturation_bits:
        near = distance <= radius + config.saturation_margin_px
        saturated_pixels = int(np.count_nonzero(near & ((flags & saturation_bits) != 0)))
    masked_fraction = float(weights[bad].sum() / total_weight) if total_weight > 0 else 1.0
    common = {
        "aperture_pixels": total_weight,
        "flag_bits": flag_bits,
        "masked_fraction": masked_fraction,
        "saturated_pixels": saturated_pixels,
    }
    if saturated_pixels > 0:
        return failed("saturated", **common)
    core_masked = bool(np.any(bad & (distance <= config.core_radius_px)))
    if core_masked or masked_fraction > config.max_masked_fraction:
        return failed("masked", **common)

    # Fondo: anillo, sin pixeles descartados y, si alcanzan, sin los de fuentes conocidas.
    ring = (distance >= config.annulus_in_px) & (distance <= config.annulus_out_px) & ~bad
    if source_bits:
        quiet = ring & ((flags & source_bits) == 0)
        if int(np.count_nonzero(quiet)) >= config.min_sky_pixels:
            ring = quiet
    sky, sky_sigma, n_sky = sky_level(image[ring], config.sky_clip_sigma, config.sky_clip_iterations)
    if n_sky < config.min_sky_pixels or not math.isfinite(sky):
        return failed("no_sky", n_sky=n_sky, **common)

    good = touched & ~bad
    good_weights = weights[good]
    flux = float(np.sum(good_weights * (image[good] - sky)))
    variance_sum = float(np.sum(good_weights**2 * variance[good]))
    sky_term = total_weight**2 * MEDIAN_VARIANCE_FACTOR * sky_sigma**2 / n_sky
    error = math.sqrt(max(variance_sum + sky_term, 0.0))
    centroid: tuple[float, float] | None = None
    if error > 0 and flux > config.centroid_min_snr * error:
        signal = good_weights * (image[good] - sky)
        rows, columns = np.nonzero(good)
        centroid = (float(np.sum(signal * columns) / flux), float(np.sum(signal * rows) / flux))
    return Measurement(
        status="ok",
        flux=flux,
        error=error,
        sky=sky,
        sky_sigma=sky_sigma,
        n_sky=n_sky,
        aperture_pixels=total_weight,
        flag_bits=flag_bits,
        masked_fraction=masked_fraction,
        saturated_pixels=0,
        centroid=centroid,
    )


def gaussian_enclosed_fraction(radius: float, fwhm: float) -> float:
    """Fraccion del flujo de una PSF gaussiana de ancho `fwhm` dentro de un circulo de radio `radius`.

    `1 - exp(-4 ln2 r^2 / FWHM^2)`. Sirve para estimar cuanto flujo queda fuera
    de la apertura; la PSF real de SPHEREx tiene alas mas anchas que una
    gaussiana, asi que es una cota optimista.
    """
    if fwhm <= 0 or radius <= 0:
        return 1.0
    return 1.0 - math.exp(-4.0 * math.log(2.0) * radius * radius / (fwhm * fwhm))
