"""`load_exposure`: de un recorte en disco a una exposicion en la grilla del campo.

Dos grupos de tests, los dos sin red:
- Con los 12 recortes reales de Barnard (tests/fixtures/cutouts): el resultado
  es el del metodo del spike (`reproject_interp`), la orientacion es la de las
  estrellas del campo y la carga es segura entre hilos.
- Con recortes sinteticos escritos en una carpeta temporal: cada regla de
  limpieza, las tablas de bits distintas y los archivos que no se pueden leer.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from functools import cache
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from numpy.typing import NDArray
from reproject import reproject_interp

from app import geometry
from app.domain import Grid, ReprojectedExposure
from app.pipeline.exposure import (
    MASKED_FLAGS,
    MIN_SKY_PIXELS,
    REQUIRED_EXTENSIONS,
    SATURATION_FLAGS,
    flag_mask,
    load_exposure,
    read_flag_table,
    wcs_cards,
)

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
CUTOUTS_DIR = FIXTURES_DIR / "cutouts"
CUTOUT_INDEX: dict[str, Any] = json.loads((CUTOUTS_DIR / "index.json").read_text(encoding="utf-8"))
CUTOUT_FILES: list[str] = [entry["file"] for entry in CUTOUT_INDEX["cutouts"]]
CUTOUT_EPOCH: dict[str, int] = {entry["file"]: entry["epoch"] for entry in CUTOUT_INDEX["cutouts"]}

# Barnard en la epoca 2026.0: el centro que da /api/resolve y con el que se pide el campo.
BARNARD = (269.4463, 4.7683)

# Tabla de bits de un nivel 2 de SPHEREx, copiada del encabezado de FLAGS de los recortes reales
# (`test_real_flag_table_is_read_by_name` la compara con ellos). SATELLITE_HALO, bit 29, solo
# aparece en algunos archivos y SNOWBALL falta en otros (contrato, seccion 9).
REAL_BITS: dict[str, int] = {
    "TRANSIENT": 0, "OVERFLOW": 1, "SUR_ERROR": 2, "NONFUNC": 6, "DICHROIC": 7, "MISSING_DATA": 9, "HOT": 10,
    "COLD": 11, "FULLSAMPLE": 12, "PHANMISS": 14, "NONLINEAR": 15, "PERSIST": 17, "OUTLIER": 19, "CROSSTALK": 20,
    "SOURCE": 21, "GHOST": 22, "GHOST_FPA": 23, "GHOST_EXT": 24, "STREAK": 25, "BLOOM": 26, "SNOWBALL": 27,
    "HALO": 28,
}  # fmt: skip
SATELLITE_HALO_BIT = 29

each_cutout = pytest.mark.parametrize("filename", CUTOUT_FILES, ids=[name[7:27] for name in CUTOUT_FILES])


@cache
def barnard_grid(step: str = "base") -> Grid:
    """Grilla del campo de Barnard tal como la arma el backend: centrada en el pedido normalizado."""
    fov = {"base": 0.1667, "wide": 0.5}[step]
    return geometry.build_grid(geometry.normalize_request(*BARNARD, fov))


@cache
def real_exposure(filename: str) -> ReprojectedExposure:
    return load_exposure(CUTOUTS_DIR / filename, barnard_grid())


@cache
def barnard_core(epoch: int) -> tuple[int, int]:
    """Pixel `(fila, columna)` de la grilla donde se espera a Barnard en esa epoca, segun la muestra guardada."""
    samples = json.loads((FIXTURES_DIR / "fields" / "index.json").read_text(encoding="utf-8"))["samples"]
    (sample,) = (item for item in samples if item["label"] == "barnard")
    track = json.loads((FIXTURES_DIR / "fields" / sample["id"] / sample["track_file"]).read_text(encoding="utf-8"))
    (position,) = (item for item in track["positions"] if item["epoch"] == epoch)
    x, y = geometry.sky_to_pixel(barnard_grid(), position["ra"], position["dec"])
    return round(y), round(x)


def bit(name: str, table: dict[str, int] = REAL_BITS) -> int:
    return 1 << table[name]


def same_arrays(a: ReprojectedExposure, b: ReprojectedExposure) -> bool:
    return (
        np.array_equal(a.image, b.image, equal_nan=True)
        and np.array_equal(a.variance, b.variance, equal_nan=True)
        and np.array_equal(a.flags, b.flags)
        and np.array_equal(a.footprint, b.footprint)
        and a.flag_bits == b.flag_bits
        and a.flag_descriptions == b.flag_descriptions
        and a.background == b.background
    )


# ------------------------------------------------------------- recortes reales


def spike_reference(path: Path, grid: Grid) -> tuple[NDArray[np.float64], NDArray[np.float64], float, NDArray[Any]]:
    """`load_and_reproject` de spike/field.py, mas los flags por vecino mas cercano pasando por float64.

    Es el metodo ya probado con datos reales: `reproject_interp` sobre la
    imagen y la varianza limpias. Devuelve (imagen, varianza, fondo, flags).
    """
    with fits.open(path, memmap=False) as hdul:
        header = hdul["IMAGE"].header
        image = hdul["IMAGE"].data.astype(np.float64)
        zodi = hdul["ZODI"].data.astype(np.float64)
        variance = hdul["VARIANCE"].data.astype(np.float64)
        flags = hdul["FLAGS"].data.astype(np.int64)
        flag_header = hdul["FLAGS"].header
        bits = {str(flag_header[key]): int(key[4:]) for key in flag_header["MSKN*"]}
    bad_bits = 0
    for name in MASKED_FLAGS:
        if name in bits:
            bad_bits |= 1 << bits[name]
    data = image - zodi
    bad = ((flags & bad_bits) != 0) | ~np.isfinite(data) | ~np.isfinite(variance) | (variance <= 0)
    background = 0.0
    sky = ~bad
    if "SOURCE" in bits:
        no_source = sky & (((flags >> bits["SOURCE"]) & 1) == 0)
        if no_source.sum() >= 50:
            sky = no_source
    if sky.any():
        background = float(np.median(data[sky]))
        data = data - background
    data[bad] = np.nan
    variance[bad] = np.nan
    wcs = WCS(header)
    out_wcs = grid.wcs.deepcopy()
    stacked = reproject_interp(
        (np.stack([data, variance]), wcs), out_wcs, shape_out=grid.shape, order="bilinear", return_footprint=False
    )
    nearest = reproject_interp(
        (flags.astype(np.float64), wcs), out_wcs, shape_out=grid.shape, order="nearest-neighbor", return_footprint=False
    )
    return stacked[0], stacked[1], background, nearest


@each_cutout
def test_real_cutout_gives_the_same_as_the_spike(filename: str) -> None:
    """Misma ciencia que el spike: imagen, varianza y fondo coinciden con `reproject_interp`."""
    grid = barnard_grid()
    exposure = real_exposure(filename)
    image, variance, background, nearest = spike_reference(CUTOUTS_DIR / filename, grid)

    assert exposure.background == pytest.approx(background, rel=1e-12)
    # Los mismos pixeles descartados, y los mismos valores salvo el paso a Float32.
    assert np.array_equal(np.isnan(exposure.image), np.isnan(image))
    assert np.array_equal(np.isnan(exposure.variance), np.isnan(variance))
    valid = np.isfinite(image)
    np.testing.assert_allclose(exposure.image[valid], image[valid], rtol=1e-6, atol=1e-7)
    np.testing.assert_allclose(exposure.variance[valid], variance[valid], rtol=1e-6, atol=0.0)

    # La huella es donde `reproject` encuentra un pixel del recorte, y ahi los flags son los del
    # vecino mas cercano. En float64 un entero de 32 bits es exacto, asi que sirve de referencia.
    assert np.array_equal(exposure.footprint, ~np.isnan(nearest))
    assert np.array_equal(exposure.flags[exposure.footprint], nearest[exposure.footprint].astype(np.uint32))


@pytest.mark.parametrize("filename", [CUTOUT_FILES[0], CUTOUT_FILES[9]], ids=["epoca1_d3", "epoca3_d6"])
def test_real_cutout_on_the_wide_grid_gives_the_same_as_the_spike(filename: str) -> None:
    """Escalon amplio: 293 x 293 px a la escala nativa. El recorte de 0.1 grados cubre solo el centro."""
    grid = barnard_grid("wide")
    assert grid.shape == (293, 293) and grid.pixel_scale_arcsec == 6.15
    exposure = load_exposure(CUTOUTS_DIR / filename, grid)
    image, variance, _, nearest = spike_reference(CUTOUTS_DIR / filename, grid)
    assert np.array_equal(np.isnan(exposure.image), np.isnan(image))
    valid = np.isfinite(image)
    np.testing.assert_allclose(exposure.image[valid], image[valid], rtol=1e-6, atol=1e-7)
    np.testing.assert_allclose(exposure.variance[valid], variance[valid], rtol=1e-6, atol=0.0)
    assert np.array_equal(exposure.footprint, ~np.isnan(nearest))
    assert np.array_equal(exposure.flags[exposure.footprint], nearest[exposure.footprint].astype(np.uint32))
    # 0.1 grados sobre 0.5: el 4 % del campo, alrededor del centro.
    assert exposure.footprint.mean() == pytest.approx((0.1 / 0.5) ** 2, abs=0.006)
    assert exposure.footprint[146, 146] and not exposure.footprint[0, 0]


@each_cutout
def test_real_cutout_types_shapes_and_invariants(filename: str) -> None:
    grid = barnard_grid()
    exposure = real_exposure(filename)
    assert grid.shape == (195, 195)
    for array, dtype in (
        (exposure.image, np.float32),
        (exposure.variance, np.float32),
        (exposure.flags, np.uint32),
        (exposure.footprint, np.bool_),
    ):
        assert array.shape == grid.shape and array.dtype == dtype

    # Imagen y varianza se descartan juntas, y una varianza valida es positiva.
    finite = np.isfinite(exposure.image)
    assert np.array_equal(finite, np.isfinite(exposure.variance))
    assert (exposure.variance[finite] > 0).all()
    assert not np.isinf(exposure.image).any() and not np.isinf(exposure.variance).any()

    # Fuera de la huella no hay nada. El recorte de 0.1 grados cubre el centro del campo de 0.1667.
    outside = ~exposure.footprint
    assert np.isnan(exposure.image[outside]).all() and not exposure.flags[outside].any()
    assert exposure.footprint.mean() == pytest.approx((0.1 / 0.1667) ** 2, abs=0.01)
    assert exposure.footprint[97, 97] and exposure.footprint[97 - 35 : 97 + 36, 97 - 35 : 97 + 36].all()
    assert not exposure.footprint[[0, 0, -1, -1], [0, -1, 0, -1]].any()

    # La huella no depende de la mascara: adentro hay pixeles descartados (el nucleo de Barnard entre ellos).
    assert finite.sum() < exposure.footprint.sum()
    assert finite[exposure.footprint].mean() > 0.9
    core = barnard_core(CUTOUT_EPOCH[filename])
    assert exposure.footprint[core] and not finite[core]

    # El fondo residual que queda despues de restar ZODI es chico (spike/RESULTADOS.md: decimas de MJy/sr).
    assert 0.0 < exposure.background < 0.3
    assert abs(float(np.median(exposure.image[finite]))) < 0.1


@each_cutout
def test_real_flag_table_is_read_by_name(filename: str) -> None:
    exposure = real_exposure(filename)
    with fits.open(CUTOUTS_DIR / filename, memmap=False) as hdul:
        header = hdul["FLAGS"].header
        declared = {str(header[key]).strip(): int(key[4:]) for key in header["MSKN*"]}
        described = {str(header[f"MSKN{key[4:]}"]).strip(): str(header[key]).strip() for key in header["MSKD*"]}
    assert exposure.flag_bits == declared
    assert exposure.flag_descriptions == described
    assert set(exposure.flag_descriptions) == set(exposure.flag_bits)
    assert exposure.flag_descriptions["OVERFLOW"] == "Overflow detected during SUR"

    # El numero de bit de cada nombre es el mismo en todos los archivos; lo que cambia es cuales declaran.
    assert exposure.flag_bits.items() <= REAL_BITS.items()
    assert set(REAL_BITS) - set(exposure.flag_bits) <= {"SNOWBALL"}
    assert set(SATURATION_FLAGS) <= set(exposure.flag_bits)


def test_real_cutouts_have_two_different_flag_tables() -> None:
    """De los 12 recortes, uno no declara SNOWBALL. Se carga igual, con su propia tabla."""
    without = [name for name in CUTOUT_FILES if "SNOWBALL" not in real_exposure(name).flag_bits]
    assert len(without) == 1
    exposure = real_exposure(without[0])
    assert len(exposure.flag_bits) == len(REAL_BITS) - 1 == 21
    assert np.isfinite(exposure.image).any()
    assert all(real_exposure(name).flag_bits == REAL_BITS for name in CUTOUT_FILES if name != without[0])


@each_cutout
def test_real_masked_pixels_are_discarded_by_name(filename: str) -> None:
    exposure = real_exposure(filename)
    masked = (exposure.flags & np.uint32(flag_mask(exposure.flag_bits, MASKED_FLAGS))) != 0
    # Un pixel cuyo vecino mas cercano esta enmascarado no tiene valor.
    assert masked.any() and np.isnan(exposure.image[masked]).all() and np.isnan(exposure.variance[masked]).all()
    # SOURCE no enmascara: casi todo el campo es de fuentes conocidas y tiene valor.
    source = (exposure.flags & np.uint32(bit("SOURCE"))) != 0
    assert np.isfinite(exposure.image[source & ~masked]).mean() > 0.9
    # El nucleo de Barnard esta saturado en todas las exposiciones: BLOOM y sin valor.
    core = barnard_core(CUTOUT_EPOCH[filename])
    assert exposure.flags[core] & np.uint32(bit("BLOOM")) and np.isnan(exposure.image[core])


@each_cutout
def test_real_stars_fall_where_the_wcs_says(filename: str) -> None:
    """Norte arriba y este a la izquierda: fila 0 = sur, columna 0 = este.

    Se toma la estrella mas brillante del recorte lejos del centro (lejos de
    Barnard), se calcula su posicion en el cielo con el WCS del archivo y se la
    busca en la exposicion reproyectada. Tiene que estar ahi, y no en la
    posicion que le tocaria con la imagen espejada, invertida o traspuesta.
    """
    grid = barnard_grid()
    exposure = real_exposure(filename)
    with fits.open(CUTOUTS_DIR / filename, memmap=False) as hdul:
        data = hdul["IMAGE"].data.astype(np.float64) - hdul["ZODI"].data.astype(np.float64)
        variance = hdul["VARIANCE"].data.astype(np.float64)
        flags = hdul["FLAGS"].data.astype(np.int64)
        wcs = WCS(hdul["IMAGE"].header)
    bad = ((flags & flag_mask(exposure.flag_bits, MASKED_FLAGS)) != 0) | ~np.isfinite(data) | ~(variance > 0)
    ny, nx = data.shape
    star: tuple[float, int, int] | None = None
    for row in range(1, ny - 1):
        for column in range(1, nx - 1):
            block = data[row - 1 : row + 2, column - 1 : column + 2]
            if bad[row - 1 : row + 2, column - 1 : column + 2].any() or data[row, column] < block.max():
                continue
            if math.hypot(column - (nx - 1) / 2, row - (ny - 1) / 2) < 12:
                continue
            if star is None or data[row, column] > star[0]:
                star = (float(data[row, column]), column, row)
    assert star is not None
    peak, column, row = star
    peak -= exposure.background
    assert peak > 5.0  # muy por encima del ruido, que es de decimas de MJy/sr

    ra, dec = (float(value) for value in wcs.all_pix2world(column, row, 0))
    x, y = geometry.sky_to_pixel(grid, ra, dec)
    xi, yi = round(x), round(y)
    assert math.hypot(xi - 97, yi - 97) > 25

    # La grilla tiene el este a la izquierda y el norte arriba.
    assert (x < 97) == (ra > grid.ra) and (y > 97) == (dec > grid.dec)

    def brightest(center_y: int, center_x: int) -> float:
        window = exposure.image[center_y - 2 : center_y + 3, center_x - 2 : center_x + 3]
        return float(np.nanmax(window)) if np.isfinite(window).any() else 0.0

    # La estrella esta donde dice el WCS: la interpolacion la aplana un poco, no la mueve.
    assert 0.6 * peak < brightest(yi, xi) <= peak * (1 + 1e-6)
    last = grid.shape[0] - 1
    for label, (other_y, other_x) in {
        "espejada este-oeste": (yi, last - xi),
        "invertida norte-sur": (last - yi, xi),
        "traspuesta": (xi, yi),
    }.items():
        assert brightest(other_y, other_x) < 0.2 * peak, label


def test_load_exposure_from_many_threads_matches_serial() -> None:
    """Varios hilos a la vez con el mismo `Grid` dan lo mismo que la corrida en serie."""
    grid = barnard_grid()
    paths = [CUTOUTS_DIR / name for name in CUTOUT_FILES]
    serial = [load_exposure(path, grid) for path in paths]
    jobs = paths * 4
    with ThreadPoolExecutor(max_workers=8) as pool:
        threaded = list(pool.map(lambda path: load_exposure(path, grid), jobs))
    assert len(threaded) == len(jobs)
    for index, exposure in enumerate(threaded):
        assert same_arrays(exposure, serial[index % len(paths)]), jobs[index].name
    # La grilla compartida sigue sirviendo y dice lo mismo que antes.
    assert geometry.sky_to_pixel(grid, grid.ra, grid.dec) == pytest.approx((97.0, 97.0), abs=1e-6)
    again = load_exposure(paths[0], grid)
    assert same_arrays(again, serial[0])


def test_load_exposure_does_not_keep_references_between_calls() -> None:
    """Cada llamada entrega arreglos propios: modificar un resultado no cambia el siguiente."""
    grid = barnard_grid()
    path = CUTOUTS_DIR / CUTOUT_FILES[0]
    first = load_exposure(path, grid)
    reference = load_exposure(path, grid)
    first.image[:] = 0.0
    first.flags[:] = 0
    first.flag_bits.clear()
    assert same_arrays(load_exposure(str(path), grid), reference)  # tambien acepta la ruta como texto


def test_real_cutout_that_does_not_reach_the_grid() -> None:
    """Un recorte que no toca el campo no es un error: queda con la huella vacia."""
    grid = geometry.make_grid(BARNARD[0] + 2.0, BARNARD[1], 0.1667, 3.075)
    exposure = load_exposure(CUTOUTS_DIR / CUTOUT_FILES[0], grid)
    assert not exposure.footprint.any() and not exposure.flags.any()
    assert np.isnan(exposure.image).all() and np.isnan(exposure.variance).all()
    assert exposure.flag_bits == REAL_BITS and exposure.background > 0


@pytest.mark.filterwarnings("ignore")
def test_real_cutout_on_another_part_of_the_sky_is_empty_or_rejected() -> None:
    """A 30 grados la inversion de la distorsion SIP puede no converger: huella vacia o `ValueError`, nunca basura."""
    grid = geometry.make_grid(BARNARD[0] + 30.0, BARNARD[1] + 10.0, 0.5, 6.15)
    for name in CUTOUT_FILES[:4]:
        try:
            exposure = load_exposure(CUTOUTS_DIR / name, grid)
        except ValueError as error:
            assert "no converge" in str(error) and name in str(error)
        else:
            assert not exposure.footprint.any() and np.isnan(exposure.image).all()


# ---------------------------------------------------------- recortes sinteticos

SMALL_CENTER = (150.0, 2.0)
CUTOUT_SIZE = 40


@cache
def small_grid() -> Grid:
    """Grilla de 23 x 23 px a 3.075 segundos de arco por pixel, como el escalon base pero chica."""
    return geometry.make_grid(*SMALL_CENTER, 0.02, 3.075)


def tan_header(
    shape: tuple[int, int] = (CUTOUT_SIZE, CUTOUT_SIZE),
    *,
    center: tuple[float, float] = SMALL_CENTER,
    rotation_deg: float = 30.0,
    scale_arcsec: float = 6.15,
) -> fits.Header:
    """Encabezado WCS de un recorte: TAN a la escala nativa, girado, con `center` en el medio del arreglo."""
    ny, nx = shape
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = list(center)
    wcs.wcs.crpix = [(nx + 1) / 2.0, (ny + 1) / 2.0]
    wcs.wcs.cdelt = [-scale_arcsec / 3600.0, scale_arcsec / 3600.0]
    angle = math.radians(rotation_deg)
    wcs.wcs.pc = [[math.cos(angle), -math.sin(angle)], [math.sin(angle), math.cos(angle)]]
    wcs.wcs.cunit = ["deg", "deg"]
    header = wcs.to_header()
    header["RADESYS"] = "ICRS"
    return header


def write_cutout(
    path: Path,
    image: NDArray[Any],
    *,
    flags: NDArray[Any] | None = None,
    variance: NDArray[Any] | None = None,
    zodi: NDArray[Any] | None = None,
    header: fits.Header | None = None,
    bits: dict[str, int] | None = None,
    skip: tuple[str, ...] = (),
    order: tuple[str, ...] = REQUIRED_EXTENSIONS,
) -> Path:
    """Escribe un recorte con las extensiones de un nivel 2 de SPHEREx y la tabla de bits en FLAGS."""
    shape = image.shape
    header = tan_header(shape) if header is None else header
    arrays: dict[str, NDArray[Any]] = {
        "IMAGE": image.astype(np.float32),
        "FLAGS": np.zeros(shape, dtype=np.int32) if flags is None else flags,
        "VARIANCE": (np.full(shape, 0.01) if variance is None else variance).astype(np.float32),
        "ZODI": (np.zeros(shape) if zodi is None else zodi).astype(np.float32),
    }
    flag_header = header.copy()
    for name, number in (REAL_BITS if bits is None else bits).items():
        flag_header[f"MSKN{number:04d}"] = (name, f"Name for mask plane {number}")
        flag_header[f"MSKD{number:04d}"] = f"Descripcion de {name}"
    hdus: list[Any] = [fits.PrimaryHDU()]
    for name in order:
        if name not in skip:
            hdus.append(fits.ImageHDU(arrays[name], header=flag_header if name == "FLAGS" else header, name=name))
    fits.HDUList(hdus).writeto(path, overwrite=True)
    return path


def cutout_coords(grid: Grid, header: fits.Header) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Posicion `(x, y)` en pixeles del recorte del centro de cada pixel de la grilla, con astropy."""
    rows, columns = np.indices(grid.shape, dtype=np.float64)
    ra, dec = grid.wcs.deepcopy().all_pix2world(columns, rows, 0)
    x, y = WCS(header).all_world2pix(ra, dec, 0)
    return np.asarray(x), np.asarray(y)


def touched_by(x: NDArray[np.float64], y: NDArray[np.float64], column: int, row: int) -> NDArray[np.bool_]:
    """Pixeles de la grilla que usan el pixel `(column, row)` del recorte en la interpolacion bilineal."""
    return (np.abs(x - column) < 1.0) & (np.abs(y - row) < 1.0)


def nearest_to(x: NDArray[np.float64], y: NDArray[np.float64], column: int, row: int) -> NDArray[np.bool_]:
    """Pixeles de la grilla cuyo vecino mas cercano en el recorte es `(column, row)`."""
    return (np.floor(x + 0.5) == column) & (np.floor(y + 0.5) == row)


def ramp(shape: tuple[int, int] = (CUTOUT_SIZE, CUTOUT_SIZE)) -> NDArray[np.float64]:
    """Imagen lineal en x e y: la interpolacion bilineal la reproduce exacta."""
    rows, columns = np.indices(shape, dtype=np.float64)
    return 0.25 * columns - 0.125 * rows + 3.0


def ramp_at(x: NDArray[np.float64], y: NDArray[np.float64]) -> NDArray[np.float64]:
    return 0.25 * x - 0.125 * y + 3.0


def test_synthetic_cutout_covers_the_small_grid() -> None:
    grid = small_grid()
    x, y = cutout_coords(grid, tan_header())
    assert grid.shape == (23, 23)
    # El centro de la grilla cae en el centro del recorte y toda la grilla queda adentro, lejos del borde.
    assert (x[11, 11], y[11, 11]) == pytest.approx((19.5, 19.5), abs=1e-6)
    assert x.min() > 10 and x.max() < 30 and y.min() > 10 and y.max() < 30


def test_zodi_and_residual_background_are_subtracted(tmp_path: Path) -> None:
    grid = small_grid()
    zodi = np.full((CUTOUT_SIZE, CUTOUT_SIZE), 7.0)
    variance = np.full((CUTOUT_SIZE, CUTOUT_SIZE), 0.04)
    path = write_cutout(tmp_path / "rampa.fits", ramp() + zodi, zodi=zodi, variance=variance)
    exposure = load_exposure(path, grid)

    # El fondo residual es la mediana de IMAGE - ZODI sobre todo el recorte.
    background = float(np.median(ramp()))
    assert exposure.background == pytest.approx(background, abs=1e-5)
    x, y = cutout_coords(grid, tan_header())
    np.testing.assert_allclose(exposure.image, ramp_at(x, y) - background, atol=2e-5)
    np.testing.assert_allclose(exposure.variance, 0.04, rtol=1e-6)
    assert exposure.footprint.all() and not exposure.flags.any()
    assert exposure.flag_bits == REAL_BITS
    assert exposure.flag_descriptions["BLOOM"] == "Descripcion de BLOOM"


def test_extensions_are_found_by_name_not_by_position(tmp_path: Path) -> None:
    grid = small_grid()
    image = ramp()
    flags = np.zeros(image.shape, dtype=np.int32)
    flags[20, 20] = bit("HOT")
    usual = write_cutout(tmp_path / "orden.fits", image, flags=flags)
    shuffled = write_cutout(
        tmp_path / "otro_orden.fits", image, flags=flags, order=("ZODI", "VARIANCE", "FLAGS", "IMAGE")
    )
    with fits.open(shuffled) as hdul:
        assert [hdu.name for hdu in hdul] == ["PRIMARY", "ZODI", "VARIANCE", "FLAGS", "IMAGE"]
    assert same_arrays(load_exposure(shuffled, grid), load_exposure(usual, grid))


def test_background_leaves_out_known_sources(tmp_path: Path) -> None:
    grid = small_grid()
    rng = np.random.default_rng(3)
    image = rng.normal(2.0, 0.01, (CUTOUT_SIZE, CUTOUT_SIZE))
    flags = np.zeros(image.shape, dtype=np.int32)
    # Tres cuartos del recorte son de fuentes conocidas y brillan mas: no entran en la mediana.
    image[:30, :] += 5.0
    flags[:30, :] = bit("SOURCE")
    exposure = load_exposure(write_cutout(tmp_path / "fuentes.fits", image, flags=flags), grid)
    assert exposure.background == pytest.approx(2.0, abs=0.005)
    # SOURCE no enmascara: esos pixeles tienen valor, y queda el exceso de 5.
    _, y = cutout_coords(grid, tan_header())
    inside_source = y < 28.0
    assert inside_source.sum() > 400
    assert np.isfinite(exposure.image).all()
    assert float(np.median(exposure.image[inside_source])) == pytest.approx(5.0, abs=0.01)


def test_background_uses_every_valid_pixel_if_too_few_are_free_of_sources(tmp_path: Path) -> None:
    grid = small_grid()
    image = np.full((CUTOUT_SIZE, CUTOUT_SIZE), 6.0)
    flags = np.full(image.shape, bit("SOURCE"), dtype=np.int32)
    # Quedan 49 pixeles sin fuente, uno menos que el minimo: la mediana sale de todos los validos.
    assert MIN_SKY_PIXELS == 50
    image.flat[:49] = 1.0
    flags.flat[:49] = 0
    assert int((flags == 0).sum()) == 49
    few = load_exposure(write_cutout(tmp_path / "pocos.fits", image, flags=flags), grid)
    assert few.background == pytest.approx(6.0)
    # Con 50 ya alcanza.
    image.flat[49] = 1.0
    flags.flat[49] = 0
    enough = load_exposure(write_cutout(tmp_path / "suficientes.fits", image, flags=flags), grid)
    assert enough.background == pytest.approx(1.0)


@pytest.mark.parametrize("name", MASKED_FLAGS)
def test_each_masked_flag_discards_the_pixel(tmp_path: Path, name: str) -> None:
    grid = small_grid()
    table = {**REAL_BITS, "SATELLITE_HALO": SATELLITE_HALO_BIT}
    flags = np.zeros((CUTOUT_SIZE, CUTOUT_SIZE), dtype=np.int32)
    flags[21, 18] = 1 << table[name]
    exposure = load_exposure(write_cutout(tmp_path / "flag.fits", ramp(), flags=flags, bits=table), grid)
    x, y = cutout_coords(grid, tan_header())
    lost = touched_by(x, y, 18, 21)
    # Se pierde el pixel y los de la grilla que lo usan al interpolar; el resto queda.
    assert lost.any() and np.array_equal(np.isnan(exposure.image), lost)
    assert np.array_equal(np.isnan(exposure.variance), lost)
    marked = exposure.flags == np.uint32(1 << table[name])
    assert np.array_equal(marked, nearest_to(x, y, 18, 21)) and marked.any()
    assert not exposure.flags[~marked].any()
    assert exposure.footprint.all()


@pytest.mark.parametrize("name", ["SOURCE", "OUTLIER", "FULLSAMPLE", "PHANMISS"])
def test_flags_that_are_not_masked_keep_the_pixel(tmp_path: Path, name: str) -> None:
    grid = small_grid()
    assert name not in MASKED_FLAGS
    flags = np.zeros((CUTOUT_SIZE, CUTOUT_SIZE), dtype=np.int32)
    flags[21, 18] = bit(name)
    exposure = load_exposure(write_cutout(tmp_path / "flag.fits", ramp(), flags=flags), grid)
    assert np.isfinite(exposure.image).all()
    assert (exposure.flags == np.uint32(bit(name))).any()


def test_file_without_snowball_does_not_mask_bit_27(tmp_path: Path) -> None:
    """La mascara sale de la tabla de cada archivo: si no declara SNOWBALL, el bit 27 no es SNOWBALL."""
    grid = small_grid()
    flags = np.zeros((CUTOUT_SIZE, CUTOUT_SIZE), dtype=np.int32)
    flags[21, 18] = 1 << 27
    without = {name: number for name, number in REAL_BITS.items() if name != "SNOWBALL"}
    exposure = load_exposure(write_cutout(tmp_path / "sin.fits", ramp(), flags=flags, bits=without), grid)
    assert "SNOWBALL" not in exposure.flag_bits and len(exposure.flag_bits) == 21
    assert np.isfinite(exposure.image).all()
    # El bit sigue estando en los flags: se conservan todos, declarados o no.
    assert (exposure.flags == np.uint32(1 << 27)).any()

    declared = load_exposure(write_cutout(tmp_path / "con.fits", ramp(), flags=flags), grid)
    assert declared.flag_bits["SNOWBALL"] == 27
    assert np.isnan(declared.image).any()


def test_file_with_satellite_halo_keeps_bit_29_exact(tmp_path: Path) -> None:
    """El bit 29 junto con uno bajo no entra exacto en Float32: los flags no pueden pasar por ahi."""
    grid = small_grid()
    value = (1 << SATELLITE_HALO_BIT) | bit("SOURCE") | bit("SUR_ERROR")
    assert int(np.float32(value)) != value
    flags = np.zeros((CUTOUT_SIZE, CUTOUT_SIZE), dtype=np.int32)
    flags[21, 18] = value
    flags[15, 24] = 1 << SATELLITE_HALO_BIT
    table = {**REAL_BITS, "SATELLITE_HALO": SATELLITE_HALO_BIT}
    exposure = load_exposure(write_cutout(tmp_path / "halo.fits", ramp(), flags=flags, bits=table), grid)
    assert exposure.flag_bits["SATELLITE_HALO"] == SATELLITE_HALO_BIT and len(exposure.flag_bits) == 23

    x, y = cutout_coords(grid, tan_header())
    first, second = nearest_to(x, y, 18, 21), nearest_to(x, y, 24, 15)
    assert first.any() and second.any()
    assert (exposure.flags[first] == np.uint32(value)).all()
    assert (exposure.flags[second] == np.uint32(1 << SATELLITE_HALO_BIT)).all()
    assert not exposure.flags[~(first | second)].any()
    # SATELLITE_HALO enmascara por si solo, en los archivos que lo declaran.
    assert np.array_equal(np.isnan(exposure.image), touched_by(x, y, 18, 21) | touched_by(x, y, 24, 15))

    # El mismo bit en un archivo que no lo declara no enmascara, y el valor se conserva igual.
    flags[21, 18] = 0
    plain = load_exposure(write_cutout(tmp_path / "sin_halo.fits", ramp(), flags=flags), grid)
    assert "SATELLITE_HALO" not in plain.flag_bits
    assert np.isfinite(plain.image).all()
    assert (plain.flags[second] == np.uint32(1 << SATELLITE_HALO_BIT)).all()


@pytest.mark.parametrize("unsigned", [False, True], ids=["int32", "uint32"])
def test_bit_31_survives_signed_and_unsigned_storage(tmp_path: Path, unsigned: bool) -> None:
    """FLAGS viene como entero con signo: el bit 31 es un valor negativo y tiene que salir como bit."""
    grid = small_grid()
    value = (1 << 31) | bit("SOURCE")
    stored = np.zeros((CUTOUT_SIZE, CUTOUT_SIZE), dtype=np.uint32)
    stored[21, 18] = value
    flags = stored if unsigned else stored.view(np.int32)
    assert unsigned or flags[21, 18] < 0
    table = {**REAL_BITS, "PRUEBA_31": 31}
    exposure = load_exposure(write_cutout(tmp_path / "bit31.fits", ramp(), flags=flags, bits=table), grid)
    x, y = cutout_coords(grid, tan_header())
    assert exposure.flags.dtype == np.uint32
    assert (exposure.flags[nearest_to(x, y, 18, 21)] == np.uint32(value)).all()
    assert int(exposure.flags.max()) == value


@pytest.mark.parametrize("name", REQUIRED_EXTENSIONS)
def test_missing_extension_raises_key_error(tmp_path: Path, name: str) -> None:
    path = write_cutout(tmp_path / "falta.fits", ramp(), skip=(name,))
    with pytest.raises(KeyError, match=name):
        load_exposure(path, small_grid())


@pytest.mark.parametrize("value", [0.0, -1.0, np.nan, np.inf], ids=["cero", "negativa", "nan", "infinita"])
def test_bad_variance_discards_the_pixel(tmp_path: Path, value: float) -> None:
    grid = small_grid()
    variance = np.full((CUTOUT_SIZE, CUTOUT_SIZE), 0.01)
    variance[21, 18] = value
    exposure = load_exposure(write_cutout(tmp_path / "varianza.fits", ramp(), variance=variance), grid)
    x, y = cutout_coords(grid, tan_header())
    lost = touched_by(x, y, 18, 21)
    assert lost.any() and np.array_equal(np.isnan(exposure.image), lost)
    assert np.array_equal(np.isnan(exposure.variance), lost)
    assert (exposure.variance[~lost] > 0).all()
    # Un pixel descartado por su varianza sigue dentro de la huella, y sin flags.
    assert exposure.footprint.all() and not exposure.flags.any()


@pytest.mark.parametrize("layer", ["IMAGE", "ZODI"])
@pytest.mark.parametrize("value", [np.nan, np.inf, -np.inf])
def test_non_finite_image_or_zodi_discards_the_pixel(tmp_path: Path, layer: str, value: float) -> None:
    grid = small_grid()
    image, zodi = ramp(), np.full((CUTOUT_SIZE, CUTOUT_SIZE), 1.0)
    (image if layer == "IMAGE" else zodi)[21, 18] = value
    exposure = load_exposure(write_cutout(tmp_path / "no_finito.fits", image, zodi=zodi), grid)
    x, y = cutout_coords(grid, tan_header())
    assert np.array_equal(np.isnan(exposure.image), touched_by(x, y, 18, 21))
    assert not np.isinf(exposure.image).any()


def test_everything_masked(tmp_path: Path) -> None:
    grid = small_grid()
    flags = np.full((CUTOUT_SIZE, CUTOUT_SIZE), bit("OVERFLOW") | bit("BLOOM"), dtype=np.int32)
    exposure = load_exposure(write_cutout(tmp_path / "todo.fits", ramp(), flags=flags), grid)
    # Sin ningun valor, pero el recorte cubre la grilla y los flags dicen por que.
    assert np.isnan(exposure.image).all() and np.isnan(exposure.variance).all()
    assert exposure.footprint.all()
    assert (exposure.flags == np.uint32(bit("OVERFLOW") | bit("BLOOM"))).all()
    assert exposure.background == 0.0


def test_cutout_smaller_than_the_grid_leaves_a_partial_footprint(tmp_path: Path) -> None:
    grid = small_grid()
    shape = (6, 8)
    header = tan_header(shape, rotation_deg=0.0)
    flags = np.full(shape, bit("SOURCE"), dtype=np.int32)
    exposure = load_exposure(write_cutout(tmp_path / "chico.fits", ramp(shape), flags=flags, header=header), grid)
    x, y = cutout_coords(grid, header)
    inside = (x >= -0.5) & (x < 7.5) & (y >= -0.5) & (y < 5.5)
    assert np.array_equal(exposure.footprint, inside)
    # 8 x 6 pixeles nativos sobre una grilla al doble de resolucion: unos 16 x 12 pixeles de 23 x 23.
    assert 0 < inside.sum() < inside.size and inside.sum() == pytest.approx(16 * 12, abs=16)
    assert np.isfinite(exposure.image[inside]).all() and np.isnan(exposure.image[~inside]).all()
    assert (exposure.flags[inside] == np.uint32(bit("SOURCE"))).all() and not exposure.flags[~inside].any()
    # Sin giro, el recorte queda centrado: la huella es simetrica y no toca el borde de la grilla.
    assert inside[11, 11] and not inside[0, :].any() and not inside[:, 0].any()
    # En la media franja exterior del borde vale el pixel del borde, como en `reproject`.
    background = float(np.median(ramp(shape)))
    expected = ramp_at(np.clip(x, 0.0, 7.0), np.clip(y, 0.0, 5.0)) - background
    np.testing.assert_allclose(exposure.image[inside], expected[inside], atol=2e-5)


def test_cutout_away_from_the_grid_has_an_empty_footprint(tmp_path: Path) -> None:
    grid = small_grid()
    header = tan_header(center=(SMALL_CENTER[0] + 0.5, SMALL_CENTER[1]))
    exposure = load_exposure(write_cutout(tmp_path / "lejos.fits", ramp(), header=header), grid)
    assert not exposure.footprint.any() and not exposure.flags.any()
    assert np.isnan(exposure.image).all() and np.isnan(exposure.variance).all()
    assert exposure.flag_bits == REAL_BITS


def test_orientation_of_a_synthetic_cutout(tmp_path: Path) -> None:
    """Un punto brillante al noreste del centro del recorte cae arriba a la izquierda en la grilla."""
    grid = small_grid()
    header = tan_header(rotation_deg=0.0)
    image = np.zeros((CUTOUT_SIZE, CUTOUT_SIZE))
    # Sin giro el recorte tiene, como la grilla, x hacia el oeste e y hacia el norte.
    image[23, 16] = 100.0
    exposure = load_exposure(write_cutout(tmp_path / "punto.fits", image, header=header), grid)
    row, column = np.unravel_index(int(np.nanargmax(exposure.image)), grid.shape)
    assert row > 11 and column < 11
    ra, dec = geometry.pixel_to_sky(grid, float(column), float(row))
    assert ra > grid.ra and dec > grid.dec
    # 3.5 pixeles nativos al norte y 3.5 al este del centro: 7 pixeles de la grilla para cada lado.
    assert (int(column), int(row)) == (4, 18)


# ------------------------------------------------------ archivos que no sirven


def test_unreadable_files_raise_the_documented_errors(tmp_path: Path) -> None:
    grid = small_grid()
    with pytest.raises(OSError):
        load_exposure(tmp_path / "no_existe.fits", grid)

    garbage = tmp_path / "basura.fits"
    garbage.write_bytes(bytes(range(256)) * 20)
    with pytest.raises(OSError):
        load_exposure(garbage, grid)

    empty = tmp_path / "vacio.fits"
    empty.write_bytes(b"")
    with pytest.raises(OSError):
        load_exposure(empty, grid)


@pytest.mark.filterwarnings("ignore")
@pytest.mark.parametrize("keep", [3000, 2880 * 12 + 100, -15000, -1000])
def test_truncated_file_raises_one_of_the_documented_errors(tmp_path: Path, keep: int) -> None:
    """Un recorte real cortado en el encabezado, en los datos o antes de la ultima extension."""
    data = (CUTOUTS_DIR / CUTOUT_FILES[0]).read_bytes()
    path = tmp_path / "cortado.fits"
    path.write_bytes(data[:keep])
    with pytest.raises((OSError, KeyError, ValueError)):
        load_exposure(path, barnard_grid())


def damaged_cutout(folder: Path, key: str, card: bytes) -> Path:
    """Copia de un recorte real con la primera tarjeta `key` (la del encabezado de IMAGE, si esta en todos) cambiada."""
    data = (CUTOUTS_DIR / CUTOUT_FILES[0]).read_bytes()
    start = data.index(key.encode("ascii").ljust(8) + b"=")
    assert start % 80 == 0 and len(card) <= 80
    path = folder / "danado.fits"
    path.write_bytes(data[:start] + card.ljust(80) + data[start + 80 :])
    return path


@pytest.mark.parametrize(
    ("key", "card"),
    [
        ("MSKN0010", b"MSKN0010= 'HOT"),  # sin la comilla de cierre
        ("MSKD0011", b"MSKD0011= Anomalously low signal"),  # sin comillas
    ],
    ids=["nombre", "descripcion"],
)
def test_unparsable_card_of_the_flag_table_is_a_value_error(tmp_path: Path, key: str, card: bytes) -> None:
    """astropy interpreta la tarjeta recien al leerla y lanza VerifyError, que no es de la firma de `load_exposure`."""
    assert not issubclass(fits.VerifyError, OSError | KeyError | ValueError)
    with pytest.raises(ValueError, match=f"tabla de bits.*{key}") as caught:
        load_exposure(damaged_cutout(tmp_path, key, card), barnard_grid())
    assert isinstance(caught.value.__cause__, fits.VerifyError)


@pytest.mark.parametrize("card", [b"EXTNAME = IMAGE", b"EXTNAME = 'IMAGE"], ids=["sin_comillas", "sin_cierre"])
def test_unparsable_extname_is_one_of_the_documented_errors(tmp_path: Path, card: bytes) -> None:
    """Las extensiones se buscan por `EXTNAME`: si astropy no puede interpretar uno, no sale su VerifyError."""
    with pytest.raises((KeyError, ValueError)):
        load_exposure(damaged_cutout(tmp_path, "EXTNAME", card), barnard_grid())


@pytest.mark.parametrize(
    ("key", "card", "message"),
    [
        ("CRVAL1", b"CRVAL1  =        268.33x587147 / [deg]", "WCS.*CRVAL1"),
        ("CTYPE1", b"CTYPE1  = 'RA---TAN-SIP", "WCS.*CTYPE1"),
        ("A_0_2", b"A_0_2   = uno coma tres", "WCS.*A_0_2"),
        ("RADESYS", b"RADESYS = 'ICRS", "WCS.*RADESYS"),
        ("CTYPE1", b"COMMENT aca estaba CTYPE1", "WCS"),  # la tarjeta se perdio: ya no hay un WCS celeste
        ("B_ORDER", b"COMMENT aca estaba B_ORDER", "WCS"),
    ],
    ids=["numero", "texto", "coeficiente_sip", "radesys", "sin_ctype", "sin_orden_sip"],
)
def test_unusable_wcs_card_is_a_value_error(tmp_path: Path, key: str, card: bytes, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        load_exposure(damaged_cutout(tmp_path, key, card), barnard_grid())


@pytest.mark.parametrize(
    ("key", "card"),
    [
        ("CTYPE1W", b"CTYPE1W = 'WAVE-TAB"),
        ("PS1_0W", b"PS1_0W  = WCS-WAVE"),
        ("CRPIX1A", b"CRPIX1A =              -15x9.0"),
        ("OBSID", b"OBSID   = '2025W33_2C_0321_1"),
    ],
)
def test_damaged_cards_that_are_not_of_the_image_wcs_do_not_matter(tmp_path: Path, key: str, card: bytes) -> None:
    """Los WCS alternativos (A y W) y el resto del encabezado no se usan: danados, el recorte se lee igual."""
    damaged = load_exposure(damaged_cutout(tmp_path, key, card), barnard_grid())
    assert same_arrays(damaged, real_exposure(CUTOUT_FILES[0]))


def test_damaged_alternate_wcs_does_not_take_the_process_down(tmp_path: Path) -> None:
    """Con el encabezado entero, `WCS(header)` de astropy 8.0.2 corrompe la memoria y el proceso muere sin excepcion.

    Alcanza con un byte: `CTYPE1W =` pasa a `CTYPE1W\\xad=` en el WCS alternativo
    de longitud de onda, que el pipeline no usa. Como el fallo no es una
    excepcion de Python, la prueba va en un proceso aparte: si volviera, no se
    llevaria puesta la corrida de tests.
    """
    damaged = damaged_cutout(tmp_path, "CTYPE1W", b"CTYPE1W\xad= 'WAVE-TAB'           / Bilinear lookup table")
    code = (
        "import sys, warnings\n"
        "import numpy as np\n"
        "from pathlib import Path\n"
        "from app import geometry\n"
        "from app.pipeline.exposure import load_exposure\n"
        "warnings.simplefilter('ignore')  # astropy avisa que reemplazo el byte que no es ASCII\n"
        f"grid = geometry.build_grid(geometry.normalize_request({BARNARD[0]}, {BARNARD[1]}, 0.1667))\n"
        "damaged, good = (load_exposure(Path(name), grid) for name in sys.argv[1:3])\n"
        "same = all(\n"
        "    np.array_equal(getattr(damaged, name), getattr(good, name), equal_nan=True)\n"
        "    for name in ('image', 'variance', 'flags', 'footprint')\n"
        ")\n"
        "print('iguales' if same and np.isfinite(damaged.image).any() else 'distintos')\n"
    )
    process = subprocess.run(
        [sys.executable, "-c", code, str(damaged), str(CUTOUTS_DIR / CUTOUT_FILES[0])],
        cwd=Path(__file__).resolve().parent.parent,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert process.returncode == 0, f"el proceso termino con {process.returncode:#x}: {process.stderr[-500:]}"
    assert process.stdout.strip() == "iguales"


@each_cutout
def test_wcs_of_the_primary_cards_is_the_wcs_of_the_whole_header(filename: str) -> None:
    """El WCS se arma con 62 tarjetas de las 276: tiene que dar los mismos pixeles, bit a bit."""
    with fits.open(CUTOUTS_DIR / filename, memmap=False) as hdul:
        header = hdul["IMAGE"].header.copy()
    reduced = wcs_cards(header)
    assert len(reduced) == 62 < len(header)
    # Ninguna tarjeta de los WCS alternativos A y W, ni nada que no sea del WCS.
    assert not [key for key in reduced if key.endswith(("A", "W"))]
    assert {"CTYPE1A", "CTYPE1W", "PS1_0W", "WCSNAMEW", "MJD-OBS", "BUNIT"} <= set(header)  # estaban, y no pasan
    assert {"WCSAXES", "CTYPE1", "CTYPE2", "CRVAL1", "CRPIX2", "PC1_2", "CDELT1", "CUNIT2", "LONPOLE", "LATPOLE",
            "RADESYS", "A_ORDER", "B_ORDER", "AP_ORDER", "BP_ORDER", "A_0_3", "BP_3_0"} <= set(reduced)  # fmt: skip
    for key in reduced:
        assert reduced.cards[key].image == header.cards[key].image  # las mismas tarjetas, sin reescribir

    whole, primary = WCS(header), WCS(reduced)
    grid = barnard_grid()
    columns, rows = np.meshgrid(np.arange(grid.shape[1], dtype=np.float64), np.arange(grid.shape[0], dtype=np.float64))
    ra, dec = grid.wcs.deepcopy().all_pix2world(columns.ravel(), rows.ravel(), 0)
    for expected, got in zip(whole.all_world2pix(ra, dec, 0), primary.all_world2pix(ra, dec, 0), strict=True):
        assert np.array_equal(expected, got)
    sky_whole, sky_primary = whole.all_pix2world(columns, rows, 0), primary.all_pix2world(columns, rows, 0)
    for expected, got in zip(sky_whole, sky_primary, strict=True):
        assert np.array_equal(expected, got)


def test_wcs_cards_accepts_the_other_standard_spellings() -> None:
    """Si una version futura escribe el mismo WCS con CDi_j, PVi_m, CROTA o EQUINOX, no se pierden."""
    header = fits.Header()
    for key, value in {
        "WCSAXES": 2, "CTYPE1": "RA---TAN", "CTYPE2": "DEC--TAN", "CRVAL1": 10.0, "CRVAL2": 20.0, "CRPIX1": 5.0,
        "CRPIX2": 5.0, "CD1_1": -0.001, "CD1_2": 0.0, "CD2_1": 0.0, "CD2_2": 0.001, "PV2_1": 0.0, "CROTA2": 0.0,
        "EQUINOX": 2000.0, "RADESYS": "ICRS", "A_DMAX": 1.0, "B_DMAX": 1.0,
        # Lo que no es del WCS primario: versiones alternativas y cualquier otra cosa.
        "CTYPE1A": "LINEAR", "CRVAL1W": 1.0, "PS1_0W": "WCS-WAVE", "PV1_3W": 1, "WCSNAMEW": "x", "CNAME1W": "x",
        "WCSAXESA": 2, "LATPOLEA": 90.0, "MJD-OBS": 60902.8, "DATE-OBS": "2025-08-15", "BUNIT": "MJy / sr",
        "NAXIS1": 58, "DETECTOR": 3,
    }.items():  # fmt: skip
        header[key] = value
    assert list(wcs_cards(header)) == [
        "WCSAXES", "CTYPE1", "CTYPE2", "CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2", "CD1_1", "CD1_2", "CD2_1", "CD2_2",
        "PV2_1", "CROTA2", "EQUINOX", "RADESYS", "A_DMAX", "B_DMAX",
    ]  # fmt: skip


def test_extensions_of_different_size_raise_value_error(tmp_path: Path) -> None:
    path = tmp_path / "formas.fits"
    header = tan_header()
    flag_header = header.copy()
    flag_header["MSKN0001"] = "OVERFLOW"
    fits.HDUList(
        [
            fits.PrimaryHDU(),
            fits.ImageHDU(np.zeros((40, 40), dtype=np.float32), header=header, name="IMAGE"),
            fits.ImageHDU(np.zeros((40, 39), dtype=np.int32), header=flag_header, name="FLAGS"),
            fits.ImageHDU(np.ones((40, 40), dtype=np.float32), header=header, name="VARIANCE"),
            fits.ImageHDU(np.zeros((40, 40), dtype=np.float32), header=header, name="ZODI"),
        ]
    ).writeto(path)
    with pytest.raises(ValueError, match="no miden lo mismo"):
        load_exposure(path, small_grid())


def test_flags_without_a_bit_table_raise_value_error(tmp_path: Path) -> None:
    """Sin tabla de bits no se sabe que enmascarar: el recorte no sirve."""
    path = write_cutout(tmp_path / "sin_tabla.fits", ramp(), bits={})
    with pytest.raises(ValueError, match="no declara ningun bit"):
        load_exposure(path, small_grid())


def test_flags_that_are_not_integers_raise_value_error(tmp_path: Path) -> None:
    path = write_cutout(
        tmp_path / "flotante.fits", ramp(), flags=np.zeros((CUTOUT_SIZE, CUTOUT_SIZE), dtype=np.float32)
    )
    with pytest.raises(ValueError, match="FLAGS no es un entero"):
        load_exposure(path, small_grid())


def test_other_coordinate_systems_are_rejected(tmp_path: Path) -> None:
    header = tan_header()
    header["RADESYS"] = "FK5"
    with pytest.raises(ValueError, match="RADESYS"):
        load_exposure(write_cutout(tmp_path / "fk5.fits", ramp(), header=header), small_grid())


# ------------------------------------------------------------- tabla de bits


def test_read_flag_table() -> None:
    header = fits.Header()
    header["MSKN0001"] = ("OVERFLOW", "Name for mask plane 1")
    header["MSKM0001"] = 2
    header["MSKD0001"] = "Overflow detected during SUR"
    header["MSKN0006"] = "NONFUNC "
    header["MSKN0029"] = "SATELLITE_HALO"
    header["MSKD0029"] = "Pixel part of a satellite streak halo"
    bits, descriptions = read_flag_table(header)
    assert bits == {"OVERFLOW": 1, "NONFUNC": 6, "SATELLITE_HALO": 29}
    # Un bit sin MSKD no tiene descripcion; no se inventa una.
    assert descriptions == {
        "OVERFLOW": "Overflow detected during SUR",
        "SATELLITE_HALO": "Pixel part of a satellite streak halo",
    }
    assert flag_mask(bits, ("OVERFLOW", "BLOOM", "SATELLITE_HALO")) == (1 << 1) | (1 << 29)
    assert flag_mask(bits, ()) == 0


def test_read_flag_table_rejects_tables_it_cannot_trust() -> None:
    with pytest.raises(ValueError, match="no declara ningun bit"):
        read_flag_table(fits.Header())

    repeated = fits.Header()
    repeated["MSKN0001"] = "OVERFLOW"
    repeated["MSKN0002"] = "OVERFLOW"
    with pytest.raises(ValueError, match="OVERFLOW aparece en los bits 1 y 2"):
        read_flag_table(repeated)

    too_high = fits.Header()
    too_high["MSKN0032"] = "FUERA"
    with pytest.raises(ValueError, match="no entra en 32 bits"):
        read_flag_table(too_high)

    # Una tarjeta mal escrita: astropy la interpreta recien al leerla y lanza VerifyError.
    for card in ("MSKN0001= 'OVERFLOW", "MSKD0001= sin comillas"):
        cards = ["MSKN0001= 'OVERFLOW'", "MSKD0001= 'Overflow detected during SUR'"]
        cards[0 if card.startswith("MSKN") else 1] = card
        unparsable = fits.Header.fromstring("".join(text.ljust(80) for text in [*cards, "END"]))
        with pytest.raises(ValueError, match=r"no se puede interpretar.*MSK[ND]0001"):
            read_flag_table(unparsable)
