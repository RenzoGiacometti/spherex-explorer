"""Descarga de un recorte de IRSA, leyendo la respuesta de a un HDU (contrato, seccion 9).

Referencia probada contra el servicio: `cutout_url`, `_read_until` y
`fetch_cutout` en spike/irsa.py. Diferencias con el spike:

- Aca se hace UN intento por llamada. Los reintentos, la espera de
  `Retry-After` y la segunda pasada los decide el planificador
  (app/jobs/manager.py), para que una conexion en espera quede libre.
- Las extensiones se identifican por `EXTNAME`, no por posicion: se lee hasta
  juntar IMAGE, FLAGS, VARIANCE y ZODI y ahi se corta la conexion. Si el flujo
  termina sin las cuatro o un encabezado no se puede interpretar, se baja la
  respuesta completa y se abre con astropy (modo `full`).

Pendiente de implementar: por ahora solo estan las firmas y las excepciones.
"""

from __future__ import annotations

from app.config import Settings
from app.domain import CutoutFile, Exposure


class IrsaError(Exception):
    """Fallo al pedir un recorte a IRSA."""


class IrsaBusy(IrsaError):
    """IRSA respondio 503 o 429. `retry_after` son los segundos que pide esperar antes de reintentar."""

    def __init__(self, message: str, retry_after: float = 0.0) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class IrsaTransient(IrsaError):
    """Corte de conexion, timeout, 5xx sin `Retry-After` o FITS truncado: tiene sentido reintentar."""


class IrsaPermanent(IrsaError):
    """Respuesta 4xx (por ejemplo 422 "Arrays do not overlap."): reintentar no la arregla."""


def cutout_url(exposure: Exposure, ra: float, dec: float, side_deg: float) -> str:
    """URL del recorte: `<access_url>?center=<ra>,<dec>d&size=<lado>`.

    Formato verificado contra el servicio en la Etapa 0 (spike/RESULTADOS.md,
    seccion 2): `size` sin unidad esta en grados y la unidad de `center` va una
    sola vez, despues del segundo valor.
    """
    raise NotImplementedError


def fetch_cutout(exposure: Exposure, ra: float, dec: float, side_deg: float, settings: Settings) -> CutoutFile:
    """Deja en la cache de disco el recorte de una exposicion y devuelve donde quedo. Hace UN intento.

    - Si el recorte ya esta en `settings.cutout_cache_dir` (clave: exposicion,
      centro y lado), lo devuelve con `from_cache=True` sin tocar la red.
    - Si no, lo pide dentro de `limiter.cutout_slot()`, con timeout, y lee la
      respuesta de a un HDU hasta tener IMAGE, FLAGS, VARIANCE y ZODI
      (`mode="truncated"`). Si eso falla por el formato, baja la respuesta
      completa (`mode="full"`) y guarda todo menos EPSF.
    - Valida que las cuatro extensiones tengan la misma forma y escribe el
      archivo de forma atomica.

    Excepciones: `IrsaBusy(retry_after)` para 503 y 429, `IrsaTransient` para
    cortes y timeouts, `IrsaPermanent` para 4xx.
    """
    raise NotImplementedError
