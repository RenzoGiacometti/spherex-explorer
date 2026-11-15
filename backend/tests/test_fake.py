"""Servidor falso de punta a punta, sobre campos sinteticos armados en un directorio temporal."""

from __future__ import annotations

import itertools
import json
import time
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import PIPELINE_VERSION
from app.contract import (
    EVENT_ADAPTERS,
    ErrorBody,
    FieldMeta,
    FieldResponse,
    ResolveResponse,
    TrackResponse,
)
from app.fake import FakeBackend, create_fake_app, provisional_image
from app.jobs.store import split_aux

if TYPE_CHECKING:
    from conftest import SampleField, SampleFields

IMMUTABLE = "public, max-age=31536000, immutable"

# Respuestas de Sesame sinteticas, con la estructura que lee spike/field.py.
SESAME_MOVING = """<?xml version="1.0" encoding="UTF-8"?>
<Sesame xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Target option="S">
  <name>Estrella de Prueba</name>
  <Resolver name="S=Simbad (CDS, via client/server)">
    <otype>PM*</otype>
    <jradeg>10.0</jradeg>
    <jdedeg>20.0</jdedeg>
    <pm><v>1000.0</v><pa>0</pa><pmRA>0.0</pmRA><pmDE>1000.0</pmDE></pm>
    <Vel><v>-20.0</v></Vel>
    <plx><v>100.0</v></plx>
    <oname>NAME Estrella de prueba</oname>
  </Resolver>
</Target>
</Sesame>
<!--- ====Done (2026-Nov-15,05:01:23z)==== -->
"""

SESAME_FIXED = """<?xml version="1.0" encoding="UTF-8"?>
<Sesame xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Target option="S">
  <name>Galaxia Fija</name>
  <Resolver name="S=Simbad (CDS, via client/server)">
    <otype>G</otype>
    <jradeg>200.123456</jradeg>
    <jdedeg>-30.654321</jdedeg>
    <oname>M 999</oname>
  </Resolver>
</Target>
</Sesame>
"""

# Con movimiento propio y paralaje pero sin velocidad radial (no trae `Vel`), como las
# respuestas guardadas de Epsilon Indi B y WISE 0855.
SESAME_NO_VELOCITY = """<?xml version="1.0" encoding="UTF-8"?>
<Sesame xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Target option="S">
  <name>Enana de Prueba</name>
  <Resolver name="S=Simbad (CDS, via client/server)">
    <otype>BD*</otype>
    <jradeg>50.0</jradeg>
    <jdedeg>-10.0</jdedeg>
    <pm><v>500.0</v><pa>90</pa><pmRA>500.0</pmRA><pmDE>0.0</pmDE></pm>
    <plx><v>250.0</v></plx>
    <oname>ENANA J0320-1000</oname>
  </Resolver>
</Target>
</Sesame>
"""

# Solo movimiento propio: ni paralaje ni velocidad radial.
SESAME_ONLY_MOTION = """<?xml version="1.0" encoding="UTF-8"?>
<Sesame xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Target option="S">
  <name>Movil de Prueba</name>
  <Resolver name="S=Simbad (CDS, via client/server)">
    <otype>PM*</otype>
    <jradeg>120.0</jradeg>
    <jdedeg>0.0</jdedeg>
    <pm><v>360.0</v><pa>0</pa><pmRA>0.0</pmRA><pmDE>360.0</pmDE></pm>
    <oname>MOVIL 1</oname>
  </Resolver>
</Target>
</Sesame>
"""

SESAME_UNKNOWN = """<?xml version="1.0" encoding="UTF-8"?>
<Sesame xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Target option="S">
  <name>no existe</name>
  <INFO>*** Nothing found ***</INFO>
</Target>
</Sesame>
"""


@dataclass
class Sse:
    name: str
    id: int
    data: Any


def parse_sse(text: str) -> tuple[list[Sse], int]:
    """Eventos de un flujo SSE completo y cantidad de comentarios `: ping`."""
    events: list[Sse] = []
    pings = 0
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        if block.startswith(":"):
            assert block == ": ping"
            pings += 1
            continue
        lines = block.split("\n")
        assert [line.split(": ", 1)[0] for line in lines] == ["event", "id", "data"]
        fields = dict(line.split(": ", 1) for line in lines)
        events.append(Sse(fields["event"], int(fields["id"]), json.loads(fields["data"])))
    return events, pings


@pytest.fixture(scope="module")
def sesame_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    root = tmp_path_factory.mktemp("sesame")
    (root / "estrella_de_prueba.xml").write_text(SESAME_MOVING, encoding="utf-8")
    (root / "enana_de_prueba.xml").write_text(SESAME_NO_VELOCITY, encoding="utf-8")
    (root / "movil_de_prueba.xml").write_text(SESAME_ONLY_MOTION, encoding="utf-8")
    (root / "galaxia_fija.xml").write_text(SESAME_FIXED, encoding="utf-8")
    (root / "no_existe.xml").write_text(SESAME_UNKNOWN, encoding="utf-8")
    (root / "roto.xml").write_text("<Sesame><Target>", encoding="utf-8")
    return root


Factory = Callable[..., TestClient]


@pytest.fixture
def make_client(sample_fields: SampleFields, sesame_dir: Path) -> Iterator[Factory]:
    """Crea servidores falsos nuevos (cada uno con su estado) sobre las muestras sinteticas."""
    clients: list[TestClient] = []

    def factory(seconds: float = 1.0, ping_seconds: float = 15.0, fields_dir: Path | None = None) -> TestClient:
        app = create_fake_app(
            fields_dir or sample_fields.root, sesame_dir=sesame_dir, seconds=seconds, ping_seconds=ping_seconds
        )
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for client in clients:
        client.__exit__(None, None, None)


def backend_of(client: TestClient) -> FakeBackend:
    app = client.app
    assert isinstance(app, FastAPI)
    return app.state.fake


class Clock:
    """Reloj del servidor para los tests.

    Queda quieto en el instante que se le indique (segundos desde el `POST`) y
    empieza a correr en tiempo real cuando se conecta un flujo SSE. Asi lo que
    pasa entre el `POST` y la conexion no depende de la velocidad de la maquina.
    """

    def __init__(self, client: TestClient) -> None:
        self.value = 0.0
        self.running_since: float | None = None
        backend = backend_of(client)
        backend.clock = self.now
        original = backend.stream

        async def stream(sample: Any, run: Any) -> AsyncIterator[bytes]:
            if self.running_since is None:
                self.running_since = time.perf_counter()
            async for chunk in original(sample, run):
                yield chunk

        backend.stream = stream  # type: ignore[method-assign]

    def now(self) -> float:
        running = 0.0 if self.running_since is None else time.perf_counter() - self.running_since
        return self.value + running

    def __call__(self, seconds_after_post: float) -> None:
        """Adelanta el reloj a ese instante."""
        assert self.running_since is None
        self.value = seconds_after_post


def post_field(client: TestClient, sample: SampleField, **extra: Any) -> FieldResponse:
    params = {"scenario": extra.pop("scenario")} if "scenario" in extra else None
    body = {"ra": sample.meta.request.ra + 0.001, "dec": sample.meta.request.dec - 0.001, **extra}
    response = client.post("/api/field", json=body, params=params)
    assert response.status_code in (200, 202), response.text
    parsed = FieldResponse.model_validate(response.json())
    assert (response.status_code == 200) == (parsed.status in ("ready", "partial"))
    assert parsed.id == sample.id
    assert parsed.events_url == f"/api/field/{sample.id}/events"
    return parsed


def error_code(response: Any) -> str:
    return ErrorBody.model_validate(response.json()).error.code


# ------------------------------------------------------- campo nuevo, completo


def test_new_field_from_post_to_done(make_client: Factory, sample_fields: SampleFields) -> None:
    sample = sample_fields.a
    client = make_client(seconds=1.2)
    Clock(client)  # el tiempo corre desde que se conecta el flujo: no se pierde ningun evento
    base = f"/api/field/{sample.id}"

    # 1. POST: campo nuevo, en cola, con los metadatos minimos.
    response = client.post("/api/field", json={"ra": 10.001, "dec": 19.999, "band": 3})
    assert response.status_code == 202
    created = FieldResponse.model_validate(response.json())
    assert (created.id, created.status, created.events_url) == (sample.id, "queued", f"{base}/events")
    assert set(response.json()["meta"]) == {
        "id", "pipeline", "status", "rev", "request", "progress", "warnings", "preview",
    }  # fmt: skip
    assert created.meta.rev == 0
    assert created.meta.progress.phase == "queued" and created.meta.progress.queue_position == 1
    assert created.meta.preview.status == "pending" and created.meta.preview.display is None

    # 2. Flujo SSE completo: se cierra solo despues de `done`.
    stream = client.get(created.events_url)
    assert stream.status_code == 200
    assert stream.headers["content-type"].startswith("text/event-stream")
    events, pings = parse_sse(stream.text)
    assert pings == 0  # ningun silencio llega a 15 s
    names = [event.name for event in events]
    ids = [event.id for event in events]
    assert names[0] == "state"
    assert ids[0] == 1
    assert all(later > earlier for earlier, later in itertools.pairwise(ids))
    assert names[-1] == "done" and names.count("done") == 1 and "error" not in names
    # `state` llega dos veces: al conectar y, con el documento terminado, justo antes de `done`.
    assert names.count("state") == 2 and names[-2] == "state"
    for event in events:
        EVENT_ADAPTERS[event.name].validate_python(event.data)

    # La secuencia real: state, queued, preview, listed, progress, planos, state, done.
    first = {name: names.index(name) for name in ("state", "queued", "preview", "listed", "plane", "done")}
    assert first["state"] < first["queued"] < first["preview"] < first["listed"] < first["plane"] < first["done"]
    assert "progress" in names[first["listed"] : first["plane"]]

    state = events[0].data
    assert state["status"] == "queued" and "grid" not in state and "planes" not in state
    assert events[first["queued"]].data == {"position": 1}
    assert events[first["preview"]].data["status"] == "ready"
    assert events[first["preview"]].data["display"] is not None

    # `listed`: grilla, epocas, detectores y todos los planos, pendientes salvo el que no tiene exposiciones.
    listed = FieldMeta.model_validate(events[first["listed"]].data)
    assert listed.status == "downloading" and listed.rev == 0
    assert listed.grid == sample.meta.grid and listed.epochs == sample.meta.epochs
    assert listed.planes is not None and listed.detectors is not None
    assert [(p.epoch, p.detector) for p in listed.planes] == [(p.epoch, p.detector) for p in sample.meta.planes or ()]
    assert {(p.epoch, p.detector): p.status for p in listed.planes if p.status != "pending"} == {(2, 1): "empty"}
    assert all(p.rev == 0 and p.stats is None and p.cube_offset is None for p in listed.planes if p.status == "pending")
    assert all(detector.display is None for detector in listed.detectors)
    # Todavia no se bajo ningun archivo: no se conocen los bits de FLAGS ni el modo de descarga.
    assert listed.flags == []
    assert [warning.code for warning in listed.warnings] == ["plane_empty"]
    assert listed.provenance is not None
    assert listed.provenance.built_at is None and listed.provenance.download_mode is None
    assert listed.progress.cutouts_total == sum(p.n_exposures for p in sample.meta.planes or ())
    # El plano sin exposiciones ya cuenta como terminado, y `planes_total` lo incluye.
    assert (listed.progress.planes_total, listed.progress.planes_ready) == (12, 1)

    # 3. Planos: cada uno con datos sale dos veces, provisorio y definitivo, en el orden de la seccion 8.
    plane_events = [event.data for event in events if event.name == "plane"]
    order = [(e["plane"]["detector"], e["plane"]["status"], e["plane"]["epoch"]) for e in plane_events]
    expected = []
    for detector in (3, 2, 4, 1, 5, 6):  # la banda pedida y despues de la mas cercana a la mas lejana
        epochs = [epoch for epoch, d in sample.data_keys if d == detector]
        expected += [(detector, "building", epoch) for epoch in epochs]
        expected += [(detector, "ready", epoch) for epoch in epochs]
    assert order == expected
    assert len(plane_events) == 2 * len(sample.data_keys)
    for event in plane_events:
        plane, display = event["plane"], event["detector_display"]
        source = sample.meta.plane(plane["epoch"], plane["detector"])
        assert source is not None
        assert display["detector"] == plane["detector"] and display["vmax"] > display["vmin"]
        assert plane["n_exposures"] == source.n_exposures and plane["cube_offset"] is None
        assert plane["stats"] is not None
        if plane["status"] == "building":
            assert plane["rev"] == 1 and plane["n_used"] == source.n_exposures // 2
        else:
            assert plane["rev"] == 2 and plane["n_used"] == source.n_used
            assert plane["stats"] == source.model_dump(mode="json")["stats"]

    # 4. Avisos y avance.
    warning_codes = [event.data["code"] for event in events if event.name == "warning"]
    assert sorted(warning_codes) == ["full_download", "low_coverage", "saturated_source"]  # plane_empty vino en listed
    saturated_at = next(i for i, e in enumerate(events) if e.name == "warning" and e.data["code"] == "saturated_source")
    assert events[saturated_at - 1].name == "plane" and events[saturated_at - 1].data["plane"]["status"] == "ready"
    progress = [event.data for event in events if event.name == "progress"]
    phases = [item["phase"] for item in progress]
    assert phases[0] == "listing" and phases[-1] == "finishing" and "downloading" in phases
    assert phases == sorted(phases, key=["queued", "listing", "downloading", "finishing", "done"].index)
    done_counts = [item["cutouts_done"] for item in progress]
    assert done_counts == sorted(done_counts)
    assert progress[-1]["cutouts_done"] == progress[-1]["cutouts_total"] == listed.progress.cutouts_total
    assert progress[-1]["planes_ready"] == progress[-1]["planes_total"] == 12
    assert events[-1].data == {"status": "ready", "rev": 1, "elapsed_s": 1.2}

    # El `state` anterior a `done` trae lo que ningun otro evento lleva: los bits de FLAGS, los
    # `cube_offset` y la procedencia completa. Con el flujo solo alcanza para leer `/cube`.
    closing = FieldMeta.model_validate(events[-2].data)
    assert closing.status == "ready" and closing.rev == 1 and closing.progress.phase == "done"
    assert closing.flags == sample.meta.flags and closing.flags
    assert closing.provenance == sample.meta.provenance
    assert closing.provenance is not None and closing.provenance.built_at and closing.provenance.download_mode
    assert closing.planes is not None
    assert [p.cube_offset for p in closing.planes] == [p.cube_offset for p in sample.meta.planes or ()]
    assert sum(1 for p in closing.planes if p.cube_offset is not None) == len(sample.data_keys)
    assert closing.warnings == sample.meta.warnings and closing.detectors == sample.meta.detectors

    # 5. Cada plano anunciado se puede pedir, y con su revision vigente es inmutable.
    for event in plane_events:
        plane = event["plane"]
        key = (plane["epoch"], plane["detector"])
        response = client.get(f"{base}/plane/{key[0]}/{key[1]}", params={"rev": plane["rev"]})
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/octet-stream"
        assert len(response.content) == sample.plane_nbytes
        assert response.content == sample.images[key].astype("<f4").tobytes()  # ya es la definitiva
        # La revision provisoria ya fue reemplazada: llega la vigente, sin marca de inmutable.
        assert response.headers["cache-control"] == (IMMUTABLE if plane["status"] == "ready" else "no-cache")

    # 6. `GET /meta` despues de `done` trae el mismo documento que el ultimo `state`.
    final = FieldMeta.model_validate(client.get(f"{base}/meta").json())
    assert final == closing
    assert final.progress.elapsed_s == 1.2
    assert final.planes is not None
    assert [p.rev for p in final.planes if p.status == "ready"] == [2] * len(sample.data_keys)

    # 7. El cubo: los planos con datos, en orden, en los offsets anunciados.
    cube = client.get(f"{base}/cube", params={"rev": final.rev})
    assert cube.status_code == 200
    assert cube.headers["cache-control"] == IMMUTABLE
    assert len(cube.content) == sample.plane_nbytes * len(sample.data_keys)
    for plane in final.planes:
        if plane.cube_offset is None:
            assert plane.status == "empty"
            continue
        chunk = cube.content[plane.cube_offset : plane.cube_offset + sample.plane_nbytes]
        assert chunk == sample.images[(plane.epoch, plane.detector)].astype("<f4").tobytes()
    assert client.get(f"{base}/cube").headers["cache-control"] == "no-cache"

    # 8. Pedirlo de nuevo: ya esta "en cache".
    again = client.post("/api/field", json={"ra": 10.0, "dec": 20.0})
    assert again.status_code == 200
    assert FieldResponse.model_validate(again.json()).meta == final

    # 9. Reconectar a un campo terminado: `state`, `done` y cierre.
    events, _ = parse_sse(client.get(created.events_url).text)
    assert [event.name for event in events] == ["state", "done"]
    assert events[1].id > events[0].id
    assert FieldMeta.model_validate(events[0].data) == final
    assert events[1].data == {"status": "ready", "rev": 1, "elapsed_s": 1.2}


# ------------------------------------------- estados intermedios (reloj manual)


def test_resources_at_each_stage_of_a_run(make_client: Factory, sample_fields: SampleFields) -> None:
    sample = sample_fields.a
    client = make_client(seconds=100.0)
    at = Clock(client)
    base = f"/api/field/{sample.id}"
    final_13 = sample.images[(1, 3)].astype("<f4").tobytes()

    def meta() -> FieldMeta:
        return FieldMeta.model_validate(client.get(f"{base}/meta").json())

    post_field(client, sample, band=3)

    # En cola: no hay planos ni vista provisoria todavia.
    at(1.0)
    assert meta().status == "queued"
    assert client.get(f"{base}/preview").status_code == 409
    response = client.get(f"{base}/plane/1/3")
    assert (response.status_code, error_code(response)) == (409, "not_ready")
    assert response.json()["error"]["retryable"] is True  # el trabajo sigue: tiene sentido volver a pedirlo
    response = client.get(f"{base}/plane/9/3")
    assert (response.status_code, error_code(response)) == (404, "not_found")
    assert client.get(f"{base}/plane/1/7").status_code == 404
    response = client.get(f"{base}/cube")
    assert (response.status_code, error_code(response)) == (409, "not_ready")

    at(7.0)
    assert meta().status == "listing" and meta().progress.phase == "listing"

    # Vista provisoria lista antes que la lista de exposiciones.
    at(11.0)
    assert meta().preview.status == "ready" and meta().grid is None
    preview = client.get(f"{base}/preview")
    assert preview.status_code == 200
    assert sample.preview is not None and preview.content == sample.preview.astype("<f4").tobytes()

    # Listado: los planos existen pero estan pendientes; el vacio no tiene binario.
    at(17.0)
    listed = meta()
    assert listed.status == "downloading" and listed.plane(1, 3) is not None
    assert error_code(client.get(f"{base}/plane/1/3")) == "not_ready"
    response = client.get(f"{base}/plane/2/1")
    assert (response.status_code, error_code(response)) == (404, "not_found")
    assert error_code(client.get(f"{base}/aux/1/3")) == "not_ready"
    assert client.get(f"{base}/aux/2/1").status_code == 404

    # Primera revision provisoria de la banda pedida (el primer plano sale a los 20 s).
    at(21.0)
    building = meta()
    plane = building.plane(1, 3)
    assert plane is not None and plane.status == "building" and plane.rev == 1
    assert plane.n_used == plane.n_exposures // 2 and plane.stats is not None and plane.cube_offset is None
    assert building.plane(2, 3) is not None and building.plane(2, 3).status == "pending"  # type: ignore[union-attr]
    assert building.flags == sample.meta.flags  # con el primer archivo ya se conocen los bits
    assert building.detectors is not None
    assert [d.display is not None for d in building.detectors] == [False, False, True, False, False, False]
    assert building.progress.cutouts_done == plane.n_used and building.rev == 0

    provisional = client.get(f"{base}/plane/1/3", params={"rev": 1})
    assert provisional.status_code == 200
    assert provisional.headers["cache-control"] == IMMUTABLE
    assert len(provisional.content) == sample.plane_nbytes
    assert provisional.content != final_13
    noisy = np.frombuffer(provisional.content, dtype="<f4").reshape(sample.shape)
    clean = sample.images[(1, 3)]
    assert np.isnan(noisy).sum() > np.isnan(clean).sum()  # huecos nuevos
    np.testing.assert_array_equal(np.isposinf(noisy), np.isposinf(clean))  # la saturacion se conserva
    both = np.isfinite(noisy) & np.isfinite(clean)
    assert 0.03 < float(np.std(noisy[both] - clean[both])) < 0.2  # ruido agregado, del orden del del plano
    assert client.get(f"{base}/plane/1/3").headers["cache-control"] == "no-cache"
    assert client.get(f"{base}/plane/1/3", params={"rev": 2}).headers["cache-control"] == "no-cache"

    # La capa auxiliar acompana a la imagen provisoria: cobertura 0 donde no hay dato.
    aux = client.get(f"{base}/aux/1/3")
    assert aux.status_code == 200 and len(aux.content) == 6 * sample.shape[0] * sample.shape[1]
    flags, coverage = split_aux(aux.content, sample.shape)
    np.testing.assert_array_equal(flags, sample.flags[(1, 3)])
    np.testing.assert_array_equal(coverage == 0, ~np.isfinite(noisy))
    assert coverage.max() == (sample.coverage[(1, 3)].max() + 1) // 2
    plain = client.get(f"{base}/aux/1/3", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers and plain.content == aux.content

    # Cambio de banda mientras carga: lo pendiente se reordena y sigue la banda 6.
    assert client.post(f"{base}/priority", json={"band": 6}).status_code == 204
    at(24.0)  # segundo turno de plano
    reordered = meta()
    assert reordered.plane(1, 6).status == "building"  # type: ignore[union-attr]
    assert reordered.plane(2, 3).status == "pending"  # type: ignore[union-attr]
    # Un POST con otra banda se suma al trabajo y tambien reordena.
    joined = post_field(client, sample, band=1)
    assert joined.status == "downloading"
    at(27.6)  # tercer turno
    assert meta().plane(1, 1).status == "building"  # type: ignore[union-attr]

    # Terminado: la revision provisoria ya no existe y la definitiva es otra URL.
    at(100.0)
    done = meta()
    assert done.status == "ready" and done.rev == 1 and done.progress.elapsed_s == 100.0
    replaced = client.get(f"{base}/plane/1/3", params={"rev": 1})
    assert replaced.content == final_13 and replaced.headers["cache-control"] == "no-cache"
    current = client.get(f"{base}/plane/1/3", params={"rev": 2})
    assert current.content == final_13 and current.headers["cache-control"] == IMMUTABLE
    assert client.post(f"{base}/priority", json={"band": 2}).status_code == 204  # no hace nada

    final_aux = client.get(f"{base}/aux/1/3")
    assert final_aux.headers.get("content-encoding") == "gzip"
    flags, coverage = split_aux(final_aux.content, sample.shape)
    np.testing.assert_array_equal(flags, sample.flags[(1, 3)])
    np.testing.assert_array_equal(coverage, sample.coverage[(1, 3)])


def test_meta_has_etag_and_supports_revalidation(make_client: Factory, sample_fields: SampleFields) -> None:
    sample = sample_fields.a
    client = make_client(seconds=100.0)
    at = Clock(client)
    url = f"/api/field/{sample.id}/meta"
    post_field(client, sample)
    at(1.0)
    first = client.get(url)
    assert first.status_code == 200
    assert first.headers["cache-control"] == "no-cache"
    etag = first.headers["etag"]
    assert etag.startswith('"') and etag.endswith('"')
    unchanged = client.get(url, headers={"If-None-Match": etag})
    assert unchanged.status_code == 304 and unchanged.content == b"" and unchanged.headers["etag"] == etag
    at(15.0)  # ya paso `listed`: el documento cambio
    changed = client.get(url, headers={"If-None-Match": etag})
    assert changed.status_code == 200 and changed.headers["etag"] != etag


def test_reconnecting_mid_run_starts_with_the_current_state(make_client: Factory, sample_fields: SampleFields) -> None:
    sample = sample_fields.a
    client = make_client(seconds=1.5)
    at = Clock(client)
    created = post_field(client, sample, band=2)
    at(0.75)  # la conexion llega a mitad del trabajo
    events, _ = parse_sse(client.get(created.events_url).text)
    names = [event.name for event in events]
    assert names[0] == "state" and names[-2:] == ["state", "done"] and names.count("state") == 2
    assert "listed" not in names and "queued" not in names  # no se repite lo perdido
    state = FieldMeta.model_validate(events[0].data)
    assert state.status == "downloading" and state.planes is not None
    seen = {(p.epoch, p.detector): p.rev for p in state.planes if p.status in ("building", "ready")}
    assert seen  # el estado ya trae lo anterior
    ids = [event.id for event in events]
    assert ids[0] > 1 and all(later > earlier for earlier, later in itertools.pairwise(ids))
    # Lo que llega despues son revisiones nuevas: nunca una que el estado ya traia.
    for event in events:
        if event.name == "plane":
            plane = event.data["plane"]
            assert plane["rev"] > seen.get((plane["epoch"], plane["detector"]), 0)
            seen[(plane["epoch"], plane["detector"])] = plane["rev"]
    assert set(seen) == set(sample.data_keys) and set(seen.values()) == {2}


# -------------------------------------------------------------------- escenarios


def test_first_request_is_new_and_later_ones_are_cached(make_client: Factory, sample_fields: SampleFields) -> None:
    client = make_client(seconds=100.0)
    at = Clock(client)
    assert post_field(client, sample_fields.a).status == "queued"
    # El mismo pedido mientras carga se suma al trabajo: mismo id, sin empezar de nuevo.
    at(15.0)
    assert post_field(client, sample_fields.a).status == "downloading"
    at(200.0)
    assert post_field(client, sample_fields.a).status == "ready"
    # `scenario=new` lo vuelve a simular como nuevo.
    assert post_field(client, sample_fields.a, scenario="new").status == "queued"
    at(215.0)
    meta = FieldMeta.model_validate(client.get(f"/api/field/{sample_fields.a.id}/meta").json())
    assert meta.status == "downloading" and meta.rev == 0


def test_cached_scenario_answers_ready_at_once(make_client: Factory, sample_fields: SampleFields) -> None:
    sample = sample_fields.a
    client = make_client(seconds=100.0)
    response = client.post("/api/field", params={"scenario": "cached"}, json={"ra": 10.0, "dec": 20.0, "band": 6})
    assert response.status_code == 200
    body = FieldResponse.model_validate(response.json())
    assert body.status == "ready" and body.meta.rev == 1
    assert body.meta.planes is not None and body.meta.grid == sample.meta.grid
    # Todo esta disponible sin SSE: planos de la banda actual, cubo y capas.
    for plane in body.meta.planes:
        url = f"/api/field/{sample.id}/plane/{plane.epoch}/{plane.detector}"
        if plane.status == "empty":
            assert client.get(url).status_code == 404
            continue
        assert plane.rev == 2 and plane.cube_offset is not None
        got = client.get(url, params={"rev": plane.rev})
        assert got.content == sample.images[(plane.epoch, plane.detector)].astype("<f4").tobytes()
        assert got.headers["cache-control"] == IMMUTABLE
    assert len(client.get(f"/api/field/{sample.id}/cube").content) == sample.plane_nbytes * len(sample.data_keys)
    events, _ = parse_sse(client.get(body.events_url).text)
    assert [(event.name, event.id) for event in events] == [("state", 1), ("done", 2)]
    assert events[1].data == {"status": "ready", "rev": 1, "elapsed_s": 155.4}
    # Y los pedidos siguientes siguen en cache.
    assert post_field(client, sample).status == "ready"


def test_queued_scenario_counts_down_and_sends_pings(make_client: Factory, sample_fields: SampleFields) -> None:
    sample = sample_fields.b  # campo parcial: una epoca y un recorte fallido
    client = make_client(seconds=0.6, ping_seconds=0.03)
    Clock(client)
    created = post_field(client, sample, scenario="queued", band=4)
    assert created.status == "queued" and created.meta.progress.queue_position == 3
    events, pings = parse_sse(client.get(created.events_url).text)
    names = [event.name for event in events]
    assert names[0] == "state" and names[-1] == "done"
    assert [event.data["position"] for event in events if event.name == "queued"] == [3, 2, 1]
    assert names.index("listed") > max(i for i, name in enumerate(names) if name == "queued")
    assert pings >= 1  # la espera en la cola supera el intervalo de ping
    # El campo termina `partial`: un plano con un recorte fallido y su aviso.
    assert events[-1].data["status"] == "partial"
    finals = {
        (e.data["plane"]["epoch"], e.data["plane"]["detector"]): e.data["plane"]
        for e in events
        if e.name == "plane" and e.data["plane"]["status"] != "building"
    }
    assert finals[(1, 4)]["status"] == "partial" and finals[(1, 4)]["n_failed"] == 1
    assert {plane["status"] for key, plane in finals.items() if key != (1, 4)} == {"ready"}
    assert "cutouts_failed" in [event.data["code"] for event in events if event.name == "warning"]
    last_progress = [event.data for event in events if event.name == "progress"][-1]
    assert last_progress["cutouts_failed"] == 1
    assert last_progress["cutouts_done"] + last_progress["cutouts_failed"] == last_progress["cutouts_total"]
    # Sin vista provisoria: el evento lo dice y el recurso no existe.
    assert next(event.data["status"] for event in events if event.name == "preview") == "unavailable"
    response = client.get(f"/api/field/{sample.id}/preview")
    assert (response.status_code, error_code(response)) == (404, "not_found")
    assert post_field(client, sample).status == "partial"


def test_error_scenario_fails_the_job(make_client: Factory, sample_fields: SampleFields) -> None:
    sample = sample_fields.a
    client = make_client(seconds=0.8)
    Clock(client)
    created = post_field(client, sample, scenario="error", band=3)
    events, _ = parse_sse(client.get(created.events_url).text)
    names = [event.name for event in events]
    assert names[0] == "state" and names[-1] == "error" and "done" not in names
    error = ErrorBody.model_validate(events[-1].data).error
    assert (error.code, error.retryable) == ("upstream_unavailable", True)
    # Antes de fallar llegaron las imagenes provisorias de la banda pedida.
    planes = [event.data["plane"] for event in events if event.name == "plane"]
    assert [(p["epoch"], p["detector"], p["status"]) for p in planes] == [(1, 3, "building"), (2, 3, "building")]

    base = f"/api/field/{sample.id}"
    failed = FieldMeta.model_validate(client.get(f"{base}/meta").json())
    assert failed.status == "failed" and failed.rev == 0
    # `phase` no tiene un valor para la falla: queda en la fase en la que estaba el trabajo.
    assert failed.progress.phase == "downloading"
    assert client.get(f"{base}/plane/1/3").status_code == 200  # lo que se llego a construir sigue disponible
    # Lo que no se llego a construir no va a estar: 409 `not_ready`, pero sin `retryable`.
    for url in (f"{base}/cube", f"{base}/plane/1/1", f"{base}/aux/1/1"):
        response = client.get(url)
        assert response.status_code == 409, url
        error = ErrorBody.model_validate(response.json()).error
        assert (error.code, error.retryable) == ("not_ready", False), url
    # Reconectar a un trabajo fallido: `state`, `error` y cierre.
    events, _ = parse_sse(client.get(created.events_url).text)
    assert [event.name for event in events] == ["state", "error"]
    assert FieldMeta.model_validate(events[0].data).status == "failed"
    assert set(events[1].data) == {"error"}  # el cuerpo de error completo, envuelto como en HTTP
    # Un pedido nuevo lo reintenta desde cero.
    assert post_field(client, sample).status == "queued"


def test_plane_whose_exposures_were_all_unusable_ends_empty(
    make_client: Factory, sample_field_builder: Callable[..., SampleField], tmp_path: Path
) -> None:
    sample = sample_field_builder(tmp_path, 80.0, 40.0, n_epochs=1, unusable=((1, 2),))
    client = make_client(seconds=0.5, fields_dir=tmp_path)
    Clock(client)
    created = post_field(client, sample, band=2)
    events, _ = parse_sse(client.get(created.events_url).text)
    for event in events:
        EVENT_ADAPTERS[event.name].validate_python(event.data)

    # En la lista todavia no se sabe: el plano figura pendiente, con sus exposiciones.
    listed = FieldMeta.model_validate(next(event.data for event in events if event.name == "listed"))
    pending = listed.plane(1, 2)
    assert pending is not None and (pending.status, pending.n_exposures) == ("pending", 3)
    assert listed.warnings == []

    # Es el primero de la banda pedida: sale una sola vez, vacio, sin escala y con su aviso.
    planes = [event for event in events if event.name == "plane"]
    assert planes[0].data["plane"]["status"] == "empty" and planes[0].data["plane"]["detector"] == 2
    assert planes[0].data["plane"]["rev"] == 1  # revision nueva respecto del pendiente, aunque no tenga binario
    assert planes[0].data["plane"]["stats"] is None and planes[0].data["detector_display"] is None
    assert sum(1 for event in planes if event.data["plane"]["detector"] == 2) == 1
    following = events[events.index(planes[0]) + 1]
    assert (following.name, following.data) == ("warning", {"code": "plane_empty", "epoch": 1, "detector": 2})

    last_progress = [event.data for event in events if event.name == "progress"][-1]
    assert last_progress["cutouts_failed"] == 3
    assert last_progress["cutouts_done"] + last_progress["cutouts_failed"] == last_progress["cutouts_total"]
    response = client.get(f"/api/field/{sample.id}/plane/1/2")
    assert (response.status_code, error_code(response)) == (404, "not_found")
    cube = client.get(f"/api/field/{sample.id}/cube")
    assert len(cube.content) == sample.plane_nbytes * 5


def test_plane_with_a_single_revision_is_emitted_once(
    make_client: Factory, sample_field_builder: Callable[..., SampleField], tmp_path: Path
) -> None:
    """Las revisiones se sirven como estan en disco: un plano guardado con `rev` 1 no tiene provisoria."""
    sample = sample_field_builder(tmp_path, 80.0, 40.0, n_epochs=1, plane_rev=1, partial=((1, 4),))
    client = make_client(seconds=0.5, fields_dir=tmp_path)
    Clock(client)
    created = post_field(client, sample, band=2)
    events, _ = parse_sse(client.get(created.events_url).text)
    planes = [event.data["plane"] for event in events if event.name == "plane"]
    assert [(p["detector"], p["status"], p["rev"]) for p in planes] == [
        (2, "ready", 1), (1, "ready", 1), (3, "ready", 1), (4, "partial", 1), (5, "ready", 1), (6, "ready", 1),
    ]  # fmt: skip
    # El avance cuenta cada recorte una sola vez, tambien sin revision provisoria.
    last_progress = [event.data for event in events if event.name == "progress"][-1]
    assert last_progress["cutouts_failed"] == 1
    assert last_progress["cutouts_done"] + last_progress["cutouts_failed"] == last_progress["cutouts_total"]
    final = FieldMeta.model_validate(events[-2].data)
    assert final.planes == sample.meta.planes
    for plane in final.planes or ():
        url = f"/api/field/{sample.id}/plane/{plane.epoch}/{plane.detector}"
        assert client.get(url, params={"rev": 1}).headers["cache-control"] == IMMUTABLE


def test_sample_with_the_real_pipeline_is_never_immutable(
    make_client: Factory, sample_field_builder: Callable[..., SampleField], tmp_path: Path
) -> None:
    """Una muestra con el pipeline real comparte `id` y rutas con el campo real: no se guarda para siempre."""
    sample = sample_field_builder(tmp_path, 80.0, 40.0, n_epochs=1, pipeline=PIPELINE_VERSION)
    client = make_client(seconds=100.0, fields_dir=tmp_path)
    body = post_field(client, sample, scenario="cached")
    assert body.meta.pipeline == PIPELINE_VERSION and body.meta.planes is not None
    plane = body.meta.planes[0]
    response = client.get(f"/api/field/{sample.id}/plane/{plane.epoch}/{plane.detector}", params={"rev": plane.rev})
    assert response.status_code == 200 and response.headers["cache-control"] == "no-cache"
    cube = client.get(f"/api/field/{sample.id}/cube", params={"rev": body.meta.rev})
    assert cube.status_code == 200 and cube.headers["cache-control"] == "no-cache"


def test_revision_that_is_not_the_current_one_is_not_immutable(
    make_client: Factory, sample_fields: SampleFields
) -> None:
    """Con `?rev=N` solo es `immutable` la revision vigente; cualquier otra devuelve la vigente con `no-cache`."""
    sample = sample_fields.a
    client = make_client(seconds=100.0)
    post_field(client, sample, scenario="cached")
    plane_url = f"/api/field/{sample.id}/plane/1/3"
    current = client.get(plane_url, params={"rev": 2})
    assert current.headers["cache-control"] == IMMUTABLE
    for rev in (None, 0, 1, 3, 7):  # sin `rev`, una revision reemplazada y una que todavia no existe
        response = client.get(plane_url, params=None if rev is None else {"rev": rev})
        assert response.status_code == 200 and response.content == current.content, rev
        assert response.headers["cache-control"] == "no-cache", rev
    cube_url = f"/api/field/{sample.id}/cube"
    assert client.get(cube_url, params={"rev": 1}).headers["cache-control"] == IMMUTABLE
    for rev in (None, 0, 2):
        response = client.get(cube_url, params=None if rev is None else {"rev": rev})
        assert response.status_code == 200 and response.headers["cache-control"] == "no-cache", rev


def test_preview_is_labelled_with_the_band_of_the_request_that_created_the_job(
    make_client: Factory, sample_fields: SampleFields
) -> None:
    """Seccion 4.10: W2 si el `band` pedido es 5 o 6. La imagen del servidor falso es la misma; cambia el rotulo."""
    sample = sample_fields.a
    assert sample.preview is not None and sample.meta.preview.band == "W1"
    client = make_client(seconds=100.0)
    at = Clock(client)
    base = f"/api/field/{sample.id}"

    created = post_field(client, sample, band=6)
    assert (created.meta.preview.status, created.meta.preview.band, created.meta.preview.wave_um) == (
        "pending", "W2", 4.6,
    )  # fmt: skip
    at(11.0)
    preview = FieldMeta.model_validate(client.get(f"{base}/meta").json()).preview
    assert (preview.status, preview.survey, preview.band, preview.wave_um) == ("ready", "WISE", "W2", 4.6)
    assert preview.display == sample.meta.preview.display
    assert client.get(f"{base}/preview").content == sample.preview.astype("<f4").tobytes()
    # Cambiar de banda mientras carga no vuelve a pedir la vista: queda con la del primer pedido.
    assert client.post(f"{base}/priority", json={"band": 1}).status_code == 204
    assert post_field(client, sample, band=2).meta.preview.band == "W2"
    at(100.0)
    assert FieldMeta.model_validate(client.get(f"{base}/meta").json()).preview.band == "W2"
    assert post_field(client, sample, band=3).meta.preview.band == "W2"  # ya en cache, con la vista que se guardo

    # Con las bandas 1 a 4 es W1, y un campo que ya estaba en cache trae la vista guardada con la muestra.
    assert post_field(client, sample, scenario="new", band=4).meta.preview.band == "W1"
    cached = post_field(client, sample, scenario="cached", band=6).meta.preview
    assert (cached.band, cached.wave_um) == ("W1", 3.4)


def test_preview_event_carries_the_band(make_client: Factory, sample_fields: SampleFields) -> None:
    client = make_client(seconds=0.6)
    Clock(client)
    created = post_field(client, sample_fields.a, band=5)
    events, _ = parse_sse(client.get(created.events_url).text)
    preview = next(event.data for event in events if event.name == "preview")
    assert (preview["status"], preview["band"], preview["wave_um"]) == ("ready", "W2", 4.6)
    assert FieldMeta.model_validate(events[-2].data).preview.band == "W2"


# ----------------------------------------------------------- pedidos y errores


def test_post_picks_the_nearest_sample(make_client: Factory, sample_fields: SampleFields) -> None:
    client = make_client(seconds=100.0)
    near_a = client.post("/api/field", params={"scenario": "cached"}, json={"ra": 12.0, "dec": 21.0})
    # Cualquier `fov` que se normalice al escalon base elige entre las mismas muestras.
    near_b = client.post("/api/field", params={"scenario": "cached"}, json={"ra": 190.0, "dec": -35.0, "fov": 0.05})
    assert near_a.json()["id"] == sample_fields.a.id
    assert near_b.json()["id"] == sample_fields.b.id
    # El pedido se normaliza antes de comparar: 370 grados es 10. Los enteros valen como numeros.
    wrapped = client.post("/api/field", params={"scenario": "cached"}, json={"ra": 370, "dec": 20, "refresh": True})
    assert wrapped.status_code == 200 and wrapped.json()["id"] == sample_fields.a.id
    assert client.get("/openapi.json").status_code == 200
    health = client.get("/api/health").json()
    assert health["status"] == "ok" and health["fake"] is True
    assert {item["id"] for item in health["fields"]} == {sample_fields.a.id, sample_fields.b.id}
    assert {item["pipeline"] for item in health["fields"]} == {"prueba"}
    # Los nombres que `/api/resolve` conoce: el texto buscado y el nombre principal de cada respuesta guardada.
    assert health["names"] == [
        "ENANA J0320-1000", "Enana de Prueba", "Estrella de Prueba", "Galaxia Fija", "M 999", "MOVIL 1",
        "Movil de Prueba", "NAME Estrella de prueba",
    ]  # fmt: skip


def test_a_step_without_samples_has_no_coverage(make_client: Factory, sample_fields: SampleFields) -> None:
    """No hay muestras del escalon amplio: se responde `no_coverage` en vez de un campo de otro tamano."""
    client = make_client(seconds=100.0)
    for fov in (0.5, 0.4, 0.17):
        response = client.post("/api/field", json={"ra": 10.0, "dec": 20.0, "fov": fov})
        assert (response.status_code, error_code(response)) == (404, "no_coverage"), fov
        assert response.json()["error"]["retryable"] is False
    # No quedo ningun trabajo: el campo del escalon base sigue siendo nuevo.
    assert backend_of(client).runs == {}
    assert post_field(client, sample_fields.a, fov=0.1667).status == "queued"


@pytest.mark.parametrize(
    ("scenario", "status", "retryable"),
    [("queue_full", 429, True), ("no_coverage", 404, False), ("upstream_unavailable", 503, True)],
)
def test_error_scenarios_answer_the_contract_error_without_creating_a_job(
    make_client: Factory, sample_fields: SampleFields, scenario: str, status: int, retryable: bool
) -> None:
    client = make_client(seconds=100.0)
    response = client.post("/api/field", params={"scenario": scenario}, json={"ra": 10.0, "dec": 20.0})
    assert response.status_code == status
    error = ErrorBody.model_validate(response.json()).error
    assert (error.code, error.retryable) == (scenario, retryable)
    assert set(response.json()) == {"error"}
    # Solo la cola llena trae `Retry-After`, en segundos enteros.
    assert response.headers.get("retry-after") == ("5" if scenario == "queue_full" else None)
    # El pedido se valida antes: uno invalido es `invalid_request` con cualquier escenario.
    invalid = client.post("/api/field", params={"scenario": scenario}, json={"ra": 10.0, "dec": 120.0})
    assert (invalid.status_code, error_code(invalid)) == (422, "invalid_request")
    # No se creo ningun trabajo ni se dio el campo por visto: el pedido siguiente es un campo nuevo.
    assert backend_of(client).runs == {}
    assert post_field(client, sample_fields.a).status == "queued"


def test_retry_after_is_readable_from_another_origin(make_client: Factory) -> None:
    """El frontend de desarrollo esta en otro puerto: tiene que poder leer `Retry-After`."""
    response = make_client().post(
        "/api/field",
        params={"scenario": "queue_full"},
        json={"ra": 10.0, "dec": 20.0},
        headers={"Origin": "http://localhost:5173"},
    )
    assert response.status_code == 429
    assert "retry-after" in response.headers["access-control-expose-headers"].lower()


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
        {"ra": 10.0, "dec": 20.0, "refresh": "si"},
        {},
    ],
)
def test_invalid_requests_get_the_contract_error(make_client: Factory, body: dict[str, Any]) -> None:
    response = make_client().post("/api/field", json=body)
    assert response.status_code == 422
    assert error_code(response) == "invalid_request"
    assert response.json()["error"]["retryable"] is False


def test_unknown_scenario_and_unknown_resources(make_client: Factory, sample_fields: SampleFields) -> None:
    client = make_client(seconds=100.0)
    response = client.post("/api/field", params={"scenario": "otro"}, json={"ra": 10.0, "dec": 20.0})
    assert (response.status_code, error_code(response)) == (422, "invalid_request")

    unknown = "/api/field/ffffffffffffffff"
    for url in ["/meta", "/events", "/plane/1/1", "/cube", "/aux/1/1", "/preview", "/track?name=x"]:
        response = client.get(unknown + url)
        assert (response.status_code, error_code(response)) == (404, "not_found"), url
    response = client.post(f"{unknown}/priority", json={"band": 3})
    assert (response.status_code, error_code(response)) == (404, "not_found")
    assert client.get("/api/field/../meta").status_code == 404

    base = f"/api/field/{sample_fields.a.id}"
    post_field(client, sample_fields.a, scenario="cached")
    for url, params in [
        (f"{base}/plane/uno/3", None),
        (f"{base}/plane/1/3", {"rev": "x"}),
        (f"{base}/plane/1/3", {"rev": -1}),
        (f"{base}/track", None),
    ]:
        response = client.get(url, params=params)
        assert (response.status_code, error_code(response)) == (422, "invalid_request"), url
    response = client.post(f"{base}/priority", json={"band": 9})
    assert (response.status_code, error_code(response)) == (422, "invalid_request")


def test_without_samples_there_is_no_coverage(make_client: Factory, tmp_path: Path) -> None:
    client = make_client(fields_dir=tmp_path / "vacio")
    response = client.post("/api/field", json={"ra": 10.0, "dec": 20.0})
    assert (response.status_code, error_code(response)) == (404, "no_coverage")
    assert client.get("/api/health").json()["fields"] == []


def test_broken_samples_are_skipped(
    make_client: Factory,
    sample_fields: SampleFields,
    sample_field_builder: Callable[..., SampleField],
    tmp_path: Path,
) -> None:
    good = sample_field_builder(tmp_path, 50.0, 5.0, n_epochs=1)
    (tmp_path / "rota").mkdir()
    (tmp_path / "rota" / "meta.json").write_text('{"id": "rota"}', encoding="utf-8")
    unfinished = sample_fields.a.meta.model_copy(deep=True, update={"id": "encurso", "status": "downloading"})
    (tmp_path / "encurso").mkdir()
    (tmp_path / "encurso" / "meta.json").write_text(unfinished.model_dump_json(), encoding="utf-8")
    # Revisiones que no son las de un campo terminado: el servidor no las corrige, descarta la muestra.
    for name, change in [("sinrev", {"rev": 0}), ("planosinrev", {})]:
        broken = sample_fields.a.meta.model_copy(deep=True, update={"id": name, **change})
        if name == "planosinrev":
            assert broken.planes is not None
            broken.planes[2].rev = 0  # un plano con datos que dice no haber cambiado nunca
        (tmp_path / name).mkdir()
        (tmp_path / name / "meta.json").write_text(broken.model_dump_json(), encoding="utf-8")

    client = make_client(fields_dir=tmp_path)
    assert [item["id"] for item in client.get("/api/health").json()["fields"]] == [good.id]
    for name in ("rota", "encurso", "sinrev", "planosinrev"):
        assert client.get(f"/api/field/{name}/meta").status_code == 404, name


def test_cors_allows_the_dev_frontend(make_client: Factory, sample_fields: SampleFields) -> None:
    client = make_client()
    response = client.get("/api/health", headers={"Origin": "http://localhost:5173"})
    assert response.headers["access-control-allow-origin"] == "*"
    preflight = client.options(
        "/api/field",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert preflight.status_code == 200


# ----------------------------------------------------------- nombres y rastro


def test_resolve_coordinates(make_client: Factory) -> None:
    client = make_client()
    for text in ["269.4463 4.7683", "269.4463, +4.7683", " 269.4463,4.7683 ", "269,4463 +4,7683"]:
        response = client.get("/api/resolve", params={"name": text})
        assert response.status_code == 200
        resolved = ResolveResponse.model_validate(response.json())
        assert resolved.source == "coordinates"
        assert resolved.name is None and resolved.object_type is None and resolved.motion is None
        assert (resolved.j2000.ra, resolved.j2000.dec) == pytest.approx((269.4463, 4.7683))
        assert (resolved.field_center.ra, resolved.field_center.dec, resolved.field_center.epoch) == (
            269.4463,
            4.7683,
            2026.0,
        )
        assert resolved.moved_arcsec == 0.0
    assert response.json()["name"] is None and response.json()["motion"] is None  # van como null, no se omiten
    south = ResolveResponse.model_validate(client.get("/api/resolve", params={"name": "133.7598 -7.2422"}).json())
    assert south.field_center.dec == -7.2422

    for text in ["10 95", "629.4463 4.7683"]:  # `dec` o `ra` fuera de rango: `ra` no se envuelve
        out_of_range = client.get("/api/resolve", params={"name": text})
        assert (out_of_range.status_code, error_code(out_of_range)) == (422, "invalid_request")
    for params in [{"name": "   "}, {}]:
        response = client.get("/api/resolve", params=params)
        assert (response.status_code, error_code(response)) == (422, "invalid_request")


def test_resolve_sexagesimal_coordinates(make_client: Factory) -> None:
    """Seccion 4.8: el texto se interpreta como coordenadas si lo son, tambien en sexagesimal."""
    client = make_client()
    # WISE 0855 como lo da CLAUDE.md, y las mismas coordenadas con dos puntos y con espacios.
    expected_ra = 15.0 * (8 + 55 / 60 + 10.831 / 3600)
    expected_dec = -(7 + 14 / 60 + 42.53 / 3600)
    for text in ["08h55m10.831s -07d14m42.53s", "08:55:10.831 -07:14:42.53", "08 55 10.831 -07 14 42.53"]:
        response = client.get("/api/resolve", params={"name": text})
        assert response.status_code == 200, text
        resolved = ResolveResponse.model_validate(response.json())
        assert (resolved.query, resolved.source) == (text, "coordinates")
        assert resolved.name is None and resolved.object_type is None and resolved.motion is None
        assert (resolved.j2000.ra, resolved.j2000.dec) == (round(expected_ra, 6), round(expected_dec, 6))
        assert (resolved.field_center.ra, resolved.field_center.dec) == (133.7951, -7.2451)
        assert resolved.field_center.epoch == 2026.0 and resolved.moved_arcsec == 0.0
    # Con forma de coordenadas pero fuera de rango: no se busca como nombre.
    for text in ["25:00:00 +10:00:00", "08h55m10s -95d00m00s"]:
        response = client.get("/api/resolve", params={"name": text})
        assert (response.status_code, error_code(response)) == (422, "invalid_request"), text


def test_resolve_scenario_simulates_sesame_down(make_client: Factory) -> None:
    client = make_client()
    for name in ["Estrella de Prueba", "10 20"]:
        response = client.get("/api/resolve", params={"name": name, "scenario": "upstream_unavailable"})
        assert response.status_code == 503
        error = ErrorBody.model_validate(response.json()).error
        assert (error.code, error.retryable) == ("upstream_unavailable", True)
    response = client.get("/api/resolve", params={"name": "Estrella de Prueba", "scenario": "otro"})
    assert (response.status_code, error_code(response)) == (422, "invalid_request")
    assert client.get("/api/resolve", params={"name": "Estrella de Prueba"}).status_code == 200


def test_resolve_keeps_null_for_what_the_catalog_does_not_give(make_client: Factory) -> None:
    """Paralaje o velocidad radial que el catalogo no trae van como `null`: un 0 pareceria un valor medido."""
    client = make_client()
    without_velocity = client.get("/api/resolve", params={"name": "Enana de Prueba"}).json()
    assert without_velocity["motion"] == {
        "pm_ra": 500.0, "pm_dec": 0.0, "parallax": 250.0, "radial_velocity": None, "per_year_arcsec": 0.5,
    }  # fmt: skip
    # Sin velocidad radial la posicion se propaga igual: 0.5 segundos de arco por anio hacia el este.
    resolved = ResolveResponse.model_validate(without_velocity)
    assert resolved.moved_arcsec == pytest.approx(13.0, abs=0.5)
    assert resolved.field_center.ra > 50.0

    only_motion = client.get("/api/resolve", params={"name": "MOVIL 1"}).json()
    assert only_motion["motion"] == {
        "pm_ra": 0.0, "pm_dec": 360.0, "parallax": None, "radial_velocity": None, "per_year_arcsec": 0.36,
    }  # fmt: skip
    # Sin paralaje no hay desplazamiento paralactico: 0.36 por 26 anios, justo hacia el norte.
    resolved = ResolveResponse.model_validate(only_motion)
    assert resolved.moved_arcsec == pytest.approx(9.4, abs=0.1)
    assert (resolved.field_center.ra, resolved.field_center.dec) == (120.0, 0.0026)


def test_resolve_names_from_saved_sesame_answers(make_client: Factory) -> None:
    client = make_client()
    for text in ["Estrella de Prueba", "estrella de prueba", "NAME Estrella de prueba", "estrella-de-prueba"]:
        response = client.get("/api/resolve", params={"name": text})
        assert response.status_code == 200, text
        resolved = ResolveResponse.model_validate(response.json())
        assert resolved.query == text
        assert (resolved.name, resolved.source, resolved.object_type) == ("NAME Estrella de prueba", "sesame", "PM*")
        assert (resolved.j2000.ra, resolved.j2000.dec) == (10.0, 20.0)
        assert resolved.motion is not None
        assert resolved.motion.model_dump() == {
            "pm_ra": 0.0, "pm_dec": 1000.0, "parallax": 100.0, "radial_velocity": -20.0, "per_year_arcsec": 1.0,
        }  # fmt: skip
        # 1 segundo de arco por anio hacia el norte durante 26 anios, mas una paralaje de 0.1.
        assert resolved.field_center.epoch == 2026.0
        assert resolved.field_center.ra == pytest.approx(10.0, abs=2e-4)
        assert resolved.field_center.dec == pytest.approx(20.0 + 26.0 / 3600.0, abs=2e-4)
        assert resolved.moved_arcsec == pytest.approx(26.0, abs=0.3)
        assert round(resolved.field_center.dec, 4) == resolved.field_center.dec  # 4 decimales, como el campo

    fixed = ResolveResponse.model_validate(client.get("/api/resolve", params={"name": "M999"}).json())
    assert (fixed.name, fixed.object_type, fixed.motion, fixed.moved_arcsec) == ("M 999", "G", None, 0.0)
    assert (fixed.j2000.ra, fixed.j2000.dec) == (200.123456, -30.654321)
    assert (fixed.field_center.ra, fixed.field_center.dec) == (200.1235, -30.6543)

    for text in ["Objeto Desconocido", "no existe", "roto"]:
        response = client.get("/api/resolve", params={"name": text})
        assert (response.status_code, error_code(response)) == (404, "not_resolved"), text


def test_track(make_client: Factory, sample_fields: SampleFields) -> None:
    sample = sample_fields.a
    client = make_client()
    url = f"/api/field/{sample.id}/track"
    assert sample.track is not None
    # Por el nombre de catalogo, por el texto buscado (via la respuesta de Sesame) o sin el prefijo.
    for name in ["NAME Estrella de prueba", "Estrella de Prueba", "estrella de prueba"]:
        response = client.get(url, params={"name": name})
        assert response.status_code == 200
        assert TrackResponse.model_validate(response.json()) == sample.track
    positions = client.get(url, params={"name": "Estrella de Prueba"}).json()["positions"]
    assert [item["epoch"] for item in positions] == [1, 2]
    assert set(positions[0]) == {"epoch", "mjd", "ra", "dec", "x", "y", "in_field"}
    # Sin movimiento propio (o sin trayectoria guardada): lista vacia, la mira va en el centro del campo.
    assert client.get(url, params={"name": "Galaxia Fija"}).json() == {"name": "M 999", "positions": []}
    assert client.get(url, params={"name": "otro"}).json() == {"name": "otro", "positions": []}
    other = client.get(f"/api/field/{sample_fields.b.id}/track", params={"name": "Estrella de Prueba"})
    assert other.json()["positions"] == []


def test_track_is_not_ready_before_listed(make_client: Factory, sample_fields: SampleFields) -> None:
    """Contrato 4.9: antes de `listed` el campo no tiene epocas, y una lista vacia querria decir otra cosa."""
    sample = sample_fields.a
    client = make_client(seconds=100.0)
    at = Clock(client)
    url = f"/api/field/{sample.id}/track"
    post_field(client, sample)
    for moment in (1.0, 7.0, 11.0):  # en cola, listando y con la vista provisoria lista
        at(moment)
        for name in ("Estrella de Prueba", "Galaxia Fija", "otro", "10 20"):
            response = client.get(url, params={"name": name})
            assert (response.status_code, error_code(response)) == (409, "not_ready"), (moment, name)
            assert response.json()["error"]["retryable"] is True
    # El nombre se mira antes: uno vacio es un pedido invalido en cualquier momento.
    response = client.get(url, params={"name": "  "})
    assert (response.status_code, error_code(response)) == (422, "invalid_request")
    assert client.get("/api/field/ffffffffffffffff/track", params={"name": "x"}).status_code == 404
    # Desde `listed` hay epocas: la trayectoria guardada con la muestra.
    at(17.0)
    response = client.get(url, params={"name": "Estrella de Prueba"})
    assert response.status_code == 200 and TrackResponse.model_validate(response.json()) == sample.track
    assert client.get(url, params={"name": "Galaxia Fija"}).json() == {"name": "M 999", "positions": []}


def test_plane_and_aux_say_which_revision_they_carry(make_client: Factory, sample_fields: SampleFields) -> None:
    """Contrato 4.4 y 4.6: `X-Plane-Rev` en el plano y en sus capas auxiliares."""
    sample = sample_fields.a
    client = make_client(seconds=100.0)
    at = Clock(client)
    base = f"/api/field/{sample.id}"
    post_field(client, sample, band=3)

    at(21.0)  # primera revision provisoria del plano (1, 3)
    for params in (None, {"rev": 1}, {"rev": 2}, {"rev": 9}):
        assert client.get(f"{base}/plane/1/3", params=params).headers["x-plane-rev"] == "1", params
    aux = client.get(f"{base}/aux/1/3")
    assert (aux.headers["x-plane-rev"], aux.headers["cache-control"]) == ("1", "no-cache")
    assert "Accept-Encoding" in aux.headers["vary"]

    at(100.0)  # terminado: la definitiva es la 2
    # Quien pide la provisoria recibe la vigente, y la cabecera le dice cual es.
    replaced = client.get(f"{base}/plane/1/3", params={"rev": 1})
    assert (replaced.headers["x-plane-rev"], replaced.headers["cache-control"]) == ("2", "no-cache")
    current = client.get(f"{base}/plane/1/3", params={"rev": 2})
    assert (current.headers["x-plane-rev"], current.headers["cache-control"]) == ("2", IMMUTABLE)
    for headers in ({}, {"Accept-Encoding": "identity"}):
        aux = client.get(f"{base}/aux/1/3", headers=headers)
        assert (aux.headers["x-plane-rev"], aux.headers["cache-control"]) == ("2", "no-cache")
    # Ni el cubo ni los errores llevan la cabecera.
    assert "x-plane-rev" not in client.get(f"{base}/cube").headers
    assert "x-plane-rev" not in client.get(f"{base}/plane/2/1").headers  # plano vacio: 404
    # Desde otro origen, el frontend de desarrollo puede leerla.
    exposed = client.get(f"{base}/plane/1/3", headers={"Origin": "http://localhost:5173"})
    assert "x-plane-rev" in exposed.headers["access-control-expose-headers"].lower()


def test_aux_is_not_gzipped_for_a_client_that_refuses_it(make_client: Factory, sample_fields: SampleFields) -> None:
    sample = sample_fields.a
    client = make_client(seconds=100.0)
    post_field(client, sample, scenario="cached")
    url = f"/api/field/{sample.id}/aux/1/3"
    expected = 6 * sample.shape[0] * sample.shape[1]
    for accept, compressed in (("gzip", True), ("br, gzip;q=0.5", True), ("gzip;q=0", False), ("identity", False)):
        with client.stream("GET", url, headers={"Accept-Encoding": accept}) as response:
            raw = b"".join(response.iter_raw())
        assert (response.headers.get("content-encoding") == "gzip") is compressed, accept
        assert (len(raw) == expected) is not compressed, accept


def test_resolve_rounds_like_the_real_backend(sample_fields: SampleFields, tmp_path: Path) -> None:
    """Contrato 4.8: movimiento propio, paralaje y velocidad radial a 3 decimales; nombres sin espacios de mas."""
    (tmp_path / "precisa.xml").write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<Sesame xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<Target option="S">
  <name>Estrella  Precisa</name>
  <Resolver name="S=Simbad (CDS, via client/server)">
    <otype>PM*</otype>
    <jradeg>269.4520769586187</jradeg>
    <jdedeg>4.69336496657667</jdedeg>
    <pm><v>10393.3</v><pa>355.6</pa><pmRA>-801.55149</pmRA><pmDE>10362.39451</pmDE></pm>
    <Vel><v>-110.11049</v></Vel>
    <plx><v>546.9759</v></plx>
    <oname>NAME  Estrella   precisa</oname>
  </Resolver>
</Target>
</Sesame>
""",
        encoding="utf-8",
    )
    client = TestClient(create_fake_app(sample_fields.root, sesame_dir=tmp_path))
    response = client.get("/api/resolve", params={"name": "  estrella   precisa "})
    assert response.status_code == 200
    assert response.json() == {
        "query": "estrella precisa",
        "name": "NAME Estrella precisa",
        "source": "sesame",
        "object_type": "PM*",
        "j2000": {"ra": 269.452077, "dec": 4.693365},
        "motion": {
            "pm_ra": -801.551,
            "pm_dec": 10362.395,
            "parallax": 546.976,
            "radial_velocity": -110.11,
            "per_year_arcsec": 10.39,
        },
        "field_center": {"ra": 269.4463, "dec": 4.7683, "epoch": 2026.0},
        "moved_arcsec": 270.4,
    }
    assert client.get("/api/health").json()["names"] == ["Estrella Precisa", "NAME Estrella precisa"]


# ------------------------------------------------------------------- utilidades


def test_provisional_image_is_deterministic(sample_fields: SampleFields) -> None:
    final = sample_fields.a.images[(1, 3)]
    first = provisional_image("abc", 1, 3, final)
    again = provisional_image("abc", 1, 3, final.copy())
    assert first.dtype == np.float32 and first.shape == final.shape
    np.testing.assert_array_equal(first, again)
    assert not np.array_equal(first, provisional_image("abc", 2, 3, final), equal_nan=True)
    assert not np.array_equal(first, final, equal_nan=True)
    assert np.isnan(first).sum() > np.isnan(final).sum()
    np.testing.assert_array_equal(np.isposinf(first), np.isposinf(final))
    # Tambien con un plano sin ningun dato valido.
    empty = provisional_image("abc", 1, 1, np.full((6, 6), np.nan, dtype=np.float32))
    assert np.isnan(empty).all()


def test_module_level_app_exists() -> None:
    from app import fake

    assert isinstance(fake.app, FastAPI)
    paths = {route.path for route in fake.app.routes}  # type: ignore[attr-defined]
    assert {
        "/api/field",
        "/api/field/{field_id}/events",
        "/api/field/{field_id}/meta",
        "/api/field/{field_id}/plane/{epoch}/{detector}",
        "/api/field/{field_id}/cube",
        "/api/field/{field_id}/aux/{epoch}/{detector}",
        "/api/field/{field_id}/priority",
        "/api/field/{field_id}/preview",
        "/api/field/{field_id}/track",
        "/api/resolve",
    } <= paths
