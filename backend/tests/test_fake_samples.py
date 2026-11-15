"""Los campos de muestra del repositorio (tests/fixtures/fields) sirven para el servidor falso.

Si la carpeta no existe o esta vacia, el test se saltea: las muestras las
genera scripts/make_sample_fields.py.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.contract import CUBE_PLANE_STATUSES, FieldMeta, FieldResponse
from app.fake import _load_sample, create_fake_app
from app.jobs.store import FieldStore, aux_filename, cube_nbytes, plane_nbytes

FIELDS_DIR = Path(__file__).resolve().parent / "fixtures" / "fields"
SAMPLE_IDS = FieldStore(FIELDS_DIR).list_ids()

pytestmark = pytest.mark.skipif(not SAMPLE_IDS, reason=f"no hay campos de muestra en {FIELDS_DIR}")


@pytest.mark.parametrize("field_id", SAMPLE_IDS or ["sin-muestras"])
def test_sample_is_a_finished_field_with_all_its_files(field_id: str) -> None:
    store = FieldStore(FIELDS_DIR)
    meta = _load_sample(store, field_id)
    assert meta is not None, "meta.json no cumple el contrato o el campo no esta terminado (ver el log)"
    assert meta.grid is not None and meta.planes is not None and meta.detectors is not None

    shape = meta.grid.shape
    size = plane_nbytes(shape)
    folder = store.locate(field_id)
    assert folder is not None
    for plane in meta.planes:
        if plane.status not in CUBE_PLANE_STATUSES:
            continue
        assert len(store.read_plane_bytes(field_id, plane.epoch, plane.detector, shape=shape)) == size
        assert plane.stats is not None and plane.mjd_mean is not None
        if (folder / aux_filename(plane.epoch, plane.detector)).is_file():
            flags, coverage = store.read_aux(field_id, plane.epoch, plane.detector, shape=shape)
            assert flags.shape == coverage.shape == shape
    assert sum(len(chunk) for chunk in store.iter_cube(field_id, meta)) == cube_nbytes(meta)
    if meta.preview.status == "ready":
        assert len(store.read_preview_bytes(field_id, shape=shape)) == size
    for detector in meta.detectors:
        has_data = any(p.detector == detector.detector and p.status in CUBE_PLANE_STATUSES for p in meta.planes)
        assert (detector.display is not None) == has_data


@pytest.mark.parametrize("field_id", SAMPLE_IDS or ["sin-muestras"])
def test_sample_can_be_simulated_from_new_to_done(field_id: str) -> None:
    app = create_fake_app(FIELDS_DIR, seconds=100.0)
    backend = app.state.fake
    now = [0.0]
    backend.clock = lambda: now[0]
    sample = backend.samples()[field_id]
    with TestClient(app) as client:
        body = {"ra": sample.request.ra, "dec": sample.request.dec, "fov": sample.request.fov}
        created = FieldResponse.model_validate(client.post("/api/field", json=body).json())
        # Puede haber otra muestra con el mismo centro; se sigue la que eligio el servidor.
        chosen = backend.samples()[created.id]
        assert created.status == "queued"
        now[0] = 50.0
        halfway = FieldMeta.model_validate(client.get(f"/api/field/{created.id}/meta").json())
        assert halfway.status == "downloading" and halfway.planes is not None
        now[0] = 100.0
        final = FieldMeta.model_validate(client.get(f"/api/field/{created.id}/meta").json())
        assert final.status == chosen.status and final.planes == chosen.planes
        assert final.progress.phase == "done"
        cube = client.get(f"/api/field/{created.id}/cube", params={"rev": final.rev})
        assert cube.status_code == 200 and len(cube.content) == cube_nbytes(chosen)
