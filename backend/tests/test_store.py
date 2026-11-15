"""Campo en disco: formato, busqueda por raices, validacion de tamanos y cubo."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np
import pytest

from app.config import Settings
from app.contract import (
    FieldMeta,
    FieldRequestInfo,
    GridInfo,
    PlaneInfo,
    PreviewInfo,
    Progress,
    TrackPosition,
    TrackResponse,
)
from app.jobs.store import (
    FieldNotFoundError,
    FieldStore,
    ResourceNotFoundError,
    SizeMismatchError,
    StoreError,
    aux_filename,
    aux_nbytes,
    cube_nbytes,
    plane_filename,
    plane_nbytes,
    track_filename,
    track_slug,
    with_cube_offsets,
)

SHAPE = (5, 7)  # (ny, nx): distintos, para que un eje cambiado se note
FIELD_ID = "0123456789abcdef"


def _meta(field_id: str = FIELD_ID, *, listed: bool = True, status: str = "ready") -> FieldMeta:
    meta = FieldMeta(
        id=field_id,
        pipeline="1",
        status=status,  # type: ignore[arg-type]
        rev=1 if status == "ready" else 0,
        request=FieldRequestInfo(ra=10.0, dec=20.0, fov=0.1667),
        progress=Progress(phase="done" if status == "ready" else "queued"),
        preview=PreviewInfo(status="unavailable", band="W1", wave_um=3.4, hips="prueba"),
    )
    if listed:
        meta.grid = GridInfo(
            crval=(10.0, 20.0),
            crpix=(4.0, 3.0),
            cdelt=(-0.000854167, 0.000854167),
            shape=SHAPE,
            fov=0.1667,
            pixel_scale_arcsec=3.075,
            native_pixel_scale_arcsec=6.15,
        )
        meta.planes = [
            PlaneInfo(epoch=1, detector=1, status="ready", rev=1, n_exposures=4, n_used=4),
            PlaneInfo(epoch=1, detector=2, status="empty"),
            PlaneInfo(epoch=2, detector=1, status="partial", rev=2, n_exposures=4, n_used=3, n_failed=1),
            PlaneInfo(epoch=2, detector=2, status="ready", rev=1, n_exposures=5, n_used=5),
        ]
    return meta


def _image(seed: int) -> np.ndarray:
    image = np.random.default_rng(seed).normal(0.0, 1.0, SHAPE).astype(np.float32)
    image[0, 0] = np.nan
    image[1, 1] = np.inf
    return image


@pytest.fixture
def store(tmp_path: Path) -> FieldStore:
    return FieldStore(tmp_path / "cache", read_roots=(tmp_path / "data", tmp_path / "cache"))


# --------------------------------------------------------------------- nombres


def test_file_names_follow_the_format() -> None:
    assert plane_filename(2, 6) == "plane_e2_d6.f32"
    assert aux_filename(2, 6) == "aux_e2_d6.bin.gz"
    assert track_slug("NAME Barnard's star") == "name-barnard-s-star"
    assert track_filename("WISE J085510.83-071442.5") == "track_wise-j085510-83-071442-5.json"
    assert track_slug("***") == "objeto"
    assert plane_nbytes(SHAPE) == 4 * 5 * 7
    assert aux_nbytes(SHAPE) == 6 * 5 * 7


# ------------------------------------------------------------------- metadatos


def test_meta_round_trip_and_layout(store: FieldStore, tmp_path: Path) -> None:
    assert not store.exists(FIELD_ID)
    path = store.write_meta(_meta())
    assert path == tmp_path / "cache" / FIELD_ID / "meta.json"
    assert store.exists(FIELD_ID)
    assert store.locate(FIELD_ID) == tmp_path / "cache" / FIELD_ID
    assert store.read_meta(FIELD_ID) == _meta()
    # En disco es el documento del contrato, en JSON legible.
    document = json.loads(path.read_text(encoding="utf-8"))
    assert document["id"] == FIELD_ID
    assert document["grid"]["shape"] == [5, 7]
    assert document["planes"][1]["cube_offset"] is None


def test_meta_before_listed_omits_the_missing_sections(store: FieldStore) -> None:
    path = store.write_meta(_meta(listed=False, status="queued"))
    document = json.loads(path.read_text(encoding="utf-8"))
    assert set(document) == {"id", "pipeline", "status", "rev", "request", "progress", "warnings", "preview"}
    loaded = store.read_meta(FIELD_ID)
    assert loaded.grid is None and loaded.planes is None and loaded.provenance is None


def test_meta_write_is_atomic_and_leaves_no_temporary_files(store: FieldStore, tmp_path: Path) -> None:
    store.write_meta(_meta())
    updated = _meta()
    updated.rev = 7
    store.write_meta(updated)
    assert store.read_meta(FIELD_ID).rev == 7
    assert [item.name for item in (tmp_path / "cache" / FIELD_ID).iterdir()] == ["meta.json"]


def test_meta_that_breaks_the_contract_is_not_written(store: FieldStore) -> None:
    meta = _meta()
    meta.progress.elapsed_s = float("nan")  # JSON no admite NaN
    with pytest.raises(StoreError):
        store.write_meta(meta)
    meta = _meta()
    meta.status = "otro"  # type: ignore[assignment]
    with pytest.raises(StoreError):
        store.write_meta(meta)
    assert not store.exists(FIELD_ID)


def test_unknown_or_unsafe_ids(store: FieldStore, tmp_path: Path) -> None:
    (tmp_path / "meta.json").write_text("{}", encoding="utf-8")  # un meta.json fuera de las raices
    for field_id in ["ffffffffffffffff", "..", "../cache", "a/b", "", "ABCDEF", "con espacio", "."]:
        assert not store.exists(field_id)
        with pytest.raises(FieldNotFoundError):
            store.read_meta(field_id)
    bad = _meta()
    bad.id = "../fuera"
    with pytest.raises(StoreError):
        store.write_meta(bad)


def test_corrupt_meta_is_reported(store: FieldStore, tmp_path: Path) -> None:
    folder = tmp_path / "cache" / FIELD_ID
    folder.mkdir(parents=True)
    (folder / "meta.json").write_text('{"id": "x"}', encoding="utf-8")
    with pytest.raises(StoreError):
        store.read_meta(FIELD_ID)
    (folder / "meta.json").write_text("no es json", encoding="utf-8")
    with pytest.raises(StoreError):
        store.read_meta(FIELD_ID)


# ---------------------------------------------------------------------- raices


def test_reads_precomputed_first_and_writes_only_to_the_write_root(tmp_path: Path) -> None:
    data, cache = tmp_path / "data", tmp_path / "cache"
    precompute = FieldStore(data, read_roots=(data, cache))
    runtime = FieldStore(cache, read_roots=(data, cache))

    precomputed = _meta()
    precomputed.rev = 5
    precompute.write_meta(precomputed)
    runtime.write_meta(_meta())  # el mismo id, en la cache
    runtime.write_meta(_meta("aaaaaaaaaaaaaaaa"))

    assert (data / FIELD_ID / "meta.json").is_file()
    assert (cache / FIELD_ID / "meta.json").is_file()
    # Gana el precalculado.
    assert runtime.locate(FIELD_ID) == data / FIELD_ID
    assert runtime.read_meta(FIELD_ID).rev == 5
    assert runtime.list_ids() == [FIELD_ID, "aaaaaaaaaaaaaaaa"]
    # Lo que no esta precalculado sale de la cache.
    assert runtime.locate("aaaaaaaaaaaaaaaa") == cache / "aaaaaaaaaaaaaaaa"


def test_from_settings_uses_data_then_cache(tmp_path: Path) -> None:
    settings = Settings(data_dir=tmp_path / "data", cache_dir=tmp_path / "cache")
    runtime = FieldStore.from_settings(settings)
    assert runtime.read_roots == (tmp_path / "data" / "fields", tmp_path / "cache" / "fields")
    assert runtime.write_root == tmp_path / "cache" / "fields"
    precompute = FieldStore.from_settings(settings, write_precomputed=True)
    assert precompute.write_root == tmp_path / "data" / "fields"
    assert precompute.read_roots == runtime.read_roots


def test_list_ids_ignores_folders_without_meta(store: FieldStore, tmp_path: Path) -> None:
    assert store.list_ids() == []
    store.write_meta(_meta())
    (tmp_path / "cache" / "sin-meta").mkdir()
    (tmp_path / "cache" / "suelto.txt").write_text("x", encoding="utf-8")
    assert store.list_ids() == [FIELD_ID]


# ---------------------------------------------------------------------- planos


def test_plane_round_trip_is_little_endian_float32_row_major(store: FieldStore, tmp_path: Path) -> None:
    store.write_meta(_meta())
    image = _image(1)
    path = store.write_plane(FIELD_ID, 1, 1, image)
    assert path == tmp_path / "cache" / FIELD_ID / "plane_e1_d1.f32"

    raw = path.read_bytes()
    assert len(raw) == 4 * 5 * 7
    assert raw == image.astype("<f4").tobytes()  # fila 0 primero, y dentro de la fila la columna 0
    assert store.read_plane_bytes(FIELD_ID, 1, 1) == raw

    loaded = store.read_plane(FIELD_ID, 1, 1)
    assert loaded.dtype == np.float32 and loaded.shape == SHAPE
    np.testing.assert_array_equal(loaded, image)  # NaN e infinito incluidos
    assert np.isnan(loaded[0, 0]) and np.isposinf(loaded[1, 1])
    loaded[0, 0] = 1.0  # la copia se puede modificar


def test_plane_accepts_other_dtypes_and_explicit_shape(store: FieldStore) -> None:
    store.write_meta(_meta(listed=False, status="queued"))
    image = np.arange(35, dtype=np.float64).reshape(SHAPE)
    # Sin grilla en los metadatos hay que pasar la forma.
    with pytest.raises(StoreError):
        store.write_plane(FIELD_ID, 1, 1, image)
    store.write_plane(FIELD_ID, 1, 1, image, shape=SHAPE)
    np.testing.assert_array_equal(store.read_plane(FIELD_ID, 1, 1, shape=SHAPE), image.astype(np.float32))


def test_plane_size_is_validated(store: FieldStore, tmp_path: Path) -> None:
    store.write_meta(_meta())
    with pytest.raises(SizeMismatchError):
        store.write_plane(FIELD_ID, 1, 1, np.zeros((7, 5), dtype=np.float32))  # ejes cambiados
    with pytest.raises(SizeMismatchError):
        store.write_plane(FIELD_ID, 1, 1, np.zeros(35, dtype=np.float32))
    assert not (tmp_path / "cache" / FIELD_ID / "plane_e1_d1.f32").exists()

    (tmp_path / "cache" / FIELD_ID / "plane_e1_d1.f32").write_bytes(b"\x00" * (4 * 5 * 7 - 4))
    with pytest.raises(SizeMismatchError):
        store.read_plane_bytes(FIELD_ID, 1, 1)
    with pytest.raises(SizeMismatchError):
        store.read_plane(FIELD_ID, 1, 1)


def test_missing_plane_and_missing_field(store: FieldStore) -> None:
    store.write_meta(_meta())
    with pytest.raises(ResourceNotFoundError):
        store.read_plane_bytes(FIELD_ID, 1, 1)
    with pytest.raises(FieldNotFoundError):
        store.read_plane_bytes("ffffffffffffffff", 1, 1)
    with pytest.raises(FieldNotFoundError):
        store.write_plane("ffffffffffffffff", 1, 1, np.zeros(SHAPE, dtype=np.float32))


# ------------------------------------------------------------ capas auxiliares


def test_aux_round_trip_and_layout(store: FieldStore, tmp_path: Path) -> None:
    store.write_meta(_meta())
    flags = np.arange(35, dtype=np.uint32).reshape(SHAPE) * 70000  # no entra en 16 bits
    coverage = np.arange(35, dtype=np.uint16).reshape(SHAPE)
    path = store.write_aux(FIELD_ID, 2, 1, flags, coverage)
    assert path == tmp_path / "cache" / FIELD_ID / "aux_e2_d1.bin.gz"

    # En disco: gzip de los flags Uint32 seguidos de la cobertura Uint16.
    payload = gzip.decompress(path.read_bytes())
    assert len(payload) == 6 * 5 * 7
    assert payload == flags.astype("<u4").tobytes() + coverage.astype("<u2").tobytes()
    assert store.read_aux_bytes(FIELD_ID, 2, 1) == payload
    assert gzip.decompress(store.read_aux_gzip(FIELD_ID, 2, 1)) == payload

    loaded_flags, loaded_coverage = store.read_aux(FIELD_ID, 2, 1)
    assert loaded_flags.dtype == np.uint32 and loaded_coverage.dtype == np.uint16
    np.testing.assert_array_equal(loaded_flags, flags)
    np.testing.assert_array_equal(loaded_coverage, coverage)


def test_aux_bytes_do_not_depend_on_the_time_of_writing(store: FieldStore, tmp_path: Path) -> None:
    store.write_meta(_meta())
    flags = np.ones(SHAPE, dtype=np.uint32)
    coverage = np.full(SHAPE, 3, dtype=np.uint16)
    first = store.write_aux(FIELD_ID, 1, 1, flags, coverage).read_bytes()
    assert first[4:8] == b"\x00\x00\x00\x00"  # campo de fecha del encabezado gzip
    assert store.write_aux(FIELD_ID, 1, 1, flags.astype(np.int64), coverage.astype(np.int32)).read_bytes() == first


def test_aux_size_is_validated(store: FieldStore, tmp_path: Path) -> None:
    store.write_meta(_meta())
    good = np.zeros(SHAPE, dtype=np.uint32)
    with pytest.raises(SizeMismatchError):
        store.write_aux(FIELD_ID, 1, 1, good, np.zeros((7, 5), dtype=np.uint16))
    with pytest.raises(SizeMismatchError):
        store.write_aux(FIELD_ID, 1, 1, np.zeros((5, 6), dtype=np.uint32), good)

    path = tmp_path / "cache" / FIELD_ID / "aux_e1_d1.bin.gz"
    path.write_bytes(gzip.compress(b"\x00" * 100))
    with pytest.raises(SizeMismatchError):
        store.read_aux_bytes(FIELD_ID, 1, 1)
    with pytest.raises(SizeMismatchError):
        store.read_aux_gzip(FIELD_ID, 1, 1)
    path.write_bytes(b"esto no es gzip")
    with pytest.raises(StoreError):
        store.read_aux(FIELD_ID, 1, 1)
    with pytest.raises(ResourceNotFoundError):
        store.read_aux(FIELD_ID, 2, 2)


# ------------------------------------------------- vista provisoria y trayectoria


def test_preview_round_trip(store: FieldStore, tmp_path: Path) -> None:
    store.write_meta(_meta())
    assert not store.has_preview(FIELD_ID)
    with pytest.raises(ResourceNotFoundError):
        store.read_preview_bytes(FIELD_ID)
    image = _image(9)
    path = store.write_preview(FIELD_ID, image)
    assert path == tmp_path / "cache" / FIELD_ID / "preview.f32"
    assert store.has_preview(FIELD_ID)
    assert store.read_preview_bytes(FIELD_ID) == image.astype("<f4").tobytes()
    np.testing.assert_array_equal(store.read_preview(FIELD_ID), image)
    with pytest.raises(SizeMismatchError):
        store.write_preview(FIELD_ID, np.zeros((2, 2), dtype=np.float32))


def test_track_round_trip(store: FieldStore, tmp_path: Path) -> None:
    store.write_meta(_meta())
    track = TrackResponse(
        name="NAME Barnard's star",
        positions=[
            TrackPosition(epoch=1, mjd=60913.7, ra=269.44604, dec=4.7674, x=97.3, y=96.0, in_field=True),
            TrackPosition(epoch=2, mjd=61116.2, ra=269.44661, dec=4.76896, x=96.6, y=97.8, in_field=True),
        ],
    )
    path = store.write_track(FIELD_ID, track)
    assert path == tmp_path / "cache" / FIELD_ID / "track_name-barnard-s-star.json"
    assert store.read_track(FIELD_ID, "NAME Barnard's star") == track
    assert store.read_track(FIELD_ID, "name barnard s star") == track  # mismo slug
    assert store.read_track(FIELD_ID, "otro objeto") is None
    assert store.list_tracks(FIELD_ID) == [track]
    with pytest.raises(FieldNotFoundError):
        store.read_track("ffffffffffffffff", "x")


# ------------------------------------------------------------------------ cubo


def test_cube_offsets_skip_planes_without_data() -> None:
    meta = with_cube_offsets(_meta())
    assert meta.planes is not None
    size = 4 * 5 * 7
    assert [plane.cube_offset for plane in meta.planes] == [0, None, size, 2 * size]
    assert cube_nbytes(meta) == 3 * size
    # No modifica el original.
    original = _meta()
    with_cube_offsets(original)
    assert original.planes is not None and all(plane.cube_offset is None for plane in original.planes)
    # Sin planos todavia, queda igual.
    assert with_cube_offsets(_meta(listed=False, status="queued")).planes is None


def test_cube_concatenates_planes_in_order(store: FieldStore) -> None:
    meta = with_cube_offsets(_meta())
    store.write_meta(meta)
    images = {(1, 1): _image(1), (2, 1): _image(2), (2, 2): _image(3)}
    for (epoch, detector), image in images.items():
        store.write_plane(FIELD_ID, epoch, detector, image)

    chunks = list(store.iter_cube(FIELD_ID))
    assert len(chunks) == 3
    cube = b"".join(chunks)
    assert len(cube) == cube_nbytes(meta)
    assert meta.planes is not None
    for plane in meta.planes:
        if plane.cube_offset is None:
            continue
        expected = images[(plane.epoch, plane.detector)].astype("<f4").tobytes()
        assert cube[plane.cube_offset : plane.cube_offset + len(expected)] == expected


def test_cube_fails_before_yielding_if_a_plane_is_missing_or_wrong(store: FieldStore, tmp_path: Path) -> None:
    store.write_meta(with_cube_offsets(_meta()))
    store.write_plane(FIELD_ID, 1, 1, _image(1))
    store.write_plane(FIELD_ID, 2, 1, _image(2))
    with pytest.raises(ResourceNotFoundError):
        store.iter_cube(FIELD_ID)  # falta el plano (2, 2): falla al pedir el iterador
    (tmp_path / "cache" / FIELD_ID / "plane_e2_d2.f32").write_bytes(b"\x00" * 8)
    with pytest.raises(SizeMismatchError):
        store.iter_cube(FIELD_ID)
    store.write_meta(_meta(listed=False, status="queued"))
    with pytest.raises(StoreError):
        store.iter_cube(FIELD_ID)
