"""Geometria del campo: escalones, normalizacion, id, grilla y lado del recorte."""

from __future__ import annotations

import hashlib
import math

import pytest

from app import geometry
from app.api.errors import ApiError

# ------------------------------------------------------------------ escalones


def test_steps_match_the_contract_table() -> None:
    base, wide = geometry.FOV_STEPS
    assert (base.name, base.fov, base.pixel_scale_arcsec, base.size) == ("base", 0.1667, 3.075, 195)
    assert (wide.name, wide.fov, wide.pixel_scale_arcsec, wide.size) == ("wide", 0.5, 6.15, 293)
    for step in geometry.FOV_STEPS:
        assert geometry.grid_size(step.fov, step.pixel_scale_arcsec) == step.size
        assert step.size % 2 == 1


@pytest.mark.parametrize(
    ("fov", "expected"),
    [
        (0.02, "base"),
        (0.0833, "base"),  # la vista de 5 minutos usa el cubo base
        (10 / 60, "base"),
        (0.1667, "base"),
        (0.16671, "wide"),
        (0.3, "wide"),
        (0.5, "wide"),
    ],
)
def test_fov_rounds_up_to_the_next_step(fov: float, expected: str) -> None:
    assert geometry.select_step(fov).name == expected


@pytest.mark.parametrize("fov", [0.0, 0.0199, 0.5001, 1.0, -0.1, math.nan, math.inf])
def test_fov_out_of_range_is_rejected(fov: float) -> None:
    with pytest.raises(ApiError) as caught:
        geometry.select_step(fov)
    assert caught.value.code == "invalid_request"
    assert caught.value.http_status == 422


# -------------------------------------------------------------- normalizacion


def test_normalize_defaults_and_rounding() -> None:
    request = geometry.normalize_request(269.446312, 4.768349)
    assert request.ra == 269.4463
    assert request.dec == 4.7683
    assert request.fov == 0.1667
    assert request.band == 3
    assert request.refresh is False
    assert request.step.name == "base"
    assert request.pipeline == "1"


@pytest.mark.parametrize(
    ("ra", "expected"),
    [
        (-10.0, 350.0),
        (360.0, 0.0),
        (725.25, 5.25),
        (359.99996, 0.0),  # al redondear llega a 360 y vuelve a 0
        (-0.00001, 0.0),
        (-0.0, 0.0),
    ],
)
def test_ra_is_wrapped_into_range(ra: float, expected: float) -> None:
    request = geometry.normalize_request(ra, 10.0)
    assert request.ra == expected
    assert 0.0 <= request.ra < 360.0
    assert math.copysign(1.0, request.ra) == 1.0


def test_negative_zero_declination_does_not_change_the_id() -> None:
    plus = geometry.normalize_request(10.0, 0.0)
    minus = geometry.normalize_request(10.0, -0.00001)
    assert math.copysign(1.0, minus.dec) == 1.0
    assert plus.field_id == minus.field_id


@pytest.mark.parametrize(
    ("ra", "dec", "fov", "band"),
    [
        (10.0, 90.1, None, None),
        (10.0, -91.0, None, None),
        (math.nan, 0.0, None, None),
        (10.0, math.inf, None, None),
        (10.0, 0.0, 0.9, None),
        (10.0, 0.0, 0.01, None),
        (10.0, 0.0, None, 0),
        (10.0, 0.0, None, 7),
        (10.0, 0.0, None, True),
    ],
)
def test_invalid_requests_are_rejected(ra: float, dec: float, fov: float | None, band: int | None) -> None:
    with pytest.raises(ApiError) as caught:
        geometry.normalize_request(ra, dec, fov, band)
    assert caught.value.code == "invalid_request"


def test_poles_are_valid() -> None:
    assert geometry.normalize_request(0.0, 90.0).dec == 90.0
    assert geometry.normalize_request(0.0, -90.0).dec == -90.0


# ----------------------------------------------------------------------- id


def test_field_id_is_the_documented_hash() -> None:
    request = geometry.normalize_request(269.4463, 4.7683, 0.1667)
    expected = hashlib.sha256(b"1|269.4463|+4.7683|0.1667").hexdigest()[:16]
    assert request.field_id == expected
    assert len(request.field_id) == 16
    assert all(char in "0123456789abcdef" for char in request.field_id)

    south = geometry.normalize_request(133.7598, -7.2422, 0.5)
    assert south.field_id == hashlib.sha256(b"1|133.7598|-7.2422|0.5000").hexdigest()[:16]


def test_field_id_depends_only_on_geometry_and_pipeline() -> None:
    base = geometry.normalize_request(269.4463, 4.7683, 0.1667, band=3)
    assert geometry.normalize_request(269.4463, 4.7683, 0.1667, band=6, refresh=True).field_id == base.field_id
    # 5 y 10 minutos comparten cubo; 30 minutos es otro campo.
    assert geometry.normalize_request(269.4463, 4.7683, 0.0833).field_id == base.field_id
    assert geometry.normalize_request(269.4463, 4.7683, 0.5).field_id != base.field_id
    # Menos de media unidad del cuarto decimal no cambia el campo; mas, si.
    assert geometry.normalize_request(269.44632, 4.76828).field_id == base.field_id
    assert geometry.normalize_request(269.4464, 4.7683).field_id != base.field_id
    # Otra version del pipeline invalida la cache.
    assert geometry.normalize_request(269.4463, 4.7683, pipeline="2").field_id != base.field_id


# -------------------------------------------------------------------- grilla


def test_base_grid_matches_the_contract_example() -> None:
    grid = geometry.build_grid(geometry.normalize_request(269.4463, 4.7683, 0.1667))
    info = geometry.grid_info(grid)
    assert info.projection == "TAN"
    assert info.crval == (269.4463, 4.7683)
    assert info.crpix == (98.0, 98.0)
    assert info.cdelt == pytest.approx((-0.000854167, 0.000854167), abs=1e-9)
    assert info.cdelt[0] < 0 < info.cdelt[1]
    assert info.shape == (195, 195)
    assert info.fov == 0.1667
    assert info.pixel_scale_arcsec == 3.075
    assert info.native_pixel_scale_arcsec == 6.15


def test_wide_grid() -> None:
    grid = geometry.build_grid(geometry.normalize_request(10.0, -30.0, 0.5))
    assert grid.shape == (293, 293)
    assert grid.pixel_scale_arcsec == 6.15
    assert geometry.grid_info(grid).crpix == (147.0, 147.0)


def test_center_falls_on_the_central_pixel() -> None:
    grid = geometry.build_grid(geometry.normalize_request(269.4463, 4.7683))
    x, y = geometry.sky_to_pixel(grid, 269.4463, 4.7683)
    assert x == pytest.approx(97.0, abs=1e-6)
    assert y == pytest.approx(97.0, abs=1e-6)
    ra, dec = geometry.pixel_to_sky(grid, 97.0, 97.0)
    assert ra == pytest.approx(269.4463, abs=1e-9)
    assert dec == pytest.approx(4.7683, abs=1e-9)


def test_north_is_up_and_x_grows_westward() -> None:
    grid = geometry.build_grid(geometry.normalize_request(269.4463, 4.7683))
    step = grid.pixel_scale_arcsec / 3600.0

    # Un pixel al norte: misma columna, una fila mas.
    x, y = geometry.sky_to_pixel(grid, 269.4463, 4.7683 + step)
    assert x == pytest.approx(97.0, abs=1e-4)
    assert y == pytest.approx(98.0, abs=1e-4)

    # Un pixel al este (RA mayor): una columna menos, porque x crece hacia el oeste.
    x, y = geometry.sky_to_pixel(grid, 269.4463 + step / math.cos(math.radians(4.7683)), 4.7683)
    assert x == pytest.approx(96.0, abs=1e-4)
    assert y == pytest.approx(97.0, abs=1e-3)

    # La fila 0 es el borde sur y la columna 0 el borde este.
    _, dec_bottom = geometry.pixel_to_sky(grid, 97.0, 0.0)
    ra_left, _ = geometry.pixel_to_sky(grid, 0.0, 97.0)
    assert dec_bottom < 4.7683
    assert ra_left > 269.4463


def test_pixel_conversion_matches_the_gnomonic_projection() -> None:
    """La cuenta que hace el frontend con crval, crpix y cdelt da lo mismo que el WCS."""
    grid = geometry.build_grid(geometry.normalize_request(133.7598, -7.2422))
    info = geometry.grid_info(grid)
    ra0, dec0 = (math.radians(v) for v in info.crval)
    for ra_deg, dec_deg in [(133.80, -7.20), (133.70, -7.30), (133.7598, -7.2422), (133.84, -7.17)]:
        ra, dec = math.radians(ra_deg), math.radians(dec_deg)
        cos_c = math.sin(dec0) * math.sin(dec) + math.cos(dec0) * math.cos(dec) * math.cos(ra - ra0)
        xi = math.degrees(math.cos(dec) * math.sin(ra - ra0) / cos_c)
        eta = math.degrees(
            (math.cos(dec0) * math.sin(dec) - math.sin(dec0) * math.cos(dec) * math.cos(ra - ra0)) / cos_c
        )
        expected_x = xi / info.cdelt[0] + info.crpix[0] - 1.0
        expected_y = eta / info.cdelt[1] + info.crpix[1] - 1.0
        x, y = geometry.sky_to_pixel(grid, ra_deg, dec_deg)
        assert x == pytest.approx(expected_x, abs=1e-6)
        assert y == pytest.approx(expected_y, abs=1e-6)
        back_ra, back_dec = geometry.pixel_to_sky(grid, x, y)
        assert back_ra == pytest.approx(ra_deg, abs=1e-9)
        assert back_dec == pytest.approx(dec_deg, abs=1e-9)


def test_grid_round_trips_through_the_metadata() -> None:
    grid = geometry.build_grid(geometry.normalize_request(359.9999, 89.5, 0.5))
    rebuilt = geometry.grid_from_info(geometry.grid_info(grid))
    assert rebuilt.shape == grid.shape
    assert rebuilt.pixel_scale_arcsec == grid.pixel_scale_arcsec
    for point in [(359.9, 89.6), (0.3, 89.4)]:
        assert geometry.sky_to_pixel(rebuilt, *point) == pytest.approx(geometry.sky_to_pixel(grid, *point), abs=1e-6)


def test_pixel_to_sky_keeps_ra_in_range_across_zero() -> None:
    grid = geometry.build_grid(geometry.normalize_request(0.0, 0.0))
    ra_east, _ = geometry.pixel_to_sky(grid, 0.0, 97.0)
    ra_west, _ = geometry.pixel_to_sky(grid, 194.0, 97.0)
    assert 0.0 < ra_east < 1.0
    assert 359.0 < ra_west < 360.0


def test_in_grid() -> None:
    grid = geometry.build_grid(geometry.normalize_request(10.0, 10.0))
    assert geometry.in_grid(grid, 0.0, 0.0)
    assert geometry.in_grid(grid, -0.5, 194.49)
    assert not geometry.in_grid(grid, -0.51, 10.0)
    assert not geometry.in_grid(grid, 194.5, 10.0)
    assert not geometry.in_grid(grid, 10.0, 195.0)
    assert not geometry.in_grid(grid, math.nan, 10.0)


# ------------------------------------------------------------------ recortes


def test_cutout_side_matches_the_contract_table() -> None:
    # fov x raiz(2) + 4 px nativos de 6.15 arcsec.
    assert geometry.cutout_side_deg(0.1667) == pytest.approx(0.1667 * math.sqrt(2) + 4 * 6.15 / 3600, abs=1e-5)
    assert geometry.cutout_side_deg(0.1667) == pytest.approx(0.2425, abs=1e-4)
    assert geometry.cutout_side_deg(0.5) == pytest.approx(0.714, abs=1e-4)
    # 142 px nativos para el escalon base, como midio el spike.
    assert round(geometry.cutout_side_deg(0.1667) * 3600 / 6.15) == 142


def test_cutout_covers_the_grid_at_any_rotation() -> None:
    for step in geometry.FOV_STEPS:
        diagonal = step.size * step.pixel_scale_arcsec / 3600.0 * math.sqrt(2)
        assert geometry.cutout_side_deg(step.fov) > diagonal


# -------------------------------------------------------------------- cielo


def test_angular_separation() -> None:
    assert geometry.angular_separation_deg(10.0, 20.0, 10.0, 20.0) == 0.0
    assert geometry.angular_separation_deg(0.0, 0.0, 0.0, 1.0) == pytest.approx(1.0)
    assert geometry.angular_separation_deg(359.5, 0.0, 0.5, 0.0) == pytest.approx(1.0)
    assert geometry.angular_separation_deg(0.0, 60.0, 1.0, 60.0) == pytest.approx(0.5, abs=1e-4)
    assert geometry.angular_separation_deg(0.0, 90.0, 123.0, -90.0) == pytest.approx(180.0)
