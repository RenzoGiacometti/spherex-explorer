"""Reproyeccion de un recorte de otra mision a la grilla del campo (app/context/reproject.py).

Dos clases de pruebas, ninguna usa la red:

- Con imagenes sinteticas, donde se conoce la respuesta: una fuente puesta en
  una posicion del cielo tiene que caer en el pixel de la grilla que le toca,
  con el norte arriba y el este a la izquierda, y el brillo se tiene que conservar.
- Con recortes reales de 2MASS y de WISE del campo de Barnard, guardados en
  tests/fixtures/context: las estrellas tienen que quedar donde Gaia dice que
  estaban en la fecha de cada imagen.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from numpy.typing import NDArray

from app import geometry
from app.context import reproject
from app.context.gaia import parse_sources, position_at
from app.context.surveys import BANDS, SurveyImage, observation_times
from app.domain import Grid

FIXTURES = Path(__file__).parent / "fixtures" / "context"

# Campo base de Barnard (contrato, seccion 3): 195 x 195 px a 3,075".
RA0, DEC0 = 269.4463, 4.7683

# Ventana del centroide sobre los recortes reales (7 x 7 px, 21") y distancia minima a otra fuente.
CENTROID_RADIUS = 3
ISOLATION_PX = 6.0


@pytest.fixture(scope="module")
def grid() -> Grid:
    return geometry.make_grid(RA0, DEC0, 0.1667, 3.075)


def survey_wcs(ra: float, dec: float, size: int, scale_arcsec: float, rotation_deg: float = 0.0) -> WCS:
    """WCS como el de un recorte de 2MASS o de WISE: proyeccion SIN, norte arriba salvo `rotation_deg`."""
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---SIN", "DEC--SIN"]
    wcs.wcs.crval = [ra, dec]
    wcs.wcs.crpix = [(size + 1) / 2.0, (size + 1) / 2.0]
    wcs.wcs.cdelt = [-scale_arcsec / 3600.0, scale_arcsec / 3600.0]
    wcs.wcs.crota = [0.0, rotation_deg]
    wcs.wcs.cunit = ["deg", "deg"]
    return wcs


def offset_position(ra: float, dec: float, east_arcsec: float, north_arcsec: float) -> tuple[float, float]:
    """Posicion corrida unos segundos de arco al este y al norte (aproximacion plana, sobra para un campo de 10')."""
    return ra + east_arcsec / 3600.0 / math.cos(math.radians(dec)), dec + north_arcsec / 3600.0


def gaussian_image(
    wcs: WCS, size: int, ra: float, dec: float, sigma_px: float, peak: float = 100.0
) -> NDArray[np.float64]:
    """Imagen con una fuente gaussiana centrada en esa posicion del cielo."""
    x0, y0 = wcs.all_world2pix(ra, dec, 0)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    return peak * np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2.0 * sigma_px**2))


def centroid(image: NDArray[np.floating], x: float, y: float, radius: int = 4) -> tuple[float, float]:
    """Centroide ponderado por brillo en una ventana alrededor de `(x, y)`, en pixeles desde 0."""
    cx, cy = round(x), round(y)
    window = np.asarray(image[cy - radius : cy + radius + 1, cx - radius : cx + radius + 1], dtype=np.float64)
    window = np.where(np.isfinite(window), window, 0.0)
    window = np.clip(window - np.median(window), 0.0, None)
    yy, xx = np.mgrid[cy - radius : cy + radius + 1, cx - radius : cx + radius + 1]
    total = window.sum()
    return float((window * xx).sum() / total), float((window * yy).sum() / total)


# ------------------------------------------------------------ imagenes sinteticas


@pytest.mark.parametrize(
    ("scale", "east", "north"),
    [
        (1.0, 0.0, 0.0),  # 2MASS, en el centro
        (1.0, 120.0, -150.0),  # 2MASS, al sureste
        (1.375, -200.0, 90.0),  # WISE, al noroeste
        (1.375, 37.3, 211.9),  # WISE, lejos de un centro de pixel
    ],
)
def test_source_lands_on_its_grid_pixel(grid: Grid, scale: float, east: float, north: float) -> None:
    size = 700
    wcs = survey_wcs(RA0 + 0.01, DEC0 - 0.008, size, scale)  # centro de la imagen corrido del centro del campo
    ra, dec = offset_position(RA0, DEC0, east, north)
    image, footprint = reproject.resample_to_grid(gaussian_image(wcs, size, ra, dec, sigma_px=2.5 / scale), wcs, grid)

    expected_x, expected_y = geometry.sky_to_pixel(grid, ra, dec)
    found_x, found_y = centroid(image, expected_x, expected_y)
    assert found_x == pytest.approx(expected_x, abs=0.05)
    assert found_y == pytest.approx(expected_y, abs=0.05)
    assert footprint.all()


def test_north_is_up_and_east_is_left(grid: Grid) -> None:
    size = 700
    wcs = survey_wcs(RA0, DEC0, size, 1.0)
    ra, dec = offset_position(RA0, DEC0, east_arcsec=150.0, north_arcsec=100.0)
    image, _ = reproject.resample_to_grid(gaussian_image(wcs, size, ra, dec, sigma_px=3.0), wcs, grid)

    row, column = np.unravel_index(np.nanargmax(image), image.shape)
    center = (grid.shape[0] - 1) / 2
    # Fila 0 = sur y columna 0 = este: al norte la fila crece y al este la columna baja.
    assert row == pytest.approx(center + 100.0 / 3.075, abs=1.0)
    assert column == pytest.approx(center - 150.0 / 3.075, abs=1.0)


def test_rotated_input_lands_on_the_same_pixel(grid: Grid) -> None:
    size = 900
    ra, dec = offset_position(RA0, DEC0, east_arcsec=-80.0, north_arcsec=140.0)
    expected = geometry.sky_to_pixel(grid, ra, dec)
    for rotation in (0.0, 33.0, 180.0):
        wcs = survey_wcs(RA0, DEC0, size, 1.0, rotation_deg=rotation)
        image, _ = reproject.resample_to_grid(gaussian_image(wcs, size, ra, dec, sigma_px=3.0), wcs, grid)
        found = centroid(image, *expected)
        assert found[0] == pytest.approx(expected[0], abs=0.05), rotation
        assert found[1] == pytest.approx(expected[1], abs=0.05), rotation


def test_surface_brightness_is_conserved(grid: Grid) -> None:
    size = 700
    wcs = survey_wcs(RA0, DEC0, size, 1.0)
    flat, _ = reproject.resample_to_grid(np.full((size, size), 7.5), wcs, grid)
    assert np.allclose(flat, 7.5, atol=1e-5)

    # El flujo de una fuente es la suma del brillo por el area del pixel: tiene que dar lo mismo antes y despues.
    source = gaussian_image(wcs, size, RA0, DEC0, sigma_px=3.0)
    image, _ = reproject.resample_to_grid(source, wcs, grid)
    flux_in = source.sum() * 1.0**2
    flux_out = float(np.nansum(image)) * grid.pixel_scale_arcsec**2
    assert flux_out == pytest.approx(flux_in, rel=0.01)


def test_area_average_lowers_the_noise(grid: Grid) -> None:
    size = 700
    wcs = survey_wcs(RA0, DEC0, size, 1.0)
    noise = np.random.default_rng(7).normal(0.0, 1.0, (size, size))
    averaged, _ = reproject.resample_to_grid(noise, wcs, grid)
    center_only, _ = reproject.resample_to_grid(noise, wcs, grid, oversample=1)
    assert reproject.oversample_for(1.0, grid) == 3
    # Con 9 pixeles de entrada por pixel de salida el ruido baja cerca de 3 veces; el valor del centro solo, casi nada.
    assert float(np.std(averaged)) < 0.45
    assert float(np.std(center_only)) > 0.55


def test_outside_the_input_there_is_no_data(grid: Grid) -> None:
    # Una imagen de 300" de lado centrada en el campo de 600": solo el cuadrado central tiene datos.
    size = 300
    wcs = survey_wcs(RA0, DEC0, size, 1.0)
    image, footprint = reproject.resample_to_grid(np.ones((size, size)), wcs, grid)

    assert image.dtype == np.float32
    assert image.shape == grid.shape == footprint.shape
    center = (grid.shape[0] - 1) // 2
    half = int(150.0 / 3.075)
    assert np.isfinite(image[center - half + 1 : center + half, center - half + 1 : center + half]).all()
    assert np.isnan(image[:20, :]).all() and np.isnan(image[:, -20:]).all()
    assert not footprint[:20, :].any()
    assert np.isfinite(image).sum() == pytest.approx((300.0 / 3.075) ** 2, rel=0.05)
    # Donde hay valor, la huella esta prendida.
    assert footprint[np.isfinite(image)].all()


def test_input_nan_does_not_spread_beyond_its_pixels(grid: Grid) -> None:
    size = 700
    wcs = survey_wcs(RA0, DEC0, size, 1.0)
    data = np.ones((size, size))
    data[340:361, 340:361] = np.nan  # un hueco de 21" en el centro
    image, footprint = reproject.resample_to_grid(data, wcs, grid)

    center = (grid.shape[0] - 1) // 2
    assert np.isnan(image[center, center])
    assert footprint[center, center]  # sin datos, pero dentro de la imagen
    assert np.isnan(image).sum() <= 81  # el hueco mide 7 pixeles de la grilla de lado, mas el borde
    assert np.allclose(image[np.isfinite(image)], 1.0)


def test_oversample_follows_the_pixel_scales(grid: Grid) -> None:
    assert reproject.oversample_for(1.0, grid) == 3  # 2MASS
    assert reproject.oversample_for(1.375, grid) == 2  # WISE
    assert reproject.oversample_for(6.15, grid) == 1  # nunca menos de 1
    assert reproject.oversample_for(0.01, grid) == reproject.MAX_OVERSAMPLE
    wide = geometry.make_grid(RA0, DEC0, 0.5, 6.15)
    assert reproject.oversample_for(1.0, wide) == 6


def test_mosaic_takes_the_first_image_that_has_data() -> None:
    first = np.array([[1.0, np.nan], [np.nan, np.nan]], dtype=np.float32)
    second = np.array([[9.0, 2.0], [np.nan, np.nan]], dtype=np.float32)
    third = np.array([[9.0, 9.0], [3.0, np.nan]], dtype=np.float32)
    mosaic = reproject.compose_mosaic([first, second, third])
    assert mosaic.dtype == np.float32
    assert mosaic[0, 0] == 1.0 and mosaic[0, 1] == 2.0 and mosaic[1, 0] == 3.0
    assert np.isnan(mosaic[1, 1])
    with pytest.raises(ValueError):
        reproject.compose_mosaic([])
    with pytest.raises(ValueError):
        reproject.compose_mosaic([first, np.zeros((3, 3), dtype=np.float32)])


def test_surface_brightness_factor() -> None:
    # Una cuenta de una imagen Ks de 2MASS con MAGZP = 20: 666,7 Jy x 10^-8 sobre un pixel de 1".
    steradians = (math.pi / 180.0 / 3600.0) ** 2
    expected = 666.7e-8 / steradians * 1e-6
    assert reproject.surface_brightness_factor(20.0, 666.7, 1.0) == pytest.approx(expected, rel=1e-12)
    # Con el doble de escala el pixel tiene cuatro veces el area: la cuenta vale la cuarta parte.
    assert reproject.surface_brightness_factor(20.0, 666.7, 2.0) == pytest.approx(expected / 4.0, rel=1e-12)
    with pytest.raises(ValueError):
        reproject.surface_brightness_factor(20.0, 666.7, 0.0)


def test_reproject_cutout_subtracts_the_background_and_converts(grid: Grid) -> None:
    size = 700
    wcs = survey_wcs(RA0, DEC0, size, 1.0)
    data = np.full((size, size), 650.0) + gaussian_image(wcs, size, RA0, DEC0, sigma_px=3.0, peak=1000.0)
    header = wcs.to_header()
    header["MAGZP"] = 20.0
    cutout = reproject.SurveyCutout(data=data, wcs=wcs, header=header)

    counts, _ = reproject.reproject_cutout(cutout, grid)
    assert reproject.background_level(counts) == pytest.approx(0.0, abs=1e-3)
    assert float(np.nanmax(counts)) > 100.0

    factor = reproject.surface_brightness_factor(20.0, 666.7, 1.0)
    converted, _ = reproject.reproject_cutout(cutout, grid, zero_flux_jy=666.7)
    assert np.allclose(converted, counts * factor, rtol=1e-5, atol=1e-6)

    del header["MAGZP"]
    with pytest.raises(ValueError):
        reproject.reproject_cutout(reproject.SurveyCutout(data=data, wcs=wcs, header=header), grid, zero_flux_jy=666.7)


def test_read_cutout_rejects_what_is_not_an_image(tmp_path: Path) -> None:
    not_fits = tmp_path / "pagina.fits"
    not_fits.write_bytes(b"<html>502 Proxy Error</html>")
    with pytest.raises(ValueError):
        reproject.read_cutout(not_fits)

    table_only = tmp_path / "tabla.fits"
    fits.HDUList([fits.PrimaryHDU()]).writeto(table_only)
    with pytest.raises(ValueError):
        reproject.read_cutout(table_only)


# ---------------------------------------------------------------- recortes reales


def real_cutouts() -> list[dict[str, object]]:
    index = FIXTURES / "index.json"
    if not index.is_file():
        return []
    return list(json.loads(index.read_text(encoding="utf-8"))["cutouts"])


@pytest.mark.parametrize("entry", real_cutouts(), ids=lambda entry: str(entry["file"]))
def test_real_cutout_puts_the_stars_where_gaia_says(grid: Grid, entry: dict[str, object]) -> None:
    cutout = reproject.read_cutout(FIXTURES / str(entry["file"]))
    assert cutout.pixel_scale_arcsec == pytest.approx(float(entry["pixel_scale_arcsec"]), rel=1e-3)
    image, footprint = reproject.reproject_cutout(cutout, grid, zero_flux_jy=float(entry["zero_flux_jy"]))
    assert image.shape == grid.shape and image.dtype == np.float32
    assert footprint.any()

    # Un pixel de la grilla son 3,075": una estrella aislada tiene que quedar a menos de medio pixel,
    # y las mas brillantes, donde el ruido no cuenta, a menos de 0,15 px (medio segundo de arco).
    offsets = star_offsets(image, grid, float(entry["year"]), float(entry["g_max"]))
    assert len(offsets) >= int(entry["min_stars"])
    assert max(offsets) < float(entry["max_offset_px"]), offsets
    bright = star_offsets(image, grid, float(entry["year"]), float(entry["bright_g_max"]))
    assert len(bright) >= int(entry["bright_min_stars"])
    assert max(bright) < float(entry["bright_max_offset_px"]), bright

    # La fecha del recorte sale de su encabezado y coincide con la que se anoto al bajarlo.
    band = next(item for item in BANDS if item.survey == entry["survey"] and item.band == entry["band"])
    times = observation_times(cutout.header, band, SurveyImage(obs_id="fixture", url=str(entry["url"]).split("?")[0]))
    assert times is not None
    assert Time(times.mjd, format="mjd").strftime("%Y-%m-%d") == entry["date"]
    assert Time(times.mjd, format="mjd").jyear == pytest.approx(float(entry["year"]), abs=0.002)


def star_offsets(image: NDArray[np.float32], grid: Grid, year: float, g_max: float) -> list[float]:
    """Distancia, en pixeles, entre cada estrella de Gaia aislada y el centroide de la imagen en ese lugar.

    Se usan las fuentes mas brillantes que `g_max` que no tienen otra fuente de
    la tabla (G < 16,5) a menos de `ISOLATION_PX`: con una vecina el centroide
    se corre hacia ella y no dice nada de la reproyeccion.
    """
    sources = parse_sources((FIXTURES / "gaia_barnard_bright.tbl").read_bytes())
    ra, dec = position_at(sources, year)
    positions = [geometry.sky_to_pixel(grid, float(a), float(d)) for a, d in zip(ra, dec, strict=True)]
    offsets: list[float] = []
    for index, (x, y) in enumerate(positions):
        if sources.g_mag[index] > g_max:
            continue
        if not (CENTROID_RADIUS + 1 <= x < grid.shape[1] - CENTROID_RADIUS - 1):
            continue
        if not (CENTROID_RADIUS + 1 <= y < grid.shape[0] - CENTROID_RADIUS - 1):
            continue
        if any(math.hypot(x - ox, y - oy) < ISOLATION_PX for other, (ox, oy) in enumerate(positions) if other != index):
            continue
        window = image[
            round(y) - CENTROID_RADIUS : round(y) + CENTROID_RADIUS + 1,
            round(x) - CENTROID_RADIUS : round(x) + CENTROID_RADIUS + 1,
        ]
        if not np.isfinite(window).all():
            continue
        found_x, found_y = centroid(image, x, y, radius=CENTROID_RADIUS)
        offsets.append(math.hypot(found_x - x, found_y - y))
    return offsets
