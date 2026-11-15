"""Vista provisoria: recorte de WISE de la misma zona, pedido a hips2fits de CDS (contrato, seccion 4.10).

El backend lo pide al crear el trabajo, en paralelo con la lista de
exposiciones, y lo guarda con el campo (`preview.f32`). Si hips2fits no responde
en `settings.preview_timeout_s`, la vista se descarta y el campo sigue igual.

Los parametros de hips2fits y los identificadores HiPS de WISE no estan
verificados todavia: hay que tomarlos de la documentacion del servicio y de la
lista de HiPS de CDS, y citar la fuente en un comentario. No inventarlos.

Pendiente de implementar: `fetch_preview`. `preview_band` ya esta, porque
tambien la usa el servidor falso.
"""

from __future__ import annotations

from typing import Literal

from app.config import Settings
from app.domain import Grid, PreviewImage


class PreviewUnavailable(Exception):
    """hips2fits no respondio a tiempo o devolvio algo que no sirve. No es un error del campo."""


def preview_band(band: int) -> tuple[Literal["W1", "W2"], float]:
    """Banda de WISE para la vista provisoria y su longitud de onda en micrones.

    W1 (3.4 um), o W2 (4.6 um) si el detector pedido es 5 o 6 (contrato,
    seccion 4.10). La vista se pide una sola vez, al crear el trabajo: queda con
    la banda de ese primer pedido aunque despues la persona cambie de banda.
    """
    return ("W2", 4.6) if band in (5, 6) else ("W1", 3.4)


def fetch_preview(grid: Grid, band: int, settings: Settings) -> PreviewImage:
    """Pide a hips2fits un recorte de WISE con la grilla del campo.

    - Misma proyeccion, centro, escala y forma que `grid`, para que el
      resultado tenga el formato de un plano: Float32 de `grid.shape`, fila 0 =
      sur, `NaN` sin datos. Los valores quedan en las unidades del relevamiento.
    - Banda segun `preview_band(band)`.
    - Un solo pedido, con timeout `settings.preview_timeout_s`. Se consulta
      desde el backend, nunca desde el navegador.

    Lanza `PreviewUnavailable` si el servicio no responde a tiempo o la
    respuesta no se puede interpretar.
    """
    raise NotImplementedError
