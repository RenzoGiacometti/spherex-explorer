"""Lo numerico de la capa optica (app/context/optical.py). Sin red.

Fechas de placa, bandas y la reproyeccion de una placa real del Digitized Sky
Survey: las estrellas tienen que quedar donde Gaia dice que estaban el dia de
la placa, 25 anios antes de la epoca de Gaia.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest
from numpy.typing import NDArray

from app import geometry
from app.context import optical
from app.context.fields import object_alias
from app.context.gaia import parse_sources, position_at
from app.context.reproject import background_level, read_cutout, resample_to_grid
from app.domain import Grid

FIXTURES = Path(__file__).parent / "fixtures"
# Placa POSS-II roja SF04022 del campo de Barnard, bajada de STScI el 2026-11-15:
# dss_search?v=poss2ukstu_red&r=269.446300&d=4.800800&e=J2000&h=3.60&w=3.60&f=fits&c=none
PLATE = FIXTURES / "optical" / "dss2_red_barnard.fits"
GAIA = FIXTURES / "context" / "gaia_barnard_bright.tbl"


@pytest.fixture(scope="module")
def grid() -> Grid:
    return geometry.make_grid(269.4463, 4.7683, 0.1667, 3.075)


# ------------------------------------------------------------------- fechas


@pytest.mark.parametrize(
    ("text", "date", "mjd"),
    [
        ("1991-06-16T07:80:00", "1991-06-16", 48423.0),  # minutos imposibles: se lee el dia
        ("1950-07-09T06:75:00", "1950-07-09", 33471.0),
        ("1976-03-11T18:13", "1976-03-11", 42848.0),  # sin segundos
        ("1997-03-11T17:19:00", "1997-03-11", 50518.0),
        ("2000-01-01", "2000-01-01", 51544.0),
        ("1858-11-17T00:00:00", "1858-11-17", 0.0),  # el dia cero
    ],
)
def test_plate_date_reads_the_day(text: str, date: str, mjd: float) -> None:
    assert optical.plate_mjd(text) == mjd
    assert optical.mjd_date(mjd) == date


@pytest.mark.parametrize("text", ["", None, "sin fecha", "16/06/1991", "1991-13-40T00:00:00", "1991-06"])
def test_plate_date_rejects_what_is_not_a_date(text: str | None) -> None:
    assert optical.plate_mjd(text) is None


def test_mjd_year_is_the_julian_year() -> None:
    assert optical.mjd_year(51544.5) == 2000.0
    assert optical.mjd_year(51544.5 + 365.25) == 2001.0
    # 48423 es 3121,5 dias antes de J2000,0: 8,5462 anios julianos.
    assert optical.mjd_year(optical.plate_mjd("1991-06-16") or 0.0) == pytest.approx(1991.4538, abs=0.0001)
    assert optical.mjd_year(optical.plate_mjd("1950-07-09") or 0.0) == pytest.approx(1950.5174, abs=0.0001)


def test_impossible_plate_dates_are_flagged() -> None:
    # La POSS-II SF07095 dice 1952 en su encabezado: ese relevamiento empezo en los 80.
    assert not optical.is_plausible_date("DSS2", 1952.64)
    assert optical.is_plausible_date("DSS2", 1991.46)
    assert optical.is_plausible_date("DSS2", 1998.9)
    assert optical.is_plausible_date("DSS1", 1950.5)
    assert optical.is_plausible_date("DSS1", 1987.1)  # Quick-V del sur
    assert not optical.is_plausible_date("DSS1", 2010.0)
    assert not optical.is_plausible_date("DSS2", 2026.0)


# -------------------------------------------------------------------- bandas


@pytest.mark.parametrize(
    ("emulsion", "band", "wave_um"),
    [
        ("IIIaF", "R", 0.65),  # POSS-II y UK Schmidt, rojo
        ("103aE", "R", 0.65),  # POSS-I, rojo
        ("IIIaJ", "Bj", 0.47),  # SERC-J, azul
        ("IIaD", "V", 0.55),  # Quick-V
        ("IV-N", "I", 0.80),
        (" iiiaf ", "R", 0.65),
    ],
)
def test_plate_band_from_the_emulsion(emulsion: str, band: str, wave_um: float) -> None:
    assert optical.plate_band(emulsion) == (band, wave_um)


def test_unknown_emulsion_has_no_band() -> None:
    assert optical.plate_band("Kodak") is None
    assert optical.plate_band(None) is None
    assert optical.plate_band("") is None


# --------------------------------------------------------------------- pedido


def test_request_matches_the_stsci_form(grid: Grid) -> None:
    # Lado del campo por raiz de 2 mas el margen: 0,24258 grados, 14,55 minutos de arco.
    assert optical.side_arcmin(grid) == pytest.approx(14.55, abs=0.005)
    params = optical.request_params("poss2ukstu_red", 269.4463, 4.7683, optical.side_arcmin(grid))
    assert params == {
        "v": "poss2ukstu_red",
        "r": "269.446300",
        "d": "4.768300",
        "e": "J2000",
        "h": "14.55",
        "w": "14.55",
        "f": "fits",
        "c": "none",
        "fov": "NONE",
        "v3": "",
    }
    # El servicio no acepta mas de 60 minutos de lado.
    assert optical.request_params("poss1_red", 0.0, 0.0, 90.0)["h"] == "60.00"
    assert optical.survey_by_key("dss1").versions == ("poss1_red", "phase2_gsc1")
    with pytest.raises(KeyError):
        optical.survey_by_key("dss9")


def test_object_alias_keeps_catalogue_acronyms() -> None:
    assert object_alias("HD 33793") == "hd-33793"
    assert object_alias("GJ 699") == "gj-699"
    assert object_alias("NAME Proxima Centauri") == "proxima-centauri"


# ------------------------------------------------------------------ placa real


def centroid(image: NDArray[np.floating], x: float, y: float, radius: int = 3) -> tuple[float, float]:
    cx, cy = round(x), round(y)
    window = np.asarray(image[cy - radius : cy + radius + 1, cx - radius : cx + radius + 1], dtype=np.float64)
    window = np.clip(np.where(np.isfinite(window), window, 0.0) - np.median(window), 0.0, None)
    yy, xx = np.mgrid[cy - radius : cy + radius + 1, cx - radius : cx + radius + 1]
    return float((window * xx).sum() / window.sum()), float((window * yy).sum() / window.sum())


def test_real_plate_header_gives_date_band_and_owner() -> None:
    cutout = read_cutout(PLATE)
    header = cutout.header
    mjd = optical.plate_mjd(str(header["DATE-OBS"]))
    assert mjd == 48423.0
    assert optical.mjd_date(mjd) == "1991-06-16"
    assert optical.is_plausible_date("DSS2", optical.mjd_year(mjd))
    assert optical.plate_band(str(header["EMULSION"])) == ("R", 0.65)
    assert header["SURVEY"] == "POSSII-F"
    assert header["PLTLABEL"] == "SF04022"
    assert header["COPYRGHT"] == "Caltech/Palomar"
    # Un pixel de la placa digitalizada mide 1,02".
    assert cutout.pixel_scale_arcsec == pytest.approx(1.02, abs=0.005)


def test_real_plate_puts_the_stars_where_gaia_says(grid: Grid) -> None:
    cutout = read_cutout(PLATE)
    image, footprint = resample_to_grid(cutout.data, cutout.wcs, grid)
    image = image - np.float32(background_level(image))
    assert image.shape == grid.shape and image.dtype == np.float32
    assert footprint.any() and not footprint.all()  # el recorte guardado cubre una parte del campo

    year = optical.mjd_year(48423.0)
    sources = parse_sources(GAIA.read_bytes())
    ra, dec = position_at(sources, year)  # 24,5 anios antes de la epoca de Gaia
    positions = [geometry.sky_to_pixel(grid, float(a), float(d)) for a, d in zip(ra, dec, strict=True)]
    offsets: list[float] = []
    for index, (x, y) in enumerate(positions):
        if sources.g_mag[index] > 15.0 or not (4 <= x < grid.shape[1] - 4 and 4 <= y < grid.shape[0] - 4):
            continue
        if any(math.hypot(x - ox, y - oy) < 6.0 for other, (ox, oy) in enumerate(positions) if other != index):
            continue
        window = image[round(y) - 3 : round(y) + 4, round(x) - 3 : round(x) + 4]
        if not np.isfinite(window).all():
            continue
        found_x, found_y = centroid(image, x, y)
        offsets.append(math.hypot(found_x - x, found_y - y))
    assert len(offsets) >= 4
    # En una placa fotografica una estrella brillante es una mancha saturada, con halo y cruz de
    # difraccion, y su centroide es menos preciso que en 2MASS o WISE. Medido sobre el campo
    # entero (17 estrellas): mediana de 0,14 px (0,4") y maximo de 0,56 px.
    assert float(np.median(offsets)) < 0.35, offsets
    assert max(offsets) < 0.75, offsets
