"""Agrupacion de exposiciones en epocas (contrato, seccion 2).

Una epoca es una pasada del relevamiento: exposiciones separadas por mas de 60
dias caen en epocas distintas. Referencia: `assign_epochs` en spike/field.py.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

from app.domain import EpochAssignment, EpochSummary, Exposure

EPOCH_GAP_DAYS = 60.0


def assign_epochs(exposures: Sequence[Exposure], gap_days: float = EPOCH_GAP_DAYS) -> EpochAssignment:
    """Asigna una epoca a cada exposicion y resume cada epoca.

    Ordena por `mjd_start` y abre una epoca nueva cada vez que el hueco con la
    exposicion anterior supera `gap_days`. Las epocas se numeran desde 1 en
    orden temporal.

    Devuelve `indices` (la epoca de cada exposicion, en el mismo orden en que se
    recibieron) y `epochs` (por epoca: inicio, fin y media de `mjd_start`, y
    cantidad de exposiciones). Con la lista vacia devuelve las dos vacias.

    Un hueco de exactamente `gap_days` no separa: hace falta que lo supere. Una
    epoca puede durar menos de un dia, y con una sola exposicion su inicio, su
    fin y su media coinciden. Lanza `ValueError` si `gap_days` es negativo o no
    es un numero, o si alguna exposicion no tiene una fecha finita.
    """
    if not math.isfinite(gap_days) or gap_days < 0:
        raise ValueError(f"gap_days={gap_days!r}: tiene que ser un numero finito, no negativo")
    times = [float(exposure.mjd_start) for exposure in exposures]
    for position, mjd in enumerate(times):
        if not math.isfinite(mjd):
            raise ValueError(f"la exposicion {exposures[position].obs_id!r} no tiene una fecha finita: {mjd!r}")

    # Orden temporal; a igual fecha se respeta el orden de entrada.
    order = sorted(range(len(times)), key=lambda position: (times[position], position))
    indices = [0] * len(times)
    members: list[list[float]] = []
    previous: float | None = None
    for position in order:
        mjd = times[position]
        if previous is None or mjd - previous > gap_days:
            members.append([])
        members[-1].append(mjd)
        indices[position] = len(members)
        previous = mjd

    epochs = [
        EpochSummary(
            epoch=number,
            mjd_start=mjds[0],
            mjd_end=mjds[-1],
            # `fsum` no depende del orden de los sumandos; el recorte evita que el redondeo saque la media del rango.
            mjd_mean=min(max(math.fsum(mjds) / len(mjds), mjds[0]), mjds[-1]),
            n_exposures=len(mjds),
        )
        for number, mjds in enumerate(members, start=1)
    ]
    return EpochAssignment(indices=indices, epochs=epochs)
