"""`GET /api/resolve` y `GET /api/field/{id}/track` de la aplicacion real (contrato 4.8 y 4.9).

Sin red: los nombres salen de una cache de Sesame sembrada con las respuestas
guardadas en tests/fixtures, o de un servidor HTTP local que hace de Sesame.
"""

from __future__ import annotations

import itertools
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import pytest
from fastapi.testclient import TestClient
from test_api_support import FIXTURES, SAVED_SESAME, LiveServer, error_of, seed_sesame
from test_irsa_support import Behaviour, Hit, IrsaStub, respond
from test_jobs_support import Harness, HarnessFactory, harness_factory

from app.api.main import create_app
from app.config import Settings
from app.contract import FieldMeta, ResolveResponse, TrackResponse
from app.jobs.store import track_filename
from app.resolve.sesame import cache_path

UNKNOWN_XML = (FIXTURES / "sesame_extra" / "nombre_inexistente.xml").read_bytes()
CDS_DOWN_HTML = (FIXTURES / "sesame_extra" / "cds_page_unavailable.html").read_bytes()

# Centro del campo de Barnard's Star en 2026.0 (contrato 4.8).
BARNARD_FIELD = {"ra": 269.4463, "dec": 4.7683}


@pytest.fixture
def build(tmp_path: Path) -> Iterator[HarnessFactory]:
    with harness_factory(tmp_path) as factory:
        yield factory


@pytest.fixture
def stub() -> Iterator[IrsaStub]:
    server = IrsaStub()
    try:
        yield server
    finally:
        server.close()


def sesame(answers: dict[str, bytes], *, delay_s: float = 0.0) -> Behaviour:
    """Conducta de un Sesame local: la respuesta guardada del nombre pedido o, si no lo conoce, la de "no existe"."""

    def behaviour(handler: Any, hit: Hit) -> None:
        name = unquote(handler.path.split("?", 1)[1])
        if delay_s:
            time.sleep(delay_s)
        respond(200, answers.get(name, UNKNOWN_XML), content_type="text/xml")(handler, hit)

    return behaviour


def offline(tmp_path: Path, **overrides: Any) -> Settings:
    """Configuracion sin servidores de Sesame: lo que no este en la cache termina en `upstream_unavailable`."""
    values: dict[str, Any] = {"data_dir": tmp_path / "data", "cache_dir": tmp_path / "cache", "sesame_urls": ()}
    values.update(overrides)
    return Settings(**values)


# --------------------------------------------------------------------- resolve


def test_resolve_a_name_is_the_example_of_the_contract(tmp_path: Path) -> None:
    settings = offline(tmp_path)
    seed_sesame(settings)
    client = TestClient(create_app(settings))
    response = client.get("/api/resolve", params={"name": "  Barnard's   Star "})
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/json"
    assert response.json() == {
        "query": "Barnard's Star",
        "name": "NAME Barnard's star",
        "source": "sesame",
        "object_type": "BY*",
        "j2000": {"ra": 269.452077, "dec": 4.693365},
        "motion": {
            "pm_ra": -801.551,
            "pm_dec": 10362.394,
            "parallax": 546.976,
            "radial_velocity": -110.11,
            "per_year_arcsec": 10.39,
        },
        "field_center": {"ra": 269.4463, "dec": 4.7683, "epoch": 2026.0},
        "moved_arcsec": 270.4,
    }
    # Lo que el catalogo no trae va como `null`, no se omite ni va en 0.
    wise = client.get("/api/resolve", params={"name": "WISE J085510.83-071442.5"}).json()
    assert wise["motion"]["radial_velocity"] is None and wise["field_center"]["ra"] == 133.7598
    fixed = client.get("/api/resolve", params={"name": "Abell 2218"}).json()
    assert fixed["motion"] is None and fixed["name"] == "ACO 2218" and fixed["moved_arcsec"] == 0.0


def test_resolve_coordinates_without_asking_anyone(tmp_path: Path) -> None:
    client = TestClient(create_app(offline(tmp_path)))  # sin cache y sin servidores
    for text in ("269.4463 4.7683", "269.4463, +4.7683", "17:57:47.112 +04:46:05.88"):
        response = client.get("/api/resolve", params={"name": text})
        assert response.status_code == 200, text
        resolved = ResolveResponse.model_validate(response.json())
        assert (resolved.source, resolved.name, resolved.object_type, resolved.motion) == (
            "coordinates", None, None, None,
        )  # fmt: skip
        assert (resolved.field_center.ra, resolved.field_center.dec, resolved.field_center.epoch) == (
            269.4463, 4.7683, 2026.0,
        )  # fmt: skip
    assert response.json()["name"] is None and response.json()["motion"] is None  # van como null
    assert not (tmp_path / "cache").exists()


def test_resolve_errors(tmp_path: Path) -> None:
    client = TestClient(create_app(offline(tmp_path)))
    for params in ({"name": ""}, {"name": "   "}, {}, {"name": "10 95"}, {"name": "25:00:00 +10:00:00"}):
        assert error_of(client.get("/api/resolve", params=params)) == (422, "invalid_request", False), params
    assert error_of(client.get("/api/resolve", params={"name": "x" * 300})) == (422, "invalid_request", False)
    # Un nombre que no esta en la cache, sin ningun servidor que responda.
    assert error_of(client.get("/api/resolve", params={"name": "Proxima Centauri"})) == (
        503, "upstream_unavailable", True,
    )  # fmt: skip
    assert error_of(client.post("/api/resolve", params={"name": "10 20"})) == (422, "invalid_request", False)


def test_resolve_asks_sesame_and_keeps_the_answer(tmp_path: Path, stub: IrsaStub) -> None:
    barnard_xml = SAVED_SESAME["Barnard's Star"][0].read_bytes()
    stub.routes["/sesame"] = sesame({"Barnard's Star": barnard_xml})
    settings = offline(tmp_path, sesame_urls=(stub.url("/sesame?"),), sesame_timeout_s=5.0)
    client = TestClient(create_app(settings))

    first = client.get("/api/resolve", params={"name": "Barnard's Star"})
    assert first.status_code == 200 and first.json()["name"] == "NAME Barnard's star"
    assert [hit.path for hit in stub.hits] == ["/sesame"]
    assert cache_path("Barnard's Star", settings).read_bytes() == barnard_xml
    # La segunda vez sale de la cache (contrato, seccion 11).
    assert client.get("/api/resolve", params={"name": "Barnard's Star"}).json() == first.json()
    assert len(stub.hits) == 1

    # Sesame no conoce el nombre: 404 `not_resolved`, y no se guarda.
    unknown = client.get("/api/resolve", params={"name": "Objeto Inexistente 12345"})
    assert error_of(unknown) == (404, "not_resolved", False)
    assert not cache_path("Objeto Inexistente 12345", settings).exists()


def test_a_cds_error_page_is_upstream_unavailable_not_an_unknown_name(tmp_path: Path, stub: IrsaStub) -> None:
    stub.routes["/sesame"] = respond(404, CDS_DOWN_HTML, content_type="text/html")
    stub.routes["/mirror"] = respond(200, CDS_DOWN_HTML, content_type="text/html")
    settings = offline(tmp_path, sesame_urls=(stub.url("/sesame?"), stub.url("/mirror?")), sesame_timeout_s=5.0)
    client = TestClient(create_app(settings))
    response = client.get("/api/resolve", params={"name": "Barnard's Star"})
    assert error_of(response) == (503, "upstream_unavailable", True)
    assert {hit.path for hit in stub.hits} == {"/sesame", "/mirror"}


def test_a_slow_sesame_does_not_block_the_other_requests(tmp_path: Path, stub: IrsaStub) -> None:
    """Sesame se consulta en un hilo: mientras tarda, el bucle de asyncio sigue atendiendo."""
    barnard_xml = SAVED_SESAME["Barnard's Star"][0].read_bytes()
    stub.routes["/sesame"] = sesame({"Barnard's Star": barnard_xml}, delay_s=1.0)
    settings = offline(tmp_path, sesame_urls=(stub.url("/sesame?"),), sesame_timeout_s=5.0)
    with LiveServer(create_app(settings)) as server:
        result: list[tuple[int, float]] = []

        def resolve() -> None:
            started = time.perf_counter()
            status, _, _ = server.request("GET", "/api/resolve?name=Barnard%27s%20Star")
            result.append((status, time.perf_counter() - started))

        slow = threading.Thread(target=resolve)
        slow.start()
        while not stub.hits:  # el pedido a Sesame ya esta en curso
            time.sleep(0.005)
        started = time.perf_counter()
        for _ in range(5):
            status, _, body = server.request("GET", "/api/health")
            assert status == 200 and b'"ok"' in body
        quick = time.perf_counter() - started
        slow.join(10.0)
    assert result and result[0][0] == 200 and result[0][1] >= 1.0
    assert quick < 0.8, f"cinco pedidos de /api/health tardaron {quick:.2f} s con Sesame colgado"


# ----------------------------------------------------------------------- track


def finished_field(harness: Harness, client: TestClient, **body: Any) -> FieldMeta:
    """Pide un campo, espera a que termine y devuelve su documento."""
    posted = client.post("/api/field", json={**BARNARD_FIELD, **body})
    assert posted.status_code == 202, posted.text
    assert harness.manager.wait_idle(20.0)
    return FieldMeta.model_validate(client.get(f"/api/field/{posted.json()['id']}/meta").json())


def test_track_of_a_moving_object(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2, (2, 3): 2, (3, 3): 1}, sesame_urls=())
    seed_sesame(harness.settings, ["Barnard's Star"])
    client = TestClient(create_app(manager=harness.manager))
    meta = finished_field(harness, client)
    assert meta.epochs is not None and len(meta.epochs) == 3
    url = f"/api/field/{meta.id}/track"

    response = client.get(url, params={"name": "Barnard's Star"})
    assert response.status_code == 200 and response.headers["content-type"] == "application/json"
    track = TrackResponse.model_validate(response.json())
    assert track.name == "NAME Barnard's star"  # el nombre principal del catalogo, no el texto buscado
    assert set(response.json()["positions"][0]) == {"epoch", "mjd", "ra", "dec", "x", "y", "in_field"}
    # Una posicion por epoca, en su fecha media (contrato 4.9).
    assert [(item.epoch, item.mjd) for item in track.positions] == [
        (epoch.epoch, round(epoch.mjd_mean, 4)) for epoch in meta.epochs
    ]
    assert all(item.in_field for item in track.positions)
    # Barnard sube 10 segundos de arco por anio: unos 3,4 px de la grilla. Las epocas estan a 200 dias.
    ys = [item.y for item in track.positions]
    assert all(1.2 < later - earlier < 2.6 for earlier, later in itertools.pairwise(ys))
    assert all(abs(item.x - 97.0) < 3.0 and abs(item.y - 97.0) < 6.0 for item in track.positions)


def test_track_is_saved_with_the_field_and_served_without_sesame(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2, (2, 3): 2}, sesame_urls=())
    seed_sesame(harness.settings, ["Barnard's Star", "Abell 2218"])
    client = TestClient(create_app(manager=harness.manager))
    meta = finished_field(harness, client)
    url = f"/api/field/{meta.id}/track"
    folder = harness.settings.cached_fields_dir / meta.id
    saved = folder / track_filename("NAME Barnard's star")
    assert not saved.exists()

    first = client.get(url, params={"name": "Barnard's Star"})
    assert first.status_code == 200
    # Quedo guardada con el campo, bajo el nombre principal.
    assert saved.name == "track_name-barnard-s-star.json"
    assert TrackResponse.model_validate_json(saved.read_text(encoding="utf-8")) == TrackResponse.model_validate(
        first.json()
    )
    written = saved.stat().st_mtime_ns

    # Sin la cache de Sesame (y sin servidores): por el nombre principal sale de lo guardado...
    for path in harness.settings.sesame_cache_dir.iterdir():
        path.unlink()
    by_main_name = client.get(url, params={"name": "NAME Barnard's star"})
    assert by_main_name.status_code == 200 and by_main_name.json() == first.json()
    assert client.get(url, params={"name": " NAME   Barnard's star "}).json() == first.json()
    assert saved.stat().st_mtime_ns == written  # y no se vuelve a escribir
    # ...y por otro texto hay que resolverlo primero: sin Sesame no se puede.
    assert error_of(client.get(url, params={"name": "Barnard's Star"})) == (503, "upstream_unavailable", True)
    # El nombre de archivo no distingue mayusculas: otro objeto con el mismo no recibe esta trayectoria.
    assert error_of(client.get(url, params={"name": "name barnard's STAR"})) == (503, "upstream_unavailable", True)


def test_a_saved_track_of_other_epochs_is_computed_again(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2, (2, 3): 2}, sesame_urls=())
    seed_sesame(harness.settings, ["Barnard's Star"], main_names=True)
    client = TestClient(create_app(manager=harness.manager))
    meta = finished_field(harness, client)
    url = f"/api/field/{meta.id}/track"
    fresh = TrackResponse.model_validate(client.get(url, params={"name": "NAME Barnard's star"}).json())
    # Lo guardado es de cuando las epocas eran otras (antes de un `refresh`, por ejemplo): no se sirve.
    stale = fresh.model_copy(deep=True)
    stale.positions[1].mjd += 3.0
    stale.positions[1].y += 0.2
    harness.store.write_track(meta.id, stale)
    again = TrackResponse.model_validate(client.get(url, params={"name": "NAME Barnard's star"}).json())
    assert again == fresh
    assert harness.store.read_track(meta.id, "NAME Barnard's star") == fresh  # y lo guardado quedo corregido


def test_track_without_proper_motion_and_for_coordinates(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2}, sesame_urls=())
    seed_sesame(harness.settings, ["Abell 2218"])
    client = TestClient(create_app(manager=harness.manager))
    meta = finished_field(harness, client)
    url = f"/api/field/{meta.id}/track"
    folder = harness.settings.cached_fields_dir / meta.id

    # Sin movimiento propio: `positions` vacio; la mira va en `field_center`.
    fixed = client.get(url, params={"name": "Abell 2218"})
    assert fixed.status_code == 200 and fixed.json() == {"name": "ACO 2218", "positions": []}
    assert (folder / track_filename("ACO 2218")).is_file()
    # Coordenadas: `name` es el texto buscado. No hay nada que guardar.
    coordinates = client.get(url, params={"name": "269.4463  4.7683"})
    assert coordinates.status_code == 200 and coordinates.json() == {"name": "269.4463 4.7683", "positions": []}
    assert sorted(path.name for path in folder.glob("track_*.json")) == ["track_aco-2218.json"]
    # Errores, los de `/api/resolve`.
    assert error_of(client.get(url, params={"name": "10 95"})) == (422, "invalid_request", False)
    assert error_of(client.get(url, params={"name": " "})) == (422, "invalid_request", False)
    assert error_of(client.get(url)) == (422, "invalid_request", False)
    assert error_of(client.get(url, params={"name": "Proxima Centauri"})) == (503, "upstream_unavailable", True)


def test_track_of_an_unknown_name_is_not_resolved(build: HarnessFactory, stub: IrsaStub) -> None:
    stub.routes["/sesame"] = sesame({})
    harness = build({(1, 3): 2}, sesame_urls=(stub.url("/sesame?"),), sesame_timeout_s=5.0)
    client = TestClient(create_app(manager=harness.manager))
    meta = finished_field(harness, client)
    response = client.get(f"/api/field/{meta.id}/track", params={"name": "Objeto Inexistente 12345"})
    assert error_of(response) == (404, "not_resolved", False)
    assert list((harness.settings.cached_fields_dir / meta.id).glob("track_*.json")) == []


def test_track_of_an_object_on_the_other_side_of_the_sky(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2}, sesame_urls=())
    seed_sesame(harness.settings, ["Barnard's Star", "R Draconis"])
    client = TestClient(create_app(manager=harness.manager))
    # R Draconis sobre el campo de Barnard, a 64 grados: sale, fuera del campo.
    barnard = finished_field(harness, client)
    far = client.get(f"/api/field/{barnard.id}/track", params={"name": "R Draconis"})
    positions = TrackResponse.model_validate(far.json()).positions
    assert far.json()["name"] == "V* R Dra" and len(positions) == 1 and not positions[0].in_field
    # Barnard sobre el campo de WISE 0855, a 130 grados: no tiene pixel en la proyeccion del campo.
    wise = finished_field(harness, client, ra=133.7598, dec=-7.2422)
    assert client.get(f"/api/field/{wise.id}/track", params={"name": "Barnard's Star"}).json() == {
        "name": "NAME Barnard's star",
        "positions": [],
    }
