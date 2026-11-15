"""Agrupacion de exposiciones en epocas (contrato, seccion 2).

Una epoca es una pasada del relevamiento: exposiciones separadas por mas de 60
dias caen en epocas distintas. Referencia: `assign_epochs` en spike/field.py.

Pendiente de implementar: por ahora solo esta la firma.
"""

from __future__ import annotations

from collections.abc import Sequence

from app.domain import EpochAssignment, Exposure

EPOCH_GAP_DAYS = 60.0


def assign_epochs(exposures: Sequence[Exposure], gap_days: float = EPOCH_GAP_DAYS) -> EpochAssignment:
    """Asigna una epoca a cada exposicion y resume cada epoca.

    Ordena por `mjd_start` y abre una epoca nueva cada vez que el hueco con la
    exposicion anterior supera `gap_days`. Las epocas se numeran desde 1 en
    orden temporal.

    Devuelve `indices` (la epoca de cada exposicion, en el mismo orden en que se
    recibieron) y `epochs` (por epoca: inicio, fin y media de `mjd_start`, y
    cantidad de exposiciones). Con la lista vacia devuelve las dos vacias.
    """
    raise NotImplementedError
