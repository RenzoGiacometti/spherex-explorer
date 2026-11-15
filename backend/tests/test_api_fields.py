"""Las rutas reales de `/api/field` (app/api), una por una: codigos, cuerpos y cabeceras del contrato.

Sin red: detras de la aplicacion hay un gestor de trabajos de verdad con IRSA,
hips2fits y el pipeline reemplazados (test_jobs_support). Con una sola conexion
de descarga los recortes llegan en el orden de la seccion 8 del contrato, y se
puede frenar el trabajo en cada etapa para pedir los recursos en ese momento.
"""

from __future__ import annotations

import gzip
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient
from test_api_support import IMMUTABLE, error_of, parse_sse, seed_sesame, when_subscribed
from test_jobs_support import (
    SHAPE,
    Harness,
    HarnessFactory,
    expected_plane,
    harness_factory,
    make_exposures,
    preview_image,
    wait_until,
)

from app import geometry
from app.api.main import create_app
from app.contract import FieldMeta, FieldResponse, TrackResponse
from app.irsa.cutouts import IrsaPermanent, IrsaTransient
from app.jobs.store import split_aux

PLANE_NBYTES = 4 * SHAPE[0] * SHAPE[1]
AUX_NBYTES = 6 * SHAPE[0] * SHAPE[1]

# Dos epocas en la banda 3, de 4 exposiciones cada una, y una en la banda 5 de 2: los demas planos quedan vacios.
COUNTS = {(1, 3): 4, (2, 3): 4, (1, 5): 2}


@pytest.fixture
def build(tmp_path: Path) -> Iterator[HarnessFactory]:
    with harness_factory(tmp_path) as factory:
        yield factory


def client_of(harness: Harness) -> TestClient:
    # Sin gzip: estas pruebas miran los bytes y el `Content-Length` de cada recurso tal como los arma la
    # ruta. La aplicacion comprime lo que pasa de 1 kB si el cliente lo acepta, y httpx lo pide por defecto.
    return TestClient(create_app(manager=harness.manager), headers={"Accept-Encoding": "identity"})


def serial(build: HarnessFactory, counts: dict[tuple[int, int], int] | None = None, **options: Any) -> Harness:
    """Un gestor con una sola conexion de descarga (los recortes llegan en orden) y sin servidores de Sesame."""
    return build(COUNTS if counts is None else counts, max_cutout_downloads=1, sesame_urls=(), **options)


def get_meta(client: TestClient, field_id: str) -> FieldMeta:
    response = client.get(f"/api/field/{field_id}/meta")
    assert response.status_code == 200, response.text
    return FieldMeta.model_validate(response.json())


def plane_status(client: TestClient, field_id: str, epoch: int, detector: int) -> str | None:
    plane = get_meta(client, field_id).plane(epoch, detector)
    return None if plane is None else plane.status


# ----------------------------------------------------- un campo, etapa por etapa


def test_every_resource_at_each_stage_of_a_new_field(build: HarnessFactory) -> None:
    harness = serial(build, preview="slow")
    harness.irsa.list_gate = threading.Event()
    harness.irsa.hold_after = 4  # pasan los dos primeros recortes de cada epoca de la banda 3 y el resto espera
    seed_sesame(harness.settings, ["Barnard's Star"])
    client = client_of(harness)

    # 1. POST: campo nuevo. 202, en cola, con los metadatos minimos (contrato 4.1 y 5).
    posted = client.post("/api/field", json={"ra": 269.44634, "dec": 4.76829, "band": 3})
    assert posted.status_code == 202
    assert posted.headers["content-type"] == "application/json"
    created = FieldResponse.model_validate(posted.json())
    request = geometry.normalize_request(269.4463, 4.7683)
    assert created.id == request.field_id and len(created.id) == 16
    assert (created.status, created.events_url) == ("queued", f"/api/field/{created.id}/events")
    assert set(posted.json()) == {"id", "status", "events_url", "meta"}
    assert set(posted.json()["meta"]) == {
        "id", "pipeline", "status", "rev", "request", "progress", "warnings", "preview",
    }  # fmt: skip
    assert created.meta.request.model_dump() == {"ra": 269.4463, "dec": 4.7683, "fov": 0.1667}
    assert (created.meta.rev, created.meta.progress.phase, created.meta.progress.queue_position) == (0, "queued", 1)
    assert (created.meta.preview.status, created.meta.preview.band) == ("pending", "W2")
    base = f"/api/field/{created.id}"

    # 2. Listando: todavia no hay grilla, epocas ni planos. Nada esta construido, pero va a estarlo.
    wait_until(lambda: get_meta(client, created.id).status == "listing")
    listing = get_meta(client, created.id)
    assert listing.grid is None and listing.planes is None and listing.progress.phase == "listing"
    for url in (f"{base}/plane/1/3", f"{base}/aux/1/3", f"{base}/cube", f"{base}/preview"):
        assert error_of(client.get(url)) == (409, "not_ready", True), url
    assert error_of(client.get(f"{base}/track", params={"name": "Barnard's Star"})) == (409, "not_ready", True)
    # Un plano con esos numeros no existe en ningun campo: 404 sin esperar la lista.
    for url in (f"{base}/plane/1/7", f"{base}/plane/0/3", f"{base}/aux/1/0", f"{base}/plane/-1/3"):
        assert error_of(client.get(url)) == (404, "not_found", False), url
    assert client.post(f"{base}/priority", json={"band": 3}).status_code == 204

    # 3. La vista provisoria llega antes que la lista: se sirve con la forma del escalon (contrato 4.10).
    harness.preview.gate.set()
    wait_until(lambda: get_meta(client, created.id).preview.status == "ready")
    assert get_meta(client, created.id).grid is None
    preview = client.get(f"{base}/preview")
    assert preview.status_code == 200
    assert preview.headers["content-type"] == "application/octet-stream"
    assert preview.headers["cache-control"] == "no-cache"
    assert preview.content == preview_image(geometry.build_grid(request)).astype("<f4").tobytes()
    assert len(preview.content) == PLANE_NBYTES

    # 4. Listado, con las descargas frenadas despues de los primeros cuatro recortes: provisorias de la banda 3.
    harness.irsa.list_gate.set()
    wait_until(lambda: plane_status(client, created.id, 2, 3) == "building")
    wait_until(lambda: len(harness.irsa.calls) == 5)  # el quinto recorte esta pedido y retenido
    building = get_meta(client, created.id)
    assert building.status == "downloading" and building.rev == 0
    assert building.grid is not None and building.grid.shape == SHAPE
    assert building.planes is not None and len(building.planes) == 12
    statuses = {(plane.epoch, plane.detector): plane.status for plane in building.planes}
    assert statuses[(1, 3)] == statuses[(2, 3)] == "building" and statuses[(1, 5)] == "pending"
    assert [key for key, status in statuses.items() if status == "empty"] == [
        (1, 1), (1, 2), (1, 4), (1, 6), (2, 1), (2, 2), (2, 4), (2, 5), (2, 6),
    ]  # fmt: skip

    provisional = client.get(f"{base}/plane/1/3", params={"rev": 1})
    assert provisional.status_code == 200
    assert provisional.headers["content-type"] == "application/octet-stream"
    assert provisional.headers["content-length"] == str(PLANE_NBYTES)
    assert provisional.headers["cache-control"] == IMMUTABLE
    assert provisional.headers["x-plane-rev"] == "1"
    half = expected_plane(harness, ["E1D3N0", "E1D3N1"])
    assert provisional.content == half.image.astype("<f4").tobytes()
    # Sin `rev`, o con una revision que todavia no existe: la vigente, sin marca de inmutable.
    for params in (None, {"rev": 2}, {"rev": 0}):
        response = client.get(f"{base}/plane/1/3", params=params)
        assert response.status_code == 200 and response.content == provisional.content
        assert (response.headers["cache-control"], response.headers["x-plane-rev"]) == ("no-cache", "1"), params

    # Las capas auxiliares son las de esa misma revision.
    aux = client.get(f"{base}/aux/1/3", headers={"Accept-Encoding": "gzip"})
    assert aux.status_code == 200
    assert aux.headers["content-type"] == "application/octet-stream"
    assert (aux.headers["cache-control"], aux.headers["x-plane-rev"]) == ("no-cache", "1")
    assert aux.headers["content-encoding"] == "gzip" and aux.headers["vary"] == "Accept-Encoding"
    assert len(aux.content) == AUX_NBYTES
    flags, coverage = split_aux(aux.content, SHAPE)
    assert np.array_equal(flags, half.flags) and np.array_equal(coverage, half.coverage)
    assert int(coverage.max()) == 2

    # Lo que falta construir, lo vacio y lo que no existe.
    assert error_of(client.get(f"{base}/plane/1/5")) == (409, "not_ready", True)
    assert error_of(client.get(f"{base}/aux/1/5")) == (409, "not_ready", True)
    assert error_of(client.get(f"{base}/cube")) == (409, "not_ready", True)
    assert error_of(client.get(f"{base}/cube", params={"rev": 1})) == (409, "not_ready", True)
    for url in (f"{base}/plane/1/1", f"{base}/aux/2/6", f"{base}/plane/3/3", f"{base}/aux/9/3"):
        assert error_of(client.get(url)) == (404, "not_found", False), url

    # Desde `listed` hay epocas: la trayectoria ya se puede pedir.
    track = client.get(f"{base}/track", params={"name": "Barnard's Star"})
    assert track.status_code == 200
    assert [item.epoch for item in TrackResponse.model_validate(track.json()).positions] == [1, 2]

    # Cambio de banda mientras carga: 204, y lo que falta pedir se reordena.
    reordered = client.post(f"{base}/priority", json={"band": 5})
    assert reordered.status_code == 204 and reordered.content == b""
    # Un pedido igual se suma al trabajo: 202 con el documento actual.
    joined = client.post("/api/field", json={"ra": 269.4463, "dec": 4.7683, "band": 5})
    assert joined.status_code == 202
    assert FieldResponse.model_validate(joined.json()).status == "downloading"

    # 5. Terminado.
    harness.irsa.resume.set()
    assert harness.manager.wait_idle(20.0)
    assert harness.irsa.calls[4:7] == ["E1D3N2", "E1D5N0", "E1D5N1"]  # la banda 5 paso adelante
    final = get_meta(client, created.id)
    assert (final.status, final.rev, final.progress.phase) == ("ready", 1, "done")
    assert final.planes is not None
    with_data = [(plane.epoch, plane.detector) for plane in final.planes if plane.status == "ready"]
    assert with_data == [(1, 3), (1, 5), (2, 3)]

    full = expected_plane(harness, [f"E1D3N{order}" for order in range(4)])
    current = client.get(f"{base}/plane/1/3", params={"rev": 2})
    assert (current.headers["cache-control"], current.headers["x-plane-rev"]) == (IMMUTABLE, "2")
    assert current.content == full.image.astype("<f4").tobytes() != provisional.content
    # La URL de la revision provisoria ahora trae la definitiva: lo dice la cabecera y no es inmutable.
    replaced = client.get(f"{base}/plane/1/3", params={"rev": 1})
    assert replaced.content == current.content
    assert (replaced.headers["cache-control"], replaced.headers["x-plane-rev"]) == ("no-cache", "2")
    # El plano de dos exposiciones tuvo provisoria con la primera; el definitivo es la revision 2.
    assert client.get(f"{base}/plane/1/5", params={"rev": 2}).headers["cache-control"] == IMMUTABLE

    # Capas auxiliares: comprimidas como estan en disco, o sin comprimir si el cliente no acepta gzip.
    packed = client.get(f"{base}/aux/1/3", headers={"Accept-Encoding": "gzip"})
    assert (packed.headers["content-encoding"], packed.headers["x-plane-rev"]) == ("gzip", "2")
    plain = client.get(f"{base}/aux/1/3", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers and plain.headers["content-length"] == str(AUX_NBYTES)
    assert (plain.headers["cache-control"], plain.headers["x-plane-rev"]) == ("no-cache", "2")
    assert plain.content == packed.content
    flags, coverage = split_aux(plain.content, SHAPE)
    assert np.array_equal(flags, full.flags) and np.array_equal(coverage, full.coverage)

    # El cubo: los planos con datos en el orden de `planes`, en los offsets del documento (contrato 6).
    cube = client.get(f"{base}/cube", params={"rev": 1})
    assert cube.status_code == 200
    assert cube.headers["content-type"] == "application/octet-stream"
    assert cube.headers["content-length"] == str(3 * PLANE_NBYTES) and len(cube.content) == 3 * PLANE_NBYTES
    assert cube.headers["cache-control"] == IMMUTABLE
    for plane in final.planes:
        if plane.status != "ready":
            assert plane.cube_offset is None
            continue
        assert plane.cube_offset is not None
        chunk = cube.content[plane.cube_offset : plane.cube_offset + PLANE_NBYTES]
        assert chunk == client.get(f"{base}/plane/{plane.epoch}/{plane.detector}").content
    for params in (None, {"rev": 0}, {"rev": 2}):
        response = client.get(f"{base}/cube", params=params)
        assert response.content == cube.content and response.headers["cache-control"] == "no-cache", params

    # 6. El mismo pedido ahora esta en cache: 200 con el documento completo, sin tocar IRSA.
    calls = len(harness.irsa.calls)
    again = client.post("/api/field", json={"ra": 269.4463, "dec": 4.7683, "band": 1})
    assert again.status_code == 200
    cached = FieldResponse.model_validate(again.json())
    assert (cached.id, cached.status) == (created.id, "ready") and cached.meta == final
    assert len(harness.irsa.calls) == calls and harness.irsa.list_calls == [False]
    assert client.post(f"{base}/priority", json={"band": 2}).status_code == 204  # no hace nada
    events, pings = parse_sse(client.get(created.events_url).text)
    assert [(event.id, event.event) for event in events] == [(1, "state"), (2, "done")] and pings == 0
    assert FieldMeta.model_validate(events[0].data) == final
    assert events[1].data == {"status": "ready", "rev": 1, "elapsed_s": final.progress.elapsed_s}


# ------------------------------------------------------------------ metadatos


def test_meta_has_an_etag_and_answers_304(build: HarnessFactory) -> None:
    harness = serial(build)
    harness.irsa.gate = threading.Event()
    client = client_of(harness)
    created = client.post("/api/field", json={"ra": 10.0, "dec": 20.0}).json()
    url = f"/api/field/{created['id']}/meta"
    wait_until(lambda: len(harness.irsa.calls) == 1)  # listado, con la primera descarga retenida

    first = client.get(url)
    assert first.status_code == 200
    assert first.headers["content-type"] == "application/json"
    assert first.headers["cache-control"] == "no-cache"
    etag = first.headers["etag"]
    assert etag.startswith('"') and etag.endswith('"') and len(etag) == 34
    for header in (etag, f"W/{etag}", f'"otro", {etag}', "*"):
        unchanged = client.get(url, headers={"If-None-Match": header})
        assert unchanged.status_code == 304 and unchanged.content == b"", header
        assert unchanged.headers["etag"] == etag and unchanged.headers["cache-control"] == "no-cache"
    assert client.get(url, headers={"If-None-Match": '"otro"'}).status_code == 200

    harness.irsa.gate.set()
    assert harness.manager.wait_idle(20.0)
    changed = client.get(url, headers={"If-None-Match": etag})
    assert changed.status_code == 200 and changed.headers["etag"] != etag
    assert FieldMeta.model_validate(changed.json()).status == "ready"
    # Terminado, el documento ya no cambia: mismo `ETag` en cada pedido.
    assert client.get(url).headers["etag"] == changed.headers["etag"]


# -------------------------------------------------------------------- pedidos


def test_post_normalizes_the_request_and_is_idempotent(build: HarnessFactory) -> None:
    harness = serial(build, {(1, 3): 1})
    harness.irsa.list_gate = threading.Event()
    client = client_of(harness)
    # `ra` fuera de [0, 360), mas de 4 decimales, un `fov` chico (va al escalon base) y enteros como numeros.
    first = client.post("/api/field", json={"ra": 370.00004, "dec": 20, "fov": 0.05, "band": 6})
    assert first.status_code == 202
    created = FieldResponse.model_validate(first.json())
    assert created.meta.request.model_dump() == {"ra": 10.0, "dec": 20.0, "fov": 0.1667}
    assert created.id == geometry.field_id(10.0, 20.0, 0.1667)
    assert created.meta.preview.band == "W2"  # la vista provisoria queda con la banda del pedido (contrato 4.10)
    # El mismo campo pedido de otra forma es el mismo trabajo.
    same = client.post("/api/field", json={"ra": 10.0, "dec": 20.00001})
    assert same.status_code == 202 and same.json()["id"] == created.id
    assert harness.manager.queue_state().active == (created.id,)
    # Otro escalon es otro campo.
    wide = client.post("/api/field", json={"ra": 10.0, "dec": 20.0, "fov": 0.4})
    assert wide.status_code == 202 and wide.json()["id"] == geometry.field_id(10.0, 20.0, 0.5) != created.id
    assert wide.json()["meta"]["request"]["fov"] == 0.5
    harness.irsa.list_gate.set()
    assert harness.manager.wait_idle(20.0)
    done = client.post("/api/field", json={"ra": 10.0, "dec": 20.0, "refresh": False})
    assert done.status_code == 200 and done.json()["status"] == "ready"


@pytest.mark.parametrize(
    "body",
    [
        {"ra": 10.0, "dec": 100.0},
        {"ra": 10.0, "dec": 20.0, "fov": 0.9},
        {"ra": 10.0, "dec": 20.0, "fov": 0.001},
        {"ra": 10.0, "dec": 20.0, "band": 7},
        {"ra": 10.0, "dec": 20.0, "band": 0},
        {"ra": 10.0},
        {"ra": "diez", "dec": 20.0},
        {"ra": "10.0", "dec": 20.0},
        {"ra": 10.0, "dec": 20.0, "band": "3"},
        {"ra": 10.0, "dec": 20.0, "band": 3.5},
        {"ra": 10.0, "dec": 20.0, "refresh": "si"},
        {},
        [1, 2],
    ],
)
def test_invalid_requests_get_the_contract_error(build: HarnessFactory, body: Any) -> None:
    harness = serial(build)
    client = client_of(harness)
    assert error_of(client.post("/api/field", json=body)) == (422, "invalid_request", False)
    assert harness.manager.queue_state().active == () and harness.irsa.list_calls == []


def test_framework_errors_and_unknown_resources(build: HarnessFactory) -> None:
    harness = serial(build, {(1, 3): 1})
    client = client_of(harness)
    # Cuerpo que no es JSON y metodo no admitido: `invalid_request` con 422 (contrato, seccion 2).
    not_json = client.post("/api/field", content=b"no es json", headers={"Content-Type": "application/json"})
    assert error_of(not_json) == (422, "invalid_request", False)
    wrong_method = client.put("/api/field", json={"ra": 10.0, "dec": 20.0})
    assert error_of(wrong_method) == (422, "invalid_request", False)
    assert wrong_method.headers["allow"] == "POST"
    assert error_of(client.delete("/api/field/abc/meta")) == (422, "invalid_request", False)
    # Rutas que no existen.
    for url in ("/api/otra", "/api/field/abc", "/otra", "/api/field/abc/plane/1"):
        assert error_of(client.get(url)) == (404, "not_found", False), url

    # Un campo que no existe, en cada ruta. Tambien un `id` que no puede ser el nombre de una carpeta.
    for field_id in ("ffffffffffffffff", "NO-ES-UN-ID", "a" * 80):
        unknown = f"/api/field/{field_id}"
        for url in ("/meta", "/events", "/plane/1/1", "/cube", "/aux/1/1", "/preview", "/track?name=x"):
            assert error_of(client.get(unknown + url)) == (404, "not_found", False), (field_id, url)
        assert error_of(client.post(f"{unknown}/priority", json={"band": 3})) == (404, "not_found", False)
    assert client.get("/api/field/../meta").status_code == 404

    created = client.post("/api/field", json={"ra": 10.0, "dec": 20.0}).json()
    assert harness.manager.wait_idle(20.0)
    base = f"/api/field/{created['id']}"
    for url, params in [
        (f"{base}/plane/uno/3", None),
        (f"{base}/plane/1/3.5", None),
        (f"{base}/aux/1/tres", None),
        (f"{base}/plane/1/3", {"rev": "x"}),
        (f"{base}/plane/1/3", {"rev": -1}),
        (f"{base}/cube", {"rev": "ultima"}),
        (f"{base}/cube", {"rev": -1}),
        (f"{base}/track", None),
        (f"{base}/track", {"name": "   "}),
    ]:
        assert error_of(client.get(url, params=params)) == (422, "invalid_request", False), (url, params)
    for body in ({"band": 9}, {"band": 0}, {"band": "3"}, {}, {"banda": 3}):
        assert error_of(client.post(f"{base}/priority", json=body)) == (422, "invalid_request", False), body
    assert client.get("/openapi.json").status_code == 200


# ------------------------------------------------------------- cola y fallas


def test_a_full_queue_answers_429_with_retry_after(build: HarnessFactory) -> None:
    harness = serial(build, {(1, 3): 1}, max_active_jobs=1, max_queued_jobs=1)
    harness.irsa.list_gate = threading.Event()
    client = client_of(harness)
    active = client.post("/api/field", json={"ra": 10.0, "dec": 20.0})
    waiting = client.post("/api/field", json={"ra": 11.0, "dec": 20.0})
    assert (active.status_code, waiting.status_code) == (202, 202)
    assert waiting.json()["status"] == "queued" and waiting.json()["meta"]["progress"]["queue_position"] == 1

    full = client.post("/api/field", json={"ra": 12.0, "dec": 20.0})
    assert error_of(full) == (429, "queue_full", True)
    assert full.headers["retry-after"] == "30"
    # Los campos que ya tienen trabajo se siguen atendiendo con la cola llena.
    assert client.post("/api/field", json={"ra": 11.0, "dec": 20.0}).status_code == 202

    # El que espera lo dice en su flujo: `state` con la posicion y, cuando le toca, todo lo demas.
    events_url = waiting.json()["events_url"]
    waiting_id = waiting.json()["id"]
    opener = when_subscribed(lambda: harness.bus.subscriber_count(waiting_id), harness.irsa.list_gate.set)
    events, _ = parse_sse(client.get(events_url).text)
    opener.join()
    assert events[0].event == "state" and events[0].data["progress"]["queue_position"] == 1
    assert events[0].data["status"] == "queued"
    assert [event.event for event in events[-2:]] == ["state", "done"]
    assert harness.manager.wait_idle(20.0)
    assert client.post("/api/field", json={"ra": 12.0, "dec": 20.0}).status_code == 202
    assert harness.manager.wait_idle(20.0)


def test_a_point_without_coverage(build: HarnessFactory) -> None:
    harness = serial(build, {})  # ninguna exposicion cubre el punto
    client = client_of(harness)
    posted = client.post("/api/field", json={"ra": 30.0, "dec": -5.0})
    assert posted.status_code == 202  # todavia no se sabe
    events, _ = parse_sse(client.get(posted.json()["events_url"]).text)
    assert events[0].event == "state" and events[-1].event == "error"
    assert set(events[-1].data) == {"error"}
    assert (events[-1].data["error"]["code"], events[-1].data["error"]["retryable"]) == ("no_coverage", False)
    assert harness.manager.wait_idle(20.0)
    # Ya se sabe: el pedido siguiente lo responde el `POST`, sin crear otro trabajo.
    assert error_of(client.post("/api/field", json={"ra": 30.0, "dec": -5.0})) == (404, "no_coverage", False)
    assert harness.irsa.list_calls == [False]


def test_a_failed_job_answers_not_ready_without_retry_and_a_new_post_retries(build: HarnessFactory) -> None:
    harness = serial(build, {(1, 3): 2, (1, 6): 2})
    harness.pipeline.fail_at = 3  # falla interna al procesar el tercer recorte: el plano (1, 3) ya esta listo
    client = client_of(harness)
    posted = client.post("/api/field", json={"ra": 10.0, "dec": 20.0})
    base = f"/api/field/{posted.json()['id']}"
    assert harness.manager.wait_idle(20.0)

    failed = get_meta(client, posted.json()["id"])
    assert failed.status == "failed" and failed.rev == 0
    assert failed.progress.phase == "downloading"  # queda en la fase en la que estaba (contrato, seccion 5)
    # Lo que se llego a construir se sigue sirviendo.
    built = client.get(f"{base}/plane/1/3", params={"rev": 2})
    assert built.status_code == 200 and built.headers["x-plane-rev"] == "2"
    assert client.get(f"{base}/aux/1/3").status_code == 200
    # Lo que no, no va a estar: `not_ready` con `retryable` en falso.
    for url in (f"{base}/cube", f"{base}/plane/1/6", f"{base}/aux/1/6"):
        assert error_of(client.get(url)) == (409, "not_ready", False), url
    assert error_of(client.get(f"{base}/plane/1/1")) == (404, "not_found", False)
    # El flujo de un trabajo fallido: `state`, el mismo `error` y cierre.
    events, _ = parse_sse(client.get(f"{base}/events").text)
    assert [event.event for event in events] == ["state", "error"]
    assert events[0].data["status"] == "failed"
    assert (events[1].data["error"]["code"], events[1].data["error"]["retryable"]) == ("upstream_unavailable", True)
    assert client.post(f"{base}/priority", json={"band": 6}).status_code == 204  # no hace nada

    # Otro `POST` lo reintenta: 202, y esta vez termina. Las revisiones siguen numerando.
    retried = client.post("/api/field", json={"ra": 10.0, "dec": 20.0})
    assert retried.status_code == 202 and retried.json()["status"] == "queued"
    assert harness.manager.wait_idle(20.0)
    final = get_meta(client, posted.json()["id"])
    assert final.status == "ready"
    plane = final.plane(1, 3)
    assert plane is not None and plane.rev == 4
    assert client.get(f"{base}/plane/1/3", params={"rev": 4}).headers["cache-control"] == IMMUTABLE
    assert client.get(f"{base}/cube").status_code == 200


def test_a_job_that_fails_before_listing(build: HarnessFactory) -> None:
    harness = serial(build, {(1, 3): 1}, preview="down")
    harness.irsa.list_error = IrsaTransient("IRSA no responde (simulado)")
    client = client_of(harness)
    posted = client.post("/api/field", json={"ra": 10.0, "dec": 20.0})
    base = f"/api/field/{posted.json()['id']}"
    assert harness.manager.wait_idle(20.0)
    failed = get_meta(client, posted.json()["id"])
    assert (failed.status, failed.progress.phase, failed.grid) == ("failed", "listing", None)
    for url in (f"{base}/cube", f"{base}/plane/1/3", f"{base}/aux/1/3"):
        assert error_of(client.get(url)) == (409, "not_ready", False), url
    assert error_of(client.get(f"{base}/track", params={"name": "10 20"})) == (409, "not_ready", False)
    # La vista provisoria se descarto: no es un error del campo, pero el recurso no existe.
    assert failed.preview.status == "unavailable"
    assert error_of(client.get(f"{base}/preview")) == (404, "not_found", False)
    events, _ = parse_sse(client.get(f"{base}/events").text)
    assert [event.event for event in events] == ["state", "error"]
    assert events[1].data["error"]["code"] == "upstream_unavailable"


def test_a_partial_field_is_served_like_a_finished_one(build: HarnessFactory) -> None:
    harness = serial(build, {(1, 3): 3, (2, 3): 2})
    harness.irsa.script["E1D3N1"] = [IrsaPermanent("422 Arrays do not overlap (simulado)")]
    client = client_of(harness)
    posted = client.post("/api/field", json={"ra": 10.0, "dec": 20.0})
    base = f"/api/field/{posted.json()['id']}"
    events, _ = parse_sse(client.get(f"{base}/events").text)
    assert events[-1].event == "done" and events[-1].data["status"] == "partial"
    assert harness.manager.wait_idle(20.0)
    again = client.post("/api/field", json={"ra": 10.0, "dec": 20.0})
    assert again.status_code == 200 and again.json()["status"] == "partial"  # terminado: 200
    meta = FieldMeta.model_validate(again.json()["meta"])
    plane = meta.plane(1, 3)
    assert plane is not None and (plane.status, plane.n_used, plane.n_failed) == ("partial", 2, 1)
    assert "cutouts_failed" in [warning.code for warning in meta.warnings]
    assert client.get(f"{base}/plane/1/3", params={"rev": plane.rev}).headers["cache-control"] == IMMUTABLE
    cube = client.get(f"{base}/cube", params={"rev": meta.rev})
    assert len(cube.content) == 2 * PLANE_NBYTES and cube.headers["cache-control"] == IMMUTABLE


# -------------------------------------------------------------------- refresh


def test_refresh_serves_the_old_revision_until_the_new_one_is_ready(build: HarnessFactory) -> None:
    harness = serial(build, {(1, 3): 2, (1, 6): 2})
    client = client_of(harness)
    body = {"ra": 10.0, "dec": 20.0}
    created = client.post("/api/field", json=body).json()
    base = f"/api/field/{created['id']}"
    assert harness.manager.wait_idle(20.0)
    old = get_meta(client, created["id"])
    old_plane = client.get(f"{base}/plane/1/3", params={"rev": 2})
    old_cube = client.get(f"{base}/cube", params={"rev": 1})
    assert (old.rev, old_plane.headers["cache-control"], old_cube.headers["cache-control"]) == (1, IMMUTABLE, IMMUTABLE)

    # IRSA publico una exposicion mas del plano (1, 3). El `refresh` vuelve a listar en un trabajo aparte.
    harness.irsa.exposures = make_exposures({(1, 3): 3, (1, 6): 2})
    harness.irsa.gate = threading.Event()
    calls = len(harness.irsa.calls)
    refreshed = client.post("/api/field", json={**body, "refresh": True})
    # Responde enseguida con lo que hay: el campo sigue terminado, en su revision anterior (contrato, seccion 11).
    assert refreshed.status_code == 200 and FieldMeta.model_validate(refreshed.json()["meta"]) == old
    wait_until(lambda: len(harness.irsa.calls) == calls + 1)  # el refresh esta bajando, y queda retenido
    assert harness.manager.queue_state().refreshing == (created["id"],)
    assert get_meta(client, created["id"]) == old
    during = client.get(f"{base}/plane/1/3", params={"rev": 2})
    assert (during.content, during.headers["cache-control"]) == (old_plane.content, IMMUTABLE)
    assert client.get(f"{base}/cube", params={"rev": 1}).content == old_cube.content
    events, _ = parse_sse(client.get(f"{base}/events").text)
    assert [event.event for event in events] == ["state", "done"] and events[1].data["rev"] == 1
    # Otro `refresh` mientras tanto no arranca otro trabajo.
    assert client.post("/api/field", json={**body, "refresh": True}).status_code == 200
    assert harness.irsa.list_calls == [False, True]

    harness.irsa.gate.set()
    assert harness.manager.wait_idle(20.0)
    new = get_meta(client, created["id"])
    changed, same = new.plane(1, 3), new.plane(1, 6)
    assert changed is not None and same is not None
    assert (new.rev, changed.rev, changed.n_used, same.rev) == (2, 3, 3, 2)
    # La URL de la revision anterior del plano que cambio ya no es inmutable, y dice que trae la nueva.
    replaced = client.get(f"{base}/plane/1/3", params={"rev": 2})
    assert (replaced.headers["cache-control"], replaced.headers["x-plane-rev"]) == ("no-cache", "3")
    assert replaced.content != old_plane.content
    current = client.get(f"{base}/plane/1/3", params={"rev": 3})
    assert (current.headers["cache-control"], current.content) == (IMMUTABLE, replaced.content)
    assert client.get(f"{base}/aux/1/3").headers["x-plane-rev"] == "3"
    # El plano que no cambio conserva su revision: el navegador no lo vuelve a bajar.
    assert client.get(f"{base}/plane/1/6", params={"rev": 2}).headers["cache-control"] == IMMUTABLE
    # Lo mismo con el cubo y la revision del campo.
    assert client.get(f"{base}/cube", params={"rev": 1}).headers["cache-control"] == "no-cache"
    new_cube = client.get(f"{base}/cube", params={"rev": 2})
    assert new_cube.headers["cache-control"] == IMMUTABLE and new_cube.content != old_cube.content
    assert new_cube.content[:PLANE_NBYTES] == current.content


def test_cube_is_read_with_the_lock_that_a_refresh_takes_to_swap_planes(build: HarnessFactory) -> None:
    """El documento y los planos del cubo se leen juntos: nunca planos de una revision con el rotulo de otra."""
    harness = serial(build, {(1, 3): 1, (1, 6): 1})
    client = client_of(harness)
    created = client.post("/api/field", json={"ra": 10.0, "dec": 20.0}).json()
    assert harness.manager.wait_idle(20.0)
    url = f"/api/field/{created['id']}/cube"
    answers: list[Any] = []
    reader = threading.Thread(target=lambda: answers.append(TestClient(client.app).get(url, params={"rev": 1})))
    with harness.manager.swap_lock:  # un refresh esta reemplazando planos
        reader.start()
        reader.join(0.3)
        assert reader.is_alive() and not answers  # el cubo espera
        # Los metadatos no dependen de ese candado.
        assert client.get(f"/api/field/{created['id']}/meta").status_code == 200
    reader.join(10.0)
    assert len(answers) == 1 and answers[0].status_code == 200
    assert len(answers[0].content) == 2 * PLANE_NBYTES and answers[0].headers["cache-control"] == IMMUTABLE


# ------------------------------------------------------------ capas auxiliares


@pytest.mark.parametrize(
    ("accept", "compressed"),
    [
        ("gzip", True),
        ("gzip, deflate, br", True),
        ("br;q=1.0, gzip;q=0.5", True),
        ("*", True),
        ("identity", False),
        ("gzip;q=0", False),
        ("br, *;q=0", False),
        ("", False),
    ],
)
def test_aux_is_gzipped_only_if_the_client_accepts_it(build: HarnessFactory, accept: str, compressed: bool) -> None:
    harness = serial(build, {(1, 3): 1})
    client = client_of(harness)
    posted = client.post("/api/field", json={"ra": 10.0, "dec": 20.0})
    assert harness.manager.wait_idle(20.0)
    url = f"/api/field/{posted.json()['id']}/aux/1/3"
    stored = harness.store.read_aux_gzip(posted.json()["id"], 1, 3, shape=SHAPE)
    # Se mira lo que viaja, sin que el cliente lo descomprima.
    with client.stream("GET", url, headers={"Accept-Encoding": accept}) as response:
        raw = b"".join(response.iter_raw())
    assert response.status_code == 200
    assert response.headers["vary"] == "Accept-Encoding" and response.headers["x-plane-rev"] == "1"
    if compressed:
        assert response.headers["content-encoding"] == "gzip"
        assert raw == stored and len(raw) < AUX_NBYTES / 4  # tal como esta en disco: comprime unas 8 veces o mas
    else:
        assert "content-encoding" not in response.headers
        assert raw == gzip.decompress(stored) and len(raw) == AUX_NBYTES


# ------------------------------------------------------------ vista provisoria


def test_preview_unavailable_is_not_found_and_the_field_goes_on(build: HarnessFactory) -> None:
    harness = serial(build, {(1, 3): 1}, preview="down")
    client = client_of(harness)
    posted = client.post("/api/field", json={"ra": 10.0, "dec": 20.0})
    assert harness.manager.wait_idle(20.0)
    meta = get_meta(client, posted.json()["id"])
    assert (meta.status, meta.preview.status, meta.preview.display) == ("ready", "unavailable", None)
    assert error_of(client.get(f"/api/field/{meta.id}/preview")) == (404, "not_found", False)


def test_preview_of_a_cached_field(build: HarnessFactory) -> None:
    harness = serial(build, {(1, 6): 1})
    client = client_of(harness)
    posted = client.post("/api/field", json={"ra": 10.0, "dec": 20.0, "band": 6})
    assert harness.manager.wait_idle(20.0)
    meta = get_meta(client, posted.json()["id"])
    assert (meta.preview.status, meta.preview.band, meta.preview.wave_um) == ("ready", "W2", 4.6)
    preview = client.get(f"/api/field/{meta.id}/preview")
    assert preview.status_code == 200 and preview.headers["content-length"] == str(PLANE_NBYTES)
    assert preview.content == preview_image(geometry.build_grid(harness.request())).astype("<f4").tobytes()
    # Si el archivo falta, el recurso no existe.
    (harness.settings.cached_fields_dir / meta.id / "preview.f32").unlink()
    assert error_of(client.get(f"/api/field/{meta.id}/preview")) == (404, "not_found", False)


# ---------------------------------------------------------------------- salud


def test_health(build: HarnessFactory) -> None:
    harness = serial(build)
    response = client_of(harness).get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "pipeline": harness.settings.pipeline_version}
