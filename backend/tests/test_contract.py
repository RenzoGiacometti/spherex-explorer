"""Los modelos de `app.contract` contra los ejemplos y las tablas de docs/contrato-cubo.md.

Si el documento cambia y los modelos no, estos tests fallan.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, get_args

import pytest
from pydantic import TypeAdapter, ValidationError

from app.api.errors import ERROR_RETRYABLE, ERROR_STATUS
from app.contract import (
    EVENT_ADAPTERS,
    DoneEvent,
    ErrorBody,
    ErrorCode,
    EventName,
    FieldMeta,
    FieldRequest,
    FieldRequestInfo,
    FieldResponse,
    FieldWarning,
    PlaneEvent,
    PreviewInfo,
    PriorityRequest,
    Progress,
    ResolveResponse,
    TrackResponse,
    utc_timestamp,
)

CONTRACT_PATH = Path(__file__).resolve().parents[2] / "docs" / "contrato-cubo.md"


@pytest.fixture(scope="module")
def contract_text() -> str:
    if not CONTRACT_PATH.is_file():
        pytest.skip(f"no esta {CONTRACT_PATH}")
    return CONTRACT_PATH.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def examples(contract_text: str) -> dict[str, Any]:
    """Los bloques JSON del documento, identificados por una clave propia de cada uno."""
    found: dict[str, Any] = {}
    for block in re.findall(r"```json\n(.*?)```", contract_text, flags=re.DOTALL):
        document = json.loads(block)
        if "pipeline" in document:
            found["meta"] = document
        elif "events_url" in document:
            found["field_response"] = document
        elif "query" in document:
            found["resolve"] = document
        elif "positions" in document:
            found["track"] = document
        elif "ra" in document:
            found["field_request"] = document
    assert set(found) == {"meta", "field_response", "resolve", "track", "field_request"}
    return found


def _table_codes(text: str, heading: str) -> list[str]:
    """Primera columna (entre acentos graves) de la tabla que sigue a una linea de encabezado."""
    section = text.split(heading, 1)[1]
    codes: list[str] = []
    for line in section.splitlines()[2:]:
        match = re.match(r"^\| `([a-z_]+)` \|", line)
        if not match:
            break
        codes.append(match.group(1))
    return codes


# ---------------------------------------------------------- ejemplos del documento


def test_meta_example_round_trips_field_by_field(examples: dict[str, Any]) -> None:
    meta = FieldMeta.model_validate(examples["meta"])
    assert meta.model_dump(mode="json") == examples["meta"]
    assert json.loads(meta.model_dump_json()) == examples["meta"]
    assert meta.grid is not None and meta.grid.shape == (195, 195)
    assert meta.planes is not None and meta.planes[0].stats is not None
    assert meta.warnings[0].code == "saturated_source"


def test_field_request_example(examples: dict[str, Any]) -> None:
    request = FieldRequest.model_validate(examples["field_request"])
    assert (request.ra, request.dec, request.fov, request.band, request.refresh) == (269.4463, 4.7683, 0.1667, 3, False)
    # Solo ra y dec son obligatorios.
    defaults = FieldRequest.model_validate({"ra": 1.0, "dec": 2.0})
    assert (defaults.fov, defaults.band, defaults.refresh) == (0.1667, 3, False)
    # Un entero vale como numero; un texto o un booleano, no.
    assert FieldRequest.model_validate({"ra": 1, "dec": -2}).dec == -2.0
    for body in [
        {"ra": 1.0},
        {"dec": 2.0},
        {"ra": "x", "dec": 2.0},
        {"ra": "1.0", "dec": 2.0},
        {"ra": 1.0, "dec": 2.0, "band": "3"},
        {"ra": 1.0, "dec": 2.0, "band": True},
        {"ra": 1.0, "dec": 2.0, "band": 3.5},
        {"ra": 1.0, "dec": 2.0, "refresh": 1},
    ]:
        with pytest.raises(ValidationError):
            FieldRequest.model_validate(body)


def test_field_response_example(examples: dict[str, Any]) -> None:
    document = dict(examples["field_response"], meta=examples["meta"])
    response = FieldResponse.model_validate(document)
    assert response.model_dump(mode="json") == document
    assert response.events_url == f"/api/field/{response.id}/events"


def test_resolve_example_round_trips(examples: dict[str, Any]) -> None:
    resolved = ResolveResponse.model_validate(examples["resolve"])
    assert resolved.model_dump(mode="json") == examples["resolve"]
    assert resolved.motion is not None and resolved.motion.per_year_arcsec == 10.39


def test_motion_without_parallax_or_radial_velocity_keeps_nulls(examples: dict[str, Any]) -> None:
    """Si el catalogo trae movimiento propio pero no paralaje o velocidad radial, van como `null`, no como 0."""
    motion = {"pm_ra": -8123.7, "pm_dec": 673.2, "parallax": 439.0, "radial_velocity": None, "per_year_arcsec": 8.15}
    document = dict(examples["resolve"], motion=motion)
    resolved = ResolveResponse.model_validate(document)
    assert resolved.motion is not None and resolved.motion.radial_velocity is None
    assert resolved.model_dump(mode="json")["motion"] == motion
    # Las claves viajan siempre: si faltan en la entrada, salen como `null`.
    partial = ResolveResponse.model_validate(
        dict(document, motion={"pm_ra": 1.0, "pm_dec": 2.0, "per_year_arcsec": 0.0})
    )
    assert partial.model_dump(mode="json")["motion"] == {
        "pm_ra": 1.0, "pm_dec": 2.0, "parallax": None, "radial_velocity": None, "per_year_arcsec": 0.0,
    }  # fmt: skip
    # Un 0 medido se conserva como 0.
    measured = ResolveResponse.model_validate(dict(document, motion=dict(motion, radial_velocity=0.0)))
    assert measured.model_dump(mode="json")["motion"]["radial_velocity"] == 0.0


def test_resolve_for_coordinates_has_nulls() -> None:
    document = {
        "query": "269.4463 4.7683",
        "name": None,
        "source": "coordinates",
        "object_type": None,
        "j2000": {"ra": 269.4463, "dec": 4.7683},
        "motion": None,
        "field_center": {"ra": 269.4463, "dec": 4.7683, "epoch": 2026.0},
        "moved_arcsec": 0.0,
    }
    assert ResolveResponse.model_validate(document).model_dump(mode="json") == document


def test_track_example_round_trips(examples: dict[str, Any]) -> None:
    track = TrackResponse.model_validate(examples["track"])
    assert track.model_dump(mode="json") == examples["track"]
    assert TrackResponse(name="x").model_dump(mode="json") == {"name": "x", "positions": []}


def test_sse_examples_validate(contract_text: str) -> None:
    """Las lineas `data:` del ejemplo de SSE que son JSON completo (las que traen `...` no lo son)."""
    block = contract_text.split("Ejemplo de un campo nuevo:", 1)[1].split("```", 2)[1]
    events = re.findall(r"event: (\w+)\nid: (\d+)\ndata: (.*)", block)
    # Un plano sale dos veces (provisorio y definitivo) y antes de `done` va el `state` con el documento terminado.
    assert [name for name, _, _ in events] == ["state", "listed", "progress", "plane", "plane", "state", "done"]
    assert [int(number) for _, number, _ in events] == sorted(int(number) for _, number, _ in events)
    validated = []
    for name, _, data in events:
        try:
            document = json.loads(data)
        except json.JSONDecodeError:
            continue
        EVENT_ADAPTERS[name].validate_python(document)
        validated.append(name)
    assert validated == ["progress", "done"]


# ------------------------------------------------------------ tablas del documento


def test_error_codes_match_the_table(contract_text: str) -> None:
    rows = re.findall(r"^\| `([a-z_]+)` \| (\d{3}) \|", contract_text, flags=re.MULTILINE)
    assert dict((code, int(status)) for code, status in rows) == ERROR_STATUS
    assert set(get_args(ErrorCode)) == set(ERROR_STATUS) == set(ERROR_RETRYABLE)


def test_event_names_match_the_table(contract_text: str) -> None:
    assert _table_codes(contract_text, "| Evento | `data` | Cuándo |") == list(get_args(EventName))
    assert set(EVENT_ADAPTERS) == set(get_args(EventName))


def test_warning_codes_match_the_table(contract_text: str) -> None:
    documented = _table_codes(contract_text, "| `code` | Parámetros | Significado |")
    samples = {
        "saturated_source": {"ra": 1.0, "dec": 2.0, "radius_arcsec": 14.1, "epochs": [1], "detectors": [1, 2]},
        "plane_empty": {"epoch": 4, "detector": 1},
        "few_exposures": {"epoch": 1, "detector": 1, "n": 3},
        "low_coverage": {"epoch": 1, "detector": 2, "valid_fraction": 0.84},
        "cutouts_failed": {"n": 2, "planes": [{"epoch": 1, "detector": 2}]},
        "stale_exposure_list": {"listed_at": "2026-11-15T06:21:10Z"},
        "full_download": {"reason": "orden de extensiones inesperado"},
    }
    assert documented == list(samples)
    adapter = TypeAdapter(FieldWarning)
    for code, params in samples.items():
        document = {"code": code, **params}
        warning = adapter.validate_python(document)
        assert warning.code == code
        assert adapter.dump_python(warning, mode="json") == document
        # Cada parametro es obligatorio.
        for name in params:
            with pytest.raises(ValidationError):
                adapter.validate_python({key: value for key, value in document.items() if key != name})
    with pytest.raises(ValidationError):
        adapter.validate_python({"code": "desconocido"})


def test_statuses_match_the_document(contract_text: str) -> None:
    for model, name, values in [
        (FieldMeta, "status", ["queued", "listing", "downloading", "ready", "partial", "failed"]),
        (Progress, "phase", ["queued", "listing", "downloading", "finishing", "done"]),
        (PreviewInfo, "status", ["pending", "ready", "unavailable"]),
        (DoneEvent, "status", ["ready", "partial"]),
    ]:
        assert list(get_args(model.model_fields[name].annotation)) == values
        for value in values:
            assert f"`{value}`" in contract_text


# ------------------------------------------------------------------ serializacion


def _queued_meta() -> FieldMeta:
    return FieldMeta(
        id="f3a91c0e52d47b18",
        pipeline="1",
        status="queued",
        request=FieldRequestInfo(ra=269.4463, dec=4.7683, fov=0.1667),
        progress=Progress(phase="queued", queue_position=1),
        preview=PreviewInfo(status="pending", band="W1", wave_um=3.4, hips="x"),
    )


def test_meta_before_listed_omits_what_does_not_exist_yet() -> None:
    document = _queued_meta().model_dump(mode="json")
    assert set(document) == {"id", "pipeline", "status", "rev", "request", "progress", "warnings", "preview"}
    assert document["rev"] == 0
    assert document["warnings"] == []
    assert document["preview"]["display"] is None
    # Los contadores de avance viajan siempre.
    assert document["progress"] == {
        "phase": "queued", "queue_position": 1, "cutouts_total": 0, "cutouts_done": 0, "cutouts_failed": 0,
        "cutouts_cached": 0, "planes_total": 0, "planes_ready": 0, "elapsed_s": 0.0,
    }  # fmt: skip
    # Tambien anidado dentro de la respuesta de POST /api/field y en JSON directo.
    response = FieldResponse(id="f3a91c0e52d47b18", status="queued", events_url="/x", meta=_queued_meta())
    assert "grid" not in response.model_dump(mode="json")["meta"]
    assert "grid" not in json.loads(response.model_dump_json())["meta"]
    # Y se vuelve a leer igual.
    assert FieldMeta.model_validate(document) == _queued_meta()


def test_pending_plane_keeps_null_fields() -> None:
    event = PlaneEvent.model_validate({"plane": {"epoch": 1, "detector": 3, "status": "pending"}})
    assert event.model_dump(mode="json") == {
        "plane": {
            "epoch": 1, "detector": 3, "status": "pending", "rev": 0, "n_exposures": 0, "n_used": 0, "n_failed": 0,
            "mjd_mean": None, "stats": None, "saturated": [], "cube_offset": None,
        },
        "detector_display": None,
    }  # fmt: skip


def test_numbers_must_be_finite_and_in_range() -> None:
    with pytest.raises(ValidationError):
        FieldRequest.model_validate({"ra": float("nan"), "dec": 0.0})
    with pytest.raises(ValidationError):
        Progress.model_validate({"phase": "done", "elapsed_s": float("inf")})
    for band in [0, 7, 2.5, "x"]:
        with pytest.raises(ValidationError):
            PriorityRequest.model_validate({"band": band})
    assert PriorityRequest.model_validate({"band": 6}).band == 6
    with pytest.raises(ValidationError):
        PlaneEvent.model_validate({"plane": {"epoch": 0, "detector": 3, "status": "ready"}})
    with pytest.raises(ValidationError):
        PlaneEvent.model_validate({"plane": {"epoch": 1, "detector": 3, "status": "otro"}})


def test_meta_plane_lookup(examples: dict[str, Any]) -> None:
    meta = FieldMeta.model_validate(examples["meta"])
    plane = meta.plane(1, 1)
    assert plane is not None and plane.n_exposures == 24
    assert meta.plane(2, 1) is None
    assert _queued_meta().plane(1, 1) is None


def test_error_body_shape() -> None:
    document = {"error": {"code": "not_ready", "message": "el plano esta pendiente", "retryable": True}}
    assert ErrorBody.model_validate(document).model_dump(mode="json") == document
    with pytest.raises(ValidationError):
        ErrorBody.model_validate({"error": {"code": "otro", "message": "", "retryable": False}})


def test_utc_timestamp_format() -> None:
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", utc_timestamp())
