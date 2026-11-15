"""Interpretacion de un texto como coordenadas (contrato, seccion 4.8)."""

from __future__ import annotations

import pytest

from app.api.errors import ApiError
from app.resolve.coords import parse_coordinates

# WISE 0855 tal como lo da CLAUDE.md: RA 08h55m10.831s, Dec -07d14m42.53s.
WISE0855 = (15.0 * (8 + 55 / 60 + 10.831 / 3600), -(7 + 14 / 60 + 42.53 / 3600))
MINUS = chr(0x2212)  # signo menos tipografico


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("269.4463 4.7683", (269.4463, 4.7683)),
        ("269.4463, +4.7683", (269.4463, 4.7683)),
        (" 269.4463,4.7683 ", (269.4463, 4.7683)),
        ("133.7598 -7.2422", (133.7598, -7.2422)),
        ("133.7598\t-7.2422", (133.7598, -7.2422)),
        ("10 20", (10.0, 20.0)),
        (".5 -.25", (0.5, -0.25)),
        ("0 90", (0.0, 90.0)),
        ("0 -90", (0.0, -90.0)),
    ],
)
def test_decimal_degrees(text: str, expected: tuple[float, float]) -> None:
    assert parse_coordinates(text) == pytest.approx(expected, abs=1e-12)


@pytest.mark.parametrize("text", ["400 10", "629.4463 4.7683", "360 0", "-10 20", "-0.00000000000000001 0", "400,5 10"])
def test_ra_out_of_range_is_an_error_and_does_not_wrap(text: str) -> None:
    with pytest.raises(ApiError) as caught:
        parse_coordinates(text)
    assert (caught.value.code, caught.value.http_status) == ("invalid_request", 422)
    assert "ra" in caught.value.message


def test_ra_limits() -> None:
    assert parse_coordinates("0 0") == (0.0, 0.0)
    assert parse_coordinates("-0 0") == (0.0, 0.0)
    assert parse_coordinates("359.9999 0") == (359.9999, 0.0)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("269,4463 +4,7683", (269.4463, 4.7683)),
        ("269,4463 4,7683", (269.4463, 4.7683)),
        ("269,4463, +4,7683", (269.4463, 4.7683)),
        ("269,4463,+4,7683", (269.4463, 4.7683)),
        ("269,4463 4.7683", (269.4463, 4.7683)),
        ("133,7598 -7,2422", (133.7598, -7.2422)),
        ("10,5 20", (10.5, 20.0)),
        # Con punto decimal la coma sigue separando los dos valores.
        ("269.4463, +4.7683", (269.4463, 4.7683)),
        ("269.4463,4.7683", (269.4463, 4.7683)),
        ("10,20", (10.0, 20.0)),
        # Signo menos tipografico.
        (f"133.7598 {MINUS}7.2422", (133.7598, -7.2422)),
        (f"133,7598 {MINUS}7,2422", (133.7598, -7.2422)),
    ],
)
def test_decimal_comma_and_typographic_minus(text: str, expected: tuple[float, float]) -> None:
    assert parse_coordinates(text) == pytest.approx(expected, abs=1e-12)


@pytest.mark.parametrize(
    "text",
    [
        "08h55m10,831s -07d14m42,53s",
        f"08h55m10.831s {MINUS}07d14m42.53s",
        "08:55:10,831 -07:14:42,53",
        "08 55 10,831 -07 14 42,53",
    ],
)
def test_sexagesimal_with_decimal_comma_or_typographic_minus(text: str) -> None:
    assert parse_coordinates(text) == pytest.approx(WISE0855, abs=1e-9)


def test_the_two_forms_from_the_public_site() -> None:
    assert parse_coordinates("08h55m10.831s -07d14m42.53s") == pytest.approx((133.795129, -7.245147), abs=1e-6)
    assert parse_coordinates("17h57m47s +04d46m06s") == pytest.approx((269.445833, 4.768333), abs=1e-6)


def test_decimal_comma_out_of_range_is_an_error() -> None:
    for text in ("10,5 95,5", "08h55m10,5s -91d00m00,5s"):
        with pytest.raises(ApiError) as caught:
            parse_coordinates(text)
        assert caught.value.code == "invalid_request"


@pytest.mark.parametrize(
    "text",
    [
        "08h55m10.831s -07d14m42.53s",
        "08h55m10.831s, -07d14m42.53s",
        "08H55M10.831S -07D14M42.53S",
        "8h 55m 10.831s  -7d 14m 42.53s",
        "08h55m10.831 -07d14m42.53",
        "08:55:10.831 -07:14:42.53",
        "08:55:10.831,-07:14:42.53",
        "08 55 10.831 -07 14 42.53",
        "08h55m10.831s -07\u00b014'42.53\"",
        "08h55m10.831s -07\u00b014\u203242.53\u2033",
    ],
)
def test_sexagesimal_with_ra_in_hours(text: str) -> None:
    assert parse_coordinates(text) == pytest.approx(WISE0855, abs=1e-9)


def test_sexagesimal_sign_and_limits() -> None:
    # Sin signo es positivo, y el signo vale para toda la declinacion, tambien con 0 grados.
    assert parse_coordinates("17:57:48.5 04:41:36") == pytest.approx((269.4520833, 4.6933333), abs=1e-6)
    assert parse_coordinates("17:57:48.5 +04:41:36") == pytest.approx((269.4520833, 4.6933333), abs=1e-6)
    assert parse_coordinates("00:00:00 -00:30:00") == pytest.approx((0.0, -0.5), abs=1e-12)
    assert parse_coordinates("23:59:59.99 +90:00:00") == pytest.approx((359.99995833, 90.0), abs=1e-6)


@pytest.mark.parametrize(
    "text",
    [
        "10 95",
        "10, -90.0001",
        "24:00:00 +10:00:00",
        "25h00m00s +10d00m00s",
        "25:00:00 +10:00:00",
        "08:60:00 +10:00:00",
        "08:55:60 +10:00:00",
        "08:55:10 +10:60:00",
        "08:55:10 +10:00:60",
        "08:55:10 +90:00:01",
        "08h55m10s -91d00m00s",
    ],
)
def test_out_of_range_is_an_invalid_request_and_not_a_name(text: str) -> None:
    with pytest.raises(ApiError) as caught:
        parse_coordinates(text)
    assert (caught.value.code, caught.value.http_status) == ("invalid_request", 422)


@pytest.mark.parametrize(
    "text",
    [
        "",
        "   ",
        "Barnard's Star",
        "WISE J085510.83-071442.5",
        "M 31",
        "NGC 1068",
        "47 Tuc",
        "855",
        "10 20 30",
        "10 20 30 40",
        "08:55:10.831",
        "08h55m10.831s",
        "1e2 3",
        "10 20 abc",
        "HD 12 34 56 +01 02 03",
    ],
)
def test_names_are_not_coordinates(text: str) -> None:
    assert parse_coordinates(text) is None
