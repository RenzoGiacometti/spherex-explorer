"""Un campo nuevo de punta a punta a traves de la API, con los recortes reales de Barnard. Sin red.

Lo unico reemplazado es la lista de exposiciones (los doce recortes guardados en
tests/fixtures/cutouts, con sus URL apuntando a un servidor HTTP local que hace
de IRSA) y la vista provisoria. `fetch_cutout`, la cache de recortes, el limite
de conexiones, `load_exposure`, el coadd y el reloj son los de verdad, y la
aplicacion arma y detiene su propio gestor de trabajos.
"""

from __future__ import annotations

import gzip
import threading
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient
from test_api_support import IMMUTABLE, parse_sse, seed_sesame, when_subscribed
from test_irsa_support import CUTOUTS_DIR, Gate, IrsaStub, exposure_from_entry, irsa_response, respond, sequence, serve
from test_jobs_e2e import DEC, ENTRIES, PLANES, RA, RecordingLoader, check_planes_against_the_pipeline, path_of
from test_jobs_support import (
    SHAPE,
    FakeIrsa,
    FakePreview,
    manager_threads,
    planes_of,
    preview_image,
    replay,
    wait_until,
)

from app import geometry
from app.api.main import create_app
from app.config import Settings
from app.contract import FieldMeta, FieldResponse, TrackResponse
from app.irsa.limits import get_limiter, reset_limiter
from app.jobs.deps import JobDeps
from app.jobs.store import split_aux, track_filename

PLANE_NBYTES = 4 * SHAPE[0] * SHAPE[1]


@pytest.fixture(autouse=True)
def _fresh_limiter() -> Iterator[None]:
    reset_limiter()
    yield
    reset_limiter()


@pytest.fixture
def stub() -> Iterator[IrsaStub]:
    server = IrsaStub()
    try:
        yield server
    finally:
        server.close()


def test_a_new_field_through_the_api_with_the_real_cutouts(stub: IrsaStub, tmp_path: Path) -> None:
    exposures = [exposure_from_entry(entry, stub.base_url) for entry in ENTRIES]
    responses = {
        path_of(exposure): irsa_response((CUTOUTS_DIR / entry["file"]).read_bytes())
        for exposure, entry in zip(exposures, ENTRIES, strict=True)
    }
    for path, body in responses.items():
        stub.routes[path] = serve(body)
    # Uno recibe primero el 503 habitual de IRSA cargado.
    busy = path_of(exposures[2])
    stub.routes[busy] = sequence(
        respond(503, b"Server busy, retry later.", headers={"Retry-After": "0"}), serve(responses[busy])
    )
    stub.gate = Gate(target=10, hold_s=0.02)  # el servidor cuenta cuantas conexiones tiene a la vez

    settings = Settings(
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        irsa_connect_timeout_s=5.0,
        irsa_read_timeout_s=10.0,
        sesame_urls=(),
        preview_enabled=True,
    )
    seed_sesame(settings, ["Barnard's Star"], main_names=True)
    irsa = FakeIrsa(exposures)  # solo se usa su lista de exposiciones
    irsa.list_gate = threading.Event()
    loader = RecordingLoader()
    deps = JobDeps(
        list_exposures=irsa.list_exposures, fetch_preview=FakePreview("ready").fetch_preview, load_exposure=loader
    )
    app = create_app(settings, deps=deps)

    # Sin gzip: se comparan los bytes y el `Content-Length` sin comprimir (httpx pide gzip por defecto).
    with TestClient(app, headers={"Accept-Encoding": "identity"}) as client:
        manager = app.state.backend.manager
        # 1. POST con el centro de Barnard, con mas decimales de los que entran en el `id`.
        posted = client.post("/api/field", json={"ra": RA, "dec": DEC, "band": 3})
        assert posted.status_code == 202
        created = FieldResponse.model_validate(posted.json())
        assert created.meta.request.model_dump() == {"ra": 269.4463, "dec": 4.7683, "fov": 0.1667}
        base = f"/api/field/{created.id}"
        wait_until(lambda: manager.get_meta(created.id).preview.status == "ready")
        # La vista provisoria ya se puede pedir, antes de que exista la lista de exposiciones.
        preview = client.get(f"{base}/preview")
        request = geometry.normalize_request(RA, DEC)
        assert preview.status_code == 200
        assert preview.content == preview_image(geometry.build_grid(request)).astype("<f4").tobytes()

        # 2. El flujo de eventos completo: la lista se suelta cuando el flujo ya esta conectado.
        opener = when_subscribed(lambda: manager.bus.subscriber_count(created.id), irsa.list_gate.set)
        stream = client.get(created.events_url)
        opener.join()
        assert stream.status_code == 200 and stream.headers["content-type"].startswith("text/event-stream")
        events, _ = parse_sse(stream.text)
        names = [event.event for event in events]
        assert names[0] == "state" and events[0].data["status"] == "listing"
        assert names[1] == "listed" and names[-2:] == ["state", "done"] and "error" not in names
        listed = FieldMeta.model_validate(events[1].data)
        assert listed.epochs is not None and [(epoch.epoch, epoch.n_exposures) for epoch in listed.epochs] == [
            (1, 6),
            (2, 6),
        ]
        assert listed.planes is not None and listed.flags == []
        assert {(plane.epoch, plane.detector) for plane in listed.planes if plane.status == "pending"} == set(PLANES)
        # Cada plano con datos sale provisorio (con una de sus tres exposiciones) y definitivo.
        revisions = planes_of(events)
        assert sorted(revisions) == sorted(
            [(epoch, detector, "building", 1, 1) for epoch, detector in PLANES]
            + [(epoch, detector, "ready", 2, 3) for epoch, detector in PLANES]
        )
        # La definitiva de cada plano sale despues de su provisoria.
        for key in PLANES:
            own = [status for epoch, detector, status, _, _ in revisions if (epoch, detector) == key]
            assert own == ["building", "ready"]
        final = FieldMeta.model_validate(events[-2].data)
        assert (final.status, final.rev) == ("ready", 1) and events[-1].data["status"] == "ready"
        assert final.provenance is not None and final.provenance.download_mode == "truncated"
        assert (final.progress.cutouts_done, final.progress.cutouts_failed, final.progress.cutouts_cached) == (
            12, 0, 0,
        )  # fmt: skip
        assert replay(events) == events[-2].data
        assert manager.wait_idle(10.0)
        assert client.get(f"{base}/meta").json() == events[-2].data

        # Lo que vio el servidor que hace de IRSA: el centro normalizado, el lado del contrato y nunca mas de diez.
        stub.wait_idle()
        assert stub.max_active <= 10 and get_limiter(settings).cutouts_in_flight == 0
        assert {hit.query["center"] for hit in stub.hits} == {"269.446300,4.768300d"}
        assert {hit.query["size"] for hit in stub.hits} == {"0.24258"}
        assert len(stub.hits) == 13 and [hit.path for hit in stub.hits].count(busy) == 2

        # 3. Los planos son, byte por byte, el coadd del pipeline con los recortes guardados.
        check_planes_against_the_pipeline(SimpleNamespace(store=manager.store), final, loader.order)  # type: ignore[arg-type]
        assert final.planes is not None and final.grid is not None
        saturation = sum(1 << flag.bit for flag in final.flags or () if flag.saturation)
        offsets: dict[tuple[int, int], int] = {}
        for plane in final.planes:
            url = f"{base}/plane/{plane.epoch}/{plane.detector}"
            if plane.status == "empty":
                assert client.get(url).status_code == 404
                continue
            key = (plane.epoch, plane.detector)
            assert plane.cube_offset is not None
            offsets[key] = plane.cube_offset
            got = client.get(url, params={"rev": plane.rev})
            assert (got.headers["cache-control"], got.headers["x-plane-rev"]) == (IMMUTABLE, "2")
            image = manager.store.read_plane(created.id, *key, shape=SHAPE)
            assert got.content == image.tobytes()
            # Capas auxiliares de esa revision: cobertura 0 donde no hay valor y flag de saturacion donde satura.
            aux = client.get(f"{base}/aux/{plane.epoch}/{plane.detector}", headers={"Accept-Encoding": "identity"})
            assert aux.headers["x-plane-rev"] == "2" and "content-encoding" not in aux.headers
            flags, coverage = split_aux(aux.content, SHAPE)
            assert np.array_equal(coverage == 0, ~np.isfinite(image)) and int(coverage.max()) == 3
            assert np.isposinf(image).sum() >= 4 and np.all(flags[np.isposinf(image)] & saturation)
            packed = manager.store.read_aux_gzip(created.id, *key, shape=SHAPE)
            assert gzip.decompress(packed) == aux.content
        assert sorted(offsets) == PLANES

        # 4. El cubo: los cuatro planos, cada uno en su `cube_offset`.
        cube = client.get(f"{base}/cube", params={"rev": final.rev})
        assert cube.headers["cache-control"] == IMMUTABLE and cube.headers["content-length"] == str(4 * PLANE_NBYTES)
        for key, offset in offsets.items():
            stored = manager.store.read_plane_bytes(created.id, *key, shape=SHAPE)
            assert cube.content[offset : offset + PLANE_NBYTES] == stored

        # 5. Avisos: Barnard satura, y los recortes guardados (0,1 grados) no llenan el campo.
        codes = [warning.code for warning in final.warnings]
        assert codes.count("saturated_source") == 1 and codes.count("low_coverage") == 4
        assert "cutouts_failed" not in codes and "full_download" not in codes

        # 6. La trayectoria de Barnard sobre las dos epocas del campo: queda guardada con el.
        track = client.get(f"{base}/track", params={"name": "Barnard's Star"})
        positions = TrackResponse.model_validate(track.json()).positions
        assert [item.epoch for item in positions] == [1, 2] and all(item.in_field for item in positions)
        # Un anio entre las dos pasadas: 10,4 segundos de arco hacia el norte, 3,4 px.
        assert positions[1].y - positions[0].y == pytest.approx(3.4, abs=0.2)
        assert (settings.cached_fields_dir / created.id / track_filename("NAME Barnard's star")).is_file()

        # 7. Pedirlo de nuevo: en cache, sin volver a tocar IRSA.
        hits = len(stub.hits)
        again = client.post("/api/field", json={"ra": 269.4463, "dec": 4.7683, "band": 6})
        assert again.status_code == 200 and FieldMeta.model_validate(again.json()["meta"]) == final
        cached_events, _ = parse_sse(client.get(created.events_url).text)
        assert [(event.id, event.event) for event in cached_events] == [(1, "state"), (2, "done")]
        assert cached_events[0].data == events[-2].data
        assert len(stub.hits) == hits and irsa.list_calls == [False]
        assert manager_threads()
    # Al cerrar la aplicacion no queda ningun hilo del gestor.
    wait_until(lambda: not manager_threads(), 10.0, f"quedaron hilos del gestor: {manager_threads()}")
