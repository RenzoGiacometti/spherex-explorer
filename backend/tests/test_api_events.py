"""El flujo de eventos de la aplicacion real (`GET /api/field/{id}/events`, contrato 4.2).

Con el cliente de pruebas se mira el flujo completo, que llega cuando ya
termino. Lo que depende de la conexion (que cada evento salga apenas se
publica, el `: ping`, un cliente que se va a mitad del trabajo, el apagado del
servidor con un flujo abierto) se prueba contra un uvicorn de verdad en
127.0.0.1, leyendo el flujo de a un evento.
"""

from __future__ import annotations

import itertools
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from test_api_support import EventReader, LiveServer, error_of, fake_deps, parse_sse, when_subscribed
from test_jobs_support import HarnessFactory, harness_factory, manager_threads, planes_of, replay, wait_until

from app.api.main import create_app
from app.contract import FieldMeta, FieldResponse
from app.jobs.events import FieldEvent

COUNTS = {(1, 3): 4, (2, 3): 4, (1, 6): 2}


@pytest.fixture
def build(tmp_path: Path) -> Iterator[HarnessFactory]:
    with harness_factory(tmp_path) as factory:
        yield factory


def as_tuples(events: list[FieldEvent]) -> list[tuple[int, str, object]]:
    return [(event.id, event.event, event.data) for event in events]


def assert_follows_what_was_published(received: list[FieldEvent], published: list[FieldEvent]) -> None:
    """Despues del primer `state`, el flujo trae lo que el trabajo publico desde ese momento, en orden.

    Todo menos los `progress` llega tal cual. De dos `progress` seguidos que el
    flujo no llego a leer queda solo el ultimo, que trae lo mismo y mas
    (`app.jobs.events`): los recibidos son una parte de los publicados, sin
    cambiar el orden, y el ultimo de cada tanda siempre llega.
    """
    after = [event for event in published if event.id > received[0].id]
    rest = received[1:]
    assert as_tuples([event for event in rest if event.event != "progress"]) == as_tuples(
        [event for event in after if event.event != "progress"]
    )
    sent, got = as_tuples(after), as_tuples(rest)
    assert all(item in sent for item in got)
    assert [event.id for event in rest] == sorted(event.id for event in rest)
    for index, item in enumerate(sent):
        last_of_its_run = index + 1 == len(after) or after[index + 1].event != "progress"
        if item[1] == "progress" and last_of_its_run:
            assert item in got


def test_the_stream_of_a_new_field_from_the_first_event_to_done(build: HarnessFactory) -> None:
    # Una sola conexion de descarga: los recortes, y con ellos las revisiones, salen en el orden de la seccion 8.
    harness = build(COUNTS, max_cutout_downloads=1, preview="slow")
    harness.irsa.list_gate = threading.Event()  # el trabajo no pasa de `listing` hasta que el flujo este conectado
    client = TestClient(create_app(manager=harness.manager))
    created = FieldResponse.model_validate(client.post("/api/field", json={"ra": 10.0, "dec": 20.0, "band": 3}).json())
    wait_until(lambda: harness.manager.get_meta(created.id).status == "listing")

    def release() -> None:
        # Primero la vista provisoria y despues la lista, para que el orden de sus eventos sea siempre el mismo.
        harness.preview.gate.set()
        wait_until(lambda: harness.manager.get_meta(created.id).preview.status == "ready")
        harness.irsa.list_gate.set()

    opener = when_subscribed(lambda: harness.bus.subscriber_count(created.id), release)
    response = client.get(created.events_url)
    opener.join()

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"
    assert "content-length" not in response.headers and "content-encoding" not in response.headers
    events, pings = parse_sse(response.text)  # cada evento, validado contra su modelo del contrato
    assert pings == 0
    names = [event.event for event in events]

    # Siempre empieza con `state`, y termina con el `state` del documento terminado y `done`.
    assert names[0] == "state" and names[-2:] == ["state", "done"]
    assert names.count("state") == 2 and names.count("done") == 1 and "error" not in names
    first = FieldMeta.model_validate(events[0].data)
    assert first.status == "listing" and first.grid is None and first.planes is None
    assert first.preview.status == "pending"
    # Lo que sigue es, evento por evento, lo que publico el trabajo desde ese momento: ni uno menos ni repetido.
    assert events[0].id == 3  # `state`, `queued` y el `progress` de `listing` salieron antes de conectar
    assert_follows_what_was_published(events, harness.bus.of(created.id))
    ids = [event.id for event in events]
    assert all(later > earlier for earlier, later in itertools.pairwise(ids))

    # El orden del contrato: vista provisoria y lista, despues el avance y los planos, y los avisos al detectarlos.
    order = {name: names.index(name) for name in ("preview", "listed", "plane", "done")}
    assert order["preview"] < order["listed"] < order["plane"] < order["done"]
    assert events[order["preview"]].data["status"] == "ready" and events[order["preview"]].data["display"]
    assert events[order["listed"] + 1].event == "progress"
    listed = FieldMeta.model_validate(events[order["listed"]].data)
    assert listed.status == "downloading" and listed.flags == [] and listed.planes is not None
    assert {plane.status for plane in listed.planes} == {"pending", "empty"}
    # Cada plano sale dos veces, provisorio con la mitad de sus exposiciones y definitivo: primero la banda
    # pedida, con sus dos epocas avanzando a la par, y despues la otra.
    assert planes_of(events) == [
        (1, 3, "building", 1, 2), (2, 3, "building", 1, 2), (1, 3, "ready", 2, 4), (2, 3, "ready", 2, 4),
        (1, 6, "building", 1, 1), (1, 6, "ready", 2, 2),
    ]  # fmt: skip
    progress = [event.data for event in events if event.event == "progress"]
    assert progress[-1]["phase"] == "finishing"
    assert progress[-1]["cutouts_done"] == progress[-1]["cutouts_total"] == 10

    # El `state` final es el unico evento con `cube_offset`, `flags` completo y `built_at` (contrato 4.2).
    final = FieldMeta.model_validate(events[-2].data)
    assert (final.status, final.rev, final.progress.phase) == ("ready", 1, "done")
    assert final.planes is not None and final.provenance is not None and final.provenance.built_at
    assert [plane.cube_offset for plane in final.planes if plane.status == "ready"] == [0, 152100, 304200]
    assert final.flags and all(plane["cube_offset"] is None for plane in events[order["listed"]].data["planes"])
    assert events[-1].data == {"status": "ready", "rev": 1, "elapsed_s": final.progress.elapsed_s}
    # Quien aplica los eventos como el frontend llega al mismo documento que entrega `/meta`.
    assert replay(events) == events[-2].data == client.get(f"/api/field/{created.id}/meta").json()
    assert harness.bus.subscriber_count(created.id) == 0


def test_reconnecting_halfway_starts_with_the_current_state(build: HarnessFactory) -> None:
    harness = build(COUNTS, max_cutout_downloads=1)
    harness.irsa.hold_after = 6  # las provisorias de la banda 3 ya salieron; lo demas espera
    client = TestClient(create_app(manager=harness.manager))
    created = FieldResponse.model_validate(client.post("/api/field", json={"ra": 10.0, "dec": 20.0}).json())
    wait_until(lambda: len(harness.irsa.calls) == 7)
    wait_until(lambda: harness.manager.get_meta(created.id).progress.cutouts_done == 6)
    opener = when_subscribed(lambda: harness.bus.subscriber_count(created.id), harness.irsa.resume.set)
    events, _ = parse_sse(client.get(created.events_url).text)
    opener.join()

    names = [event.event for event in events]
    assert names[0] == "state" and names[-2:] == ["state", "done"]
    # No se repite lo perdido: ni `queued`, ni `listed`, ni la vista provisoria.
    assert not {"queued", "listed", "preview"} & set(names)
    state = FieldMeta.model_validate(events[0].data)
    assert state.status == "downloading" and state.planes is not None and state.preview.status == "ready"
    seen = {(plane.epoch, plane.detector): plane.rev for plane in state.planes if plane.status == "building"}
    assert seen == {(1, 3): 1, (2, 3): 1}  # el `state` ya trae lo anterior
    # El `state` lleva el id del ultimo evento publicado, y lo que sigue es lo publicado despues, sin huecos.
    assert events[0].id > 3
    assert_follows_what_was_published(events, harness.bus.of(created.id))
    # Lo que llega despues son revisiones nuevas, nunca una que el `state` ya traia.
    for epoch, detector, _, rev, _ in planes_of(events):
        assert rev > seen.get((epoch, detector), 0)
        seen[(epoch, detector)] = rev
    assert seen == {(1, 3): 2, (2, 3): 2, (1, 6): 2}
    assert replay(events) == events[-2].data


def test_two_clients_follow_the_same_job(build: HarnessFactory) -> None:
    harness = build(COUNTS)
    harness.irsa.list_gate = threading.Event()
    client = TestClient(create_app(manager=harness.manager))
    created = FieldResponse.model_validate(client.post("/api/field", json={"ra": 10.0, "dec": 20.0}).json())
    wait_until(lambda: harness.manager.get_meta(created.id).status == "listing")
    wait_until(lambda: harness.manager.get_meta(created.id).preview.status == "ready")
    texts: list[str] = []

    def follow() -> None:
        texts.append(TestClient(client.app).get(created.events_url).text)

    readers = [threading.Thread(target=follow) for _ in range(2)]
    for reader in readers:
        reader.start()
    opener = when_subscribed(
        lambda: harness.bus.subscriber_count(created.id), harness.irsa.list_gate.set, subscribers=2
    )
    for thread in (*readers, opener):
        thread.join(20.0)
    assert len(texts) == 2
    first, second = (parse_sse(text)[0] for text in texts)
    published = harness.bus.of(created.id)
    for events in (first, second):
        assert events[0].event == "state" and events[-1].event == "done"
        assert_follows_what_was_published(events, published)
    # Los dos reciben lo mismo, salvo los `progress` que cada flujo funde por su cuenta cuando se le juntan,
    # y llegan al mismo documento.
    assert [event for event in first if event.event != "progress"] == [
        event for event in second if event.event != "progress"
    ]
    assert replay(first) == replay(second) == first[-2].data
    assert harness.irsa.list_calls == [False]  # un solo trabajo


def test_unknown_field_is_a_plain_404_not_a_stream(build: HarnessFactory) -> None:
    harness = build(COUNTS)
    client = TestClient(create_app(manager=harness.manager))
    response = client.get("/api/field/0123456789abcdef/events")
    assert error_of(response) == (404, "not_found", False)
    assert response.headers["content-type"] == "application/json"


# ----------------------------------------------------- contra un servidor real


def test_events_arrive_one_by_one_with_pings_in_the_silences(build: HarnessFactory) -> None:
    harness = build(COUNTS, max_cutout_downloads=1, sse_ping_s=0.05)
    harness.irsa.gate = threading.Event()  # ninguna descarga termina hasta que el test lo diga
    with LiveServer(create_app(manager=harness.manager)) as server:
        status, _, body = server.request("POST", "/api/field", {"ra": 10.0, "dec": 20.0})
        assert status == 202
        created = FieldResponse.model_validate_json(body)
        wait_until(lambda: len(harness.irsa.calls) == 1)

        reader = EventReader(server, created.events_url)
        assert reader.status == 200
        assert reader.headers["content-type"].startswith("text/event-stream")
        assert reader.headers["cache-control"] == "no-cache" and reader.headers["x-accel-buffering"] == "no"
        assert reader.headers.get("transfer-encoding") == "chunked"  # sin tamano: el flujo sale por tramos
        # El `state` llega enseguida, con el trabajo todavia frenado: nada lo retiene hasta el final.
        block = reader.next_block()
        assert block is not None and block.startswith("event: state\n")
        assert '"status":"downloading"' in block
        # Sin eventos, cada 0.05 s sale un `: ping`.
        started = time.perf_counter()
        assert [reader.next_block() for _ in range(3)] == [": ping"] * 3
        assert 0.1 < time.perf_counter() - started < 5.0
        assert harness.bus.subscriber_count(created.id) == 1

        # Se suelta el trabajo: el resto llega y el servidor cierra el flujo despues de `done`.
        harness.irsa.gate.set()
        events = reader.rest()
        assert [event.event for event in events[-2:]] == ["state", "done"]
        assert {event.event for event in events} >= {"progress", "plane", "state", "done"}
        assert reader.next_block() is None
        reader.close()
        wait_until(lambda: harness.bus.subscriber_count(created.id) == 0)
        status, _, body = server.request("POST", "/api/field", {"ra": 10.0, "dec": 20.0})
        assert status == 200 and FieldResponse.model_validate_json(body).status == "ready"


def test_the_job_goes_on_when_the_client_leaves(build: HarnessFactory) -> None:
    harness = build(COUNTS, max_cutout_downloads=1, sse_ping_s=5.0)
    harness.irsa.hold_after = 2
    with LiveServer(create_app(manager=harness.manager)) as server:
        _, _, body = server.request("POST", "/api/field", {"ra": 10.0, "dec": 20.0})
        created = FieldResponse.model_validate_json(body)
        wait_until(lambda: len(harness.irsa.calls) == 3)
        reader = EventReader(server, created.events_url)
        first = reader.next_event()
        assert first is not None and first.event == "state" and first.data["status"] == "downloading"
        assert harness.bus.subscriber_count(created.id) == 1

        # El navegador se va a mitad del trabajo: el flujo se suelta enseguida, sin esperar otro evento.
        reader.close()
        wait_until(lambda: harness.bus.subscriber_count(created.id) == 0, 5.0, "el flujo abandonado no se cerro")
        assert harness.manager.get_meta(created.id).status == "downloading"

        # El trabajo no depende de la conexion: sigue y queda en cache (contrato 4.2).
        harness.irsa.resume.set()
        assert harness.manager.wait_idle(20.0)
        status, _, body = server.request("POST", "/api/field", {"ra": 10.0, "dec": 20.0})
        assert status == 200 and FieldResponse.model_validate_json(body).status == "ready"
        # Al volver: `state`, `done` y cierre.
        again = EventReader(server, created.events_url)
        assert [event.event for event in again.rest()] == ["state", "done"]
        again.close()


def test_stopping_the_server_stops_the_manager_and_ends_open_streams(build: HarnessFactory) -> None:
    harness = build(COUNTS, sse_ping_s=5.0)
    harness.irsa.gate = threading.Event()
    # La aplicacion arma su propio gestor, con las funciones de mentira, y lo detiene al cerrar.
    app = create_app(harness.settings, deps=fake_deps(harness))
    # uvicorn anota como error la tarea que cancela al vencer el plazo: es lo esperado, y aca no se muestra.
    with LiveServer(app, timeout_graceful_shutdown=1, log_level="critical") as server:
        _, _, body = server.request("POST", "/api/field", {"ra": 10.0, "dec": 20.0})
        created = FieldResponse.model_validate_json(body)
        wait_until(lambda: len(harness.irsa.calls) >= 1)
        assert manager_threads()  # el trabajo y las descargas estan corriendo
        reader = EventReader(server, created.events_url)
        first = reader.next_event()
        assert first is not None and first.event == "state"

        # Se detiene el servidor con el flujo abierto y el trabajo a medio hacer.
        stopper = threading.Thread(target=server.stop)
        stopper.start()
        # Pasado el plazo, uvicorn corta la conexion: el flujo termina sin `done` ni `error`.
        started = time.perf_counter()
        assert reader.rest() == []
        assert time.perf_counter() - started < 8.0
        reader.close()
        harness.irsa.gate.set()  # las descargas retenidas vuelven; sus resultados ya no le sirven a nadie
        stopper.join(20.0)
        assert not stopper.is_alive()
    wait_until(lambda: not manager_threads(), 10.0, f"quedaron hilos del gestor: {manager_threads()}")
    # El campo quedo a medio armar: no cuenta como existente y se rehace cuando se lo vuelva a pedir.
    assert harness.manager.store.read_meta(created.id).status == "downloading"


def test_the_application_starts_and_stops_its_own_manager(build: HarnessFactory) -> None:
    harness = build(COUNTS)
    app = create_app(harness.settings, deps=fake_deps(harness))
    with TestClient(app) as client:
        manager = app.state.backend.manager
        assert manager is not harness.manager and manager.settings is harness.settings
        assert harness.irsa.pruned == 2  # crear el gestor aplica el tope de disco de la cache (el del Harness y este)
        posted = client.post("/api/field", json={"ra": 10.0, "dec": 20.0})
        assert posted.status_code == 202
        events, _ = parse_sse(client.get(posted.json()["events_url"]).text)
        assert events[-1].event == "done"
        assert manager.wait_idle(20.0)
        assert client.post("/api/field", json={"ra": 10.0, "dec": 20.0}).status_code == 200
        assert manager_threads()  # los hilos de descarga quedan esperando el proximo trabajo
    # Al cerrar la aplicacion el gestor se detiene: no queda ningun hilo.
    wait_until(lambda: not manager_threads(), 10.0, f"quedaron hilos del gestor: {manager_threads()}")
    with pytest.raises(Exception, match="deteniendo"):
        manager.submit(harness.request(11.0, 20.0))
    # Si la aplicacion vuelve a arrancar, arma un gestor nuevo, que encuentra el campo en cache.
    with TestClient(app) as client:
        assert app.state.backend.manager is not manager
        assert client.post("/api/field", json={"ra": 10.0, "dec": 20.0}).status_code == 200
