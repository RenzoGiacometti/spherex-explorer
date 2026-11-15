"""Limite global de conexiones hacia IRSA (contrato, seccion 10).

Los limites valen para todo el backend, sumando todos los trabajos: 10
descargas de recortes y 2 consultas SIA2 a la vez. Las descargas corren en
hilos, asi que el limitador se basa en semaforos de `threading`.

Pendiente de implementar: por ahora solo estan las firmas.
"""

from __future__ import annotations

from contextlib import AbstractContextManager

from app.config import Settings


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
        raise NotImplementedError

    def cutout_slot(self) -> AbstractContextManager[None]:
        """Gestor de contexto que ocupa un lugar de descarga de recorte; bloquea hasta que haya uno libre."""
        raise NotImplementedError

    def sia_slot(self) -> AbstractContextManager[None]:
        """Gestor de contexto que ocupa un lugar de consulta SIA2; bloquea hasta que haya uno libre."""
        raise NotImplementedError

    @property
    def cutouts_in_flight(self) -> int:
        """Descargas de recortes en curso en este momento, para diagnostico y tests."""
        raise NotImplementedError


def get_limiter(settings: Settings) -> IrsaLimiter:
    """Devuelve el limitador unico del proceso, creado con los cupos de `settings` la primera vez.

    Todos los trabajos comparten la misma instancia: es lo que hace que el limite sea global.
    """
    raise NotImplementedError
