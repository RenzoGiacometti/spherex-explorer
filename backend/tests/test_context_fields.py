"""Movimiento de un objeto estimado de su trayectoria guardada (app/context/fields.py). Sin red.

Lo numerico de armar el contexto desde los metadatos de un campo: el movimiento
lineal que sale de dos epocas separadas un anio y la posicion que da al llevarlo
a la fecha de 2MASS o de WISE.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from app import geometry
from app.config import get_settings
from app.context.fields import (
    DAYS_PER_YEAR,
    MIN_BASELINE_YEARS,
    list_fields,
    object_alias,
    target_at,
    track_motion,
)
from app.contract import TrackPosition
from app.resolve import motion as catalog_motion
from app.resolve.sesame import parse_sesame

FIXTURES = Path(__file__).parent / "fixtures"
MJD0 = 60800.0


def position(
    epoch: int,
    years: float,
    *,
    ra0: float = 150.0,
    dec0: float = -30.0,
    east_per_year: float = 0.0,
    north_per_year: float = 0.0,
    parallax: float = 0.0,
) -> TrackPosition:
    """Posicion de un objeto con movimiento propio y una elipse de paralaje, `years` despues de `MJD0`.

    La elipse es la mas simple que tiene periodo de un anio: `parallax` segundos
    de arco de semieje al este y la mitad al norte.
    """
    east = east_per_year * years + parallax * math.cos(2.0 * math.pi * years)
    north = north_per_year * years + 0.5 * parallax * math.sin(2.0 * math.pi * years)
    return TrackPosition(
        epoch=epoch,
        mjd=MJD0 + years * DAYS_PER_YEAR,
        ra=ra0 + east / 3600.0 / math.cos(math.radians(dec0)),
        dec=dec0 + north / 3600.0,
        x=0.0,
        y=0.0,
        in_field=True,
    )


def test_motion_without_parallax_is_exact() -> None:
    track = [
        position(i + 1, years, east_per_year=-0.8, north_per_year=10.36) for i, years in enumerate((0.0, 0.5, 1.0))
    ]
    motion = track_motion(track)
    assert motion is not None
    # 1e-4: la posicion de prueba pasa a ascension recta con el coseno de la declinacion inicial y
    # la estimacion usa el de la declinacion media, 5" mas al norte.
    assert motion.rate_east == pytest.approx(-0.8, abs=1e-4)
    assert motion.rate_north == pytest.approx(10.36, abs=1e-6)
    assert motion.per_year_arcsec == pytest.approx(math.hypot(0.8, 10.36), abs=1e-4)
    assert motion.baseline_years == pytest.approx(1.0)

    # Llevado 26 anios atras cae donde corresponde.
    ra, dec = motion.position_at(MJD0 - 26.0 * DAYS_PER_YEAR)
    assert (dec - -30.0) * 3600.0 == pytest.approx(-26.0 * 10.36, abs=1e-3)
    assert (ra - 150.0) * 3600.0 * math.cos(math.radians(-30.0)) == pytest.approx(26.0 * 0.8, abs=0.02)


def test_one_year_pair_cancels_the_parallax() -> None:
    # Proxima: 0,77" de paralaje. La primera y la tercera pasada estan a 0,98 anios.
    parallax = 0.77
    track = [
        position(i + 1, years, east_per_year=-3.78, north_per_year=0.77, parallax=parallax)
        for i, years in enumerate((0.0, 0.54, 0.98))
    ]
    motion = track_motion(track)
    assert motion is not None
    assert motion.baseline_years == pytest.approx(0.98)
    # El error que queda es la paralaje por el desfasaje (2 pi x 0,02 anios), sobre la separacion.
    bound = parallax * 2.0 * math.pi * 0.02 / 0.98
    assert abs(motion.rate_east - -3.78) < bound
    assert abs(motion.rate_north - 0.77) < bound

    # Con el par de seis meses la paralaje entraria entera: hasta 4 veces la paralaje por anio.
    half_year = [track[0], track[1]]
    assert track_motion(half_year) is None
    assert (track[1].mjd - track[0].mjd) / DAYS_PER_YEAR < MIN_BASELINE_YEARS


def test_picks_the_pair_closest_to_whole_years() -> None:
    # Cuatro pasadas, como Epsilon Indi B: 0, 0,42, 0,96 y 1,39 anios.
    track = [
        position(i + 1, years, north_per_year=1.0, parallax=0.3) for i, years in enumerate((0.0, 0.42, 0.96, 1.39))
    ]
    motion = track_motion(track)
    assert motion is not None
    # Hay dos pares de casi un anio: 0 a 0,96 (a 0,04 de un anio) y 0,42 a 1,39 (0,97, a 0,03).
    # Gana el de menor desfasaje. El par mas largo, 0 a 1,39, queda descartado: esta a 0,39.
    assert motion.baseline_years == pytest.approx(0.97)
    assert motion.rate_north == pytest.approx(1.0, abs=0.3 * 2.0 * math.pi * 0.03 / 0.97)


def test_no_positions_means_no_motion() -> None:
    assert track_motion([]) is None
    assert track_motion([position(1, 0.0)]) is None


def test_motion_across_the_zero_meridian() -> None:
    track = [position(i + 1, years, ra0=359.9999, dec0=0.0, east_per_year=2.0) for i, years in enumerate((0.0, 1.0))]
    assert track[1].ra > 360.0  # la segunda posicion ya cruzo
    wrapped = [track[0], track[1].model_copy(update={"ra": track[1].ra % 360.0})]
    motion = track_motion(wrapped)
    assert motion is not None
    assert motion.rate_east == pytest.approx(2.0, abs=1e-6)
    ra, _dec = motion.position_at(wrapped[1].mjd + 10.0 * DAYS_PER_YEAR)
    assert 0.0 <= ra < 0.01


def test_target_at_gives_the_grid_pixel() -> None:
    grid = geometry.make_grid(150.0, -30.0, 0.1667, 3.075)
    track = [position(i + 1, years, north_per_year=10.0) for i, years in enumerate((0.0, 1.0))]
    motion = track_motion(track)
    assert motion is not None
    # Diez anios antes de la primera epoca estaba 100" al sur: 32,5 pixeles mas abajo.
    target = target_at(motion, MJD0 - 10.0 * DAYS_PER_YEAR, grid)
    assert target is not None and target.in_field
    assert target.x == pytest.approx(97.0, abs=0.01)
    assert target.y == pytest.approx(97.0 - 100.0 / 3.075, abs=0.02)
    # Cien anios antes ya estaba fuera del campo.
    far = target_at(motion, MJD0 - 100.0 * DAYS_PER_YEAR, grid)
    assert far is not None and not far.in_field


@pytest.mark.parametrize(
    ("name", "alias"),
    [
        ("NAME Luhman 16", "luhman-16"),
        ("NAME Barnard's star", "barnard-s-star"),
        ("V* R Dra", "r-dra"),
        ("* eps Ind B", "eps-ind-b"),
        ("M 82", "m-82"),
        ("WISEA J085510.74-071442.5", "wisea-j085510-74-071442-5"),
        ("Wolf 359", "wolf-359"),
    ],
)
def test_object_alias(name: str, alias: str) -> None:
    assert object_alias(name) == alias


# ------------------------------------------------- contra los campos del repositorio

# Texto que se le pregunto a Sesame por cada objeto de prueba, y la respuesta guardada.
SAVED = {
    "NAME Barnard's star": "barnard_s_star.xml",
    "* eps Ind B": "epsilon_indi_b.xml",
    "WISEA J085510.74-071442.5": "wise_j085510_83_071442_5.xml",
}
# Fechas de 2MASS y de WISE de esos campos (MJD), las mas lejanas a las que se lleva la posicion.
OLD_DATES = (51175.0, 51700.0, 55300.0, 55500.0)


@pytest.mark.parametrize("name", sorted(SAVED))
def test_track_motion_matches_the_catalog_motion(name: str) -> None:
    """La posicion llevada 16 a 27 anios atras coincide con la del movimiento propio del catalogo."""
    entries = {entry.name: entry for entry in list_fields(get_settings().precomputed_fields_dir)}
    if name not in entries:
        pytest.skip(f"el campo de {name} no esta en data/fields")
    entry = entries[name]
    assert entry.track is not None
    estimated = track_motion(entry.track.positions)
    assert estimated is not None

    target = parse_sesame((FIXTURES / "sesame" / SAVED[name]).read_text(encoding="utf-8"), name)
    assert target is not None
    assert estimated.per_year_arcsec == pytest.approx(catalog_motion.per_year_arcsec(target), abs=0.12)
    for mjd in OLD_DATES:
        ra, dec = estimated.position_at(mjd)
        expected_ra, expected_dec = catalog_motion.position_at(target, mjd)
        separation = geometry.angular_separation_deg(ra, dec, expected_ra, expected_dec) * 3600.0
        # Menos de un pixel de la grilla base (3,075"): alcanza para la mira.
        assert separation < 3.0, (name, mjd, separation)
