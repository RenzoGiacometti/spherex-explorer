"""Un trabajo del gestor de punta a punta, con IRSA, hips2fits y el pipeline reemplazados: eventos, documento,
revisiones de los planos, orden de descarga, reintentos y avisos."""

from __future__ import annotations

import gzip
import hashlib
import itertools
import math
import threading
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from test_jobs_support import (
    FLAG_BITS,
    SHAPE,
    HarnessFactory,
    expected_plane,
    harness_factory,
    planes_of,
    preview_image,
    replay,
    synthetic_exposure,
    validate_events,
    wait_until,
)

from app import geometry
from app.api.errors import ApiError, upstream_unavailable
from app.contract import FieldMeta
from app.irsa.cutouts import IrsaBusy, IrsaPermanent, IrsaTransient
from app.jobs.store import plane_nbytes
from app.pipeline.stats import detector_display, plane_stats, saturated_regions


@pytest.fixture
def build(tmp_path: Path) -> Iterator[HarnessFactory]:
    with harness_factory(tmp_path) as factory:
        yield factory


# ------------------------------------------------------- secuencia de eventos


def test_new_field_publishes_the_whole_sequence(build: HarnessFactory) -> None:
    harness = build({(1, 3): 4, (2, 3): 4, (1, 6): 2, (2, 6): 1})
    request = harness.request()

    first = harness.manager.submit(request)
    assert (first.id, first.status, first.rev) == (request.field_id, "queued", 0)
    assert first.progress.phase == "queued" and first.progress.queue_position == 1
    assert first.preview.status == "pending" and first.preview.band == "W2"  # pendiente: siempre W2
    # Lo que todavia no existe falta: no va en null (contrato, seccion 5).
    assert set(first.model_dump(mode="json")) == {
        "id", "pipeline", "status", "rev", "request", "progress", "warnings", "preview",
    }  # fmt: skip
    assert harness.manager.wait_idle(20.0)

    events = harness.bus.of(request.field_id)
    validate_events(events)
    assert [event.id for event in events] == list(range(1, len(events) + 1))
    names = [event.event for event in events]
    assert names[:3] == ["state", "queued", "progress"]
    assert names[-2:] == ["state", "done"]
    assert names.count("listed") == 1 and names.count("preview") == 1 and names.count("done") == 1
    assert "error" not in names
    assert events[1].data == {"position": 1}

    # Fases, en orden, y `status` del documento acompaniando.
    phases = [event.data["phase"] for event in events if event.event == "progress"]
    assert phases[0] == "listing" and phases[-1] == "finishing"
    assert [phase for index, phase in enumerate(phases) if index == 0 or phases[index - 1] != phase] == [
        "listing", "downloading", "finishing",
    ]  # fmt: skip
    listed_at = names.index("listed")
    assert names.index("progress") < listed_at
    assert events[listed_at + 1].event == "progress" and events[listed_at + 1].data["phase"] == "downloading"
    assert all(name != "plane" for name in names[:listed_at])

    listed = FieldMeta.model_validate(events[listed_at].data)
    assert listed.status == "downloading" and listed.rev == 0 and listed.flags == []
    assert listed.grid is not None and listed.grid.shape == SHAPE
    assert listed.grid.crval == (request.ra, request.dec)
    assert listed.provenance is not None
    assert listed.provenance.download_mode is None and listed.provenance.built_at is None
    assert listed.provenance.collections == ["spherex_dr1", "spherex_qr3"]
    assert [(plane.epoch, plane.detector) for plane in listed.planes or ()] == [
        (epoch, detector) for epoch in (1, 2) for detector in range(1, 7)
    ]
    statuses = {(plane.epoch, plane.detector): plane.status for plane in listed.planes or ()}
    with_exposures = {(1, 3), (2, 3), (1, 6), (2, 6)}
    assert all(status == ("pending" if key in with_exposures else "empty") for key, status in statuses.items())
    assert all(plane.rev == 0 and plane.cube_offset is None for plane in listed.planes or ())
    assert [epoch.n_exposures for epoch in listed.epochs or ()] == [6, 5]
    assert listed.progress.cutouts_total == 11
    assert (listed.progress.planes_total, listed.progress.planes_ready) == (12, 8)

    # El `state` final: el unico con `cube_offset`, `flags` completo y `built_at`.
    final = FieldMeta.model_validate(events[-2].data)
    assert (final.status, final.rev, final.progress.phase) == ("ready", 1, "done")
    assert final.provenance is not None and final.provenance.built_at is not None
    assert final.provenance.download_mode == "truncated" and final.provenance.list_stale is False
    assert [flag.name for flag in final.flags or ()] == sorted(FLAG_BITS, key=FLAG_BITS.__getitem__)
    assert [flag.name for flag in final.flags or () if flag.saturation] == ["OVERFLOW", "BLOOM"]
    offsets = [plane.cube_offset for plane in final.planes or () if plane.status == "ready"]
    assert offsets == [index * plane_nbytes(SHAPE) for index in range(4)]
    assert all(plane.cube_offset is None for plane in final.planes or () if plane.status == "empty")
    assert final.progress.model_dump() == {
        "phase": "done", "queue_position": 0, "cutouts_total": 11, "cutouts_done": 11, "cutouts_failed": 0,
        "cutouts_cached": 0, "planes_total": 12, "planes_ready": 12, "elapsed_s": final.progress.elapsed_s,
    }  # fmt: skip
    assert events[-1].data == {"status": "ready", "rev": 1, "elapsed_s": final.progress.elapsed_s}
    for event in events[:-2]:
        if event.event in ("state", "listed"):
            document = FieldMeta.model_validate(event.data)
            assert all(plane.cube_offset is None for plane in document.planes or ())
            assert document.provenance is None or document.provenance.built_at is None

    # Quien sigue el flujo llega al mismo documento que trae el `state` final.
    followed = replay(events[:-2])
    assert followed is not None
    assert followed["planes"] == [{**plane, "cube_offset": None} for plane in events[-2].data["planes"]]
    assert followed["detectors"] == events[-2].data["detectors"]
    assert followed["warnings"] == events[-2].data["warnings"]
    assert followed["preview"] == events[-2].data["preview"]
    assert replay(events) == {**events[-2].data}

    # Y el campo queda en el almacen tal como salio.
    assert harness.store.read_meta(request.field_id) == final
    assert harness.manager.get_meta(request.field_id) == final
    assert harness.irsa.pruned == 2  # al crear el gestor y al terminar el trabajo


def test_planes_are_the_coadd_of_their_exposures(build: HarnessFactory) -> None:
    harness = build({(1, 3): 4, (2, 3): 3, (2, 6): 1}, max_cutout_downloads=1)
    meta = harness.run()
    field_id = meta.id
    members = {(1, 3): ["E1D3N0", "E1D3N1", "E1D3N2", "E1D3N3"], (2, 3): ["E2D3N0", "E2D3N1", "E2D3N2"]}
    members[(2, 6)] = ["E2D6N0"]
    images = {}
    for key, obs_ids in members.items():
        expected = expected_plane(harness, obs_ids)
        image = harness.store.read_plane(field_id, *key, shape=SHAPE)
        flags, coverage = harness.store.read_aux(field_id, *key, shape=SHAPE)
        assert image.tobytes() == expected.image.tobytes()
        assert np.array_equal(flags, expected.flags) and np.array_equal(coverage, expected.coverage)
        images[key] = image
        plane = meta.plane(*key)
        assert plane is not None
        assert plane.stats == plane_stats(image) and plane.saturated == saturated_regions(image)
        assert (plane.n_exposures, plane.n_used, plane.n_failed) == (len(obs_ids), len(obs_ids), 0)
        mjds = [item.mjd_start for item in harness.irsa.exposures if item.obs_id in obs_ids]
        assert plane.mjd_mean == round(sum(mjds) / len(mjds), 4)
    assert meta.detectors is not None
    assert meta.detectors[2].display == detector_display([images[(1, 3)], images[(2, 3)]])
    assert meta.detectors[5].display == detector_display([images[(2, 6)]])
    assert meta.detectors[0].display is None
    assert (meta.detectors[2].wave_min_um, meta.detectors[2].wave_max_um) == (1.6301, 2.4302)
    # `/cube`: los planos con datos, uno detras de otro en el orden de `planes`.
    cube = b"".join(harness.store.iter_cube(field_id, meta))
    assert cube == b"".join(images[key].tobytes() for key in [(1, 3), (2, 3), (2, 6)])


# ------------------------------------------------------------------ revisiones


def test_each_plane_gets_a_provisional_revision_at_half_and_a_final_one(build: HarnessFactory) -> None:
    harness = build({(1, 3): 6, (2, 3): 1, (3, 3): 2, (1, 4): 5}, max_cutout_downloads=1)
    request = harness.request()
    snapshots: dict[tuple[int, int, int], str] = {}

    def on_event(field_id: str, name: str, data: Mapping[str, Any]) -> None:
        # Cuando sale el evento, el binario de esa revision ya esta en el almacen.
        if name == "plane" and data["plane"]["status"] != "empty":
            plane = data["plane"]
            payload = harness.store.read_plane_bytes(field_id, plane["epoch"], plane["detector"], shape=SHAPE)
            snapshots[(plane["epoch"], plane["detector"], plane["rev"])] = hashlib.sha256(payload).hexdigest()

    harness.bus.hook = on_event
    meta = harness.run(request)
    events = harness.bus.of(request.field_id)
    assert planes_of(events) == [
        (2, 3, "ready", 1, 1),  # una sola exposicion: sin provisoria, y la definitiva es la 1
        (3, 3, "building", 1, 1),
        (3, 3, "ready", 2, 2),
        (1, 3, "building", 1, 3),  # la mitad de 6
        (1, 3, "ready", 2, 6),
        (1, 4, "building", 1, 2),  # la mitad de 5, hacia abajo
        (1, 4, "ready", 2, 5),
    ]
    assert {(plane.epoch, plane.detector): plane.rev for plane in meta.planes or () if plane.rev} == {
        (1, 3): 2, (2, 3): 1, (3, 3): 2, (1, 4): 2,
    }  # fmt: skip
    # La provisoria es el coadd de las exposiciones que habian entrado, no la definitiva.
    half = expected_plane(harness, ["E1D3N0", "E1D3N1", "E1D3N2"])
    assert snapshots[(1, 3, 1)] == hashlib.sha256(half.image.tobytes()).hexdigest()
    assert snapshots[(1, 3, 1)] != snapshots[(1, 3, 2)]
    assert (
        harness.store.read_plane_bytes(request.field_id, 1, 3, shape=SHAPE)
        == expected_plane(harness, [f"E1D3N{order}" for order in range(6)]).image.tobytes()
    )

    # `detector_display` se recalcula con los planos del detector que ya tienen datos.
    displays = [event.data["detector_display"] for event in events if event.event == "plane"]
    assert all(display is not None for display in displays)
    assert [display["detector"] for display in displays] == [3, 3, 3, 3, 3, 4, 4]
    others = [expected_plane(harness, ["E2D3N0"]).image, expected_plane(harness, ["E3D3N0", "E3D3N1"]).image]
    assert displays[0] == {"detector": 3, **detector_display(others[:1]).model_dump()}  # type: ignore[union-attr]
    with_half = detector_display([half.image, *others])
    assert displays[3] == {"detector": 3, **with_half.model_dump()}  # type: ignore[union-attr]
    assert displays[3] != displays[4]
    assert meta.detectors is not None
    assert displays[4] == {"detector": 3, **meta.detectors[2].display.model_dump()}  # type: ignore[union-attr]

    # `planes_ready` cuenta los definitivos y los vacios; una provisoria no suma.
    ready = [event.data["planes_ready"] for event in events if event.event == "progress"]
    assert ready == sorted(ready) and ready[-1] == 18
    stats = [event.data["plane"]["stats"] for event in events if event.event == "plane"]
    assert all(item is not None and item["valid_fraction"] == 1.0 for item in stats)


def test_cutouts_are_requested_in_the_order_of_the_contract(build: HarnessFactory) -> None:
    counts = {(1, 3): 3, (2, 3): 2, (3, 3): 3, (1, 2): 1, (2, 4): 2, (1, 6): 1, (2, 1): 1}
    harness = build(counts, max_cutout_downloads=1)
    harness.run(harness.request(band=3))
    assert harness.irsa.calls == [
        "E1D3N0", "E2D3N0", "E3D3N0", "E1D3N1", "E2D3N1", "E3D3N1", "E1D3N2", "E3D3N2",
        "E1D2N0", "E2D4N0", "E2D4N1", "E2D1N0", "E1D6N0",
    ]  # fmt: skip
    # Todos piden el mismo centro y el lado del recorte que cubre la grilla con cualquier giro.
    request = harness.request()
    assert set(harness.irsa.centers) == {(request.ra, request.dec)}


def test_another_band_reorders_the_whole_field(build: HarnessFactory) -> None:
    harness = build({(1, 1): 2, (1, 3): 1, (1, 5): 2, (2, 5): 1, (1, 6): 1}, max_cutout_downloads=1)
    harness.run(harness.request(band=5))
    assert harness.irsa.calls == ["E1D5N0", "E2D5N0", "E1D5N1", "E1D6N0", "E1D3N0", "E1D1N0", "E1D1N1"]
    # La vista provisoria queda con la banda de ese pedido: W2 para los detectores 5 y 6.
    assert harness.preview.calls == [5]
    assert harness.manager.get_meta(harness.request().field_id).preview.band == "W2"


def test_set_priority_moves_a_band_forward(build: HarnessFactory) -> None:
    counts = {(1, 1): 2, (1, 3): 2, (1, 5): 2, (1, 6): 2}
    harness = build(counts, max_cutout_downloads=1)
    harness.irsa.gate = threading.Event()
    request = harness.request(band=3)
    harness.manager.submit(request)
    wait_until(lambda: harness.irsa.calls == ["E1D3N0"])  # la primera descarga ya salio y esta retenida
    harness.manager.set_priority(request.field_id, 6)
    harness.irsa.gate.set()
    assert harness.manager.wait_idle(20.0)
    assert harness.irsa.calls == [
        "E1D3N0", "E1D6N0", "E1D6N1", "E1D5N0", "E1D5N1", "E1D3N1", "E1D1N0", "E1D1N1",
    ]  # fmt: skip
    meta = harness.manager.get_meta(request.field_id)
    assert meta.status == "ready" and meta.preview.band == "W1"  # la vista no cambia con la prioridad
    harness.manager.set_priority(request.field_id, 2)  # ya termino: no hace nada
    with pytest.raises(ApiError) as missing:
        harness.manager.set_priority("0000000000000000", 2)
    assert missing.value.code == "not_found"
    with pytest.raises(ApiError) as invalid:
        harness.manager.set_priority(request.field_id, 7)
    assert invalid.value.code == "invalid_request"


def test_a_second_request_with_another_band_moves_it_forward(build: HarnessFactory) -> None:
    harness = build({(1, 2): 2, (1, 3): 2, (1, 4): 2}, max_cutout_downloads=1)
    harness.irsa.gate = threading.Event()
    harness.manager.submit(harness.request(band=3))
    wait_until(lambda: harness.irsa.calls == ["E1D3N0"])
    joined = harness.manager.submit(harness.request(band=4))
    assert joined.status == "downloading" and joined.id == harness.request().field_id
    harness.irsa.gate.set()
    assert harness.manager.wait_idle(20.0)
    assert harness.irsa.calls == ["E1D3N0", "E1D4N0", "E1D4N1", "E1D3N1", "E1D2N0", "E1D2N1"]
    assert len(harness.irsa.list_calls) == 1  # un solo trabajo para los dos pedidos
    assert harness.bus.names(joined.id).count("done") == 1


# ------------------------------------------------------------------ reintentos


def test_retry_after_is_respected_and_the_connection_is_used_meanwhile(build: HarnessFactory) -> None:
    harness = build({(1, 3): 4}, auto_clock=False, max_cutout_downloads=1)
    harness.irsa.script["E1D3N0"] = [IrsaBusy("HTTP 503: Server busy, retry later.", retry_after=5.0, requested=5.0)]
    request = harness.request()
    harness.manager.submit(request)
    # Con una sola conexion: mientras el primero espera, bajan los otros tres.
    wait_until(lambda: harness.manager.get_meta(request.field_id).progress.cutouts_done == 3)
    assert harness.irsa.calls == ["E1D3N0", "E1D3N1", "E1D3N2", "E1D3N3"]
    assert harness.irsa.active == 0
    meta = harness.manager.get_meta(request.field_id)
    plane = meta.plane(1, 3)
    assert plane is not None and (plane.status, plane.n_used) == ("building", 2)
    assert meta.status == "downloading" and meta.progress.cutouts_failed == 0

    harness.clock.advance(4.9)
    threading.Event().wait(0.05)
    assert harness.irsa.attempts("E1D3N0") == 1  # todavia no paso lo que pidio IRSA
    harness.clock.advance(0.2)
    assert harness.manager.wait_idle(20.0)
    assert harness.irsa.calls[-1] == "E1D3N0" and harness.irsa.attempts("E1D3N0") == 2
    times = [moment for obs_id, moment in harness.irsa.call_times if obs_id == "E1D3N0"]
    assert times[1] - times[0] >= 5.0
    final = harness.manager.get_meta(request.field_id)
    assert final.status == "ready" and final.progress.cutouts_done == 4
    assert planes_of(harness.bus.of(request.field_id)) == [(1, 3, "building", 1, 2), (1, 3, "ready", 2, 4)]


def test_busy_cutouts_do_not_take_a_download_thread_while_they_wait(build: HarnessFactory) -> None:
    """Con todos los recortes en espera de `Retry-After` no hay ninguna descarga en curso."""
    harness = build({(1, 3): 6}, auto_clock=False, max_cutout_downloads=2)
    for order in range(6):
        harness.irsa.script[f"E1D3N{order}"] = [IrsaBusy("HTTP 503", retry_after=5.0, requested=5.0)]
    request = harness.request()
    harness.manager.submit(request)
    wait_until(lambda: len(harness.irsa.calls) == 6)
    threading.Event().wait(0.05)
    assert harness.irsa.active == 0 and len(harness.irsa.calls) == 6
    harness.clock.advance(5.1)
    assert harness.manager.wait_idle(20.0)
    assert len(harness.irsa.calls) == 12 and harness.irsa.max_active <= 2
    assert harness.manager.get_meta(request.field_id).status == "ready"


def test_a_retry_after_above_the_maximum_fails_that_cutout_without_insisting(build: HarnessFactory) -> None:
    harness = build({(1, 3): 3, (2, 3): 2}, max_cutout_downloads=1)
    harness.irsa.script["E1D3N1"] = [IrsaBusy("HTTP 503 (Retry-After de 3600 s)", retry_after=60.0, requested=3600.0)]
    request = harness.request()
    meta = harness.run(request)
    assert harness.irsa.attempts("E1D3N1") == 1  # ni reintento ni segunda pasada
    assert meta.status == "partial" and meta.rev == 1
    plane = meta.plane(1, 3)
    assert plane is not None
    assert (plane.status, plane.n_exposures, plane.n_used, plane.n_failed) == ("partial", 3, 2, 1)
    assert (meta.progress.cutouts_done, meta.progress.cutouts_failed) == (4, 1)
    failed = [warning for warning in meta.warnings if warning.code == "cutouts_failed"]
    assert [warning.model_dump() for warning in failed] == [
        {"code": "cutouts_failed", "n": 1, "planes": [{"epoch": 1, "detector": 3}]}
    ]
    events = harness.bus.of(request.field_id)
    assert events[-1].data["status"] == "partial"
    assert [event.data for event in events if event.event == "warning" and event.data["code"] == "cutouts_failed"] == [
        failed[0].model_dump(mode="json")
    ]
    # El aviso sale al cerrar, antes del `progress` de `finishing`.
    names = [event.event for event in events]
    assert names[-4:] == ["warning", "progress", "state", "done"]
    assert (
        harness.store.read_plane(request.field_id, 1, 3, shape=SHAPE).tobytes()
        == expected_plane(harness, ["E1D3N0", "E1D3N2"]).image.tobytes()
    )


def test_six_attempts_then_a_second_pass(build: HarnessFactory) -> None:
    harness = build({(1, 3): 4, (2, 3): 2, (1, 4): 1}, max_cutout_downloads=1, cutout_attempts=6)
    cut = IrsaTransient("ChunkedEncodingError: la conexion se corto")
    harness.irsa.script["E1D3N1"] = [cut] * 6  # se recupera en la segunda pasada
    harness.irsa.script["E2D3N0"] = [IrsaBusy("HTTP 503", retry_after=5.0)] * 6 + [cut] * 2  # no se recupera
    harness.irsa.script["E1D4N0"] = [IrsaPermanent("HTTP 422: Arrays do not overlap.")]  # no se reintenta
    request = harness.request()
    meta = harness.run(request)

    assert harness.irsa.attempts("E1D3N1") == 7
    assert harness.irsa.attempts("E2D3N0") == 8  # seis, y dos en la segunda pasada
    assert harness.irsa.attempts("E1D4N0") == 1
    # La segunda pasada va al final, cuando ya no queda nada de la primera.
    assert harness.irsa.calls[-3:] == ["E2D3N0", "E1D3N1", "E2D3N0"]
    # Las esperas crecen: cada reintento sale despues del anterior mas la espera que le toca.
    times = [moment for obs_id, moment in harness.irsa.call_times if obs_id == "E1D3N1"]
    gaps = [later - earlier for earlier, later in itertools.pairwise(times[:6])]
    assert all(gap >= wait for gap, wait in zip(gaps, [1.0, 2.0, 3.0, 4.0, 5.0], strict=True))
    busy = [moment for obs_id, moment in harness.irsa.call_times if obs_id == "E2D3N0"]
    assert all(later - earlier >= 5.0 for earlier, later in itertools.pairwise(busy[:6]))

    events = harness.bus.of(request.field_id)
    assert planes_of(events) == [
        (2, 3, "building", 1, 1),
        (1, 3, "building", 1, 2),
        (1, 4, "empty", 1, 0),
        (1, 3, "partial", 2, 3),  # definitiva al agotar los intentos del que falta
        (2, 3, "partial", 2, 1),
        (1, 3, "ready", 3, 4),  # la segunda pasada lo recupera: otra revision
    ]
    assert meta.status == "partial"
    assert (meta.progress.cutouts_done, meta.progress.cutouts_failed, meta.progress.cutouts_total) == (5, 2, 7)
    failed = [event.data["cutouts_failed"] for event in events if event.event == "progress"]
    assert max(failed) == 3 and failed[-1] == 2
    assert [plane.n_failed for plane in meta.planes or () if plane.n_exposures] == [0, 1, 1]
    (warning,) = [item for item in meta.warnings if item.code == "cutouts_failed"]
    assert warning.model_dump()["planes"] == [{"epoch": 1, "detector": 4}, {"epoch": 2, "detector": 3}]
    assert warning.n == 2
    # El plano que quedo sin ninguna exposicion: vacio, sin binario, con su aviso.
    empty = meta.plane(1, 4)
    assert empty is not None and (empty.status, empty.rev, empty.stats, empty.mjd_mean) == ("empty", 1, None, None)
    assert not (harness.store.write_root / request.field_id / "plane_e1_d4.f32").exists()
    assert {"code": "plane_empty", "epoch": 1, "detector": 4} in [
        event.data for event in events if event.event == "warning"
    ]
    empty_event = next(event for event in events if event.event == "plane" and event.data["plane"]["detector"] == 4)
    assert empty_event.data["detector_display"] is None
    assert (
        harness.store.read_plane(request.field_id, 1, 3, shape=SHAPE).tobytes()
        == expected_plane(harness, ["E1D3N0", "E1D3N2", "E1D3N3", "E1D3N1"]).image.tobytes()
    )


def test_an_unreadable_cutout_is_discarded_and_requested_once_more(build: HarnessFactory) -> None:
    harness = build({(1, 3): 3, (2, 3): 2}, max_cutout_downloads=1)
    harness.pipeline.unreadable = {"E1D3N0": 1, "E2D3N1": 2}
    request = harness.request()
    meta = harness.run(request)
    cache = harness.settings.cutout_cache_dir
    # El que se pudo leer al segundo intento entra; el que no, se da por perdido sin insistir.
    assert harness.irsa.attempts("E1D3N0") == 2 and harness.irsa.attempts("E2D3N1") == 2
    assert harness.irsa.discarded == [cache / "E1D3N0.fits", cache / "E2D3N1.fits", cache / "E2D3N1.fits"]
    assert harness.pipeline.calls.count("E1D3N0") == 2 and harness.pipeline.calls.count("E2D3N1") == 2
    first, second = meta.plane(1, 3), meta.plane(2, 3)
    assert first is not None and (first.status, first.n_used, first.n_failed) == ("ready", 3, 0)
    assert second is not None and (second.status, second.n_used, second.n_failed) == ("partial", 1, 1)
    assert meta.status == "partial" and (meta.progress.cutouts_done, meta.progress.cutouts_failed) == (4, 1)


def test_a_cutout_with_a_conflicting_flag_table_is_lost(build: HarnessFactory) -> None:
    harness = build({(1, 3): 3}, max_cutout_downloads=1)
    harness.pipeline.bad_table = {"E1D3N2"}
    meta = harness.run()
    plane = meta.plane(1, 3)
    assert plane is not None and (plane.status, plane.n_used, plane.n_failed) == ("partial", 2, 1)
    assert harness.irsa.attempts("E1D3N2") == 1 and harness.irsa.discarded == []
    assert [flag.bit for flag in meta.flags or ()] == sorted(FLAG_BITS.values())


def test_irsa_down_for_every_cutout_fails_the_job(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2, (2, 3): 1}, cutout_attempts=3)
    for exposure in harness.irsa.exposures:
        harness.irsa.script[exposure.obs_id] = [IrsaTransient("ConnectTimeout")] * 20
    request = harness.request()
    meta = harness.run(request)
    assert all(harness.irsa.attempts(exposure.obs_id) == 5 for exposure in harness.irsa.exposures)  # 3 y 2
    assert (meta.status, meta.rev, meta.progress.phase) == ("failed", 0, "downloading")
    assert (meta.progress.cutouts_done, meta.progress.cutouts_failed) == (0, 3)
    events = harness.bus.of(request.field_id)
    assert events[-1].event == "error"
    assert events[-1].data["error"]["code"] == "upstream_unavailable" and events[-1].data["error"]["retryable"] is True
    assert "done" not in [event.event for event in events]
    assert harness.store.read_meta(request.field_id).status == "failed"


def test_irsa_down_stops_a_big_field_after_the_first_cutouts(build: HarnessFactory) -> None:
    harness = build({(1, 3): 30, (2, 3): 30}, max_cutout_downloads=1, cutout_attempts=2)
    for exposure in harness.irsa.exposures:
        harness.irsa.script[exposure.obs_id] = [IrsaTransient("ConnectTimeout")] * 20
    # Un intento de cada uno de los 60 y el segundo de los diez primeros: con eso alcanza para saberlo.
    harness.irsa.hold_after = 70
    request = harness.request()
    meta = harness.run(request)
    assert (meta.status, meta.progress.phase) == ("failed", "downloading")
    assert (meta.progress.cutouts_done, meta.progress.cutouts_failed) == (0, 10)
    assert len(harness.irsa.calls) in (70, 71)  # no insiste con los cincuenta que faltan
    error = harness.bus.last(request.field_id, "error").data["error"]
    assert error["code"] == "upstream_unavailable" and error["retryable"] is True
    assert "plane" not in harness.bus.names(request.field_id)


# ---------------------------------------------------------------------- avisos


def test_progress_events_are_throttled(build: HarnessFactory) -> None:
    clock: list[Any] = []

    def slow_load(path: Path, grid: Any) -> Any:
        clock[0].advance(0.1)  # cada recorte "tarda" 0,1 s en llegar y procesarse
        return synthetic_exposure(Path(path).stem, grid)

    harness = build({(1, 3): 20}, max_cutout_downloads=1, progress_events_per_s=4.0, deps={"load_exposure": slow_load})
    clock.append(harness.clock)
    request = harness.request()
    times: list[tuple[str, float]] = []

    def on_event(field_id: str, name: str, data: Mapping[str, Any]) -> None:
        if name == "progress":
            times.append((data["phase"], harness.clock()))

    harness.bus.hook = on_event
    harness.run(request)
    events = harness.bus.of(request.field_id)
    progress = [event for event in events if event.event == "progress"]
    phases = [event.data["phase"] for event in progress]
    # Uno por cambio de fase, y durante la descarga como mucho 4 por segundo (2 s de descarga).
    assert phases[:2] == ["listing", "downloading"] and phases[-1] == "finishing"
    downloading = [moment for phase, moment in times if phase == "downloading"][1:]
    assert 5 <= len(downloading) <= 8
    assert all(later - earlier >= 0.25 for earlier, later in itertools.pairwise(downloading))
    done = [event.data["cutouts_done"] for event in progress]
    assert done == sorted(done) and done[-1] == 20
    elapsed = [event.data["elapsed_s"] for event in progress]
    assert elapsed == sorted(elapsed) and 1.9 <= elapsed[-1] <= 2.2


def test_without_time_passing_only_phase_changes_publish_progress(build: HarnessFactory) -> None:
    harness = build({(1, 3): 6}, progress_events_per_s=4.0)
    request = harness.request()
    harness.run(request)
    phases = [event.data["phase"] for event in harness.bus.all_of(request.field_id, "progress")]
    assert phases == ["listing", "downloading", "finishing"]


def test_warnings_known_from_the_list_travel_in_listed(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2, (1, 6): 5, (2, 3): 4})
    harness.irsa.stale = True
    harness.irsa.listed_at = "2026-11-01T03:04:05Z"
    request = harness.request()
    meta = harness.run(request)
    events = harness.bus.of(request.field_id)
    listed = harness.bus.last(request.field_id, "listed").data
    with_exposures = {(1, 3), (1, 6), (2, 3)}
    empty = [
        {"code": "plane_empty", "epoch": epoch, "detector": detector}
        for epoch in (1, 2)
        for detector in range(1, 7)
        if (epoch, detector) not in with_exposures
    ]
    assert listed["warnings"] == [
        {"code": "stale_exposure_list", "listed_at": "2026-11-01T03:04:05Z"},
        *empty,
        {"code": "few_exposures", "epoch": 1, "detector": 3, "n": 2},
        {"code": "few_exposures", "epoch": 2, "detector": 3, "n": 4},
    ]
    assert listed["provenance"]["list_stale"] is True and listed["provenance"]["listed_at"] == "2026-11-01T03:04:05Z"
    # Ya viajaron en `listed`: no se repiten como eventos `warning`.
    assert [event for event in events if event.event == "warning"] == []
    assert [warning.model_dump(mode="json") for warning in meta.warnings] == listed["warnings"]
    assert meta.provenance is not None and meta.provenance.list_stale is True
    assert meta.status == "ready"


def test_few_exposures_counts_the_ones_that_were_used(build: HarnessFactory) -> None:
    harness = build({(1, 3): 6, (1, 4): 3}, max_cutout_downloads=1)
    harness.irsa.script["E1D3N0"] = [IrsaPermanent("HTTP 422")]
    harness.irsa.script["E1D3N1"] = [IrsaPermanent("HTTP 422")]
    harness.irsa.script["E1D4N2"] = [IrsaPermanent("HTTP 422")]
    request = harness.request()
    meta = harness.run(request)
    listed = harness.bus.last(request.field_id, "listed").data
    assert [item for item in listed["warnings"] if item["code"] == "few_exposures"] == [
        {"code": "few_exposures", "epoch": 1, "detector": 4, "n": 3}
    ]
    few = [warning.model_dump() for warning in meta.warnings if warning.code == "few_exposures"]
    assert few == [
        {"code": "few_exposures", "epoch": 1, "detector": 3, "n": 4},  # tenia 6 y entraron 4
        {"code": "few_exposures", "epoch": 1, "detector": 4, "n": 2},
    ]
    sent = [event.data for event in harness.bus.all_of(request.field_id, "warning")]
    assert [item for item in sent if item["code"] == "few_exposures"] == few


def test_a_saturated_source_is_warned_once(build: HarnessFactory) -> None:
    harness = build({(1, 3): 4, (2, 3): 4, (1, 6): 2}, max_cutout_downloads=1)
    harness.pipeline.saturated = {(1, 3), (2, 3)}
    request = harness.request()
    meta = harness.run(request)
    image = harness.store.read_plane(request.field_id, 1, 3, shape=SHAPE)
    flags, coverage = harness.store.read_aux(request.field_id, 1, 3, shape=SHAPE)
    saturated = np.isposinf(image)
    assert saturated.sum() == 29 and saturated[97, 97]
    assert np.all(flags[saturated] == 1 << FLAG_BITS["OVERFLOW"]) and np.all(coverage[saturated] == 0)
    plane = meta.plane(1, 3)
    assert plane is not None and plane.stats is not None
    assert [(region.x, region.y, region.n_pixels) for region in plane.saturated] == [(97.0, 97.0, 29)]
    assert plane.stats.saturated_fraction == round(29 / (195 * 195), 4)
    clean = meta.plane(1, 6)
    assert clean is not None and clean.saturated == []

    sources = [warning for warning in meta.warnings if warning.code == "saturated_source"]
    assert len(sources) == 1
    source = sources[0]
    assert (source.epochs, source.detectors) == ([1, 2], [3])
    assert (source.ra, source.dec) == (request.ra, request.dec)
    assert source.radius_arcsec == round(plane.saturated[0].radius_px * 3.075, 1)
    # Por el flujo sale una vez, con el primer plano definitivo que la muestra y lo que se sabia entonces.
    events = harness.bus.of(request.field_id)
    sent = [event.data for event in events if event.event == "warning"]
    assert [item for item in sent if item["code"] == "saturated_source"] == [
        {**source.model_dump(mode="json"), "epochs": [1]}
    ]
    position = next(index for index, event in enumerate(events) if event.event == "warning")
    assert events[position - 1].event == "plane" and events[position - 1].data["plane"]["status"] == "ready"
    # Las provisorias ya marcaban la region en `planes[].saturated`, pero todavia sin aviso.
    first_plane = next(event for event in events if event.event == "plane")
    assert first_plane.data["plane"]["status"] == "building" and len(first_plane.data["plane"]["saturated"]) == 1
    assert events.index(first_plane) < position - 1


def test_low_coverage_is_warned_with_the_final_revision(build: HarnessFactory) -> None:
    def half_covered(path: Path, grid: Any) -> Any:
        exposure = synthetic_exposure(Path(path).stem, grid)
        exposure.footprint[:, :60] = False
        exposure.image[:, :60] = np.nan
        exposure.variance[:, :60] = np.nan
        return exposure

    harness = build({(1, 3): 6}, max_cutout_downloads=1, deps={"load_exposure": half_covered})
    request = harness.request()
    meta = harness.run(request)
    fraction = round(135 / 195, 4)
    assert [warning.model_dump() for warning in meta.warnings if warning.code == "low_coverage"] == [
        {"code": "low_coverage", "epoch": 1, "detector": 3, "valid_fraction": fraction}
    ]
    events = harness.bus.of(request.field_id)
    position = next(index for index, event in enumerate(events) if event.event == "warning")
    assert events[position].data["code"] == "low_coverage"
    assert events[position - 1].event == "plane" and events[position - 1].data["plane"]["status"] == "ready"


def test_full_downloads_are_reported(build: HarnessFactory) -> None:
    harness = build({(1, 3): 3}, max_cutout_downloads=1)
    harness.irsa.modes = {"E1D3N1": "full", "E1D3N2": "full"}
    harness.irsa.reasons = {"E1D3N1": "una extension no empieza con XTENSION", "E1D3N2": "otro motivo"}
    request = harness.request()
    meta = harness.run(request)
    assert meta.provenance is not None and meta.provenance.download_mode == "mixed"
    expected = {"code": "full_download", "reason": "una extension no empieza con XTENSION"}
    assert [warning.model_dump() for warning in meta.warnings if warning.code == "full_download"] == [expected]
    # `few_exposures` ya viajo en `listed`; por el flujo sale solo este, una vez.
    assert [event.data for event in harness.bus.all_of(request.field_id, "warning")] == [expected]


def test_download_mode_full_and_cached_cutouts(build: HarnessFactory) -> None:
    harness = build({(1, 3): 5})
    obs_ids = [exposure.obs_id for exposure in harness.irsa.exposures]
    harness.irsa.modes = dict.fromkeys(obs_ids, "full")
    harness.irsa.from_cache = set(obs_ids[:3])
    meta = harness.run()
    assert meta.provenance is not None and meta.provenance.download_mode == "full"
    assert (meta.progress.cutouts_done, meta.progress.cutouts_cached) == (5, 3)
    assert [warning.code for warning in meta.warnings] == [*["plane_empty"] * 5, "full_download"]


def test_flags_and_download_mode_appear_with_the_first_cutout(build: HarnessFactory) -> None:
    harness = build({(1, 3): 4, (2, 3): 4}, max_cutout_downloads=1)
    harness.irsa.hold_after = 3
    request = harness.request()
    harness.manager.submit(request)

    def three_processed() -> bool:
        current = harness.manager.get_meta(request.field_id)
        plane = current.plane(1, 3)
        return current.progress.cutouts_done == 3 and plane is not None and plane.status == "building"

    wait_until(three_processed)
    meta = harness.manager.get_meta(request.field_id)
    # A mitad de la carga, `GET .../meta` ya trae los bits leidos y el modo de descarga.
    assert [flag.name for flag in meta.flags or ()] == sorted(FLAG_BITS, key=FLAG_BITS.__getitem__)
    assert meta.provenance is not None and meta.provenance.download_mode == "truncated"
    assert meta.provenance.built_at is None and meta.status == "downloading" and meta.rev == 0
    statuses = {(plane.epoch, plane.detector): (plane.status, plane.rev) for plane in meta.planes or ()}
    assert statuses[(1, 3)] == ("building", 1) and statuses[(2, 3)] == ("pending", 0)
    assert all(plane.cube_offset is None for plane in meta.planes or ())
    assert harness.bus.last(request.field_id, "listed").data["flags"] == []
    # El plano provisorio ya se puede leer del almacen; el pendiente todavia no tiene archivo.
    assert harness.store.read_plane(request.field_id, 1, 3, shape=SHAPE).shape == SHAPE
    assert not (harness.store.write_root / request.field_id / "plane_e2_d3.f32").exists()
    harness.irsa.resume.set()
    assert harness.manager.wait_idle(20.0)
    assert harness.manager.get_meta(request.field_id).status == "ready"


# ------------------------------------------------------------ vista provisoria


def test_preview_ready_is_saved_with_the_field(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2})
    request = harness.request()
    meta = harness.run(request)
    (event,) = harness.bus.all_of(request.field_id, "preview")
    grid = geometry.build_grid(request)
    image = preview_image(grid)
    assert event.data == {
        "status": "ready", "survey": "WISE", "band": "W1", "wave_um": 3.4, "hips": "prueba/WISE/W1",
        "display": detector_display([image]).model_dump(),  # type: ignore[union-attr]
    }  # fmt: skip
    assert meta.preview.model_dump(mode="json") == event.data
    assert harness.store.has_preview(request.field_id)
    saved = harness.store.read_preview(request.field_id, shape=SHAPE)
    assert np.array_equal(saved, image, equal_nan=True)


def test_preview_down_does_not_fail_the_field(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2}, preview="down")
    request = harness.request(band=6)
    meta = harness.run(request)
    (event,) = harness.bus.all_of(request.field_id, "preview")
    assert event.data["status"] == "unavailable" and event.data["display"] is None and event.data["band"] == "W2"
    assert meta.status == "ready" and meta.preview.status == "unavailable"
    assert not harness.store.has_preview(request.field_id)


def test_preview_can_arrive_after_listed(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2}, preview="slow")
    harness.irsa.gate = threading.Event()
    request = harness.request()
    harness.manager.submit(request)
    wait_until(lambda: "listed" in harness.bus.names(request.field_id) and len(harness.irsa.calls) == 2)
    assert harness.manager.get_meta(request.field_id).preview.status == "pending"
    assert "preview" not in harness.bus.names(request.field_id)
    harness.preview.gate.set()
    wait_until(lambda: "preview" in harness.bus.names(request.field_id))
    assert harness.manager.get_meta(request.field_id).preview.status == "ready"
    assert harness.store.has_preview(request.field_id)
    harness.irsa.gate.set()
    assert harness.manager.wait_idle(20.0)
    names = harness.bus.names(request.field_id)
    assert names.index("listed") < names.index("preview") < names.index("plane")
    assert harness.manager.get_meta(request.field_id).preview.status == "ready"


def test_a_preview_that_never_arrives_is_discarded_when_the_job_ends(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2}, preview="slow")
    request = harness.request()
    meta = harness.run(request)
    assert meta.status == "ready" and meta.preview.status == "unavailable"
    names = harness.bus.names(request.field_id)
    assert names.count("preview") == 1 and names[-2:] == ["state", "done"]
    assert harness.bus.last(request.field_id, "preview").data["status"] == "unavailable"
    count = len(names)
    harness.preview.gate.set()  # llega tarde: ya no cambia nada
    wait_until(lambda: all(not thread.name.startswith("spherex-preview") for thread in threading.enumerate()))
    assert len(harness.bus.names(request.field_id)) == count
    assert not harness.store.has_preview(request.field_id)
    assert harness.manager.get_meta(request.field_id).preview.status == "unavailable"


# ------------------------------------------------------------ lista y fallas


def test_no_coverage_fails_the_job_and_is_remembered(build: HarnessFactory) -> None:
    harness = build({})
    request = harness.request()
    first = harness.manager.submit(request)
    assert first.status == "queued"
    assert harness.manager.wait_idle(20.0)
    events = harness.bus.of(request.field_id)
    validate_events(events)
    assert [event.event for event in events] == ["state", "queued", "progress", "preview", "error"]
    error = events[-1].data["error"]
    assert error["code"] == "no_coverage" and error["retryable"] is False
    meta = harness.manager.get_meta(request.field_id)
    assert (meta.status, meta.progress.phase, meta.planes) == ("failed", "listing", None)
    # Mientras la lista que lo dijo siga vigente, el pedido se contesta sin crear otro trabajo.
    with pytest.raises(ApiError) as again:
        harness.manager.submit(request)
    assert again.value.code == "no_coverage" and again.value.http_status == 404
    assert len(harness.irsa.list_calls) == 1
    with pytest.raises(ApiError):
        harness.manager.submit(harness.request(band=6))
    # Con `refresh` se vuelve a listar.
    harness.manager.submit(harness.request(refresh=True))
    assert harness.manager.wait_idle(20.0)
    assert harness.irsa.list_calls == [False, True]


def test_an_expired_no_coverage_answer_is_checked_again(build: HarnessFactory) -> None:
    harness = build({})
    harness.irsa.listed_at = "2020-01-01T00:00:00Z"  # una lista vieja que ya no esta vigente
    request = harness.request()
    harness.manager.submit(request)
    assert harness.manager.wait_idle(20.0)
    harness.manager.submit(request)
    assert harness.manager.wait_idle(20.0)
    assert len(harness.irsa.list_calls) == 2


def test_irsa_down_without_a_saved_list_fails_and_the_next_request_retries(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2})
    harness.irsa.list_error = upstream_unavailable(
        "SIA2 spherex_dr1: HTTP 502 tras 6 intentos; no hay una lista guardada"
    )
    request = harness.request()
    harness.manager.submit(request)
    assert harness.manager.wait_idle(20.0)
    events = harness.bus.of(request.field_id)
    assert events[-1].event == "error"
    assert events[-1].data == {
        "error": {
            "code": "upstream_unavailable",
            "message": "SIA2 spherex_dr1: HTTP 502 tras 6 intentos; no hay una lista guardada",
            "retryable": True,
        }
    }
    failed = harness.manager.get_meta(request.field_id)
    assert (failed.status, failed.progress.phase, failed.rev) == ("failed", "listing", 0)
    assert harness.irsa.calls == []

    # Un `POST` posterior lo vuelve a intentar.
    harness.irsa.list_error = None
    retried = harness.manager.submit(request)
    assert retried.status == "queued" and retried.progress.phase == "queued"
    assert harness.manager.wait_idle(20.0)
    assert harness.manager.get_meta(request.field_id).status == "ready"
    later = harness.bus.of(request.field_id)[len(events) :]
    assert [event.id for event in later] == list(range(1, len(later) + 1))  # un trabajo nuevo numera desde 1
    assert later[0].event == "state" and later[-1].event == "done"


def test_listing_is_retried_while_irsa_is_down(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2})
    down = upstream_unavailable("SIA2 spherex_dr1: HTTP 502 tras 6 intentos; no hay una lista guardada")
    harness.irsa.list_failures = [down, down]
    request = harness.request()
    meta = harness.run(request)
    assert meta.status == "ready" and len(harness.irsa.list_calls) == 3
    events = harness.bus.of(request.field_id)
    validate_events(events)
    names = [event.event for event in events]
    assert "error" not in names and names[-1] == "done"
    # La vista provisoria no se descarta por los reintentos.
    assert names.index("preview") < names.index("listed") and meta.preview.status == "ready"
    # Sigue en `listing`: el numero de intento y lo que falta para el proximo, con pausas crecientes.
    progress = [event.data for event in events if event.event == "progress"]
    listing = [item for item in progress if item["phase"] == "listing"]
    assert [(item["listing_attempt"], item["retry_in_s"]) for item in listing] == [
        (1, None), (2, 10.0), (2, None), (3, 20.0), (3, None),
    ]  # fmt: skip
    # Fuera del listado esas dos claves no viajan, ni quedan en el documento guardado.
    later = [item for item in progress if item["phase"] != "listing"]
    assert later and all("listing_attempt" not in item and "retry_in_s" not in item for item in later)
    assert set(meta.progress.model_dump(mode="json")) == set(later[-1])


@pytest.mark.parametrize(("budget_s", "calls"), [(0.0, 1), (25.0, 3), (300.0, 9)])
def test_listing_gives_up_when_the_retry_time_runs_out(build: HarnessFactory, budget_s: float, calls: int) -> None:
    # Pausas de 10, 20, 30, 45, 60, 60 y 60 s, recortadas a lo que queda del tiempo de reintento.
    harness = build({(1, 3): 2}, listing_retry_s=budget_s)
    harness.irsa.list_error = upstream_unavailable("SIA2 caido (simulado)")
    request = harness.request()
    meta = harness.run(request)
    assert (meta.status, meta.progress.phase) == ("failed", "listing")
    assert len(harness.irsa.list_calls) == calls
    assert meta.progress.listing_attempt == calls and meta.progress.retry_in_s is None
    error = harness.bus.last(request.field_id, "error").data["error"]
    assert (error["code"], error["message"]) == ("upstream_unavailable", "SIA2 caido (simulado)")


def test_a_request_inside_the_footprint_of_a_stored_field_opens_that_field(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2}, nearby_field_arcsec=300.0)
    stored = harness.run(harness.request(10.0, 20.0))
    assert stored.status == "ready"
    stretch = 1.0 / math.cos(math.radians(20.0))  # grados de `ra` por grado de cielo a esa declinacion
    # Hasta 300" en cada eje. Las dos primeras estan en una esquina: 288" por eje, 407" en diagonal.
    inside = ((10.0 + 0.08 * stretch, 20.08), (10.0 - 0.08 * stretch, 19.92), (10.0, 20.0832), (10.0003, 20.0))
    for ra, dec in inside:
        assert harness.manager.submit(harness.request(ra, dec)).id == stored.id, (ra, dec)
    assert len(harness.irsa.list_calls) == 1
    # Con un solo eje a 324" ya es otro campo.
    for ra, dec in ((10.0 + 0.09 * stretch, 20.0), (10.0, 19.91)):
        other = harness.manager.submit(harness.request(ra, dec))
        assert other.id != stored.id and other.status == "queued", (ra, dec)
        assert harness.manager.wait_idle(20.0)


def test_an_unexpected_error_listing_is_reported_as_unavailable(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2})
    harness.irsa.list_error = RuntimeError("algo que nadie previo")
    request = harness.request()
    meta = harness.run(request)
    assert meta.status == "failed"
    error = harness.bus.last(request.field_id, "error").data["error"]
    assert error["code"] == "upstream_unavailable" and "RuntimeError" in error["message"]


def test_a_failure_halfway_keeps_what_was_built(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2, (2, 3): 4}, max_cutout_downloads=1)
    harness.pipeline.fail_at = 3
    request = harness.request()
    meta = harness.run(request)
    events = harness.bus.of(request.field_id)
    validate_events(events)
    assert events[-1].event == "error" and "done" not in [event.event for event in events]
    assert events[-1].data["error"]["code"] == "upstream_unavailable"
    # `status` pasa a `failed` y la fase queda donde estaba.
    assert (meta.status, meta.progress.phase, meta.rev) == ("failed", "downloading", 0)
    assert planes_of(events) == [(1, 3, "building", 1, 1)]
    built = meta.plane(1, 3)
    assert built is not None and built.status == "building"
    # Lo ya construido se sigue sirviendo.
    assert (
        harness.store.read_plane(request.field_id, 1, 3, shape=SHAPE).tobytes()
        == expected_plane(harness, ["E1D3N0"]).image.tobytes()
    )
    assert harness.store.read_meta(request.field_id).status == "failed"
    assert harness.manager.get_meta(request.field_id).status == "failed"
    assert harness.irsa.pruned == 2

    harness.pipeline.fail_at = None
    retried = harness.manager.submit(request)
    assert retried.status == "queued" and retried.planes is None
    assert harness.manager.wait_idle(20.0)
    final = harness.manager.get_meta(request.field_id)
    assert final.status == "ready" and final.rev == 1
    assert harness.store.read_meta(request.field_id) == final
    # El reintento sigue numerando las revisiones del plano que ya habia publicado una.
    second_try = events_after_restart(harness.bus.of(request.field_id))
    assert planes_of(second_try) == [
        (1, 3, "building", 2, 1),
        (1, 3, "ready", 3, 2),
        (2, 3, "building", 1, 2),
        (2, 3, "ready", 2, 4),
    ]
    listed = next(event for event in second_try if event.event == "listed")
    assert all(plane["rev"] == 0 for plane in listed.data["planes"])  # en `pending` va en 0, como siempre


def events_after_restart(events: list[Any]) -> list[Any]:
    """Los eventos del ultimo trabajo de un campo: los que siguen al ultimo `state` con id 1."""
    start = max(index for index, event in enumerate(events) if event.event == "state" and event.id == 1)
    return events[start:]


def test_reading_a_plane_gives_the_bytes_of_the_revision_it_reports(build: HarnessFactory) -> None:
    harness = build({(1, 3): 4, (2, 3): 4, (1, 4): 1}, max_cutout_downloads=1)
    harness.irsa.script["E1D4N0"] = [IrsaPermanent("HTTP 422")]
    harness.irsa.hold_after = 3
    request = harness.request()
    with pytest.raises(ApiError) as missing:
        harness.manager.read_plane(request.field_id, 1, 3)
    assert missing.value.code == "not_found"
    harness.irsa.list_gate = threading.Event()
    harness.manager.submit(request)
    with pytest.raises(ApiError) as early:  # antes de `listed` todavia no hay planos
        harness.manager.read_plane(request.field_id, 1, 3)
    assert (early.value.code, early.value.retryable) == ("not_ready", True)
    harness.irsa.list_gate.set()

    def halfway() -> bool:
        plane = harness.manager.get_meta(request.field_id).plane(1, 3)
        return plane is not None and plane.status == "building" and len(harness.irsa.calls) == 4

    wait_until(halfway)
    data, plane = harness.manager.read_plane(request.field_id, 1, 3)
    assert (plane.status, plane.rev, plane.n_used) == ("building", 1, 2)
    assert data == expected_plane(harness, ["E1D3N0", "E1D3N1"]).image.tobytes()
    aux, aux_plane = harness.manager.read_aux(request.field_id, 1, 3)
    assert aux_plane == plane and len(aux) == 6 * 195 * 195
    zipped, _ = harness.manager.read_aux(request.field_id, 1, 3, gzipped=True)
    assert gzip.decompress(zipped) == aux
    with pytest.raises(ApiError) as pending:
        harness.manager.read_plane(request.field_id, 2, 3)
    assert (pending.value.code, pending.value.http_status, pending.value.retryable) == ("not_ready", 409, True)
    for epoch, detector in ((1, 1), (3, 3), (1, 7)):  # vacio desde la lista, y dos que no existen
        with pytest.raises(ApiError) as absent:
            harness.manager.read_plane(request.field_id, epoch, detector)
        assert absent.value.code == "not_found"

    harness.irsa.resume.set()
    assert harness.manager.wait_idle(20.0)
    data, plane = harness.manager.read_plane(request.field_id, 1, 3)  # ya del almacen
    assert (plane.status, plane.rev) == ("ready", 2) and plane.cube_offset == 0
    assert data == harness.store.read_plane_bytes(request.field_id, 1, 3, shape=SHAPE)
    with pytest.raises(ApiError) as emptied:  # quedo vacio: no tiene binario
        harness.manager.read_aux(request.field_id, 1, 4)
    assert emptied.value.code == "not_found"


def test_a_plane_read_never_mixes_two_revisions(build: HarnessFactory) -> None:
    """Lecturas en paralelo con un trabajo que publica revisiones: cada una trae los bytes de la `rev` que informa."""
    harness = build({(1, 3): 40}, max_cutout_downloads=1)
    harness.irsa.hold_after = 30  # la provisoria sale con 20; el resto espera a que alguien la haya leido
    request = harness.request()
    published: dict[int, str] = {}

    def on_event(field_id: str, name: str, data: Mapping[str, Any]) -> None:
        if name == "plane":
            payload = harness.store.read_plane_bytes(field_id, 1, 3, shape=SHAPE)
            published[data["plane"]["rev"]] = hashlib.sha256(payload).hexdigest()

    harness.bus.hook = on_event
    seen: list[tuple[int, str]] = []
    stop = threading.Event()

    def reader() -> None:
        while not stop.is_set():
            try:
                data, plane = harness.manager.read_plane(request.field_id, 1, 3)
            except ApiError:
                continue
            seen.append((plane.rev, hashlib.sha256(data).hexdigest()))

    threads = [threading.Thread(target=reader) for _ in range(3)]
    for thread in threads:
        thread.start()
    try:
        harness.manager.submit(request)
        wait_until(lambda: any(rev == 1 for rev, _ in list(seen)))
        harness.irsa.resume.set()
        assert harness.manager.wait_idle(20.0)
        data, plane = harness.manager.read_plane(request.field_id, 1, 3)
        seen.append((plane.rev, hashlib.sha256(data).hexdigest()))
    finally:
        stop.set()
        for thread in threads:
            thread.join()
    assert set(published) == {1, 2} and published[1] != published[2]
    assert {rev for rev, _ in seen} == {1, 2}
    assert all(digest == published[rev] for rev, digest in seen)
