"""El gestor de trabajos con los recortes reales de Barnard (tests/fixtures/cutouts). Sin red.

Dos caminos: con los recortes entregados directamente desde la carpeta de
fixtures, para comparar los planos con los del pipeline, y de punta a punta
contra el servidor HTTP local de test_irsa_support.py, con el `fetch_cutout`,
la cache de recortes y el `load_exposure` reales.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from test_irsa_support import (
    CUTOUTS_DIR,
    Gate,
    IrsaStub,
    cutout_index,
    exposure_from_entry,
    irsa_response,
    respond,
    same_images,
    sequence,
    serve,
)
from test_jobs_support import (
    SHAPE,
    FakePreview,
    Harness,
    HarnessFactory,
    harness_factory,
    replay,
    validate_events,
)

from app import geometry
from app.config import Settings
from app.contract import FieldMeta
from app.domain import CutoutFile, Exposure, Grid, PlaneArrays, ReprojectedExposure
from app.irsa.cutouts import cutout_cache_path, discard_cutout, fetch_cutout, prune_cutout_cache
from app.irsa.limits import get_limiter, reset_limiter
from app.jobs.deps import JobDeps
from app.jobs.manager import JobManager
from app.pipeline.coadd import PlaneAccumulator
from app.pipeline.exposure import load_exposure
from app.pipeline.flag_table import field_flags
from app.pipeline.stats import detector_display, plane_stats, saturated_regions

INDEX = cutout_index()
ENTRIES: list[dict[str, Any]] = INDEX["cutouts"]
RA, DEC = INDEX["center"]["ra"], INDEX["center"]["dec"]
# Los doce recortes son de los detectores 3 y 6, tres por detector en cada una de dos pasadas: agosto de
# 2025 y agosto de 2026. En el campo completo de Barnard esas pasadas son la primera y la tercera
# (`epoch` en index.json); en un campo armado solo con estos recortes son las epocas 1 y 2.
PLANES = [(1, 3), (1, 6), (2, 3), (2, 6)]


@pytest.fixture(autouse=True)
def _fresh_limiter() -> Iterator[None]:
    reset_limiter()
    yield
    reset_limiter()


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


class RecordingLoader:
    """El `load_exposure` real, anotando en que orden entro cada recorte a su plano."""

    def __init__(self) -> None:
        self.order: list[str] = []  # nombre de archivo de la exposicion, sin el sufijo de la cache

    def __call__(self, path: Path, grid: Grid) -> ReprojectedExposure:
        exposure = load_exposure(path, grid)
        self.order.append(Path(path).name.split("__")[0])
        return exposure


def stem_of(entry: dict[str, Any]) -> str:
    return str(entry["file"]).split("__")[0]


def plane_of(entry: dict[str, Any]) -> tuple[int, int]:
    """`(epoca, detector)` del plano al que va ese recorte en un campo armado con los doce."""
    return (1 if entry["epoch"] == 1 else 2, entry["detector"])


def direct_plane(grid: Grid, stems: list[str]) -> tuple[PlaneArrays, list[ReprojectedExposure]]:
    """El plano que da el pipeline directo con esos recortes guardados, en ese orden."""
    files = {stem_of(entry): CUTOUTS_DIR / entry["file"] for entry in ENTRIES}
    exposures = [load_exposure(files[stem], grid) for stem in stems]
    accumulator = PlaneAccumulator(grid, len(exposures))
    for exposure in exposures:
        accumulator.add(exposure)
    return accumulator.snapshot(), exposures


def check_planes_against_the_pipeline(harness: Harness, meta: FieldMeta, order: list[str]) -> None:
    """Cada plano guardado es, byte por byte, el coadd del pipeline con sus recortes en el orden en que entraron."""
    assert meta.grid is not None and meta.planes is not None and meta.detectors is not None
    request = geometry.normalize_request(RA, DEC)
    grid = geometry.build_grid(request)
    assert meta.grid == geometry.grid_info(grid) and meta.grid.shape == SHAPE
    planes = {stem_of(entry): plane_of(entry) for entry in ENTRIES}
    mjd_of = {stem_of(entry): entry["mjd"] for entry in ENTRIES}
    images: dict[tuple[int, int], np.ndarray] = {}
    loaded: list[ReprojectedExposure] = []
    for key in PLANES:
        stems = [stem for stem in order if planes[stem] == key]
        assert len(stems) == 3
        expected, exposures = direct_plane(grid, stems)
        loaded.extend(exposures)
        image = harness.store.read_plane(meta.id, *key, shape=SHAPE)
        flags, coverage = harness.store.read_aux(meta.id, *key, shape=SHAPE)
        assert image.tobytes() == expected.image.tobytes()
        assert np.array_equal(flags, expected.flags) and np.array_equal(coverage, expected.coverage)
        images[key] = image
        plane = meta.plane(*key)
        assert plane is not None
        assert (plane.status, plane.rev, plane.n_exposures, plane.n_used, plane.n_failed) == ("ready", 2, 3, 3, 0)
        assert plane.stats == plane_stats(image) and plane.saturated == saturated_regions(image)
        assert plane.mjd_mean == round(sum(mjd_of[stem] for stem in stems) / 3, 4)
    for detector in (3, 6):
        display = detector_display([images[(1, detector)], images[(2, detector)]])
        assert meta.detectors[detector - 1].display == display
    assert meta.flags == field_flags(loaded)
    assert [plane.status for plane in meta.planes] == [
        "ready" if (plane.epoch, plane.detector) in PLANES else "empty" for plane in meta.planes
    ]


def test_planes_are_identical_to_the_pipeline_on_the_real_cutouts(build: HarnessFactory, tmp_path: Path) -> None:
    exposures = [exposure_from_entry(entry, "https://irsa.invalid") for entry in ENTRIES]
    files = {exposure.url: CUTOUTS_DIR / entry["file"] for exposure, entry in zip(exposures, ENTRIES, strict=True)}
    loader = RecordingLoader()

    def fetch(exposure: Exposure, ra: float, dec: float, side_deg: float, settings: Settings) -> CutoutFile:
        return CutoutFile(path=files[exposure.url], mode="truncated", from_cache=True, nbytes=0)

    harness = build({}, deps={"fetch_cutout": fetch, "load_exposure": loader})
    harness.irsa.exposures = exposures
    request = harness.request(RA, DEC)
    assert (request.ra, request.dec) == (269.4463, 4.7683)
    meta = harness.run(request)
    events = harness.bus.of(request.field_id)
    validate_events(events)
    assert (meta.status, meta.rev) == ("ready", 1)
    assert sorted(loader.order) == sorted(stem_of(entry) for entry in ENTRIES)
    check_planes_against_the_pipeline(harness, meta, loader.order)

    # Epocas y detectores, de los datos reales.
    assert meta.epochs is not None and meta.detectors is not None
    assert [(epoch.epoch, epoch.n_exposures) for epoch in meta.epochs] == [(1, 6), (2, 6)]
    assert [(epoch.start, epoch.end) for epoch in meta.epochs] == [
        ("2025-08-15", "2025-08-27"),
        ("2026-08-16", "2026-08-20"),
    ]
    assert meta.epochs[0].mjd_start == 60902.86472
    assert (meta.detectors[2].wave_min_um, meta.detectors[2].wave_max_um) == (1.6301, 2.4346)
    assert (meta.detectors[5].wave_min_um, meta.detectors[5].wave_max_um) == (4.4115, 5.0096)
    assert (meta.progress.cutouts_total, meta.progress.cutouts_done, meta.progress.cutouts_cached) == (12, 12, 12)

    # Barnard satura: el nucleo va como +Infinity, con su flag, su contorno y un solo aviso para la estrella.
    image = harness.store.read_plane(request.field_id, 1, 3, shape=SHAPE)
    flags, coverage = harness.store.read_aux(request.field_id, 1, 3, shape=SHAPE)
    saturated = np.isposinf(image)
    assert saturated.sum() > 20 and not np.isneginf(image).any()
    assert np.all(coverage[~np.isfinite(image)] == 0) and np.all(coverage[np.isfinite(image)] > 0)
    saturation_bits = sum(1 << flag.bit for flag in meta.flags or () if flag.saturation)
    assert [flag.name for flag in meta.flags or () if flag.saturation] == ["OVERFLOW", "BLOOM"]
    assert np.all(flags[saturated] & saturation_bits)
    sources = [warning for warning in meta.warnings if warning.code == "saturated_source"]
    assert len(sources) == 1
    assert sources[0].epochs == [1, 2] and sources[0].detectors == [3, 6]
    # La estrella esta a menos de 15" del centro del campo (que se pidio en su posicion de 2026).
    assert geometry.angular_separation_deg(sources[0].ra, sources[0].dec, request.ra, request.dec) * 3600 < 15.0
    sent = [event.data for event in events if event.event == "warning" and event.data["code"] == "saturated_source"]
    assert len(sent) == 1
    # Los recortes guardados miden 0,1 grados, menos que el campo: cobertura baja en los cuatro planos.
    low = [warning for warning in meta.warnings if warning.code == "low_coverage"]
    assert [(warning.epoch, warning.detector) for warning in low] == PLANES
    few = [warning.model_dump() for warning in meta.warnings if warning.code == "few_exposures"]
    assert few == [
        {"code": "few_exposures", "epoch": epoch, "detector": detector, "n": 3} for epoch, detector in PLANES
    ]
    assert replay(events) == events[-2].data


def path_of(exposure: Exposure) -> str:
    return "/" + exposure.url.split("/", 3)[3]


def real_manager(harness: Harness, tmp_path: Path, exposures: list[Exposure], loader: Any) -> tuple[JobManager, Any]:
    """Un gestor con `fetch_cutout`, la cache de recortes y el reloj reales; solo la lista y la vista son de mentira."""
    harness.irsa.exposures = exposures
    settings = harness.settings
    preview = FakePreview("ready")
    # El reloj de mentira solo sirve para no esperar de verdad el segundo que separa un corte de su reintento.
    deps = JobDeps(
        list_exposures=harness.irsa.list_exposures,
        fetch_preview=preview.fetch_preview,
        load_exposure=loader,
        clock=harness.clock,
        wait=harness.clock.wait,
    )
    assert deps.fetch_cutout is fetch_cutout and deps.discard_cutout is discard_cutout
    assert deps.prune_cutout_cache is prune_cutout_cache
    manager = JobManager(settings, harness.store, harness.bus, deps)
    return manager, settings


def test_end_to_end_against_the_local_http_server(build: HarnessFactory, stub: IrsaStub, tmp_path: Path) -> None:
    harness = build({}, irsa_connect_timeout_s=5.0, irsa_read_timeout_s=10.0)
    exposures = [exposure_from_entry(entry, stub.base_url) for entry in ENTRIES]
    responses = {
        path_of(exposure): irsa_response((CUTOUTS_DIR / entry["file"]).read_bytes())
        for exposure, entry in zip(exposures, ENTRIES, strict=True)
    }
    for path, body in responses.items():
        stub.routes[path] = serve(body)
    # Uno recibe primero el 503 habitual de IRSA cargado, y otro un corte a mitad de la respuesta.
    busy, cut = path_of(exposures[1]), path_of(exposures[4])
    stub.routes[busy] = sequence(
        respond(503, b"Server busy, retry later.", headers={"Retry-After": "0"}), serve(responses[busy])
    )
    stub.routes[cut] = sequence(serve(responses[cut], cut_after=40_000), serve(responses[cut]))
    stub.gate = Gate(target=10, hold_s=0.02)  # el servidor cuenta cuantas conexiones tiene a la vez

    loader = RecordingLoader()
    manager, settings = real_manager(harness, tmp_path, exposures, loader)
    request = harness.request(RA, DEC)
    side = geometry.cutout_side_deg(request.fov)
    # Un recorte ya esta en la cache, pero danado: pasa la comprobacion barata y no se puede leer.
    broken = cutout_cache_path(exposures[7], request.ra, request.dec, side, settings)
    broken.parent.mkdir(parents=True)
    broken.write_bytes(b"SIMPLE  =                    T" + b" " * (2880 - 30))
    try:
        assert manager.submit(request).status == "queued"
        assert manager.wait_idle(60.0)
        meta = manager.get_meta(request.field_id)
        events = harness.bus.of(request.field_id)
        validate_events(events)
        assert [event.event for event in events[-2:]] == ["state", "done"]
        assert (meta.status, meta.rev) == ("ready", 1)
        assert meta.provenance is not None and meta.provenance.download_mode == "truncated"
        assert (meta.progress.cutouts_done, meta.progress.cutouts_failed, meta.progress.cutouts_cached) == (12, 0, 0)
        assert "full_download" not in [warning.code for warning in meta.warnings]

        # Lo que vio el servidor: nunca mas de diez conexiones, el centro normalizado y el lado del contrato.
        stub.wait_idle()
        assert stub.max_active == 10
        assert get_limiter(settings).cutouts_in_flight == 0
        assert {hit.query["center"] for hit in stub.hits} == {"269.446300,4.768300d"}
        assert {hit.query["size"] for hit in stub.hits} == {"0.24258"}
        hits = [hit.path for hit in stub.hits]
        # Un pedido por recorte (el danado sale de la cache, se descarta y se pide), mas los reintentos
        # del 503 y del corte.
        assert len(hits) == 12 + 2 and hits.count(busy) == 2 and hits.count(cut) == 2
        assert hits.count(path_of(exposures[7])) == 1
        # Ninguna descarga llego al final de la respuesta: se cortan antes de EPSF, que es casi todo.
        assert all(hit.bytes_sent < len(responses[hit.path]) for hit in stub.hits)
        assert all(len(body) > 8_000_000 for body in responses.values())

        # En la cache quedaron los doce, iguales a los guardados (el danado se descarto y se bajo de nuevo).
        cached = sorted(settings.cutout_cache_dir.iterdir())
        assert len(cached) == 12 and all(path.name.endswith("_0.24258_img.fits") for path in cached)
        for exposure, entry in zip(exposures, ENTRIES, strict=True):
            saved = cutout_cache_path(exposure, request.ra, request.dec, side, settings)
            assert same_images(saved, CUTOUTS_DIR / entry["file"])
        assert loader.order.count(stem_of(ENTRIES[7])) == 1  # la lectura fallida no llego a anotarse

        check_planes_against_the_pipeline(harness, meta, loader.order)
        assert harness.store.has_preview(request.field_id)
        assert harness.store.read_meta(request.field_id) == meta
        cube = b"".join(harness.store.iter_cube(request.field_id, meta))
        assert len(cube) == 4 * 4 * 195 * 195
    finally:
        manager.shutdown(timeout=10.0)

    # Otro gestor, con el almacen vacio pero la misma cache de recortes: no vuelve a tocar IRSA.
    hits_before = len(stub.hits)
    again = build({}, root=tmp_path / "otro", cache_dir=tmp_path / "otro" / "cache")
    again_loader = RecordingLoader()

    def cached_fetch(exposure: Exposure, ra: float, dec: float, side_deg: float, _: Settings) -> CutoutFile:
        return fetch_cutout(exposure, ra, dec, side_deg, settings)  # la cache de recortes del primero

    second = JobManager(
        again.settings,
        again.store,
        again.bus,
        JobDeps(
            list_exposures=harness.irsa.list_exposures,
            fetch_cutout=cached_fetch,
            fetch_preview=FakePreview("down").fetch_preview,
            load_exposure=again_loader,
        ),
    )
    try:
        second.submit(request)
        assert second.wait_idle(60.0)
        rebuilt = second.get_meta(request.field_id)
        assert rebuilt.status == "ready" and rebuilt.progress.cutouts_cached == 12
        assert len(stub.hits) == hits_before
        check_planes_against_the_pipeline(again, rebuilt, again_loader.order)
    finally:
        second.shutdown(timeout=10.0)


def test_irsa_answering_503_with_a_long_retry_after_leaves_the_field_partial(
    build: HarnessFactory, stub: IrsaStub, tmp_path: Path
) -> None:
    harness = build({}, irsa_connect_timeout_s=5.0, irsa_read_timeout_s=10.0)
    exposures = [exposure_from_entry(entry, stub.base_url) for entry in ENTRIES]
    for exposure, entry in zip(exposures, ENTRIES, strict=True):
        stub.routes[path_of(exposure)] = serve(irsa_response((CUTOUTS_DIR / entry["file"]).read_bytes()))
    asked = path_of(exposures[0])
    stub.routes[asked] = respond(503, b"Server busy, retry later.", headers={"Retry-After": "3600"})
    gone = path_of(exposures[5])
    stub.routes[gone] = respond(422, b"Arrays do not overlap.")
    manager, _settings = real_manager(harness, tmp_path, exposures, RecordingLoader())
    request = harness.request(RA, DEC)
    try:
        manager.submit(request)
        assert manager.wait_idle(60.0)  # sin esperar la hora que pidio IRSA
        meta = manager.get_meta(request.field_id)
        stub.wait_idle()
        hits = [hit.path for hit in stub.hits]
        assert hits.count(asked) == 1 and hits.count(gone) == 1  # ninguno de los dos se reintenta
        assert (meta.status, meta.progress.cutouts_done, meta.progress.cutouts_failed) == ("partial", 10, 2)
        failed = [warning for warning in meta.warnings if warning.code == "cutouts_failed"]
        assert len(failed) == 1 and failed[0].n == 2
        partial = [(plane.epoch, plane.detector) for plane in meta.planes or () if plane.status == "partial"]
        assert partial == sorted({plane_of(ENTRIES[0]), plane_of(ENTRIES[5])}) == [(1, 3), (1, 6)]
        assert [(ref.epoch, ref.detector) for ref in failed[0].planes] == partial
    finally:
        manager.shutdown(timeout=10.0)
