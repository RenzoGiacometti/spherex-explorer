"""El gestor de trabajos detras de una ruta HTTP de verdad: `POST /api/field` y el flujo SSE con sus `: ping`.

Las rutas del backend real estan en app/api y tienen sus tests. Aca se arma una
aplicacion minima que usa el gestor como lo tiene que usar una ruta (suscribirse
antes de responder, esperar cada evento con un tope para intercalar el ping,
cerrar el flujo al salir), para comprobar que `subscribe` y `encode_sse` sirven
tal como estan dentro del bucle de asyncio de un servidor.
"""

from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.testclient import TestClient
from test_jobs_support import Harness, HarnessFactory, harness_factory, replay, wait_until

from app.api.errors import register_error_handlers
from app.contract import EVENT_ADAPTERS, FINISHED_FIELD_STATUSES, FieldRequest, FieldResponse
from app.geometry import normalize_request
from app.jobs.events import PING, FieldEvent, encode_sse


@pytest.fixture
def build(tmp_path: Path) -> Iterator[HarnessFactory]:
    with harness_factory(tmp_path) as factory:
        yield factory


def make_app(harness: Harness, ping_s: float) -> FastAPI:
    manager = harness.manager
    app = FastAPI()
    register_error_handlers(app)

    @app.post("/api/field")
    async def post_field(body: FieldRequest) -> JSONResponse:
        request = normalize_request(body.ra, body.dec, body.fov, body.band, body.refresh)
        meta = manager.submit(request)
        response = FieldResponse(id=meta.id, status=meta.status, events_url=f"/api/field/{meta.id}/events", meta=meta)
        status_code = 200 if meta.status in FINISHED_FIELD_STATUSES else 202
        return JSONResponse(status_code=status_code, content=response.model_dump(mode="json"))

    @app.get("/api/field/{field_id}/events")
    async def get_events(field_id: str) -> StreamingResponse:
        stream = manager.subscribe(field_id)  # `not_found` sale aca, antes de abrir el flujo

        async def body() -> AsyncIterator[bytes]:
            try:
                while True:
                    try:
                        event = await asyncio.wait_for(anext(stream), ping_s)
                    except TimeoutError:
                        yield PING
                        continue
                    except StopAsyncIteration:
                        return
                    yield encode_sse(event)
            finally:
                await stream.aclose()  # type: ignore[attr-defined]

        return StreamingResponse(body(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    return app


def parse_sse(text: str) -> tuple[list[FieldEvent], int]:
    """Eventos de un flujo SSE completo y cantidad de comentarios `: ping`."""
    events: list[FieldEvent] = []
    pings = 0
    for block in text.split("\n\n"):
        if not block:
            continue
        if block.startswith(":"):
            assert block == ": ping"
            pings += 1
            continue
        lines = block.split("\n")
        assert len(lines) == 3, block
        assert lines[0].startswith("event: ") and lines[1].startswith("id: ") and lines[2].startswith("data: ")
        name = lines[0].removeprefix("event: ")
        data = json.loads(lines[2].removeprefix("data: "))
        EVENT_ADAPTERS[name].validate_python(data)
        events.append(FieldEvent(id=int(lines[1].removeprefix("id: ")), event=name, data=data))  # type: ignore[arg-type]
    return events, pings


def test_a_new_field_over_http(build: HarnessFactory) -> None:
    harness = build({(1, 3): 3, (2, 3): 3, (1, 6): 2})
    harness.irsa.gate = threading.Event()
    client = TestClient(make_app(harness, ping_s=0.03))
    posted = client.post("/api/field", json={"ra": 10.0, "dec": 20.0, "band": 3})
    assert posted.status_code == 202
    created = FieldResponse.model_validate(posted.json())
    assert created.status == "queued" and created.meta.progress.queue_position == 1
    wait_until(lambda: len(harness.irsa.calls) == 8)  # todas las descargas retenidas
    # Las descargas quedan quietas un rato: mas que el intervalo del ping.
    opener = threading.Timer(0.25, harness.irsa.gate.set)
    opener.start()
    try:
        response = client.get(created.events_url)
    finally:
        opener.join()
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events, pings = parse_sse(response.text)
    assert pings >= 2
    assert events[0].event == "state" and events[0].data["status"] == "downloading"
    assert [event.event for event in events[-2:]] == ["state", "done"]
    assert [event.id for event in events] == sorted({event.id for event in events})
    assert {event.event for event in events} >= {"state", "progress", "plane", "done"}
    final: dict[str, Any] | None = replay(events)
    assert final is not None and final["status"] == "ready"
    assert final == harness.manager.get_meta(created.id).model_dump(mode="json")
    assert harness.bus.subscriber_count(created.id) == 0

    # Ya terminado: 200 con los metadatos, y el flujo es `state`, `done` y cierre.
    again = client.post("/api/field", json={"ra": 10.0, "dec": 20.0})
    assert again.status_code == 200 and again.json()["meta"] == final
    events, pings = parse_sse(client.get(created.events_url).text)
    assert [(event.id, event.event) for event in events] == [(1, "state"), (2, "done")] and pings == 0
    assert events[0].data == final


def test_errors_over_http(build: HarnessFactory) -> None:
    harness = build({})  # ninguna exposicion cubre el punto
    client = TestClient(make_app(harness, ping_s=5.0))
    missing = client.get("/api/field/0000000000000000/events")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "not_found"

    posted = client.post("/api/field", json={"ra": 30.0, "dec": -5.0})
    assert posted.status_code == 202
    events, _ = parse_sse(client.get(posted.json()["events_url"]).text)
    assert events[0].event == "state" and events[-1].event == "error"
    assert events[-1].data["error"] == {
        "code": "no_coverage",
        "message": events[-1].data["error"]["message"],
        "retryable": False,
    }
    assert harness.manager.wait_idle(10.0)
    refused = client.post("/api/field", json={"ra": 30.0, "dec": -5.0})
    assert refused.status_code == 404 and refused.json()["error"]["code"] == "no_coverage"
    # Quien se conecta despues de la falla recibe el estado y el mismo error.
    events, _ = parse_sse(client.get(posted.json()["events_url"]).text)
    assert [event.event for event in events] == ["state", "error"] and events[0].data["status"] == "failed"


def test_a_full_queue_over_http(build: HarnessFactory) -> None:
    harness = build({(1, 3): 1}, max_active_jobs=1, max_queued_jobs=0)
    harness.irsa.list_gate = threading.Event()
    client = TestClient(make_app(harness, ping_s=5.0))
    assert client.post("/api/field", json={"ra": 10.0, "dec": 20.0}).status_code == 202
    full = client.post("/api/field", json={"ra": 11.0, "dec": 20.0})
    assert full.status_code == 429 and full.headers["retry-after"] == "30"
    assert full.json()["error"] == {
        "code": "queue_full",
        "message": full.json()["error"]["message"],
        "retryable": True,
    }
    harness.irsa.list_gate.set()
    assert harness.manager.wait_idle(10.0)
