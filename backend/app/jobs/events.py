"""Eventos SSE de un campo (contrato, seccion 4.2).

Cada evento lleva `event`, `id` (entero creciente dentro del trabajo) y `data`
(JSON en una linea). Los trabajos publican desde hilos; los flujos SSE consumen
desde el bucle de asyncio.

Como se reparten:

- `EventBus.publish` numera el evento y lo deja en la cola de cada suscriptor
  del campo. No espera a nadie: quien publica no se frena por un flujo lento.
- Cada suscriptor guarda como mucho `max_pending` eventos sin leer. Dos
  `progress` seguidos sin leer se funden en el ultimo, que trae lo mismo y mas.
  Si aun asi se llena, al suscriptor se le descarta lo pendiente y su flujo
  termina con `lagged` en verdadero: `JobManager.subscribe` le manda entonces
  un `state` nuevo, que reemplaza todo lo anterior (el contrato no repite
  eventos perdidos). Asi un navegador que se fue sin cerrar no acumula memoria.
- No hay historial: quien se suscribe recibe solo lo publicado desde ese
  momento.
"""

from __future__ import annotations

import asyncio
import json
import threading
from collections import deque
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from typing import Any

from app.contract import EventName

# Comentario que se manda tras 15 s sin eventos, para que la conexion no se corte.
PING = b": ping\n\n"

# Eventos despues de los cuales el servidor cierra el flujo.
CLOSING_EVENTS: frozenset[str] = frozenset({"done", "error"})

# Eventos sin leer que se le guardan a cada suscriptor. Un campo de 539
# exposiciones publica unos 50 eventos `plane` y algunos avisos; los `progress`
# no se acumulan.
DEFAULT_MAX_PENDING = 256


@dataclass(frozen=True)
class FieldEvent:
    """Un evento ya numerado. `data` es el JSON del contrato para ese evento, listo para serializar."""

    id: int
    event: EventName
    data: Mapping[str, Any]


def encode_sse(event: FieldEvent) -> bytes:
    """Bytes del evento en formato `text/event-stream`.

    Tres lineas (`event:`, `id:` y `data:` con el JSON en una sola linea, sin
    NaN ni infinito) y una linea en blanco. Lanza `ValueError` si `data` trae
    un NaN o un infinito: JSON no los admite y el navegador no podria leerlo.
    """
    data = event.data if isinstance(event.data, dict) else dict(event.data)
    # `json.dumps` escapa los saltos de linea de los textos, asi que el resultado es una sola linea.
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return f"event: {event.event}\nid: {event.id}\ndata: {payload}\n\n".encode()


def _resolve(waiter: asyncio.Future[None]) -> None:
    if not waiter.done():
        waiter.set_result(None)


class Subscription:
    """Flujo de eventos de un suscriptor: un iterador asincrono con una cola acotada.

    Se crea con `EventBus.subscribe` y queda anotado desde ese momento, aunque
    todavia nadie lo recorra. Termina despues de entregar `done` o `error`,
    cuando el bus cierra el campo o cuando se atrasa (`lagged`). Quien deja de
    leerlo antes del final llama a `close()`.
    """

    def __init__(self, bus: EventBus, field_id: str, max_pending: int) -> None:
        self.field_id = field_id
        # True si el flujo termino porque el suscriptor no leia: se perdieron eventos.
        self.lagged = False
        self._bus = bus
        self._max_pending = max(1, int(max_pending))
        self._pending: deque[FieldEvent] = deque()
        self._lock = threading.Lock()
        self._ended = False  # no van a llegar mas eventos; lo pendiente todavia se entrega
        self._waiter: asyncio.Future[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def __aiter__(self) -> Subscription:
        return self

    async def __anext__(self) -> FieldEvent:
        while True:
            with self._lock:
                if self._pending:
                    return self._pending.popleft()
                if self._ended:
                    raise StopAsyncIteration
                loop = asyncio.get_running_loop()
                waiter: asyncio.Future[None] = loop.create_future()
                self._waiter, self._loop = waiter, loop
            try:
                await waiter
            finally:
                with self._lock:
                    if self._waiter is waiter:
                        self._waiter = None

    @property
    def pending(self) -> int:
        """Eventos sin leer en este momento."""
        with self._lock:
            return len(self._pending)

    def close(self) -> None:
        """El suscriptor se va: deja de recibir eventos y descarta lo pendiente."""
        self._bus._remove(self)
        with self._lock:
            self._ended = True
            self._pending.clear()
            self._wake()

    async def aclose(self) -> None:
        self.close()

    # ------------------------------------------------- lo que llama el bus

    def _offer(self, event: FieldEvent) -> bool:
        """Deja un evento en la cola. Devuelve False si el suscriptor ya no tiene que recibir mas."""
        with self._lock:
            if self._ended:
                return False
            if event.event == "progress" and self._pending and self._pending[-1].event == "progress":
                # El `progress` mas nuevo reemplaza al que nadie leyo todavia.
                self._pending[-1] = event
            elif len(self._pending) >= self._max_pending:
                # No lee: se le descarta todo. `JobManager.subscribe` lo vuelve a poner al dia con un `state`.
                self._pending.clear()
                self.lagged = True
                self._ended = True
            else:
                self._pending.append(event)
                if event.event in CLOSING_EVENTS:
                    self._ended = True
            self._wake()
            return not self._ended

    def _finish(self) -> None:
        """El bus cerro el campo: se entrega lo pendiente y el flujo termina."""
        with self._lock:
            self._ended = True
            self._wake()

    def _wake(self) -> None:
        """Despierta al consumidor si esta esperando. Se llama con el candado tomado, desde cualquier hilo."""
        waiter, loop = self._waiter, self._loop
        self._waiter = None
        if waiter is None or loop is None:
            return
        try:
            loop.call_soon_threadsafe(_resolve, waiter)
        except RuntimeError:
            # El bucle del consumidor ya se cerro: no hay a quien entregarle nada.
            self._ended = True
            self._pending.clear()


class EventBus:
    """Reparte los eventos de cada campo a los flujos SSE conectados.

    No guarda historial: no hay repeticion de eventos perdidos. Quien se
    conecta tarde recibe primero un `state` (lo arma `JobManager.subscribe`) y
    despues solo lo nuevo.
    """

    def __init__(self, max_pending: int = DEFAULT_MAX_PENDING) -> None:
        """Crea el bus vacio. `max_pending` es el tope de eventos sin leer por suscriptor."""
        self._max_pending = max(1, int(max_pending))
        self._lock = threading.Lock()
        self._last_ids: dict[str, int] = {}
        self._subscriptions: dict[str, list[Subscription]] = {}

    def publish(self, field_id: str, event: EventName, data: Mapping[str, Any]) -> FieldEvent:
        """Numera el evento con el siguiente id del campo y lo entrega a todos los suscriptores.

        Se puede llamar desde cualquier hilo. No bloquea: un suscriptor lento no
        frena al trabajo.
        """
        with self._lock:
            event_id = self._last_ids.get(field_id, 0) + 1
            self._last_ids[field_id] = event_id
            item = FieldEvent(id=event_id, event=event, data=data)
            # Se entrega con el candado tomado para que cada cola reciba los eventos en el orden de sus ids.
            subscriptions = self._subscriptions.get(field_id)
            if subscriptions:
                kept = [subscription for subscription in subscriptions if subscription._offer(item)]
                if kept:
                    self._subscriptions[field_id] = kept
                else:
                    del self._subscriptions[field_id]
        return item

    def last_id(self, field_id: str) -> int:
        """Id del ultimo evento publicado para el campo, o 0 si no hubo ninguno."""
        with self._lock:
            return self._last_ids.get(field_id, 0)

    def subscribe(self, field_id: str, max_pending: int | None = None) -> AsyncIterator[FieldEvent]:
        """Iterador asincrono con los eventos del campo publicados desde este momento.

        Termina despues de entregar `done` o `error`, o cuando se llama a `close`.
        El suscriptor queda anotado al volver de esta llamada, no al empezar a
        recorrer el iterador. Lo que se devuelve es un `Subscription`.
        """
        subscription = Subscription(self, field_id, self._max_pending if max_pending is None else max_pending)
        with self._lock:
            self._subscriptions.setdefault(field_id, []).append(subscription)
        return subscription

    def subscriber_count(self, field_id: str) -> int:
        """Suscriptores que todavia reciben eventos de ese campo. Para diagnostico y tests."""
        with self._lock:
            return len(self._subscriptions.get(field_id, ()))

    def close(self, field_id: str) -> None:
        """Termina los flujos abiertos del campo y libera su estado.

        Lo que cada suscriptor tenia sin leer se le entrega igual antes del
        final. El proximo evento del campo vuelve a numerarse desde 1.
        """
        with self._lock:
            subscriptions = self._subscriptions.pop(field_id, [])
            self._last_ids.pop(field_id, None)
        for subscription in subscriptions:
            subscription._finish()

    def _remove(self, subscription: Subscription) -> None:
        with self._lock:
            subscriptions = self._subscriptions.get(subscription.field_id)
            if not subscriptions:
                return
            kept = [item for item in subscriptions if item is not subscription]
            if kept:
                self._subscriptions[subscription.field_id] = kept
            else:
                del self._subscriptions[subscription.field_id]
