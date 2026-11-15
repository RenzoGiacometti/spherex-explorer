"""Estadisticas de un plano, escala de contraste de un detector y regiones saturadas.

Definiciones del contrato (docs/contrato-cubo.md, secciones 5 y 7). Solo numpy.

Valores de un plano: finito = brillo en MJy/sr; NaN = sin datos; +Infinity =
saturado. Las estadisticas se calculan sobre los pixeles finitos y las
fracciones sobre el total de pixeles.
"""

from __future__ import annotations

import math
from collections.abc import Iterable

import numpy as np
from numpy.typing import NDArray

from app.contract import Display, PlaneStats, SaturatedRegion

# Sigma de una gaussiana a partir de la desviacion absoluta mediana.
MAD_TO_SIGMA = 1.4826

# Una region saturada se informa si tiene al menos esta cantidad de pixeles.
MIN_SATURATED_PIXELS = 4

# Ancho minimo de la escala de contraste cuando sigma da 0.
_MIN_SPREAD = 1e-6

_SIGNIFICANT_DIGITS = 6


def _round(value: float, digits: int = _SIGNIFICANT_DIGITS) -> float:
    """Redondea a `digits` cifras significativas, para que los metadatos no arrastren ruido de coma flotante."""
    if value == 0.0 or not math.isfinite(value):
        return float(value)
    return round(value, digits - 1 - math.floor(math.log10(abs(value))))


def robust_stats(values: NDArray[np.floating]) -> tuple[float, float]:
    """Mediana y sigma robusta (1.4826 x MAD) de un arreglo de valores finitos, no vacio."""
    median = float(np.median(values))
    sigma = float(MAD_TO_SIGMA * np.median(np.abs(values - median)))
    return median, sigma


def plane_stats(image: NDArray[np.floating]) -> PlaneStats | None:
    """Estadisticas de un plano (`planes[].stats`). Devuelve `None` si no tiene ningun pixel finito.

    `min`, `max`, `median`, `sigma` y los percentiles 1, 99 y 99.7 salen de los
    pixeles finitos. `valid_fraction` es la fraccion de pixeles finitos y
    `saturated_fraction` la de pixeles en +Infinity, las dos sobre el total.
    """
    total = image.size
    if total == 0:
        return None
    values = image[np.isfinite(image)].astype(np.float64)
    if values.size == 0:
        return None
    median, sigma = robust_stats(values)
    p01, p99, p997 = (float(v) for v in np.percentile(values, [1.0, 99.0, 99.7]))
    return PlaneStats(
        min=_round(float(values.min())),
        max=_round(float(values.max())),
        median=_round(median),
        sigma=_round(sigma),
        p01=_round(p01),
        p99=_round(p99),
        p997=_round(p997),
        valid_fraction=round(values.size / total, 4),
        saturated_fraction=round(int(np.isposinf(image).sum()) / total, 4),
    )


def detector_display(planes: Iterable[NDArray[np.floating]]) -> Display | None:
    """Escala de contraste comun a todas las epocas de un detector (`detectors[].display`).

    Recibe los planos del detector que ya tienen datos, provisorios o
    definitivos. Con todos sus pixeles finitos calcula `median` y `sigma`
    robustos, `vmin = median - 2 sigma` y `vmax = max(p99.7, median + 10 sigma)`.
    Devuelve `None` si no hay ningun pixel finito.
    """
    chunks = [plane[np.isfinite(plane)].ravel() for plane in planes]
    chunks = [chunk for chunk in chunks if chunk.size]
    if not chunks:
        return None
    values = np.concatenate(chunks).astype(np.float64)
    median, sigma = robust_stats(values)
    # Si todos los pixeles valen lo mismo, sigma da 0 y la escala quedaria sin ancho.
    spread = sigma if sigma > 0.0 else max(abs(median) * 1e-3, _MIN_SPREAD)
    p997 = float(np.percentile(values, 99.7))
    return Display(
        vmin=_round(median - 2.0 * spread),
        vmax=_round(max(p997, median + 10.0 * spread)),
        median=_round(median),
        sigma=_round(sigma),
    )


def saturated_regions(image: NDArray[np.floating], min_pixels: int = MIN_SATURATED_PIXELS) -> list[SaturatedRegion]:
    """Regiones saturadas de un plano (`planes[].saturated`).

    Son las componentes conexas de pixeles en +Infinity (vecindad de 8: los
    pixeles que se tocan en diagonal forman una sola region) con al menos
    `min_pixels` pixeles. De cada una: el centro `(x, y)` en pixeles desde 0, el
    radio del circulo de igual area y la cantidad de pixeles. Van de mayor a
    menor.
    """
    mask = np.isposinf(image)
    regions: list[SaturatedRegion] = []
    for rows, cols in _connected_components(mask):
        n = len(rows)
        if n < min_pixels:
            continue
        regions.append(
            SaturatedRegion(
                x=round(sum(cols) / n, 2),
                y=round(sum(rows) / n, 2),
                radius_px=round(math.sqrt(n / math.pi), 2),
                n_pixels=n,
            )
        )
    regions.sort(key=lambda region: (-region.n_pixels, region.y, region.x))
    return regions


def _connected_components(mask: NDArray[np.bool_]) -> list[tuple[list[int], list[int]]]:
    """Componentes conexas de una mascara, con vecindad de 8. Devuelve (filas, columnas) de cada una.

    Recorrido en profundidad sobre una copia de la mascara con un borde de un
    pixel, para no comprobar limites. Las regiones saturadas son chicas (decenas
    de pixeles), asi que alcanza con un recorrido simple.
    """
    if not mask.any():
        return []
    width = mask.shape[1] + 2
    padded = np.pad(mask, 1, constant_values=False).astype(np.uint8)
    pending = bytearray(padded.tobytes())
    neighbors = (-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1)
    components: list[tuple[list[int], list[int]]] = []
    for start in (int(i) for i in np.flatnonzero(padded)):
        if not pending[start]:
            continue
        pending[start] = 0
        stack = [start]
        rows: list[int] = []
        cols: list[int] = []
        while stack:
            index = stack.pop()
            rows.append(index // width - 1)
            cols.append(index % width - 1)
            for offset in neighbors:
                neighbor = index + offset
                if pending[neighbor]:
                    pending[neighbor] = 0
                    stack.append(neighbor)
        components.append((rows, cols))
    return components
