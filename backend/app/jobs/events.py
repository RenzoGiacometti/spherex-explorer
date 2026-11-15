"""Eventos SSE de un campo (contrato, seccion 4.2).

Cada evento lleva `event`, `id` (entero creciente dentro del trabajo) y `data`
(JSON en una linea). Los trabajos publican desde hilos; los flujos SSE consumen
desde el bucle de asyncio.

Pendiente de implementar: por ahora solo estan las firmas.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from typing import Any

from app.contract import EventName

# Comentario que se manda tras 15 s sin eventos, para que la conexion no se corte.
PING = b": ping\n\n"


@dataclass(frozen=True)
class FieldEvent:
    """Un evento ya numerado. `data` es el JSON del contrato para ese evento, listo para serializar."""

    id: int
    event: EventName
    data: Mapping[str, Any]


def encode_sse(event: FieldEvent) -> bytes:
    """Bytes del evento en formato `text/event-stream`.

    Tres lineas (`event:`, `id:` y `data:` con el JSON en una sola linea, sin
    NaN ni infinito) y una linea en blanco.
    """
    raise NotImplementedError


class EventBus:
    """Reparte los eventos de cada campo a los flujos SSE conectados.

    No guarda historial: no hay repeticion de eventos perdidos. Quien se
    conecta tarde recibe primero un `state` (lo arma `JobManager.subscribe`) y
    despues solo lo nuevo.
    """

    def __init__(self) -> None:
        """Crea el bus vacio."""
        raise NotImplementedError

    def publish(self, field_id: str, event: EventName, data: Mapping[str, Any]) -> FieldEvent:
        """Numera el evento con el siguiente id del campo y lo entrega a todos los suscriptores.

        Se puede llamar desde cualquier hilo. No bloquea: un suscriptor lento no
        frena al trabajo.
        """
        raise NotImplementedError

    def last_id(self, field_id: str) -> int:
        """Id del ultimo evento publicado para el campo, o 0 si no hubo ninguno."""
        raise NotImplementedError

    def subscribe(self, field_id: str) -> AsyncIterator[FieldEvent]:
        """Iterador asincrono con los eventos del campo publicados desde este momento.

        Termina despues de entregar `done` o `error`, o cuando se llama a `close`.
        """
        raise NotImplementedError

    def close(self, field_id: str) -> None:
        """Termina los flujos abiertos del campo y libera su estado."""
        raise NotImplementedError
