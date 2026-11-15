"""Piezas comunes de los pedidos HTTP a IRSA: sesion por hilo, timeouts, plazo total y lectura de `Retry-After`.

`Deadline`, `read_some` y `read_body` no tienen nada propio de IRSA: tambien los
usan la vista provisoria (app/preview/hips2fits.py) y Sesame (app/resolve/sesame.py).
"""

from __future__ import annotations

import math
import threading
import time
from datetime import UTC
from email.utils import parsedate_to_datetime
from typing import Any

import requests
import urllib3

from app.config import Settings

_local = threading.local()

# Tramo de lectura por defecto de `read_body`.
_BODY_CHUNK = 64 * 1024
# `socket.settimeout(0)` pone el socket en modo no bloqueante: el timeout nunca baja de esto.
_MIN_SOCKET_TIMEOUT_S = 0.001


class TotalTimeout(requests.exceptions.Timeout):
    """El intercambio paso de su plazo total (`Deadline`).

    Es un `requests.Timeout`, asi que quien ya trata las demoras de `requests`
    la trata igual, sin tener que conocerla.
    """


class Deadline:
    """Plazo total de un intercambio HTTP, contado con `time.perf_counter` desde que se crea.

    Los timeouts de `requests` valen para cada lectura del socket, no para el
    total: un servidor que manda de a poco no los dispara nunca y puede tener
    ocupada una conexion sin limite. Con `seconds` en 0 o menos no hay plazo.

    El reloj es `perf_counter` y no `monotonic`: en Windows `monotonic` avanza
    de a 15,6 ms, y un timeout de socket acotado a lo que queda del plazo vencia
    antes de que ese reloj diera el plazo por vencido.

    El plazo se comprueba en cada lectura del cuerpo. Mientras llegan la linea
    de estado y las cabeceras solo valen los timeouts de `requests` (conexion y
    silencio entre lecturas): un servidor que gotea las cabeceras puede pasarse
    del plazo hasta que empieza el cuerpo.
    """

    def __init__(self, seconds: float) -> None:
        self.seconds = seconds
        self._end = time.perf_counter() + seconds if seconds > 0 else None

    def remaining(self) -> float | None:
        """Segundos que quedan (0 si ya vencio), o `None` si no hay plazo."""
        return None if self._end is None else max(0.0, self._end - time.perf_counter())

    def expired(self) -> bool:
        return self._end is not None and time.perf_counter() >= self._end

    def error(self) -> TotalTimeout:
        """La excepcion que corresponde a este plazo vencido."""
        return TotalTimeout(f"paso el plazo total de {self.seconds:g} s")

    def check(self) -> None:
        """Lanza `TotalTimeout` si el plazo ya vencio."""
        if self.expired():
            raise self.error()

    def cap(self, seconds: float) -> float:
        """`seconds` acotado a lo que queda del plazo. Lanza `TotalTimeout` si no queda nada.

        Sirve para armar los timeouts de un pedido que empieza con el plazo ya corriendo.
        """
        self.check()
        remaining = self.remaining()
        return seconds if remaining is None else max(_MIN_SOCKET_TIMEOUT_S, min(seconds, remaining))


def _limit_socket_timeout(raw: Any, seconds: float) -> bool:
    """Baja a `seconds` el timeout del socket de una respuesta de urllib3, si era mayor.

    Devuelve True si el socket quedo esperando, como mucho, lo que queda del
    plazo: un timeout de esa lectura es entonces el plazo total vencido.

    Sin esto, una lectura que empieza justo antes del plazo podria esperar el
    timeout de lectura entero. El socket se alcanza por `HTTPResponse.connection`
    de urllib3 y `HTTPConnection.sock` de http.client; si no se puede (otra
    version, respuesta ya terminada), no se hace nada y el plazo se pasa, como
    mucho, por un timeout de lectura. urllib3 vuelve a poner el timeout de cada
    pedido al reusar una conexion, asi que el cambio no sale de esta respuesta.
    """
    sock = getattr(getattr(raw, "connection", None), "sock", None)
    if sock is None:
        return False
    try:
        current = sock.gettimeout()
        if current is None or current > seconds:
            sock.settimeout(max(_MIN_SOCKET_TIMEOUT_S, seconds))
            return True
    except (OSError, AttributeError):
        pass
    return False


def read_some(raw: Any, size: int, deadline: Deadline, decode: bool = False) -> bytes:
    """Lee hasta `size` bytes del cuerpo de una respuesta pedida con `stream=True`. `b""` si el cuerpo termino.

    `raw` es `response.raw`. Vuelve con lo que haya llegado en una sola lectura
    del socket (`read1` de urllib3), sin esperar a juntar `size`: asi el plazo se
    comprueba en cada lectura aunque el servidor mande de a pocos bytes.
    `decode=True` descomprime segun `Content-Encoding`.

    Lanza `TotalTimeout` si el plazo vencio antes de leer o durante la lectura, y
    lo que lance urllib3 por un corte (`ProtocolError`) o por el silencio del
    servidor (`ReadTimeoutError`).
    """
    remaining = deadline.remaining()
    waits_for_deadline = False
    if remaining is not None:
        if remaining <= 0:
            raise deadline.error()
        waits_for_deadline = _limit_socket_timeout(raw, remaining)
    # `read1` existe desde urllib3 2.0. Con una version anterior se lee con `read`, que
    # espera a juntar `size` bytes: funciona igual, con el plazo comprobado cada mas tiempo.
    read = getattr(raw, "read1", None) or raw.read
    try:
        # Sin `decode` no se pasa el argumento: urllib3 no descomprime por defecto en una
        # respuesta de `requests`, y asi `raw` puede ser cualquier flujo de bytes.
        return read(size, decode_content=True) if decode else read(size)
    except (urllib3.exceptions.TimeoutError, TimeoutError) as exc:
        # Si el socket esperaba lo que quedaba del plazo, su timeout es el plazo vencido: no se
        # vuelve a mirar el reloj, que puede ir un instante por detras del reloj del socket.
        if waits_for_deadline or deadline.expired():
            raise deadline.error() from exc
        raise


def read_body(raw: Any, deadline: Deadline, decode: bool = True, limit: int | None = None) -> bytes:
    """El cuerpo entero de una respuesta pedida con `stream=True`, leido contra el plazo.

    `limit` es el maximo de bytes que se acepta: al pasarlo se deja de leer y se
    lanza `ValueError`. Lanza lo mismo que `read_some`.
    """
    parts: list[bytes] = []
    total = 0
    while True:
        chunk = read_some(raw, _BODY_CHUNK, deadline, decode=decode)
        if not chunk:
            return b"".join(parts)
        total += len(chunk)
        if limit is not None and total > limit:
            raise ValueError(f"la respuesta pasa de {limit} bytes")
        parts.append(chunk)


def session() -> requests.Session:
    """Sesion de `requests` del hilo que llama.

    `requests.Session` no esta pensada para compartirse entre hilos. Con una por
    hilo, las diez descargas en paralelo no comparten conexiones ni estado.
    """
    current = getattr(_local, "session", None)
    if current is None:
        current = requests.Session()
        _local.session = current
    return current


def timeouts(settings: Settings, deadline: Deadline | None = None) -> tuple[float, float]:
    """Par (conexion, lectura) en segundos. El de lectura es el silencio maximo entre dos tramos de la respuesta.

    Con `deadline`, ninguno de los dos pasa de lo que queda del plazo total; si
    ya vencio, lanza `TotalTimeout`.
    """
    if deadline is None:
        return (settings.irsa_connect_timeout_s, settings.irsa_read_timeout_s)
    return (deadline.cap(settings.irsa_connect_timeout_s), deadline.cap(settings.irsa_read_timeout_s))


def total_deadline(settings: Settings) -> Deadline:
    """Plazo total de un intercambio con IRSA que empieza ahora (`settings.irsa_total_timeout_s`)."""
    return Deadline(settings.irsa_total_timeout_s)


def request_headers(settings: Settings) -> dict[str, str]:
    """Cabeceras de todo pedido a IRSA: identificacion generica, sin datos de la persona."""
    return {"User-Agent": settings.user_agent}


def parse_retry_after(value: str | None) -> float | None:
    """Segundos que pide esperar una cabecera `Retry-After`, o `None` si falta o no se entiende.

    Admite las dos formas de RFC 9110 (seccion 10.2.3): una cantidad de segundos,
    que es lo que manda IRSA (`Retry-After: 5`, spike/RESULTADOS.md, seccion 3), o
    una fecha HTTP. Una fecha que ya paso vale 0.
    """
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        seconds = float(text)
    except ValueError:
        try:
            when = parsedate_to_datetime(text)
        except (TypeError, ValueError):
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        return max(0.0, when.timestamp() - time.time())
    if not math.isfinite(seconds) or seconds < 0:
        return None
    return seconds
