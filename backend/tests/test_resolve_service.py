"""Respuestas del contrato para `/api/resolve` (seccion 4.8) y `/api/field/{id}/track` (seccion 4.9).

Sin red: los nombres se resuelven desde una cache de Sesame sembrada con las
respuestas guardadas, y la configuracion no tiene ningun servidor de Sesame, asi
que cualquier consulta que se escape termina en `upstream_unavailable`.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from app import geometry
from app.api.errors import ApiError
from app.config import Settings
from app.contract import FieldMeta, ResolveResponse, TrackResponse
from app.domain import ResolvedTarget
from app.resolve import service
from app.resolve.sesame import cache_path

FIXTURES = Path(__file__).resolve().parent / "fixtures"
FIELDS_DIR = FIXTURES / "fields"

# Texto buscado -> respuesta guardada.
SAVED = {
    "Barnard's Star": FIXTURES / "sesame" / "barnard_s_star.xml",
    "Epsilon Indi B": FIXTURES / "sesame" / "epsilon_indi_b.xml",
    "WISE J085510.83-071442.5": FIXTURES / "sesame" / "wise_j085510_83_071442_5.xml",
    "R Draconis": FIXTURES / "sesame" / "r_draconis.xml",
    "RW Aurigae": FIXTURES / "sesame" / "rw_aurigae.xml",
    "Abell 2218": FIXTURES / "sesame_extra" / "abell_2218.xml",
    "M 87": FIXTURES / "sesame_extra" / "m_87.xml",
}


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    """Configuracion sin servidores de Sesame y con los nombres guardados ya en la cache."""
    # Carpeta de datos vacia: los nombres guardados con el repositorio no cuentan en estos tests.
    result = Settings(data_dir=tmp_path / "data", cache_dir=tmp_path / "cache", sesame_urls=())
    for query, source in SAVED.items():
        target = cache_path(query, result)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    return result


def load_meta(folder: str) -> FieldMeta:
    return FieldMeta.model_validate_json((FIELDS_DIR / folder / "meta.json").read_text(encoding="utf-8"))


def load_track(folder: str) -> TrackResponse:
    (path,) = (FIELDS_DIR / folder).glob("track_*.json")
    return TrackResponse.model_validate(json.loads(path.read_text(encoding="utf-8")))


# ------------------------------------------------------------------- resolve


def test_barnard_is_the_example_of_the_contract(settings: Settings) -> None:
    """El JSON de la seccion 4.8, tal cual."""
    response = service.resolve("Barnard's Star", settings)
    assert response.model_dump(mode="json") == {
        "query": "Barnard's Star",
        "name": "NAME Barnard's star",
        "source": "sesame",
        "object_type": "BY*",
        "j2000": {"ra": 269.452077, "dec": 4.693365},
        "motion": {
            "pm_ra": -801.551,
            "pm_dec": 10362.394,
            "parallax": 546.976,
            "radial_velocity": -110.11,
            "per_year_arcsec": 10.39,
        },
        "field_center": {"ra": 269.4463, "dec": 4.7683, "epoch": 2026.0},
        "moved_arcsec": 270.4,
    }


def test_wise0855_has_no_radial_velocity(settings: Settings) -> None:
    response = service.resolve("WISE J085510.83-071442.5", settings)
    assert response.name == "WISEA J085510.74-071442.5" and response.object_type == "BD*"
    assert response.field_center.model_dump() == {"ra": 133.7598, "dec": -7.2422, "epoch": 2026.0}
    assert response.motion is not None
    assert response.motion.model_dump() == {
        "pm_ra": -8123.7,
        "pm_dec": 673.2,
        "parallax": 439.0,
        "radial_velocity": None,  # el catalogo no la trae: `null`, no 0
        "per_year_arcsec": 8.15,
    }
    assert response.moved_arcsec == pytest.approx(211.7, abs=0.05)


@pytest.mark.parametrize(
    ("query", "name", "center", "per_year", "radial_velocity"),
    [
        ("Epsilon Indi B", "* eps Ind B", (331.0966, -56.8006), 4.68, None),
        ("R Draconis", "V* R Dra", (248.1672, 66.7550), 0.02, -132.8),
        ("RW Aurigae", "V* RW Aur", (76.9566, 30.4013), 0.02, 15.0),
    ],
)
def test_the_other_test_objects(
    settings: Settings,
    query: str,
    name: str,
    center: tuple[float, float],
    per_year: float,
    radial_velocity: float | None,
) -> None:
    response = service.resolve(query, settings)
    assert response.query == query and response.name == name and response.source == "sesame"
    assert (response.field_center.ra, response.field_center.dec) == center
    assert response.motion is not None
    assert response.motion.per_year_arcsec == per_year and response.motion.radial_velocity == radial_velocity
    # El centro del campo sale normalizado: pedirlo no lo cambia.
    request = geometry.normalize_request(response.field_center.ra, response.field_center.dec)
    assert (request.ra, request.dec) == center


def test_object_without_proper_motion_has_no_motion(settings: Settings) -> None:
    response = service.resolve("Abell 2218", settings)
    assert response.model_dump(mode="json") == {
        "query": "Abell 2218",
        "name": "ACO 2218",
        "source": "sesame",
        "object_type": "ClG",
        "j2000": {"ra": 248.975, "dec": 66.216667},
        "motion": None,
        "field_center": {"ra": 248.975, "dec": 66.2167, "epoch": 2026.0},
        "moved_arcsec": 0.0,
    }


def test_proper_motion_without_parallax(settings: Settings) -> None:
    response = service.resolve("M 87", settings)
    assert response.motion is not None
    assert response.motion.model_dump() == {
        "pm_ra": -8.029,
        "pm_dec": 10.734,
        "parallax": None,
        "radial_velocity": None,
        "per_year_arcsec": 0.01,
    }
    assert response.moved_arcsec == 0.3
    assert (response.field_center.ra, response.field_center.dec) == (187.7059, 12.3912)


@pytest.mark.parametrize(
    ("text", "ra", "dec"),
    [
        ("269.4463 4.7683", 269.4463, 4.7683),
        ("133.7598, -7.2422", 133.7598, -7.2422),
        ("08h55m10.831s -07d14m42.53s", 133.795129, -7.245147),
        ("  08:55:10.83   -07:14:42.5 ", 133.795125, -7.245139),
    ],
)
def test_coordinates_do_not_query_sesame(tmp_path: Path, text: str, ra: float, dec: float) -> None:
    # Sin cache y sin servidores: si consultara, fallaria.
    response = service.resolve(text, Settings(cache_dir=tmp_path / "vacia", sesame_urls=()))
    assert response.source == "coordinates"
    assert response.name is None and response.object_type is None and response.motion is None
    assert (response.j2000.ra, response.j2000.dec) == (ra, dec)
    assert (response.field_center.ra, response.field_center.dec) == (round(ra, 4), round(dec, 4))
    assert response.field_center.epoch == 2026.0 and response.moved_arcsec == 0.0
    assert response.query == " ".join(text.split())
    assert not (tmp_path / "vacia").exists()


def test_the_field_epoch_comes_from_the_settings(tmp_path: Path, settings: Settings) -> None:
    later = Settings(data_dir=settings.data_dir, cache_dir=settings.cache_dir, sesame_urls=(), field_epoch=2027.0)
    response = service.resolve("Barnard's Star", later)
    assert response.field_center.epoch == 2027.0
    assert response.moved_arcsec == pytest.approx(270.4 + 10.39, abs=0.2)


def test_values_are_rounded_and_stay_in_range() -> None:
    target = ResolvedTarget(
        query="x",
        ra=359.9999999,
        dec=-0.00000001,
        source="sesame",
        name="x",
        pm_ra=1.23456789,
        pm_dec=-0.0004,
        parallax=2.00049,
        radial_velocity=-0.12345,
    )
    response = service.build_resolve_response(target)
    document = response.model_dump_json()
    assert (response.j2000.ra, response.j2000.dec) == (0.0, 0.0)
    assert (response.field_center.ra, response.field_center.dec) == (0.0, 0.0)
    assert "-0.0," not in document and "-0.0}" not in document  # `-0.0` no es el `0.0` que espera quien compara
    assert response.motion is not None
    assert response.motion.model_dump() == {
        "pm_ra": 1.235,
        "pm_dec": 0.0,
        "parallax": 2.0,
        "radial_velocity": -0.123,
        "per_year_arcsec": 0.0,
    }
    ResolveResponse.model_validate_json(document)


@pytest.mark.parametrize("text", ["", "   "])
def test_empty_text_is_invalid(settings: Settings, text: str) -> None:
    with pytest.raises(ApiError) as caught:
        service.resolve(text, settings)
    assert caught.value.code == "invalid_request"


def test_coordinates_out_of_range_are_invalid_and_not_a_name(settings: Settings) -> None:
    with pytest.raises(ApiError) as caught:
        service.resolve("120.5 95.0", settings)
    assert caught.value.code == "invalid_request"


def test_a_name_that_is_not_cached_needs_sesame(settings: Settings) -> None:
    with pytest.raises(ApiError) as caught:
        service.resolve("Proxima Centauri", settings)
    assert caught.value.code == "upstream_unavailable" and caught.value.http_status == 503


# --------------------------------------------------------------------- track


@pytest.mark.parametrize(
    ("folder", "query"),
    [
        ("4a2e877f8ee4efd2", "Barnard's Star"),
        ("4022da836c5a1505", "WISE J085510.83-071442.5"),
        ("02a1d503e540822b", "Epsilon Indi B"),
    ],
)
def test_field_track_agrees_with_the_saved_track(settings: Settings, folder: str, query: str) -> None:
    """La trayectoria sobre la grilla y las epocas de cada muestra, contra la que guardo el generador.

    Las fechas no son las mismas: el backend usa `epochs[].mjd_mean` y la
    trayectoria guardada promedia las fechas de los detectores. La diferencia
    es de dias, y en pixeles, de centesimas.
    """
    meta, saved = load_meta(folder), load_track(folder)
    assert meta.epochs is not None

    response = service.field_track(query, meta, settings)

    assert response.name == saved.name
    assert [item.epoch for item in response.positions] == [item.epoch for item in meta.epochs]
    for position, epoch, expected in zip(response.positions, meta.epochs, saved.positions, strict=True):
        assert position.mjd == round(epoch.mjd_mean, 4)
        assert abs(position.mjd - expected.mjd) < 5.0
        assert position.x == pytest.approx(expected.x, abs=0.03)
        assert position.y == pytest.approx(expected.y, abs=0.03)
        assert position.in_field
    TrackResponse.model_validate_json(response.model_dump_json())


def test_track_positions_are_rounded_like_the_saved_ones(settings: Settings) -> None:
    response = service.field_track("Barnard's Star", load_meta("4a2e877f8ee4efd2"), settings)
    for position in response.positions:
        assert position.mjd == round(position.mjd, 4)
        assert position.ra == round(position.ra, 7) and position.dec == round(position.dec, 7)
        assert position.x == round(position.x, 3) and position.y == round(position.y, 3)


def test_track_is_empty_without_proper_motion(settings: Settings) -> None:
    meta = load_meta("4a2e877f8ee4efd2")
    assert service.field_track("Abell 2218", meta, settings) == TrackResponse(name="ACO 2218", positions=[])
    # Unas coordenadas no tienen nombre ni movimiento: `name` es el texto buscado.
    assert service.field_track("269.4463 4.7683", meta, settings) == TrackResponse(name="269.4463 4.7683")


def test_track_needs_the_grid_and_the_epochs(settings: Settings) -> None:
    """Antes de `listed` el documento no trae `grid` ni `epochs`: `not_ready`, no una lista vacia."""
    queued = load_meta("4a2e877f8ee4efd2").model_copy(update={"grid": None, "epochs": None})
    with pytest.raises(ApiError) as caught:
        service.field_track("Barnard's Star", queued, settings)
    assert caught.value.code == "not_ready" and caught.value.http_status == 409 and caught.value.retryable


def test_track_checks_the_name(settings: Settings) -> None:
    meta = load_meta("4a2e877f8ee4efd2")
    with pytest.raises(ApiError) as caught:
        service.field_track("  ", meta, settings)
    assert caught.value.code == "invalid_request"
    with pytest.raises(ApiError) as caught:
        service.field_track("Proxima Centauri", meta, settings)
    assert caught.value.code == "upstream_unavailable"


def test_track_of_an_object_far_from_the_field(settings: Settings) -> None:
    """Barnard sobre el campo de WISE 0855, a 130 grados: no hay pixel que informar."""
    response = service.field_track("Barnard's Star", load_meta("4022da836c5a1505"), settings)
    assert response == TrackResponse(name="NAME Barnard's star", positions=[])
    # R Draconis sobre el campo de Barnard, a 64 grados: sale, fuera del campo.
    response = service.field_track("R Draconis", load_meta("4a2e877f8ee4efd2"), settings)
    assert len(response.positions) == 3 and not any(item.in_field for item in response.positions)
