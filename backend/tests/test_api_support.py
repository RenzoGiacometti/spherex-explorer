"""Apoyo de los tests de las rutas reales (app/api). No tiene tests propios.

- `parse_sse`: eventos y comentarios `: ping` de un flujo `text/event-stream` completo.
- `seed_sesame`: deja en la cache de Sesame de una configuracion las respuestas
  guardadas en tests/fixtures, para resolver nombres sin red.
- `fake_deps`: las funciones externas de un gestor (`JobDeps`) con las piezas de
  mentira de test_jobs_support, para que la aplicacion arme su propio gestor.
- `LiveServer`: la aplicacion detras de un uvicorn de verdad en 127.0.0.1, para
  lo que el cliente de pruebas no puede hacer: leer el flujo de eventos de a un
  evento y cortar la conexion a mitad de camino.
- `EventReader`: cliente minimo de ese flujo, con `http.client`.
"""

from __future__ import annotations

import http.client
import json
import shutil
import socket
import threading
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI
from test_jobs_support import Harness, wait_until

from app.config import Settings
from app.contract import EVENT_ADAPTERS, ErrorBody
from app.jobs.deps import JobDeps
from app.jobs.events import FieldEvent
from app.resolve.sesame import cache_path

FIXTURES = Path(__file__).resolve().parent / "fixtures"
FIELDS_DIR = FIXTURES / "fields"
SESAME_DIR = FIXTURES / "sesame"

IMMUTABLE = "public, max-age=31536000, immutable"

# Texto buscado -> respuesta de Sesame guardada, y el nombre principal que trae.
SAVED_SESAME: dict[str, tuple[Path, str]] = {
    "Barnard's Star": (SESAME_DIR / "barnard_s_star.xml", "NAME Barnard's star"),
    "Epsilon Indi B": (SESAME_DIR / "epsilon_indi_b.xml", "* eps Ind B"),
    "WISE J085510.83-071442.5": (SESAME_DIR / "wise_j085510_83_071442_5.xml", "WISEA J085510.74-071442.5"),
    "RW Aurigae": (SESAME_DIR / "rw_aurigae.xml", "V* RW Aur"),
    "R Draconis": (SESAME_DIR / "r_draconis.xml", "V* R Dra"),
    "Abell 2218": (FIXTURES / "sesame_extra" / "abell_2218.xml", "ACO 2218"),
}


def seed_sesame(settings: Settings, queries: Iterable[str] | None = None, *, main_names: bool = False) -> None:
    """Copia a la cache de Sesame las respuestas guardadas de esos textos (por defecto, todas).

    Con `main_names` la misma respuesta queda tambien bajo el nombre principal
    del objeto, que es el texto con el que el frontend vuelve a preguntar.
    """
    for query in SAVED_SESAME if queries is None else queries:
        source, main_name = SAVED_SESAME[query]
        for text in (query, main_name) if main_names else (query,):
            target = cache_path(text, settings)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)


def error_of(response: Any) -> tuple[int, str, bool]:
    """`(codigo HTTP, code, retryable)` de una respuesta de error, que tiene que traer el cuerpo del contrato."""
    body = response.json()
    assert set(body) == {"error"}, body
    detail = ErrorBody.model_validate(body).error
    assert detail.message
    return response.status_code, detail.code, detail.retryable


def parse_sse(text: str) -> tuple[list[FieldEvent], int]:
    """Eventos de un flujo SSE completo, validados contra el contrato, y cantidad de comentarios `: ping`."""
    events: list[FieldEvent] = []
    pings = 0
    for block in text.split("\n\n"):
        if not block:
            continue
        if block.startswith(":"):
            assert block == ": ping", block
            pings += 1
            continue
        events.append(parse_event(block))
    return events, pings


def parse_event(block: str) -> FieldEvent:
    """Un evento: tres lineas (`event:`, `id:` y `data:` con el JSON en una sola linea)."""
    lines = block.split("\n")
    assert len(lines) == 3, block
    assert lines[0].startswith("event: ") and lines[1].startswith("id: ") and lines[2].startswith("data: "), block
    name = lines[0].removeprefix("event: ")
    data = json.loads(lines[2].removeprefix("data: "))
    EVENT_ADAPTERS[name].validate_python(data)
    return FieldEvent(id=int(lines[1].removeprefix("id: ")), event=name, data=data)  # type: ignore[arg-type]


def fake_deps(harness: Harness, **overrides: Any) -> JobDeps:
    """`JobDeps` con el IRSA, el pipeline, la vista provisoria y el reloj de mentira de un `Harness`.

    Es para que `create_app(settings, deps=...)` arme y detenga su propio
    gestor, en vez de usar el del `Harness`.
    """
    functions: dict[str, Any] = {
        "list_exposures": harness.irsa.list_exposures,
        "fetch_cutout": harness.irsa.fetch_cutout,
        "discard_cutout": harness.irsa.discard_cutout,
        "prune_cutout_cache": harness.irsa.prune_cutout_cache,
        "fetch_preview": harness.preview.fetch_preview,
        "load_exposure": harness.pipeline.load_exposure,
        "clock": harness.clock,
        "wait": harness.clock.wait,
    }
    functions.update(overrides)
    return JobDeps(**functions)


def when_subscribed(count: Any, action: Any, *, subscribers: int = 1) -> threading.Thread:
    """Lanza un hilo que espera a que haya `subscribers` flujos conectados (`count()`) y recien ahi llama a `action`.

    El cliente de pruebas devuelve la respuesta de `GET .../events` cuando el
    flujo ya termino: para retener un trabajo hasta que el flujo este conectado
    hay que soltarlo desde otro hilo.
    """

    def run() -> None:
        wait_until(lambda: count() >= subscribers, 10.0, "el flujo de eventos no se conecto")
        action()

    thread = threading.Thread(target=run, name="test-when-subscribed", daemon=True)
    thread.start()
    return thread


# ------------------------------------------------------------- servidor real


class LiveServer:
    """La aplicacion servida por uvicorn en 127.0.0.1, en un puerto libre y en un hilo."""

    def __init__(self, app: FastAPI, **config: Any) -> None:
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._socket.bind(("127.0.0.1", 0))
        self.host, self.port = self._socket.getsockname()
        options: dict[str, Any] = {"log_level": "warning", "lifespan": "on", "access_log": False}
        options.update(config)
        self.server = uvicorn.Server(uvicorn.Config(app, **options))
        self._thread = threading.Thread(
            target=self.server.run, kwargs={"sockets": [self._socket]}, name="test-uvicorn", daemon=True
        )

    def __enter__(self) -> LiveServer:
        self._thread.start()
        wait_until(lambda: self.server.started, 10.0, "uvicorn no arranco")
        return self

    def __exit__(self, *_: object) -> None:
        self.stop()

    def stop(self, timeout: float = 15.0) -> None:
        """Le pide a uvicorn que termine (como un Ctrl+C) y espera a que lo haga."""
        self.server.should_exit = True
        self._thread.join(timeout)
        assert not self._thread.is_alive(), "uvicorn no termino"

    def connection(self, timeout: float = 10.0) -> http.client.HTTPConnection:
        return http.client.HTTPConnection(self.host, self.port, timeout=timeout)

    def request(
        self, method: str, path: str, body: Mapping[str, Any] | None = None, headers: Mapping[str, str] | None = None
    ) -> tuple[int, dict[str, str], bytes]:
        """Un pedido completo: `(codigo, cabeceras en minusculas, cuerpo)`."""
        connection = self.connection()
        try:
            payload = None if body is None else json.dumps(body).encode("utf-8")
            sent = dict(headers or {})
            if payload is not None:
                sent["Content-Type"] = "application/json"
            connection.request(method, path, body=payload, headers=sent)
            response = connection.getresponse()
            return response.status, {name.lower(): value for name, value in response.getheaders()}, response.read()
        finally:
            connection.close()


class EventReader:
    """Lee un flujo `GET .../events` de un `LiveServer` de a un bloque, sin esperar a que termine."""

    def __init__(self, server: LiveServer, path: str, timeout: float = 10.0) -> None:
        self._connection = server.connection(timeout)
        self._connection.request("GET", path, headers={"Accept": "text/event-stream"})
        self.response = self._connection.getresponse()
        self.status = self.response.status
        self.headers = {name.lower(): value for name, value in self.response.getheaders()}

    def next_block(self) -> str | None:
        """El proximo bloque del flujo (un evento o un comentario), o `None` si el flujo termino.

        Termina igual si el servidor cierra bien la respuesta o si corta la
        conexion a mitad de camino: `http.client` no los distingue al leer por lineas.
        """
        lines: list[str] = []
        while True:
            try:
                line = self.response.readline()
            except (http.client.HTTPException, OSError):
                return None
            if not line:
                return None
            text = line.decode("utf-8").rstrip("\n")
            if text == "":
                if lines:
                    return "\n".join(lines)
                continue
            lines.append(text)

    def next_event(self) -> FieldEvent | None:
        """El proximo evento, salteando los `: ping`; `None` si el flujo termino."""
        while True:
            block = self.next_block()
            if block is None:
                return None
            if not block.startswith(":"):
                return parse_event(block)

    def rest(self) -> list[FieldEvent]:
        """Todos los eventos que quedan hasta que el servidor cierra el flujo."""
        events: list[FieldEvent] = []
        while (event := self.next_event()) is not None:
            events.append(event)
        return events

    def close(self) -> None:
        """Corta la conexion desde el cliente, como un navegador que se va."""
        self.response.close()
        self._connection.close()
