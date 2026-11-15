"""Orden de descarga de un campo y politica de reintentos (contrato, secciones 8 y 9).

Orden (seccion 8): primero los planos de la banda pedida, despues las demas
bandas de la mas cercana a la mas lejana. Dentro de una banda las epocas
avanzan a la vez: el primer recorte de cada una, despues el segundo de cada
una, y asi.

Nada de aca usa candados: `TaskQueue` la protege quien la usa (el candado del
gestor de trabajos).
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Literal

from app.config import Settings
from app.domain import Exposure
from app.irsa.cutouts import IrsaBusy, IrsaPermanent

Key = tuple[int, int]  # (epoca, detector)

# Intentos por recorte en la segunda pasada: uno, y otro mas si IRSA vuelve a pedir que se espere.
SECOND_PASS_ATTEMPTS = 2
# Espera antes de reintentar tras un corte o un timeout: crece con cada intento hasta el tope.
TRANSIENT_WAIT_S = 1.0
TRANSIENT_WAIT_MAX_S = 10.0

# Por que un recorte se dio por perdido en una pasada.
# - `transient`: se agotaron los intentos por causas pasajeras; entra en la segunda pasada.
# - `busy_too_long`: IRSA pidio esperar mas que el maximo que se respeta; no se insiste en este trabajo.
# - `permanent`: IRSA lo rechazo (4xx), o el archivo no sirve; reintentar no lo arregla.
FailureKind = Literal["transient", "busy_too_long", "permanent"]


@dataclass(eq=False)
class CutoutTask:
    """El recorte de una exposicion dentro de un trabajo."""

    job: Any  # el `FieldJob` al que pertenece
    index: int  # posicion de la exposicion en la lista del trabajo
    exposure: Exposure
    key: Key
    order: int  # posicion dentro de su plano, por fecha: 0, 1, 2...
    budget: int = 1  # intentos permitidos en la pasada actual
    attempts: int = 0  # intentos hechos en la pasada actual
    not_before: float = 0.0  # segun el reloj del gestor: no se pide antes de ese momento
    second_pass: bool = False
    refetched: bool = False  # ya se descarto de la cache una vez por ilegible
    error: str = ""

    def restart(self, budget: int, *, second_pass: bool | None = None) -> None:
        """Deja el recorte listo para pedirlo otra vez, con `budget` intentos."""
        self.budget = max(1, int(budget))
        self.attempts = 0
        self.not_before = 0.0
        if second_pass is not None:
            self.second_pass = second_pass


def band_order(band: int) -> list[int]:
    """Detectores en el orden en que se construyen: el pedido y despues del mas cercano al mas lejano."""
    return sorted(range(1, 7), key=lambda detector: (abs(detector - band), detector))


def task_order(band: int) -> Callable[[CutoutTask], tuple[int, int, int, int]]:
    """Clave de orden de un recorte cuando la banda prioritaria es `band`."""
    return lambda task: (abs(task.key[1] - band), task.key[1], task.order, task.key[0])


class TaskQueue:
    """Recortes de un trabajo que todavia no se pidieron o que esperan para reintentar.

    Siempre ordenada por `task_order(band)`. Un recorte con `not_before` en el
    futuro (espera de `Retry-After`) no se entrega, pero tampoco frena a los
    que vienen despues: mientras espera, su conexion la usa otro.
    """

    def __init__(self, band: int) -> None:
        self.band = band
        self._tasks: list[CutoutTask] = []

    def __len__(self) -> int:
        return len(self._tasks)

    def add(self, tasks: Iterable[CutoutTask]) -> None:
        self._tasks.extend(tasks)
        self._tasks.sort(key=task_order(self.band))

    def reprioritize(self, band: int) -> None:
        """Cambia la banda prioritaria y reordena lo pendiente."""
        self.band = band
        self._tasks.sort(key=task_order(band))

    def pop_ready(self, now: float) -> CutoutTask | None:
        """Saca el primer recorte, en orden, que ya se puede pedir. `None` si no hay ninguno."""
        for position, task in enumerate(self._tasks):
            if task.not_before <= now:
                del self._tasks[position]
                return task
        return None

    def next_due(self) -> float | None:
        """Momento en que queda listo el recorte en espera que vence antes; `None` si la cola esta vacia."""
        return min((task.not_before for task in self._tasks), default=None)

    def clear(self) -> None:
        self._tasks.clear()


@dataclass(frozen=True)
class Retry:
    """Hay que volver a pedir el recorte despues de `wait_s` segundos."""

    wait_s: float


@dataclass(frozen=True)
class GiveUp:
    """El recorte se da por perdido en esta pasada."""

    kind: FailureKind


def after_failure(task: CutoutTask, error: BaseException, settings: Settings) -> Retry | GiveUp:
    """Que hacer con un recorte cuyo intento numero `task.attempts` fallo con `error`.

    - `IrsaBusy`: se espera `retry_after` (ya acotado por `fetch_cutout`). Si
      IRSA pidio mas que `settings.irsa_retry_after_max_s`, el recorte se da por
      fallido en este trabajo en vez de insistir antes de tiempo (contrato,
      seccion 9).
    - `IrsaPermanent`: no se reintenta.
    - Cualquier otra falla (`IrsaTransient`: corte, timeout, FITS truncado) se
      reintenta con una espera corta.

    En todos los casos, hasta `task.budget` intentos.
    """
    if isinstance(error, IrsaPermanent):
        return GiveUp("permanent")
    if isinstance(error, IrsaBusy):
        if error.requested is not None and error.requested > max(0.0, settings.irsa_retry_after_max_s):
            return GiveUp("busy_too_long")
        wait_s = max(0.0, float(error.retry_after))
    else:
        wait_s = min(TRANSIENT_WAIT_S * task.attempts, TRANSIENT_WAIT_MAX_S)
    if task.attempts >= task.budget:
        return GiveUp("transient")
    return Retry(wait_s)
