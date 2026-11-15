"""Los fixtures sin red: campos de muestra, recortes, SIA2, Sesame y las copias del frontend.

Los genera scripts/make_sample_fields.py a partir de las salidas de la Etapa 0.
Estos tests no corren el script ni necesitan el spike: comprueban que lo que
esta guardado en el repositorio cumple el contrato (docs/contrato-cubo.md) y es
coherente consigo mismo, para que los demas tests y el servidor falso puedan
confiar en esos datos.
"""

from __future__ import annotations

import hashlib
import io
import json
import warnings
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass
from datetime import date, timedelta
from functools import cache
from itertools import pairwise
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from astropy.io import fits
from astropy.io.votable import parse as parse_votable
from fastapi.testclient import TestClient
from numpy.typing import NDArray

from app import geometry
from app.config import PIPELINE_VERSION, SAMPLE_PIPELINE_VERSION
from app.contract import (
    CUBE_PLANE_STATUSES,
    EVENT_ADAPTERS,
    FINISHED_FIELD_STATUSES,
    FieldMeta,
    FieldResponse,
    PlaneInfo,
    ResolveResponse,
    TrackResponse,
)
from app.fake import create_fake_app
from app.jobs.store import (
    META_FILENAME,
    PREVIEW_FILENAME,
    FieldStore,
    aux_filename,
    aux_nbytes,
    cube_nbytes,
    plane_filename,
    plane_nbytes,
    track_filename,
)
from app.pipeline.exposure import MASKED_FLAGS
from app.pipeline.stats import detector_display, plane_stats, saturated_regions

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
FIELDS_DIR = FIXTURES_DIR / "fields"
CUTOUTS_DIR = FIXTURES_DIR / "cutouts"
SIA_DIR = FIXTURES_DIR / "sia"
SESAME_DIR = FIXTURES_DIR / "sesame"
FRONTEND_FIXTURES_DIR = FIXTURES_DIR.parents[2] / "frontend" / "src" / "test" / "fixtures"

STORE = FieldStore(FIELDS_DIR)

# Contrato, seccion 7: los flags que cuentan como saturacion son esos dos.
SATURATION_FLAGS = {"OVERFLOW", "BLOOM"}
# Contrato, seccion 5: avisos por pocas exposiciones y por poca cobertura.
FEW_EXPOSURES_BELOW = 5
LOW_COVERAGE_BELOW = 0.90
# Contrato, seccion 2: mas de 60 dias entre exposiciones separan dos epocas.
EPOCH_GAP_DAYS = 60.0

IMAGE_HDUS = ["IMAGE", "FLAGS", "VARIANCE", "ZODI"]

Key = tuple[int, int]  # (epoca, detector)


@dataclass(frozen=True)
class Sample:
    label: str
    id: str
    entry: dict[str, Any]

    @property
    def folder(self) -> Path:
        return FIELDS_DIR / self.id


def _load_samples() -> list[Sample]:
    path = FIELDS_DIR / "index.json"
    if not path.is_file():
        return []
    document = json.loads(path.read_text(encoding="utf-8"))
    return [Sample(label=entry["label"], id=entry["id"], entry=entry) for entry in document["samples"]]


SAMPLES = _load_samples()
BY_LABEL = {sample.label: sample for sample in SAMPLES}

each_sample = pytest.mark.parametrize("sample", SAMPLES, ids=[sample.label for sample in SAMPLES])


@cache
def load_meta(field_id: str) -> FieldMeta:
    return FieldMeta.model_validate_json((FIELDS_DIR / field_id / META_FILENAME).read_text(encoding="utf-8"))


@cache
def load_planes(field_id: str) -> dict[Key, NDArray[np.float32]]:
    """Los planos con datos del campo, por (epoca, detector)."""
    meta = load_meta(field_id)
    assert meta.grid is not None and meta.planes is not None
    return {
        (plane.epoch, plane.detector): STORE.read_plane(field_id, plane.epoch, plane.detector, shape=meta.grid.shape)
        for plane in meta.planes
        if plane.status in CUBE_PLANE_STATUSES
    }


def listed(sample: Sample) -> tuple[FieldMeta, list[PlaneInfo]]:
    meta = load_meta(sample.id)
    assert meta.planes is not None
    return meta, meta.planes


def iso_date(mjd: float) -> str:
    """Fecha UTC de un MJD. El dia 0 es el 17 de noviembre de 1858."""
    return (date(1858, 11, 17) + timedelta(days=int(mjd // 1))).isoformat()


def read_votable(path: Path) -> tuple[list[dict[str, Any]], list[str]]:
    """Filas de una respuesta de SIA2 guardada y los valores de sus `QUERY_STATUS`."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        votable = parse_votable(io.BytesIO(path.read_bytes()))
    statuses = [info.value for resource in votable.resources for info in resource.infos if info.name == "QUERY_STATUS"]
    # IRSA pone ID="col_N" en cada FIELD; los nombres ObsCore estan en `name`.
    table = votable.get_first_table().to_table(use_names_over_ids=True)
    return [{name: row[name] for name in table.colnames} for row in table], statuses


# ------------------------------------------------------------ campos de muestra


def test_the_three_samples_are_there() -> None:
    assert set(BY_LABEL) == {"wise0855", "epsindb", "barnard"}
    assert len({sample.id for sample in SAMPLES}) == len(SAMPLES)
    # La carpeta de muestras tiene exactamente las del indice: no queda ninguna de una corrida anterior.
    assert {sample.id for sample in SAMPLES} == set(STORE.list_ids())
    for sample in SAMPLES:
        meta = load_meta(sample.id)
        assert meta.grid is not None and meta.epochs is not None
        assert sample.entry["status"] == meta.status
        assert sample.entry["pipeline"] == meta.pipeline
        assert sample.entry["shape"] == list(meta.grid.shape)
        assert sample.entry["fov"] == meta.grid.fov
        assert sample.entry["epochs"] == len(meta.epochs)


@each_sample
def test_meta_is_a_finished_field_of_the_contract(sample: Sample) -> None:
    meta, planes = listed(sample)
    assert meta.id == sample.id
    assert meta.status in FINISHED_FIELD_STATUSES
    assert meta.rev == 1
    assert meta.grid is not None and meta.detectors is not None and meta.epochs is not None
    assert meta.flags is not None and meta.provenance is not None

    # Una entrada por cada combinacion de epoca y detector, por epoca y despues por detector.
    assert [epoch.epoch for epoch in meta.epochs] == list(range(1, len(meta.epochs) + 1))
    assert [detector.detector for detector in meta.detectors] == [1, 2, 3, 4, 5, 6]
    expected = [(epoch.epoch, detector) for epoch in meta.epochs for detector in range(1, 7)]
    assert [(plane.epoch, plane.detector) for plane in planes] == expected
    assert all(plane.status in CUBE_PLANE_STATUSES or plane.status == "empty" for plane in planes)

    assert meta.provenance.collections == ["spherex_dr1", "spherex_qr3"]
    assert meta.provenance.download_mode == "truncated" and not meta.provenance.list_stale
    assert meta.provenance.listed_at < (meta.provenance.built_at or "")

    # Rangos de onda que informa IRSA (SPEC.md, seccion 2): crecen y se solapan apenas.
    for detector in meta.detectors:
        assert 0.7 < detector.wave_min_um < detector.wave_max_um < 5.1
    for before, after in pairwise(meta.detectors):
        assert before.wave_min_um < after.wave_min_um < before.wave_max_um < after.wave_max_um


@each_sample
def test_id_and_request_follow_the_geometry(sample: Sample) -> None:
    """Seccion 3 del contrato: las tres muestras estan en el escalon base y su `id` sale de `request`."""
    meta = load_meta(sample.id)
    assert meta.grid is not None
    grid = meta.grid

    # `request` ya esta normalizado: volver a normalizarlo no lo cambia.
    request = geometry.normalize_request(meta.request.ra, meta.request.dec, meta.request.fov, pipeline=meta.pipeline)
    assert (request.ra, request.dec, request.fov) == (meta.request.ra, meta.request.dec, meta.request.fov)

    # El campo pedido y la grilla dicen lo mismo, y es un escalon del contrato: el base.
    step = request.step
    assert (step.name, step.fov, step.size, step.pixel_scale_arcsec) == ("base", 0.1667, 195, 3.075)
    assert meta.request.fov == grid.fov == step.fov
    assert grid.shape == (step.size, step.size)
    assert grid.pixel_scale_arcsec == step.pixel_scale_arcsec
    assert grid.native_pixel_scale_arcsec == geometry.NATIVE_PIXEL_SCALE_ARCSEC
    assert sample.entry["contract_step"] is True

    # El `id` es el de la formula del contrato aplicada a `request` y a `pipeline`.
    text = f"{meta.pipeline}|{meta.request.ra:.4f}|{meta.request.dec:+.4f}|{meta.request.fov:.4f}"
    assert meta.id == hashlib.sha256(text.encode("ascii")).hexdigest()[:16] == request.field_id
    # Con el pipeline de las muestras: nunca coincide con el `id` del campo real del mismo centro,
    # asi el navegador no confunde lo que guardo del servidor falso con lo del backend real.
    assert meta.pipeline == SAMPLE_PIPELINE_VERSION != PIPELINE_VERSION
    assert meta.id != geometry.normalize_request(meta.request.ra, meta.request.dec, meta.request.fov).field_id

    # La grilla es la que arma `geometry` para su centro, ese campo y esa escala.
    rebuilt = geometry.grid_info(geometry.make_grid(grid.crval[0], grid.crval[1], grid.fov, grid.pixel_scale_arcsec))
    assert rebuilt == grid
    assert grid.cdelt[0] < 0 < grid.cdelt[1]
    # Limite conocido de las muestras: la grilla esta centrada en el centro con el que corrio el
    # spike (6 decimales) y `request` lleva ese centro a 4. Difieren en menos de 0.2 segundos de arco;
    # el backend real centra la grilla en `request`.
    assert request.ra == pytest.approx(grid.crval[0], abs=5.1e-5)
    assert request.dec == pytest.approx(grid.crval[1], abs=5.1e-5)
    offset = geometry.angular_separation_deg(request.ra, request.dec, grid.crval[0], grid.crval[1]) * 3600.0
    assert offset < 0.2
    x, y = geometry.sky_to_pixel(geometry.grid_from_info(grid), request.ra, request.dec)
    assert np.hypot(x - (grid.crpix[0] - 1), y - (grid.crpix[1] - 1)) < 0.07


@each_sample
def test_field_store_finds_the_sample_from_a_request(sample: Sample) -> None:
    """Un pedido normalizado con el pipeline de la muestra da su `id`: el almacen la encuentra."""
    meta = load_meta(sample.id)
    for ra, dec, fov in [
        (meta.request.ra, meta.request.dec, None),
        (meta.request.ra + 360.0, meta.request.dec, 0.1667),
        (meta.request.ra + 0.00004, meta.request.dec - 0.00004, 0.05),
    ]:
        request = geometry.normalize_request(ra, dec, fov, pipeline=meta.pipeline)
        assert request.field_id == sample.id
        assert STORE.locate(request.field_id) == sample.folder


@each_sample
def test_data_sits_in_the_centre_of_the_step_grid(sample: Sample) -> None:
    """El cubo del spike va, sin remuestrear, en el centro de la grilla; el marco queda sin datos."""
    meta, planes = listed(sample)
    assert meta.grid is not None
    ny, nx = meta.grid.shape
    margin = sample.entry["margin_px"]
    side = ny - 2 * margin
    assert sample.entry["data_shape"] == [side, side]
    # Solo WISE 0855 se corrio en el escalon base; las otras dos, con un campo de 0.1 grados.
    assert (margin, sample.entry["data_fov"]) == ((0, 0.1667) if sample.label == "wise0855" else (39, 0.1))
    assert side == geometry.grid_size(sample.entry["data_fov"], meta.grid.pixel_scale_arcsec)

    frame = np.ones((ny, nx), dtype=bool)
    frame[margin : ny - margin, margin : nx - margin] = False
    for key, image in load_planes(sample.id).items():
        flags, coverage = STORE.read_aux(sample.id, *key, shape=meta.grid.shape)
        # El marco es `NaN` (sin datos, no saturado), con cobertura 0 y sin flags.
        assert np.isnan(image[frame]).all(), key
        assert not coverage[frame].any() and not flags[frame].any(), key
        # Adentro hay datos, y llegan hasta el borde del cuadrado central.
        inner = image[margin : ny - margin, margin : nx - margin]
        assert np.isfinite(inner).mean() > 0.75, key
        assert np.isfinite(inner[:, 0]).any() and np.isfinite(inner[:, -1]).any(), key
        assert np.isfinite(inner[0, :]).any() and np.isfinite(inner[-1, :]).any(), key
    if margin:
        # Con el marco vacio menos del 40 % del campo tiene datos: todos los planos llevan el aviso.
        with_data = [plane for plane in planes if plane.stats is not None]
        assert all(0.25 < plane.stats.valid_fraction < 0.4 for plane in with_data if plane.stats)
        low = {(w.epoch, w.detector) for w in meta.warnings if w.code == "low_coverage"}
        assert low == {(plane.epoch, plane.detector) for plane in with_data}


@each_sample
def test_folder_has_exactly_the_files_of_the_field(sample: Sample) -> None:
    meta, planes = listed(sample)
    expected = {META_FILENAME, PREVIEW_FILENAME, sample.entry["track_file"]}
    for plane in planes:
        if plane.status in CUBE_PLANE_STATUSES:
            expected |= {plane_filename(plane.epoch, plane.detector), aux_filename(plane.epoch, plane.detector)}
    assert {path.name for path in sample.folder.iterdir()} == expected
    assert meta.preview.status == "ready"


@each_sample
def test_binaries_have_the_size_of_the_grid(sample: Sample) -> None:
    meta, planes = listed(sample)
    assert meta.grid is not None
    shape = meta.grid.shape
    for plane in planes:
        if plane.status not in CUBE_PLANE_STATUSES:
            continue
        path = sample.folder / plane_filename(plane.epoch, plane.detector)
        assert path.stat().st_size == plane_nbytes(shape) == 4 * shape[0] * shape[1], path.name
        aux = STORE.read_aux_bytes(sample.id, plane.epoch, plane.detector, shape=shape)
        assert len(aux) == aux_nbytes(shape) == 6 * shape[0] * shape[1], path.name
    assert (sample.folder / PREVIEW_FILENAME).stat().st_size == plane_nbytes(shape)


@each_sample
def test_cube_offsets_are_coherent(sample: Sample) -> None:
    meta, planes = listed(sample)
    assert meta.grid is not None
    size = plane_nbytes(meta.grid.shape)
    in_cube = [plane for plane in planes if plane.status in CUBE_PLANE_STATUSES]
    assert [plane.cube_offset for plane in in_cube] == [index * size for index in range(len(in_cube))]
    assert all(plane.cube_offset is None for plane in planes if plane.status not in CUBE_PLANE_STATUSES)

    cube = b"".join(STORE.iter_cube(sample.id, meta))
    assert len(cube) == cube_nbytes(meta) == size * len(in_cube)
    for plane in in_cube:
        assert plane.cube_offset is not None
        stored = (sample.folder / plane_filename(plane.epoch, plane.detector)).read_bytes()
        assert cube[plane.cube_offset : plane.cube_offset + size] == stored


@each_sample
def test_pixels_without_a_value_have_zero_coverage(sample: Sample) -> None:
    meta, planes = listed(sample)
    assert meta.grid is not None and meta.flags is not None
    declared = sum(1 << flag.bit for flag in meta.flags)
    saturation = sum(1 << flag.bit for flag in meta.flags if flag.saturation)
    for plane in planes:
        if plane.status not in CUBE_PLANE_STATUSES:
            continue
        key = (plane.epoch, plane.detector)
        image = load_planes(sample.id)[key]
        flags, coverage = STORE.read_aux(sample.id, *key, shape=meta.grid.shape)
        assert not np.isneginf(image).any(), key
        # La cobertura vale 0 exactamente donde el plano es NaN o +Infinity.
        assert ((coverage == 0) == ~np.isfinite(image)).all(), key
        assert 1 <= int(coverage.max()) <= plane.n_used, key
        # Los flags usan solo bits declarados, y un pixel saturado tiene encendido alguno de saturacion.
        assert not (flags & ~np.uint32(declared)).any(), key
        assert ((flags[np.isposinf(image)] & np.uint32(saturation)) != 0).all(), key


@each_sample
def test_stats_and_scales_come_from_the_binaries(sample: Sample) -> None:
    meta, planes = listed(sample)
    assert meta.grid is not None and meta.detectors is not None
    images = load_planes(sample.id)
    for plane in planes:
        key = (plane.epoch, plane.detector)
        if plane.status not in CUBE_PLANE_STATUSES:
            assert plane.stats is None and plane.mjd_mean is None and plane.saturated == [], key
            continue
        assert plane.stats == plane_stats(images[key]), key
        assert plane.saturated == saturated_regions(images[key]), key
        # Las fracciones son del total de pixeles del campo, con el marco sin datos incluido.
        assert plane.stats is not None and plane.stats.valid_fraction > 0.25, key
    for detector in meta.detectors:
        own = [image for (_, number), image in images.items() if number == detector.detector]
        assert detector.display == detector_display(own), detector.detector
        assert detector.display is not None and detector.display.vmin < detector.display.vmax

    preview = STORE.read_preview(sample.id, shape=meta.grid.shape)
    assert meta.preview.display == detector_display([preview])
    assert (meta.preview.survey, meta.preview.band, meta.preview.wave_um) == ("WISE", "W1", 3.4)
    # La vista provisoria cubre todo el campo y no usa infinitos: ahi no hay saturacion.
    assert np.isfinite(preview).all()


@each_sample
def test_epochs_planes_and_progress_add_up(sample: Sample) -> None:
    meta, planes = listed(sample)
    assert meta.epochs is not None
    for epoch in meta.epochs:
        own = [plane for plane in planes if plane.epoch == epoch.epoch]
        assert epoch.n_exposures == sum(plane.n_exposures for plane in own)
        assert epoch.mjd_start <= epoch.mjd_mean <= epoch.mjd_end
        assert (epoch.start, epoch.end) == (iso_date(epoch.mjd_start), iso_date(epoch.mjd_end))
        for plane in own:
            if plane.mjd_mean is not None:
                assert epoch.mjd_start <= plane.mjd_mean <= epoch.mjd_end
    for before, after in pairwise(meta.epochs):
        assert after.mjd_start - before.mjd_end > EPOCH_GAP_DAYS

    for plane in planes:
        assert plane.n_exposures == plane.n_used + plane.n_failed
        if plane.status == "empty":
            # Sin exposiciones no cambio desde la lista; si las tenia, quedar vacio fue una revision.
            assert plane.n_used == 0 and plane.rev == (1 if plane.n_exposures else 0)
        else:
            # La revision que se sirve: la 2, porque la 1 es la provisoria del servidor falso.
            assert plane.rev == 2 and plane.n_used > 0
            assert plane.status == ("partial" if plane.n_failed else "ready")

    failed = sum(plane.n_failed for plane in planes)
    total = sum(plane.n_exposures for plane in planes)
    progress = meta.progress
    assert progress.phase == "done" and progress.queue_position == 0
    assert (progress.cutouts_total, progress.cutouts_failed) == (total, failed)
    assert progress.cutouts_done == total - failed
    assert progress.planes_total == progress.planes_ready == len(planes)
    assert progress.elapsed_s > 0
    assert meta.status == ("partial" if failed else "ready")


@each_sample
def test_flags_are_the_bits_of_the_headers(sample: Sample) -> None:
    meta = load_meta(sample.id)
    assert meta.flags is not None
    names = [flag.name for flag in meta.flags]
    bits = [flag.bit for flag in meta.flags]
    assert len(set(names)) == len(names) and bits == sorted(set(bits))
    assert all(0 <= bit < 32 for bit in bits)
    # SPEC.md, seccion 2: 22 bits documentados, y SOURCE no se enmascara.
    assert len(names) >= 22
    assert {flag.name for flag in meta.flags if flag.saturation} == SATURATION_FLAGS
    for flag in meta.flags:
        assert flag.description
        assert flag.masked == (flag.name in MASKED_FLAGS), flag.name
    assert {flag.name for flag in meta.flags if not flag.masked} == {"FULLSAMPLE", "PHANMISS", "OUTLIER", "SOURCE"}


@each_sample
def test_warnings_are_coherent_with_the_planes(sample: Sample) -> None:
    meta, planes = listed(sample)
    assert meta.grid is not None
    by_code: dict[str, list[Any]] = {}
    for warning in meta.warnings:
        by_code.setdefault(warning.code, []).append(warning)
    assert set(by_code) <= {"plane_empty", "few_exposures", "low_coverage", "saturated_source", "cutouts_failed"}

    with_data = [plane for plane in planes if plane.status != "empty"]
    assert {(w.epoch, w.detector) for w in by_code.get("plane_empty", [])} == {
        (plane.epoch, plane.detector) for plane in planes if plane.status == "empty"
    }
    assert {(w.epoch, w.detector, w.n) for w in by_code.get("few_exposures", [])} == {
        (plane.epoch, plane.detector, plane.n_used) for plane in with_data if plane.n_used < FEW_EXPOSURES_BELOW
    }
    assert {(w.epoch, w.detector, w.valid_fraction) for w in by_code.get("low_coverage", [])} == {
        (plane.epoch, plane.detector, plane.stats.valid_fraction)
        for plane in with_data
        if plane.stats is not None and plane.stats.valid_fraction < LOW_COVERAGE_BELOW
    }

    failed = [plane for plane in planes if plane.n_failed]
    if failed:
        (warning,) = by_code["cutouts_failed"]
        assert warning.n == sum(plane.n_failed for plane in failed)
        assert [(ref.epoch, ref.detector) for ref in warning.planes] == [(p.epoch, p.detector) for p in failed]
    else:
        assert "cutouts_failed" not in by_code

    saturated = [plane for plane in planes if plane.saturated]
    if saturated:
        (warning,) = by_code["saturated_source"]
        assert warning.epochs == sorted({plane.epoch for plane in saturated})
        assert warning.detectors == sorted({plane.detector for plane in saturated})
        largest = max(plane.saturated[0].radius_px for plane in saturated)
        assert warning.radius_arcsec == pytest.approx(largest * meta.grid.pixel_scale_arcsec, abs=0.06)
        # El centro del aviso cae dentro de la region saturada de cada plano.
        x, y = geometry.sky_to_pixel(geometry.grid_from_info(meta.grid), warning.ra, warning.dec)
        for plane in saturated:
            region = plane.saturated[0]
            assert np.hypot(region.x - x, region.y - y) < region.radius_px, (plane.epoch, plane.detector)
    else:
        assert "saturated_source" not in by_code


@each_sample
def test_track_gives_the_target_in_grid_pixels(sample: Sample) -> None:
    meta, planes = listed(sample)
    assert meta.grid is not None and meta.epochs is not None
    grid = geometry.grid_from_info(meta.grid)
    path = sample.folder / sample.entry["track_file"]
    track = TrackResponse.model_validate_json(path.read_text(encoding="utf-8"))
    assert track.name == sample.entry["track_name"]
    assert path.name == track_filename(track.name)
    assert STORE.read_track(sample.id, track.name) == track

    with_data = sorted({plane.epoch for plane in planes if plane.status != "empty"})
    assert [position.epoch for position in track.positions] == with_data
    for position, epoch in zip(track.positions, meta.epochs, strict=True):
        x, y = geometry.sky_to_pixel(grid, position.ra, position.dec)
        assert (position.x, position.y) == pytest.approx((x, y), abs=2e-3)
        assert position.in_field and geometry.in_grid(grid, position.x, position.y)
        assert epoch.mjd_start <= position.mjd <= epoch.mjd_end
        # El objetivo esta cerca del centro del campo: la grilla se centro en su posicion de 2026.
        assert np.hypot(position.x - (meta.grid.crpix[0] - 1), position.y - (meta.grid.crpix[1] - 1)) < 4.0


def test_wise0855_is_the_base_step_of_the_contract() -> None:
    sample = BY_LABEL["wise0855"]
    meta, planes = listed(sample)
    assert meta.grid is not None and meta.epochs is not None
    # Centro de SPEC.md (seccion 3.3) y escalon base del contrato (seccion 3).
    assert (meta.request.ra, meta.request.dec, meta.request.fov) == (133.7598, -7.2422, 0.1667)
    assert meta.grid.shape == (195, 195) and meta.grid.pixel_scale_arcsec == 3.075
    assert len(meta.epochs) == 3 and len(planes) == 18
    assert all(plane.status in CUBE_PLANE_STATUSES for plane in planes)
    assert not any(np.isposinf(image).any() for image in load_planes(sample.id).values())
    # El recorte que fallo en la Etapa 0 dejo un plano parcial.
    assert [(plane.epoch, plane.detector) for plane in planes if plane.status == "partial"] == [(2, 3)]


def test_epsindb_has_four_epochs_and_empty_planes() -> None:
    sample = BY_LABEL["epsindb"]
    meta, planes = listed(sample)
    assert meta.grid is not None and meta.epochs is not None
    assert len(meta.epochs) == 4 and len(planes) == 24 and meta.grid.shape == (195, 195)
    empty = [plane for plane in planes if plane.status == "empty"]
    # Contrato, seccion 9: en la epoca 4 no hay exposiciones en D1 ni en D4.
    assert [(plane.epoch, plane.detector) for plane in empty] == [(4, 1), (4, 4)]
    for plane in empty:
        assert (plane.n_exposures, plane.rev, plane.cube_offset) == (0, 0, None)
        assert not (sample.folder / plane_filename(plane.epoch, plane.detector)).exists()
        assert not (sample.folder / aux_filename(plane.epoch, plane.detector)).exists()
    assert len(load_planes(sample.id)) == 22
    assert not any(np.isposinf(image).any() for image in load_planes(sample.id).values())
    # Los recortes median 6 minutos: el marco y las esquinas quedaron sin datos en todos los planos.
    assert all(plane.stats.valid_fraction < LOW_COVERAGE_BELOW for plane in planes if plane.stats is not None)


def test_barnard_has_a_saturated_core_in_every_plane() -> None:
    sample = BY_LABEL["barnard"]
    meta, planes = listed(sample)
    assert meta.grid is not None
    assert meta.status == "ready" and len(planes) == 18 and meta.grid.shape == (195, 195)
    track = STORE.read_track(sample.id, sample.entry["track_name"])
    assert track is not None
    positions = {position.epoch: position for position in track.positions}
    images = load_planes(sample.id)
    for plane in planes:
        key = (plane.epoch, plane.detector)
        image = images[key]
        assert plane.status == "ready" and plane.stats is not None and plane.stats.saturated_fraction > 0, key
        # Una sola region saturada, sobre la posicion esperada de la estrella en esa epoca.
        (region,) = plane.saturated
        assert region.n_pixels == int(np.isposinf(image).sum()) >= 30, key
        position = positions[plane.epoch]
        assert np.hypot(region.x - position.x, region.y - position.y) < region.radius_px, key
        assert np.isposinf(image[round(position.y), round(position.x)]), key
        # Fuera del nucleo sigue habiendo pixeles sin datos, que no son saturacion.
        assert plane.stats.valid_fraction + plane.stats.saturated_fraction <= 1.0, key
    # spike/RESULTADOS.md, seccion 5: entre la primera y la ultima epoca se corre 10.25" al norte.
    north = (positions[3].y - positions[1].y) * meta.grid.pixel_scale_arcsec
    assert north == pytest.approx(10.25, abs=0.2)


@each_sample
def test_fake_server_opens_the_sample_by_name(sample: Sample) -> None:
    """De punta a punta con el servidor falso: resolver el nombre, pedir el campo y traer la trayectoria."""
    meta = load_meta(sample.id)
    assert meta.grid is not None
    app = create_fake_app(FIELDS_DIR, sesame_dir=SESAME_DIR, seconds=1.0)
    with TestClient(app) as client:
        response = client.get("/api/resolve", params={"name": sample.entry["object"]})
        assert response.status_code == 200, response.text
        resolved = ResolveResponse.model_validate(response.json())
        assert resolved.name == sample.entry["track_name"] and resolved.motion is not None
        center = resolved.field_center
        assert (center.ra, center.dec) == (meta.request.ra, meta.request.dec)

        response = client.post("/api/field", params={"scenario": "cached"}, json={"ra": center.ra, "dec": center.dec})
        assert response.status_code == 200, response.text
        field = FieldResponse.model_validate(response.json())
        assert field.id == sample.id and field.status == meta.status

        response = client.get(f"/api/field/{sample.id}/track", params={"name": sample.entry["object"]})
        assert response.status_code == 200, response.text
        assert TrackResponse.model_validate(response.json()) == STORE.read_track(sample.id, sample.entry["track_name"])

        response = client.get(f"/api/field/{sample.id}/preview")
        assert response.status_code == 200
        assert len(response.content) == plane_nbytes(meta.grid.shape)


def test_fake_server_resolves_the_five_test_objects() -> None:
    """Los cinco objetos de prueba, con lo que el catalogo trae de cada uno y `null` en lo que no trae."""
    # Paralaje (mas) y velocidad radial (km/s) de las respuestas de Sesame guardadas. Las de
    # Epsilon Indi B y WISE 0855 no traen velocidad radial.
    expected = {
        "Barnard's Star": (546.9759, -110.11),
        "Epsilon Indi B": (270.658, None),
        "R Draconis": (1.2509, -132.8),
        "RW Aurigae": (15.42, 15.0),
        "WISE J085510.83-071442.5": (439.0, None),
    }
    app = create_fake_app(FIELDS_DIR, sesame_dir=SESAME_DIR, seconds=1.0)
    with TestClient(app) as client:
        names = client.get("/api/health").json()["names"]
        for query, (parallax, radial_velocity) in expected.items():
            assert query in names
            response = client.get("/api/resolve", params={"name": query})
            assert response.status_code == 200, query
            motion = response.json()["motion"]
            assert set(motion) == {"pm_ra", "pm_dec", "parallax", "radial_velocity", "per_year_arcsec"}, query
            assert (motion["parallax"], motion["radial_velocity"]) == (parallax, radial_velocity), query
            resolved = ResolveResponse.model_validate(response.json())
            assert resolved.source == "sesame" and resolved.name in names

        # WISE 0855 como lo da CLAUDE.md, en sexagesimal: son coordenadas, no un nombre.
        response = client.get("/api/resolve", params={"name": "08h55m10.831s -07d14m42.53s"})
        assert response.status_code == 200
        resolved = ResolveResponse.model_validate(response.json())
        assert (resolved.source, resolved.name, resolved.motion) == ("coordinates", None, None)
        assert (resolved.field_center.ra, resolved.field_center.dec) == (133.7951, -7.2451)

        # Solo conoce los nombres guardados: un apodo no se resuelve.
        for alias in ("WISE 0855", "barnard"):
            response = client.get("/api/resolve", params={"name": alias})
            assert response.status_code == 404 and response.json()["error"]["code"] == "not_resolved", alias


# -------------------------------------------------------------- recortes y SIA2


def cutout_index() -> dict[str, Any]:
    return json.loads((CUTOUTS_DIR / "index.json").read_text(encoding="utf-8"))


def test_cutout_index_matches_the_files() -> None:
    index = cutout_index()
    entries = index["cutouts"]
    # Cada recorte de la carpeta esta en el indice, y cada entrada del indice tiene su archivo.
    assert sorted(path.name for path in CUTOUTS_DIR.glob("*.fits")) == sorted(entry["file"] for entry in entries)

    # Dos epocas por dos detectores por tres exposiciones, de las dos colecciones.
    assert Counter((entry["epoch"], entry["detector"]) for entry in entries) == {
        (1, 3): 3, (1, 6): 3, (3, 3): 3, (3, 6): 3,
    }  # fmt: skip
    assert {entry["collection"] for entry in entries} == {"spherex_dr1", "spherex_qr3"}
    assert len({(entry["obs_id"], entry["detector"]) for entry in entries}) == 12
    first = max(entry["mjd"] for entry in entries if entry["epoch"] == 1)
    last = min(entry["mjd"] for entry in entries if entry["epoch"] == 3)
    assert last - first > EPOCH_GAP_DAYS

    assert index["mode"] == "truncated" and index["side_deg"] == 0.1
    assert index["hdus"] == ["PRIMARY", *IMAGE_HDUS]
    center = index["center"]
    for entry in entries:
        with fits.open(CUTOUTS_DIR / entry["file"], memmap=False) as hdul:
            assert [hdu.name for hdu in hdul] == index["hdus"], entry["file"]
            assert len({hdul[name].data.shape for name in IMAGE_HDUS}) == 1, entry["file"]
            header = hdul["IMAGE"].header
            assert header["DETECTOR"] == entry["detector"], entry["file"]
            assert header["OBSID"] == entry["obs_id"], entry["file"]
            assert header["MJD-OBS"] == pytest.approx(entry["mjd"], abs=1e-4), entry["file"]
            assert any(key.startswith("MSKN") for key in hdul["FLAGS"].header), entry["file"]
        assert entry["mjd"] < entry["mjd_end"]
        stem = entry["url"].rsplit("/", 1)[-1].removesuffix(".fits")
        assert entry["file"].startswith(f"{stem}__"), entry["file"]
        expected_url = f"{entry['url']}?center={center['ra']:.6f},{center['dec']:.6f}d&size={index['side_deg']:g}"
        assert entry["cutout_url"] == expected_url


def test_cutout_flags_are_declared_in_the_sample_of_the_same_field() -> None:
    meta = load_meta(BY_LABEL["barnard"].id)
    assert meta.flags is not None and meta.grid is not None
    index = cutout_index()
    assert (index["center"]["ra"], index["center"]["dec"]) == meta.grid.crval
    declared = {(flag.bit, flag.name, flag.description) for flag in meta.flags}
    for entry in index["cutouts"]:
        with fits.open(CUTOUTS_DIR / entry["file"], memmap=False) as hdul:
            header = hdul["FLAGS"].header
            in_file = {(int(key[4:]), str(header[key]), str(header[f"MSKD{key[4:]}"])) for key in header["MSKN*"]}
        assert in_file <= declared, entry["file"]
        assert SATURATION_FLAGS <= {name for _, name, _ in in_file}, entry["file"]


def test_sia_responses_list_the_cutouts() -> None:
    index = json.loads((SIA_DIR / "index.json").read_text(encoding="utf-8"))
    assert [query["collection"] for query in index["queries"]] == ["spherex_dr1", "spherex_qr3"]
    assert index["center"] == cutout_index()["center"]

    rows_by_url: dict[str, dict[str, Any]] = {}
    for query in index["queries"]:
        rows, statuses = read_votable(SIA_DIR / query["file"])
        assert statuses and set(statuses) == {"OK"}, query["file"]
        assert len(rows) == query["rows"] > 0, query["file"]
        assert query["collection"] in query["url"]
        for row in rows:
            assert str(row["obs_collection"]) == query["collection"]
            rows_by_url[str(row["access_url"])] = row
    # Barnard: 358 exposiciones entre DR1 y QR3, sin repetidas (spike/RESULTADOS.md, seccion 4).
    assert len(rows_by_url) == 358

    for entry in cutout_index()["cutouts"]:
        row = rows_by_url[entry["url"]]
        assert str(row["obs_id"]) == entry["obs_id"]
        assert str(row["obs_collection"]) == entry["collection"]
        assert str(row["energy_bandpassname"]) == f"SPHEREx-D{entry['detector']}"
        assert float(row["t_min"]) == entry["mjd"] and float(row["t_max"]) == entry["mjd_end"]
        assert float(row["em_min"]) * 1e6 == pytest.approx(entry["wave_min_um"], abs=1e-4)
        assert float(row["em_max"]) * 1e6 == pytest.approx(entry["wave_max_um"], abs=1e-4)


def test_sesame_responses_of_the_five_test_objects() -> None:
    # Archivo de cada objeto de prueba (CLAUDE.md), el texto buscado y el nombre principal que devolvio SIMBAD.
    expected = {
        "barnard_s_star.xml": ("Barnard's Star", "NAME Barnard's star"),
        "epsilon_indi_b.xml": ("Epsilon Indi B", "* eps Ind B"),
        "r_draconis.xml": ("R Draconis", "V* R Dra"),
        "rw_aurigae.xml": ("RW Aurigae", "V* RW Aur"),
        "wise_j085510_83_071442_5.xml": ("WISE J085510.83-071442.5", "WISEA J085510.74-071442.5"),
    }
    for filename, (query, name) in expected.items():
        # Sesame cierra la respuesta con un comentario fuera del elemento raiz.
        root = ET.fromstring((SESAME_DIR / filename).read_text(encoding="utf-8").split("<!---")[0])
        assert root.findtext("./Target/name") == query, filename
        resolver = root.find("./Target/Resolver")
        assert resolver is not None, filename
        assert resolver.findtext("oname") == name, filename
        assert 0.0 <= float(resolver.findtext("jradeg", "")) < 360.0, filename
        assert -90.0 <= float(resolver.findtext("jdedeg", "")) <= 90.0, filename
    # Las trayectorias de las muestras llevan el nombre con el que Sesame conoce a cada objeto.
    names = {name for _, name in expected.values()}
    assert {sample.entry["track_name"] for sample in SAMPLES} <= names
    assert {sample.entry["object"] for sample in SAMPLES} <= {query for query, _ in expected.values()}


# -------------------------------------------------------- copias del frontend

needs_frontend = pytest.mark.skipif(not FRONTEND_FIXTURES_DIR.is_dir(), reason=f"no existe {FRONTEND_FIXTURES_DIR}")


@needs_frontend
@each_sample
def test_frontend_has_a_copy_of_the_sample(sample: Sample) -> None:
    source = json.loads((sample.folder / META_FILENAME).read_text(encoding="utf-8"))
    flat = FRONTEND_FIXTURES_DIR / f"meta-{sample.label}.json"
    assert json.loads(flat.read_text(encoding="utf-8")) == source
    # La carpeta de la muestra tiene el formato de campo en disco, con solo algunos de sus archivos.
    folder = FRONTEND_FIXTURES_DIR / sample.label
    names = {path.name for path in folder.iterdir()}
    assert {META_FILENAME, sample.entry["track_file"]} <= names
    for name in names:
        if not (sample.folder / name).is_file():
            continue  # no es una copia: lo agrego alguien del frontend
        if name.endswith(".json"):
            copied = json.loads((folder / name).read_text(encoding="utf-8"))
            assert copied == json.loads((sample.folder / name).read_text(encoding="utf-8")), name
        else:
            assert (folder / name).read_bytes() == (sample.folder / name).read_bytes(), name


@needs_frontend
def test_frontend_has_a_saturated_plane_and_a_clean_one() -> None:
    found: dict[str, NDArray[np.float32]] = {}
    for label in ("barnard", "wise0855"):
        meta = load_meta(BY_LABEL[label].id)
        assert meta.grid is not None
        (path,) = (FRONTEND_FIXTURES_DIR / label).glob("plane_e*_d*.f32")
        assert path.stat().st_size == plane_nbytes(meta.grid.shape)
        assert (path.parent / path.name.replace("plane_", "aux_").replace(".f32", ".bin.gz")).is_file()
        found[label] = np.frombuffer(path.read_bytes(), dtype="<f4").reshape(meta.grid.shape)
    # Barnard: NaN y +Infinity en el mismo plano. WISE 0855: todos los pixeles con valor.
    assert np.isposinf(found["barnard"]).any() and np.isnan(found["barnard"]).any()
    assert np.isfinite(found["wise0855"]).all()


@needs_frontend
def test_event_transcript_of_a_new_field() -> None:
    """La transcripcion sigue las secciones 4.2 y 8 del contrato y termina en la muestra de WISE 0855."""
    sample = BY_LABEL["wise0855"]
    meta, planes = listed(sample)
    events = json.loads((FRONTEND_FIXTURES_DIR / "events-new-field.json").read_text(encoding="utf-8"))
    assert all(set(event) == {"event", "id", "data"} for event in events)
    assert [event["id"] for event in events] == list(range(1, len(events) + 1))
    parsed = [(event["event"], EVENT_ADAPTERS[event["event"]].validate_python(event["data"])) for event in events]
    names = [name for name, _ in parsed]

    # Primero `state`, con el trabajo en la cola y todavia sin grilla ni planos. El otro `state`
    # es el del documento terminado, justo antes de `done`.
    state = parsed[0][1]
    assert names[0] == "state" and names.count("state") == 2 and names[-2:] == ["state", "done"]
    assert (state.id, state.status, state.rev) == (sample.id, "queued", 0)
    assert state.progress.phase == "queued" and state.progress.queue_position >= 1
    assert state.grid is None and state.planes is None and state.preview.status == "pending"

    # Despues la cola, la vista provisoria y la lista de exposiciones, antes de cualquier plano.
    first_plane = names.index("plane")
    assert names.index("queued") < names.index("preview") < names.index("listed") < first_plane
    assert parsed[names.index("preview")][1].status == "ready"
    listed_meta = parsed[names.index("listed")][1]
    assert listed_meta.status == "downloading" and listed_meta.grid == meta.grid and listed_meta.epochs == meta.epochs
    assert [(plane.epoch, plane.detector, plane.n_exposures) for plane in listed_meta.planes] == [
        (plane.epoch, plane.detector, plane.n_exposures) for plane in planes
    ]
    assert all(plane.status == "pending" and plane.cube_offset is None for plane in listed_meta.planes)
    assert all(plane.rev == 0 for plane in listed_meta.planes)
    # Todavia no se leyo ningun archivo: `flags` va vacio y no se sabe el modo de descarga.
    assert listed_meta.flags == [] and listed_meta.provenance.download_mode is None

    # El avance no retrocede.
    progress = [data for name, data in parsed if name == "progress"]
    phases = [item.phase for item in progress]
    assert "downloading" in phases and "done" not in phases
    assert phases == sorted(phases, key=["queued", "listing", "downloading", "finishing"].index)
    for before, after in pairwise(progress):
        assert before.elapsed_s <= after.elapsed_s
        assert before.cutouts_done <= after.cutouts_done and before.planes_ready <= after.planes_ready
    assert progress[-1].cutouts_done + progress[-1].cutouts_failed == meta.progress.cutouts_total

    # Cada plano llega primero provisorio, con parte de sus exposiciones, y despues definitivo.
    revisions: dict[Key, list[PlaneInfo]] = {}
    for name, data in parsed:
        if name == "plane":
            revisions.setdefault((data.plane.epoch, data.plane.detector), []).append(data.plane)
            assert data.detector_display is not None and data.detector_display.detector == data.plane.detector
    assert set(revisions) == {(plane.epoch, plane.detector) for plane in planes}
    for plane in planes:
        provisional, final = revisions[(plane.epoch, plane.detector)]
        # La provisoria es la revision 1 y la definitiva la 2, la misma que tiene la muestra en disco:
        # quien carga `meta-wise0855.json` y despues reproduce los eventos nunca ve bajar una `rev`.
        assert provisional.status == "building" and (provisional.rev, final.rev) == (1, 2) and plane.rev == 2
        assert 0 < provisional.n_used <= final.n_used and provisional.stats is not None
        assert (final.status, final.n_used, final.n_failed) == (plane.status, plane.n_used, plane.n_failed)
        assert final.stats == plane.stats and final.cube_offset is None

    # Orden de la seccion 8: primero la banda pedida, con todas sus epocas provisorias antes de
    # completar ninguna, y despues las demas bandas, de la mas cercana a la mas lejana.
    order = [(data.plane.detector, data.plane.status) for name, data in parsed if name == "plane"]
    band = order[0][0]
    assert band == 3
    detectors = list(dict.fromkeys(detector for detector, _ in order))
    assert sorted(detectors) == [1, 2, 3, 4, 5, 6]
    assert [abs(detector - band) for detector in detectors] == sorted(abs(detector - band) for detector in detectors)
    assert [detector for detector, _ in order] == [d for d in detectors for _ in range(2 * len(meta.epochs or ()))]
    for detector in detectors:
        statuses = [status for number, status in order if number == detector]
        half = len(statuses) // 2
        assert set(statuses[:half]) == {"building"} and "building" not in statuses[half:]

    # Los avisos del campo llegan en `listed` o como eventos `warning`, y `done` cierra el flujo.
    announced = listed_meta.warnings + [data for name, data in parsed if name == "warning"]
    assert sorted(announced, key=repr) == sorted(meta.warnings, key=repr)
    done = parsed[-1][1]
    assert names[-1] == "done" and names.count("done") == 1 and "error" not in names
    assert (done.status, done.rev) == (meta.status, meta.rev)

    # El `state` anterior a `done` es la muestra tal como esta en disco, salvo el tiempo que tardo la
    # simulacion: trae lo que ningun otro evento lleva (`flags`, `cube_offset` y `provenance` completos).
    closing = parsed[-2][1]
    assert closing.progress.phase == "done" and closing.progress.elapsed_s == done.elapsed_s
    assert closing.model_copy(update={"progress": meta.progress}) == meta
    assert closing.flags and closing.provenance.built_at and closing.provenance.download_mode
    assert [plane.cube_offset for plane in closing.planes] == [plane.cube_offset for plane in planes]
    assert all(plane.cube_offset is not None for plane in closing.planes)
