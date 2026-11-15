"""El pipeline de punta a punta con los recortes reales: de 12 archivos a 4 planos.

Los recortes guardados son de Barnard: dos epocas (la 1 y la 3 del campo) por
dos detectores (3 y 6), tres exposiciones cada plano. Se procesan sobre la
grilla base del campo tal como la arma el backend. Sin red.

Lo que se comprueba es lo que el contrato promete de un plano (secciones 6 y
7): el nucleo saturado en +Infinity donde se espera a la estrella en cada
epoca, el resto con datos y fondo cercano a cero, norte arriba y este a la
izquierda, y una salida que `app.pipeline.stats` y `FieldStore` aceptan.
"""

from __future__ import annotations

import gzip
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from app import geometry
from app.contract import DetectorInfo, FieldMeta, FieldRequestInfo, PlaneInfo, PreviewInfo, Progress, TrackResponse
from app.domain import Exposure, Grid, PlaneArrays, ReprojectedExposure
from app.jobs.store import FieldStore, plane_filename, plane_nbytes, split_aux
from app.pipeline.coadd import PlaneAccumulator
from app.pipeline.epochs import assign_epochs
from app.pipeline.exposure import SATURATION_FLAGS, flag_mask, load_exposure
from app.pipeline.flag_table import field_flags
from app.pipeline.stats import detector_display, plane_stats, saturated_regions

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
CUTOUTS_DIR = FIXTURES_DIR / "cutouts"

# Centro del campo de Barnard (posicion en 2026.0, 4 decimales) y escalon base del contrato.
BARNARD = (269.4463, 4.7683)

Key = tuple[int, int]  # (epoca del campo, detector)


@dataclass
class RealPlane:
    """Un plano armado con los recortes reales, con lo que hizo falta para armarlo."""

    key: Key
    entries: list[dict[str, Any]]
    exposures: list[ReprojectedExposure]
    halfway: PlaneArrays  # con 2 de las 3 exposiciones
    final: PlaneArrays
    expected: tuple[float, float]  # (x, y) de Barnard en esa epoca, en pixeles de la grilla


@dataclass
class RealField:
    grid: Grid
    planes: dict[Key, RealPlane]


@pytest.fixture(scope="module")
def field() -> RealField:
    grid = geometry.build_grid(geometry.normalize_request(*BARNARD))
    index = json.loads((CUTOUTS_DIR / "index.json").read_text(encoding="utf-8"))
    samples = json.loads((FIXTURES_DIR / "fields" / "index.json").read_text(encoding="utf-8"))["samples"]
    (sample,) = (item for item in samples if item["label"] == "barnard")
    track = TrackResponse.model_validate_json(
        (FIXTURES_DIR / "fields" / sample["id"] / sample["track_file"]).read_text(encoding="utf-8")
    )
    # La trayectoria de la muestra da la posicion en el cielo; el pixel se calcula en esta grilla,
    # que esta centrada en el pedido y no donde la centro la Etapa 0 (difieren en 0.06 px).
    positions = {item.epoch: geometry.sky_to_pixel(grid, item.ra, item.dec) for item in track.positions}

    groups: dict[Key, list[dict[str, Any]]] = {}
    for entry in index["cutouts"]:
        groups.setdefault((entry["epoch"], entry["detector"]), []).append(entry)
    planes: dict[Key, RealPlane] = {}
    for key, entries in sorted(groups.items()):
        entries.sort(key=lambda entry: entry["mjd"])
        exposures = [load_exposure(CUTOUTS_DIR / entry["file"], grid) for entry in entries]
        accumulator = PlaneAccumulator(grid, len(exposures))
        for exposure in exposures[:2]:
            accumulator.add(exposure)
        halfway = accumulator.snapshot()
        accumulator.add(exposures[2])
        assert accumulator.n_used == accumulator.n_exposures == 3
        planes[key] = RealPlane(key, entries, exposures, halfway, accumulator.snapshot(), positions[key[0]])
    return RealField(grid=grid, planes=planes)


KEYS: list[Key] = [(1, 3), (1, 6), (3, 3), (3, 6)]
each_plane = pytest.mark.parametrize("key", KEYS, ids=[f"e{epoch}_d{detector}" for epoch, detector in KEYS])


def test_fixtures_give_four_planes_of_three_exposures(field: RealField) -> None:
    assert field.grid.shape == (195, 195) and field.grid.pixel_scale_arcsec == 3.075
    assert (field.grid.ra, field.grid.dec) == BARNARD
    assert sorted(field.planes) == KEYS
    assert all(len(plane.exposures) == 3 for plane in field.planes.values())


@each_plane
def test_plane_types_and_contract_values(field: RealField, key: Key) -> None:
    plane = field.planes[key].final
    shape = field.grid.shape
    assert plane.image.shape == plane.flags.shape == plane.coverage.shape == shape
    assert (plane.image.dtype, plane.flags.dtype, plane.coverage.dtype) == (np.float32, np.uint32, np.uint16)
    # Finito, NaN o +Infinity; nunca -Infinity (contrato, seccion 6).
    assert not np.isneginf(plane.image).any()
    assert np.isfinite(plane.image).any() and np.isnan(plane.image).any() and np.isposinf(plane.image).any()
    # La cobertura vale 0 exactamente donde el plano no tiene valor, y nunca supera las exposiciones usadas.
    assert np.array_equal(plane.coverage == 0, ~np.isfinite(plane.image))
    assert int(plane.coverage.max()) == 3


@each_plane
def test_barnard_core_is_saturated_where_the_star_is_expected(field: RealField, key: Key) -> None:
    real = field.planes[key]
    plane = real.final
    x, y = real.expected
    row, column = round(y), round(x)
    # La estrella esta a menos de 3 px del centro del campo: la grilla se centro en su posicion de 2026.
    assert math.hypot(x - 97.0, y - 97.0) < 3.0

    # El nucleo: +Infinity, sin ninguna medicion valida, con los flags de saturacion encendidos.
    core = (slice(row - 1, row + 2), slice(column - 1, column + 2))
    assert np.isposinf(plane.image[core]).all()
    assert not plane.coverage[core].any()
    table = real.exposures[0].flag_bits
    saturation = np.uint32(flag_mask(table, SATURATION_FLAGS))
    bloom, overflow = np.uint32(1 << table["BLOOM"]), np.uint32(1 << table["OVERFLOW"])
    assert ((plane.flags[core] & saturation) != 0).all()
    assert plane.flags[row, column] & bloom and plane.flags[row, column] & overflow

    # Una sola region saturada, centrada en la posicion esperada. Es mas grande en el detector 3
    # (1.6 a 2.4 micrones) que en el 6, como en la muestra de la Etapa 0.
    (region,) = saturated_regions(plane.image)
    assert region.n_pixels == int(np.isposinf(plane.image).sum()) >= 30
    assert math.hypot(region.x - x, region.y - y) < 1.0
    assert region.radius_px > (6.0 if key[1] == 3 else 3.0)

    # Todo pixel saturado tiene encendido un flag de saturacion (en estos datos, BLOOM en todos).
    saturated = np.isposinf(plane.image)
    assert ((plane.flags[saturated] & saturation) != 0).all()
    assert ((plane.flags[saturated] & bloom) != 0).all()


@each_plane
def test_the_rest_of_the_plane_has_data_and_a_background_near_zero(field: RealField, key: Key) -> None:
    real = field.planes[key]
    plane = real.final
    covered_by_all = np.all([exposure.footprint for exposure in real.exposures], axis=0)
    covered_by_any = np.any([exposure.footprint for exposure in real.exposures], axis=0)

    # Los recortes guardados miden 0.1 grados: cubren el centro del campo de 0.1667 y el marco queda sin datos.
    assert covered_by_all.mean() == pytest.approx((0.1 / 0.1667) ** 2, abs=0.02)
    assert covered_by_all[97 - 35 : 97 + 36, 97 - 35 : 97 + 36].all()
    outside = ~covered_by_any
    assert np.isnan(plane.image[outside]).all()
    assert not plane.flags[outside].any() and not plane.coverage[outside].any()

    # Donde cubren las tres, casi todo tiene valor: quedan el nucleo saturado y unas decenas de pixeles
    # que las tres exposiciones descartaron (el anillo alrededor del nucleo y algun pixel malo).
    finite = np.isfinite(plane.image)
    assert finite[covered_by_all].mean() > 0.97
    without_value = covered_by_all & ~finite
    assert 0 < int(np.isnan(plane.image[without_value]).sum()) < 80

    # Fondo cercano a cero: ya se resto ZODI y la mediana residual de cada recorte.
    stats = plane_stats(plane.image)
    assert stats is not None
    assert abs(stats.median) < 0.05 and abs(stats.median) < stats.sigma < 0.2
    backgrounds = [exposure.background for exposure in real.exposures]
    assert all(0.03 < background < 0.3 for background in backgrounds)
    assert abs(stats.median) < min(backgrounds)
    # Y hay estrellas: el campo de Barnard esta lleno.
    assert stats.max > 20.0 and stats.p997 > 5.0


def test_north_is_up_between_epochs(field: RealField) -> None:
    """Barnard se corre 10.25 segundos de arco al norte entre la primera y la ultima epoca.

    Es `y` creciente: la fila 0 es el sur. En `x` casi no se mueve (0.8
    segundos de arco al oeste, un cuarto de pixel).
    """
    for detector in (3, 6):
        first, last = field.planes[(1, detector)], field.planes[(3, detector)]
        (before,) = saturated_regions(first.final.image)
        (after,) = saturated_regions(last.final.image)
        expected_north = last.expected[1] - first.expected[1]
        assert expected_north * field.grid.pixel_scale_arcsec == pytest.approx(10.25, abs=0.2)
        assert after.y - before.y == pytest.approx(expected_north, abs=0.7)
        assert abs(after.x - before.x) < 0.7
        # El pixel saturado mas al norte y el mas al sur tambien suben.
        rows_before = np.nonzero(np.isposinf(first.final.image))[0]
        rows_after = np.nonzero(np.isposinf(last.final.image))[0]
        assert rows_after.min() > rows_before.min() and rows_after.max() > rows_before.max()


@each_plane
def test_east_is_left_and_stars_are_where_the_files_put_them(field: RealField, key: Key) -> None:
    """Columna 0 = este: una estrella del plano esta, en el cielo, donde la tienen los archivos.

    Se toma la mas brillante del plano lejos de Barnard, se pasa su pixel a
    cielo con la grilla y se la busca en cada recorte con el WCS del archivo.
    Con la imagen espejada o invertida, en esa posicion no habria nada.
    """
    real = field.planes[key]
    grid = field.grid
    image = real.final.image
    rows, columns = np.indices(image.shape)
    far = np.hypot(columns - 97, rows - 97) > 25
    row, column = np.unravel_index(int(np.argmax(np.where(np.isfinite(image) & far, image, -np.inf))), image.shape)
    peak = float(image[row, column])
    assert peak > 5.0  # decenas de veces el ruido del plano

    ra, dec = geometry.pixel_to_sky(grid, float(column), float(row))
    # Este a la izquierda y norte arriba.
    assert (column < 97) == (ra > grid.ra) and (row > 97) == (dec > grid.dec)

    seen = 0
    for entry, exposure in zip(real.entries, real.exposures, strict=True):
        with fits.open(CUTOUTS_DIR / entry["file"], memmap=False) as hdul:
            data = hdul["IMAGE"].data.astype(np.float64) - hdul["ZODI"].data.astype(np.float64)
            wcs = WCS(hdul["IMAGE"].header)
        x, y = (float(value) for value in wcs.all_world2pix(ra, dec, 0))
        xi, yi = round(x), round(y)
        assert 1 <= xi < data.shape[1] - 1 and 1 <= yi < data.shape[0] - 1
        window = data[yi - 1 : yi + 2, xi - 1 : xi + 2] - exposure.background
        if np.isfinite(window).any() and float(np.nanmax(window)) > 0.5 * peak:
            seen += 1
    assert seen == 3


@each_plane
def test_flags_layer_uses_only_declared_bits(field: RealField, key: Key) -> None:
    real = field.planes[key]
    infos = field_flags(real.exposures)
    declared = sum(1 << info.bit for info in infos)
    assert not (real.final.flags & ~np.uint32(declared)).any()
    # Flags por mayoria: un bit encendido en el plano lo tiene al menos la mitad de las exposiciones
    # que cubren el pixel (2 de las 3 en el centro del campo). Cada una vota con los bits que declara.
    covering = np.sum([exposure.footprint for exposure in real.exposures], axis=0)
    for info in infos:
        bit = np.uint32(1 << info.bit)
        votes = [(exposure.flags & bit) != 0 for exposure in real.exposures if info.name in exposure.flag_bits]
        count = np.sum(votes, axis=0)
        on = (real.final.flags & bit) != 0
        assert np.array_equal(on, (count > 0) & (2 * count >= covering)), info.name
    # SOURCE marca casi todo el campo (94 % del detector segun el encabezado) y no enmascara.
    source = np.uint32(1 << real.exposures[0].flag_bits["SOURCE"])
    marked = (real.final.flags & source) != 0
    assert marked.sum() > 0.5 * np.isfinite(real.final.image).sum()
    assert np.isfinite(real.final.image[marked]).mean() > 0.9


@each_plane
def test_provisional_snapshot_is_a_real_plane_with_less_coverage(field: RealField, key: Key) -> None:
    """La revision provisoria (contrato, seccion 8): con 2 de 3 exposiciones ya es una imagen valida."""
    real = field.planes[key]
    halfway, final = real.halfway, real.final
    assert int(halfway.coverage.max()) == 2 and int(final.coverage.max()) == 3
    assert (halfway.coverage <= final.coverage).all()
    assert np.array_equal(halfway.coverage == 0, ~np.isfinite(halfway.image))
    assert np.isfinite(final.image).sum() >= np.isfinite(halfway.image).sum()
    # El nucleo ya esta saturado en la provisoria, y el fondo ya es cercano a cero.
    x, y = real.expected
    assert np.isposinf(halfway.image[round(y), round(x)])
    stats = plane_stats(halfway.image)
    assert stats is not None and abs(stats.median) < 0.05
    # Es lo mismo que un acumulador nuevo con esas dos exposiciones.
    fresh = PlaneAccumulator(field.grid, 3)
    for exposure in real.exposures[:2]:
        fresh.add(exposure)
    again = fresh.snapshot()
    assert np.array_equal(again.image, halfway.image, equal_nan=True)
    assert np.array_equal(again.flags, halfway.flags) and np.array_equal(again.coverage, halfway.coverage)


@each_plane
def test_output_fits_the_stats_of_the_contract(field: RealField, key: Key) -> None:
    """`planes[].stats` y `planes[].saturated` salen directo del plano y entran en el modelo del contrato."""
    real = field.planes[key]
    image = real.final.image
    stats = plane_stats(image)
    regions = saturated_regions(image)
    assert stats is not None and len(regions) == 1
    total = image.size
    assert stats.valid_fraction == pytest.approx(np.isfinite(image).sum() / total, abs=1e-4)
    assert stats.saturated_fraction == pytest.approx(np.isposinf(image).sum() / total, abs=1e-4)
    assert stats.saturated_fraction > 0 and 0.3 < stats.valid_fraction < 0.4
    assert stats.min < stats.p01 < stats.median < stats.p99 < stats.p997 <= stats.max

    info = PlaneInfo(
        epoch=key[0],
        detector=key[1],
        status="ready",
        rev=2,
        n_exposures=3,
        n_used=3,
        mjd_mean=float(np.mean([entry["mjd"] for entry in real.entries])),
        stats=stats,
        saturated=regions,
    )
    # El documento se puede escribir como JSON: ningun NaN ni infinito se cuela en los metadatos.
    assert PlaneInfo.model_validate_json(info.model_dump_json()) == info


def test_detector_display_is_common_to_the_epochs(field: RealField) -> None:
    for detector in (3, 6):
        images = [field.planes[(epoch, detector)].final.image for epoch in (1, 3)]
        display = detector_display(images)
        assert display is not None and display.vmin < display.median < display.vmax
        assert display.vmin == pytest.approx(display.median - 2.0 * display.sigma, rel=1e-4)
        info = DetectorInfo(detector=detector, wave_min_um=1.0, wave_max_um=2.0, display=display)
        assert DetectorInfo.model_validate_json(info.model_dump_json()) == info


def test_planes_go_through_the_field_store(field: RealField, tmp_path: Path) -> None:
    """`FieldStore.write_plane` y `write_aux` guardan el plano tal cual, con la disposicion binaria del contrato."""
    grid = field.grid
    request = geometry.normalize_request(*BARNARD, pipeline="prueba")
    store = FieldStore(tmp_path)
    meta = FieldMeta(
        id=request.field_id,
        pipeline=request.pipeline,
        status="downloading",
        request=FieldRequestInfo(ra=request.ra, dec=request.dec, fov=request.fov),
        grid=geometry.grid_info(grid),
        flags=field_flags(exposure for plane in field.planes.values() for exposure in plane.exposures),
        progress=Progress(phase="downloading"),
        preview=PreviewInfo(status="pending", band="W1", wave_um=3.4, hips="prueba"),
    )
    store.write_meta(meta)
    assert store.read_meta(request.field_id).flags == meta.flags and len(meta.flags or []) == 22

    for (epoch, detector), real in field.planes.items():
        for plane in (real.halfway, real.final):  # la definitiva reemplaza a la provisoria
            path = store.write_plane(request.field_id, epoch, detector, plane.image, shape=grid.shape)
            store.write_aux(request.field_id, epoch, detector, plane.flags, plane.coverage, shape=grid.shape)
        final = real.final
        assert path.name == plane_filename(epoch, detector)
        assert path.stat().st_size == plane_nbytes(grid.shape) == 4 * 195 * 195

        # Lo que se lee es lo que se guardo, bit a bit, con NaN e infinito incluidos.
        stored = store.read_plane(request.field_id, epoch, detector)
        assert stored.dtype == np.float32 and stored.tobytes() == final.image.tobytes()
        flags, coverage = store.read_aux(request.field_id, epoch, detector)
        assert np.array_equal(flags, final.flags) and np.array_equal(coverage, final.coverage)

        # Disposicion binaria (contrato, seccion 6): little-endian, fila 0 = sur primero.
        raw = np.frombuffer(path.read_bytes(), dtype="<f4").reshape(grid.shape)
        x, y = real.expected
        assert np.isposinf(raw[round(y), round(x)])
        aux = gzip.decompress(store.read_aux_gzip(request.field_id, epoch, detector))
        assert len(aux) == 6 * 195 * 195
        raw_flags, raw_coverage = split_aux(aux, grid.shape)
        assert np.array_equal(raw_flags, final.flags) and np.array_equal(raw_coverage, final.coverage)


def test_epochs_of_the_fixture_exposures(field: RealField) -> None:
    """Las 12 exposiciones guardadas forman dos pasadas: la 1 y la 3 del campo completo."""
    entries = [entry for plane in field.planes.values() for entry in plane.entries]
    exposures = [
        Exposure(
            obs_id=entry["obs_id"],
            collection=entry["collection"],
            detector=entry["detector"],
            mjd_start=entry["mjd"],
            mjd_end=entry["mjd_end"],
            url=entry["url"],
            wave_min_um=entry["wave_min_um"],
            wave_max_um=entry["wave_max_um"],
        )
        for entry in entries
    ]
    result = assign_epochs(exposures)
    assert [epoch.n_exposures for epoch in result.epochs] == [6, 6]
    # Sin la epoca 2 en el medio, la que el indice llama 3 es la segunda.
    assert result.indices == [1 if entry["epoch"] == 1 else 2 for entry in entries]
    assert result.epochs[1].mjd_start - result.epochs[0].mjd_end > 60.0
