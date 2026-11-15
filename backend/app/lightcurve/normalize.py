"""De medidas por exposicion a una curva de variacion relativa.

Cada exposicion de SPHEREx ve el objeto en otra longitud de onda, asi que dos
medidas distintas pueden diferir porque el objeto cambio o porque el espectro
no es plano. Para separar las dos cosas se comparan solo medidas de longitud de
onda parecida: cada medida se asigna a un canal espectral angosto (los 17
canales de su detector) y se divide por el nivel de su canal.

El nivel de cada canal y el brillo de cada momento se estiman juntos. Las
medidas llegan en tandas: cada vez que el objeto cruza el detector lo barre de
canal en canal en pocos dias, asi que cada canal tiene mas o menos una medida
por tanda. Eso arma una tabla de canales por tandas, y el modelo es

    medida = nivel del canal x brillo relativo de la tanda x ruido

que se ajusta con un pulido de medianas (Tukey): se divide cada canal por su
mediana, despues cada tanda por la suya, y se repite hasta que no cambia. El
primer paso es la normalizacion por la mediana del canal; los siguientes
corrigen que, si el objeto vario, la mediana de un canal depende de en que
tandas se lo observo. Las medianas hacen que una medida mala no arrastre al
resto.

Salidas: el valor relativo de cada medida (medida / nivel del canal), el brillo
relativo de cada tanda con su error, y la dispersion de las medidas alrededor
del modelo, que es el ruido real de una medida.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

MAD_TO_SIGMA = 1.4826
# Error tipico de una mediana respecto del de una media, para muestras normales.
MEDIAN_ERROR_FACTOR = math.sqrt(math.pi / 2.0)


@dataclass(frozen=True)
class RelativeCurve:
    """Resultado de normalizar las medidas de una banda."""

    relative: NDArray[np.float64]  # medida / nivel de su canal; NaN si la medida no entro
    relative_error: NDArray[np.float64]  # error formal de la medida / nivel de su canal
    used: NDArray[np.bool_]  # medidas que entraron al ajuste
    channel_level: dict[int, float]  # nivel de cada canal, en las unidades de la medida
    bin_value: NDArray[np.float64]  # brillo relativo de cada tanda (mediana de sus medidas)
    bin_error: NDArray[np.float64]  # error de ese brillo, de la dispersion real de las medidas
    bin_count: NDArray[np.int64]
    residual_scatter: float  # dispersion robusta de las medidas alrededor del modelo (fraccion)
    iterations: int


def channel_index(wavelength: float, edges: NDArray[np.float64]) -> int:
    """Canal al que pertenece una longitud de onda, dados los bordes de los canales del detector."""
    index = int(np.searchsorted(edges, wavelength, side="right")) - 1
    return min(max(index, 0), edges.size - 2)


def time_bins(mjds: Sequence[float], gap_days: float = 4.0, max_days: float = 12.0) -> list[int]:
    """Tanda (desde 0) de cada fecha: se abre una nueva tras un hueco de `gap_days` o al pasar `max_days`.

    Devuelve un indice por fecha, en el orden recibido; las tandas se numeran en
    orden temporal.
    """
    order = sorted(range(len(mjds)), key=lambda index: (mjds[index], index))
    bins = [0] * len(mjds)
    current = -1
    start = previous = -math.inf
    for index in order:
        mjd = float(mjds[index])
        if mjd - previous > gap_days or mjd - start > max_days:
            current += 1
            start = mjd
        bins[index] = current
        previous = mjd
    return bins


def robust_scatter(values: NDArray[np.float64]) -> float:
    """Dispersion robusta (1,4826 x MAD); NaN con menos de dos valores."""
    finite = values[np.isfinite(values)]
    if finite.size < 2:
        return math.nan
    return MAD_TO_SIGMA * float(np.median(np.abs(finite - np.median(finite))))


def relative_curve(
    values: Sequence[float],
    errors: Sequence[float],
    channels: Sequence[int],
    bins: Sequence[int],
    *,
    min_channel_points: int = 2,
    max_iterations: int = 30,
    tolerance: float = 1e-5,
) -> RelativeCurve:
    """Normaliza las medidas de una banda por canal y devuelve la curva relativa.

    `values` y `errors` son las medidas y su error formal (cualquier unidad,
    positivas); `channels` y `bins`, el canal y la tanda de cada una. Un canal
    con menos de `min_channel_points` medidas no entra: con una sola, su nivel
    seria esa medida y no diria nada. Lo mismo las medidas no positivas.

    El brillo de las tandas queda con mediana 1 (ponderada por cantidad de
    medidas no: la mediana de los valores de tanda), asi que es relativo al
    brillo tipico del periodo observado.
    """
    value = np.asarray(values, dtype=np.float64)
    error = np.asarray(errors, dtype=np.float64)
    channel = np.asarray(channels, dtype=np.int64)
    time_bin = np.asarray(bins, dtype=np.int64)
    if not (value.shape == error.shape == channel.shape == time_bin.shape) or value.ndim != 1:
        raise ValueError("values, errors, channels y bins deben ser listas del mismo largo")
    n_bins = int(time_bin.max()) + 1 if time_bin.size else 0

    with np.errstate(invalid="ignore"):
        used = np.isfinite(value) & np.isfinite(error) & (value > 0) & (error > 0)
    for item in np.unique(channel[used]) if used.any() else []:
        members = used & (channel == item)
        if int(np.count_nonzero(members)) < min_channel_points:
            used &= ~members

    log_value = np.full(value.shape, np.nan)
    log_value[used] = np.log(value[used])
    level: dict[int, float] = {int(item): 0.0 for item in np.unique(channel[used])} if used.any() else {}
    bin_log = np.zeros(n_bins, dtype=np.float64)
    iterations = 0
    for iterations in range(1, max_iterations + 1):  # noqa: B007
        change = 0.0
        # Paso de canales: nivel = mediana de (medida / brillo de su tanda).
        for item in level:
            members = used & (channel == item)
            updated = float(np.median(log_value[members] - bin_log[time_bin[members]]))
            change = max(change, abs(updated - level[item]))
            level[item] = updated
        # Paso de tandas: brillo = mediana de (medida / nivel de su canal).
        level_of = np.array([level.get(int(item), np.nan) for item in channel])
        for index in range(n_bins):
            members = used & (time_bin == index)
            if not members.any():
                continue
            updated = float(np.median(log_value[members] - level_of[members]))
            change = max(change, abs(updated - bin_log[index]))
            bin_log[index] = updated
        # La escala comun va a los canales: la mediana del brillo de las tandas con datos queda en 1.
        occupied = np.array([bool((used & (time_bin == index)).any()) for index in range(n_bins)])
        if occupied.any():
            shift = float(np.median(bin_log[occupied]))
            bin_log[occupied] -= shift
            for item in level:
                level[item] += shift
        if change < tolerance:
            break

    level_of = np.array([level.get(int(item), np.nan) for item in channel])
    relative = np.full(value.shape, np.nan)
    relative_error = np.full(value.shape, np.nan)
    relative[used] = np.exp(log_value[used] - level_of[used])
    relative_error[used] = error[used] / np.exp(level_of[used])

    residual = np.full(value.shape, np.nan)
    residual[used] = log_value[used] - level_of[used] - bin_log[time_bin[used]]
    scatter = robust_scatter(residual[used]) if used.any() else math.nan

    bin_value = np.full(n_bins, np.nan)
    bin_error = np.full(n_bins, np.nan)
    bin_count = np.zeros(n_bins, dtype=np.int64)
    for index in range(n_bins):
        members = used & (time_bin == index)
        count = int(np.count_nonzero(members))
        bin_count[index] = count
        if count == 0:
            continue
        bin_value[index] = math.exp(bin_log[index])
        # Error de la mediana, con la dispersion real de las medidas (no la formal).
        spread = scatter if math.isfinite(scatter) and scatter > 0 else float(np.median(relative_error[members]))
        bin_error[index] = bin_value[index] * MEDIAN_ERROR_FACTOR * spread / math.sqrt(count)
    return RelativeCurve(
        relative=relative,
        relative_error=relative_error,
        used=used,
        channel_level={item: math.exp(value_) for item, value_ in level.items()},
        bin_value=bin_value,
        bin_error=bin_error,
        bin_count=bin_count,
        residual_scatter=scatter,
        iterations=iterations,
    )
