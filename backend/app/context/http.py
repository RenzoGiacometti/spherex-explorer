"""Un GET a IRSA con timeout, plazo total, reintentos y respeto de `Retry-After`.

Las piezas son las de `app.irsa.transport` (sesion por hilo, timeouts, plazo
total) y el limite global de conexiones de `app.irsa.limits`: los pedidos de
contexto cuentan en el mismo cupo de 10 descargas que los recortes de SPHEREx
(CLAUDE.md). La espera entre intentos no ocupa lugar.
"""

from __future__ import annotations

import re
import time
from collections.abc import Callable, Mapping
from contextlib import AbstractContextManager

import requests
import urllib3

from app.config import Settings
from app.irsa import transport

# Respuestas que conviene reintentar: las mismas que con SIA2 y los recortes de SPHEREx.
RETRY_STATUS = frozenset({429, 500, 502, 503, 504})

Slot = Callable[[], AbstractContextManager[None]]


class ContextFetchError(Exception):
    """El pedido no se pudo completar. `status` es el ultimo codigo HTTP, si hubo respuesta."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def excerpt(payload: bytes) -> str:
    """Comienzo de un cuerpo de error, en una linea y sin etiquetas HTML, para el mensaje."""
    text = payload[:400].decode("utf-8", errors="replace")
    return " ".join(re.sub(r"<[^>]*>", " ", text).split())[:160]


def get_bytes(
    url: str,
    settings: Settings,
    *,
    slot: Slot,
    what: str,
    params: Mapping[str, str] | None = None,
    attempts: int = 4,
    max_bytes: int | None = None,
    retry_wait_s: float = 3.0,
) -> bytes:
    """Cuerpo de la respuesta 200 a un GET, o `ContextFetchError`.

    - Cada intento corre dentro de `slot()` (un lugar del limite global) y tiene
      los timeouts de conexion y de lectura de `settings`, mas el plazo total
      `settings.irsa_total_timeout_s`.
    - Se reintentan las fallas de red y los codigos de `RETRY_STATUS`, esperando
      lo que pida `Retry-After` (hasta `settings.irsa_retry_after_max_s`) o
      `retry_wait_s` por el numero de intento.
    - Cualquier otro codigo es definitivo: no se reintenta.
    """
    attempts = max(1, attempts)
    last = "sin intentos"
    status: int | None = None
    for attempt in range(1, attempts + 1):
        wait = retry_wait_s * attempt
        try:
            with slot():
                deadline = transport.total_deadline(settings)
                with transport.session().get(
                    url,
                    params=dict(params) if params else None,
                    stream=True,
                    timeout=transport.timeouts(settings, deadline),
                    headers=transport.request_headers(settings),
                ) as response:
                    payload = transport.read_body(response.raw, deadline, limit=max_bytes)
        except (requests.RequestException, urllib3.exceptions.HTTPError, ValueError) as exc:
            # De `requests`, las fallas hasta las cabeceras y el plazo vencido; de urllib3, un corte
            # a mitad del cuerpo; `ValueError`, una respuesta mas grande que `max_bytes`.
            last, status = f"{type(exc).__name__}: {exc}", None
        else:
            status = response.status_code
            if status == 200:
                return payload
            last = f"HTTP {status}: {excerpt(payload)}".rstrip(": ")
            if status not in RETRY_STATUS:
                raise ContextFetchError(f"{what}: {last}", status)
            asked = transport.parse_retry_after(response.headers.get("Retry-After"))
            if asked is not None:
                if asked > settings.irsa_retry_after_max_s:
                    break  # IRSA pide esperar demasiado: no se insiste antes de tiempo
                wait = max(wait, asked)
        if attempt < attempts:
            time.sleep(wait)
    raise ContextFetchError(f"{what}: {last} tras {attempt} intentos", status)
