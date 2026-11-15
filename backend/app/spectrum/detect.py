"""Deteccion de las fuentes mas brillantes de un campo, sobre sus planos ya armados.

Funciones puras sobre arreglos de numpy: no leen archivos ni conocen el WCS. La
entrada es la pila de planos del campo (docs/contrato-cubo.md, seccion 6): un
coadd por epoca y detector, con NaN donde no hay datos y +Infinity donde la
fuente esta saturada.

1. Cada plano se pasa a unidades de su propio ruido, `(valor - mediana) / sigma`
   con sigma robusta (1,4826 x MAD), para que los seis detectores pesen parecido
   aunque su brillo de fondo sea distinto.
2. La imagen de deteccion es el promedio de esos planos en cada pixel, sobre los
   que tienen un valor finito. Un pixel con menos de la mitad de la cobertura
   maxima no entra: su promedio seria puro ruido.
3. Un pixel cuenta como saturado si lo esta en al menos `min_saturated_planes`
   planos (uno solo puede ser un rayo cosmico que quedo marcado). Cada mancha
   conexa de pixeles saturados es una fuente, ubicada en el centro de la mancha.
   Son las mas brillantes del campo: van primero, de la mancha mas grande a la
   mas chica.
4. Despues van los maximos locales de la imagen de deteccion que superan
   `threshold_sigma` veces su ruido, del mas brillante al mas debil, con el
   centro afinado por el centroide de la luz alrededor del pico.
5. Una fuente se descarta si queda a menos de `min_separation_px` de otra ya
   elegida (o de una posicion de `exclude`), para que las aperturas no se pisen,
   o a menos de `edge_px` del borde, donde la apertura no entraria en los
   recortes. Alrededor de una mancha saturada la distancia se cuenta desde el
   borde de la mancha: sus alas no son otra fuente.

Las posiciones salen en pixeles de la grilla contados desde 0, `(x, y)` con la
fila 0 al sur, como los planos.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray
from scipy import ndimage

# Factor entre la desviacion absoluta mediana y sigma en una distribucion normal.
MAD_TO_SIGMA = 1.4826


@dataclass(frozen=True)
class DetectConfig:
    """Parametros de la deteccion, en pixeles de la grilla del campo (3,075" en el campo de 10')."""

    max_sources: int = 20
    # 7 px de 3,075" son 21,5": mas que dos radios de apertura (2 x 9,2").
    min_separation_px: float = 7.0
    # La apertura (3 px de la grilla) y el aire que pide `covering_cutouts` tienen que entrar.
    edge_px: float = 8.0
    threshold_sigma: float = 5.0
    min_saturated_planes: int = 2
    # Fraccion de la cobertura maxima (planos con valor) que necesita un pixel para entrar.
    min_coverage_fraction: float = 0.5
    # Media ventana del maximo local y del centroide.
    peak_half_px: int = 2

    def __post_init__(self) -> None:
        if self.max_sources < 0 or self.min_separation_px < 0 or self.edge_px < 0:
            raise ValueError("max_sources, min_separation_px y edge_px no pueden ser negativos")
        if self.min_saturated_planes < 1 or self.peak_half_px < 1:
            raise ValueError("min_saturated_planes y peak_half_px deben ser al menos 1")


@dataclass(frozen=True)
class DetectedSource:
    """Una fuente detectada. `peak` es el pico de la imagen de deteccion, en sigmas; infinito si esta saturada."""

    x: float
    y: float
    peak: float
    saturated: bool
    n_saturated_px: int = 0


def _robust_level(values: NDArray) -> tuple[float, float]:
    """Mediana y sigma robusta (1,4826 x MAD) de un conjunto de valores finitos."""
    median = float(np.median(values))
    sigma = MAD_TO_SIGMA * float(np.median(np.abs(values - median)))
    return median, sigma


def detection_image(planes: NDArray, config: DetectConfig | None = None) -> tuple[NDArray, NDArray]:
    """Imagen de deteccion y mascara de saturacion de una pila de planos `(n, ny, nx)`.

    La imagen queda en sigmas de su propio ruido, con NaN donde no hay cobertura
    suficiente. La mascara marca los pixeles saturados en al menos
    `min_saturated_planes` planos (o en todos, si la pila tiene menos).
    """
    config = DetectConfig() if config is None else config
    stack = np.asarray(planes, dtype=np.float64)
    if stack.ndim == 2:
        stack = stack[None, :, :]
    if stack.ndim != 3:
        raise ValueError("los planos tienen que ser una pila (n, ny, nx)")
    saturated_count = np.isposinf(stack).sum(axis=0)
    finite = np.isfinite(stack)

    total = np.zeros(stack.shape[1:], dtype=np.float64)
    count = np.zeros(stack.shape[1:], dtype=np.int64)
    for plane, valid in zip(stack, finite, strict=True):
        if int(valid.sum()) < 16:
            continue
        median, sigma = _robust_level(plane[valid])
        if not sigma > 0:
            continue
        total[valid] += (plane[valid] - median) / sigma
        count[valid] += 1

    image = np.full(stack.shape[1:], np.nan, dtype=np.float64)
    if count.max(initial=0) > 0:
        enough = count >= max(1, math.ceil(config.min_coverage_fraction * int(count.max())))
        image[enough] = total[enough] / count[enough]
        # El promedio de n planos tiene menos ruido que cada uno: se vuelve a normalizar.
        median, sigma = _robust_level(image[enough])
        if sigma > 0:
            image = (image - median) / sigma
    needed = min(config.min_saturated_planes, max(1, stack.shape[0]))
    return image, saturated_count >= needed


def _centroid(image: NDArray, x: int, y: int, half: int) -> tuple[float, float]:
    """Centroide de la luz positiva en la ventana de `half` pixeles alrededor de `(x, y)`."""
    ny, nx = image.shape
    y0, y1 = max(0, y - half), min(ny, y + half + 1)
    x0, x1 = max(0, x - half), min(nx, x + half + 1)
    window = image[y0:y1, x0:x1]
    weights = np.where(np.isfinite(window), window, 0.0)
    # Se resta el minimo de la ventana: el pedestal (alas, fondo) tira el centroide al centro de la ventana.
    weights = np.clip(weights - float(weights.min()), 0.0, None)
    total = float(weights.sum())
    if not total > 0:
        return float(x), float(y)
    ys, xs = np.mgrid[y0:y1, x0:x1]
    return float((weights * xs).sum() / total), float((weights * ys).sum() / total)


def detect_sources(
    planes: NDArray,
    config: DetectConfig | None = None,
    *,
    exclude: Sequence[tuple[float, float]] = (),
) -> list[DetectedSource]:
    """Las fuentes mas brillantes de la pila de planos, de la mas brillante a la mas debil.

    `exclude` son posiciones `(x, y)` ya ocupadas (el objeto con nombre del
    campo): no se devuelve ninguna fuente a menos de `min_separation_px` de ellas.
    """
    config = DetectConfig() if config is None else config
    image, saturated = detection_image(planes, config)
    ny, nx = image.shape
    chosen: list[DetectedSource] = []
    # (x, y, radio de la fuente): la separacion se mide desde el borde de la mancha saturada.
    taken: list[tuple[float, float, float]] = [(float(x), float(y), 0.0) for x, y in exclude]

    def free(x: float, y: float, radius: float = 0.0) -> bool:
        if not (config.edge_px <= x <= nx - 1 - config.edge_px and config.edge_px <= y <= ny - 1 - config.edge_px):
            return False
        return all(
            math.hypot(x - other_x, y - other_y) >= config.min_separation_px + radius + other_radius
            for other_x, other_y, other_radius in taken
        )

    # Manchas saturadas, de la mas grande a la mas chica (vecindad de 8).
    labels, n_blobs = ndimage.label(saturated, structure=np.ones((3, 3), dtype=bool))
    blobs: list[tuple[int, float, float]] = []
    for index in range(1, n_blobs + 1):
        ys, xs = np.nonzero(labels == index)
        blobs.append((int(xs.size), float(xs.mean()), float(ys.mean())))
    blobs.sort(key=lambda blob: (-blob[0], blob[2], blob[1]))
    for n_pixels, x, y in blobs:
        radius = math.sqrt(n_pixels / math.pi)
        if free(x, y, radius) and len(chosen) < config.max_sources:
            chosen.append(DetectedSource(x=x, y=y, peak=math.inf, saturated=True, n_saturated_px=n_pixels))
        # Aunque no entre (borde, o pegada a otra), sus alas no son una fuente aparte.
        taken.append((x, y, radius))

    # Maximos locales de lo no saturado.
    searchable = np.where(np.isfinite(image) & ~saturated, image, -np.inf)
    size = 2 * config.peak_half_px + 1
    is_peak = (searchable == ndimage.maximum_filter(searchable, size=size, mode="constant", cval=-np.inf)) & (
        searchable >= config.threshold_sigma
    )
    ys, xs = np.nonzero(is_peak)
    order = np.argsort(-searchable[ys, xs], kind="stable")
    for index in order:
        if len(chosen) >= config.max_sources:
            break
        peak_x, peak_y = int(xs[index]), int(ys[index])
        x, y = _centroid(searchable, peak_x, peak_y, config.peak_half_px)
        if not free(x, y):
            continue
        chosen.append(DetectedSource(x=x, y=y, peak=float(searchable[peak_y, peak_x]), saturated=False))
        taken.append((x, y, 0.0))
    return chosen
