"""Lista de exposiciones que cubren un punto, por SIA2 de IRSA.

Referencia probada contra el servicio: `sia_query` en spike/irsa.py y
`list_exposures_sia` y `deduplicate` en spike/field.py. Los nombres de columnas
(ObsCore) y los parametros estan citados ahi; no inventar otros.

Pendiente de implementar: por ahora solo estan las firmas.
"""

from __future__ import annotations

from app.config import Settings
from app.domain import ExposureList


def list_exposures(ra: float, dec: float, settings: Settings, refresh: bool = False) -> ExposureList:
    """Exposiciones de nivel 2 de las colecciones de `settings.collections` que cubren el punto.

    - Una consulta SIA2 por coleccion, en VOTable (no CSV: la columna
      `cloud_access` trae comas sin entrecomillar), dentro de
      `limiter.sia_slot()`, con timeout y reintentos (IRSA devuelve 502 de forma
      intermitente).
    - Solo productos `image/science` de nivel 2. Si una exposicion esta en DR1 y
      en QR3, queda la de DR1. Ordenadas por fecha y detector.
    - Cache en `settings.sia_cache_dir`, por centro y coleccion, vigente
      `settings.exposure_list_cache_hours`. Con `refresh=True` se vuelve a
      consultar aunque este vigente.
    - Si IRSA no responde y hay una lista guardada, se devuelve esa con
      `stale=True` (aviso `stale_exposure_list`). Si no hay ninguna, lanza
      `ApiError` `upstream_unavailable`.
    - Si ninguna exposicion cubre el punto, devuelve la lista vacia; quien llama
      decide el `no_coverage`.
    """
    raise NotImplementedError
