"""Lo que un trabajo usa de afuera: IRSA, hips2fits, el pipeline, el reloj y la espera.

`JobManager` recibe un `JobDeps` opcional. Por defecto trae las funciones
reales; los tests pasan otras para correr sin red y sin esperas de verdad.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from app.config import Settings
from app.contract import utc_timestamp
from app.domain import CutoutFile, Exposure, ExposureList, Grid, PreviewImage, ReprojectedExposure
from app.irsa.cutouts import discard_cutout, fetch_cutout, prune_cutout_cache
from app.irsa.sia import list_exposures_parallel
from app.pipeline.exposure import load_exposure
from app.preview.hips2fits import fetch_preview


def wait_on(condition: threading.Condition, timeout: float | None) -> None:
    """Espera sobre una condicion ya tomada hasta que la avisen o pasen `timeout` segundos."""
    condition.wait(timeout)


@dataclass(frozen=True)
class JobDeps:
    """Funciones que usa un trabajo, con la firma de las reales.

    - `list_exposures(ra, dec, settings, refresh)`: `app.irsa.sia.list_exposures_parallel`.
      Toma por su cuenta el cupo de consultas SIA2.
    - `fetch_cutout(exposure, ra, dec, side_deg, settings)`:
      `app.irsa.cutouts.fetch_cutout`. Un intento; toma por su cuenta el cupo
      global de descargas (`get_limiter(settings).cutout_slot()`) mientras baja.
    - `discard_cutout(path, settings)` y `prune_cutout_cache(settings)`: la
      cache de recortes.
    - `fetch_preview(grid, band, settings)`: `app.preview.hips2fits.fetch_preview`.
    - `load_exposure(path, grid)`: `app.pipeline.exposure.load_exposure`.
    - `clock()`: segundos de un reloj que solo avanza. Con el se miden
      `elapsed_s`, el tope de eventos `progress` y las esperas de los reintentos.
    - `wait(condition, timeout)`: lo que hace un hilo de descarga cuando no
      tiene nada listo; `timeout` es lo que falta, segun `clock`, para el
      proximo reintento (`None` si no hay ninguno pendiente). Se llama con la
      condicion tomada.
    - `timestamp()`: fecha y hora UTC con el formato del contrato, para
      `provenance.built_at`.
    """

    list_exposures: Callable[[float, float, Settings, bool], ExposureList] = list_exposures_parallel
    fetch_cutout: Callable[[Exposure, float, float, float, Settings], CutoutFile] = fetch_cutout
    discard_cutout: Callable[[Path, Settings], bool] = discard_cutout
    prune_cutout_cache: Callable[[Settings], object] = prune_cutout_cache
    fetch_preview: Callable[[Grid, int, Settings], PreviewImage] = fetch_preview
    load_exposure: Callable[[Path, Grid], ReprojectedExposure] = load_exposure
    # `perf_counter` y no `monotonic`, que en Windows avanza de a 16 ms.
    clock: Callable[[], float] = time.perf_counter
    wait: Callable[[threading.Condition, float | None], object] = wait_on
    timestamp: Callable[[], str] = utc_timestamp
