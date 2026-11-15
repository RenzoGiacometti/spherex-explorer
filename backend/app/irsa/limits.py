"""Limite global de conexiones hacia IRSA (contrato, seccion 10).

Los limites valen para todo el backend, sumando todos los trabajos: 10
descargas de recortes y 2 consultas SIA2 a la vez. Las descargas corren en
hilos, asi que el limitador se basa en semaforos de `threading`.

El limite es por proceso: si el backend corre con varios procesos (por ejemplo
`uvicorn --workers 2`), cada uno tiene su propio cupo y el total hacia IRSA se
multiplica. Hay que correrlo con un solo proceso.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager

from app.config import IRSA_MAX_PARALLEL_DOWNLOADS, Settings


class IrsaLimiter:
    """Dos semaforos: uno para recortes y otro para consultas SIA2.

    Uso previsto:

        with limiter.cutout_slot():
            ...  # una descarga de recorte

    Mientras un recorte espera por un `Retry-After` no tiene que ocupar lugar:
    quien llama sale del bloque `with` antes de esperar.
    """

    def __init__(self, max_cutouts: int = 10, max_sia: int = 2) -> None:
        """Crea los semaforos con esos cupos. `max_cutouts` nunca supera 10 (CLAUDE.md)."""
        self.max_cutouts = max(1, min(int(max_cutouts), IRSA_MAX_PARALLEL_DOWNLOADS))
        self.max_sia = max(1, int(max_sia))
        self._cutouts = threading.BoundedSemaphore(self.max_cutouts)
        self._sia = threading.BoundedSemaphore(self.max_sia)
        self._count_lock = threading.Lock()
        self._in_flight = {"cutouts": 0, "sia": 0}

    def cutout_slot(self) -> AbstractContextManager[None]:
        """Gestor de contexto que ocupa un lugar de descarga de recorte; bloquea hasta que haya uno libre."""
        return self._slot(self._cutouts, "cutouts")

    def sia_slot(self) -> AbstractContextManager[None]:
        """Gestor de contexto que ocupa un lugar de consulta SIA2; bloquea hasta que haya uno libre."""
        return self._slot(self._sia, "sia")

    @property
    def cutouts_in_flight(self) -> int:
        """Descargas de recortes en curso en este momento, para diagnostico y tests."""
        with self._count_lock:
            return self._in_flight["cutouts"]

    @property
    def sia_in_flight(self) -> int:
        """Consultas SIA2 en curso en este momento, para diagnostico y tests."""
        with self._count_lock:
            return self._in_flight["sia"]

    @contextmanager
    def _slot(self, semaphore: threading.BoundedSemaphore, kind: str) -> Iterator[None]:
        semaphore.acquire()
        with self._count_lock:
            self._in_flight[kind] += 1
        try:
            yield
        finally:
            with self._count_lock:
                self._in_flight[kind] -= 1
            semaphore.release()


_limiter: IrsaLimiter | None = None
_limiter_lock = threading.Lock()


def get_limiter(settings: Settings) -> IrsaLimiter:
    """Devuelve el limitador unico del proceso, creado con los cupos de `settings` la primera vez.

    Todos los trabajos comparten la misma instancia: es lo que hace que el limite sea global.
    Las llamadas siguientes devuelven esa misma instancia aunque `settings` traiga otros cupos.
    """
    global _limiter
    with _limiter_lock:
        if _limiter is None:
            _limiter = IrsaLimiter(max_cutouts=settings.max_cutout_downloads, max_sia=settings.max_sia_queries)
        return _limiter


def reset_limiter() -> None:
    """Olvida el limitador del proceso: el proximo `get_limiter` crea uno nuevo.

    Es para los tests que necesitan otros cupos. No hay que llamarlo con
    descargas en curso: las que ya ocupan un lugar siguen contando en la
    instancia anterior y el limite dejaria de ser global.
    """
    global _limiter
    with _limiter_lock:
        _limiter = None
