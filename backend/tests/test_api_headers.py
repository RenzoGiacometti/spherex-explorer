"""Piezas chicas de la aplicacion real y del servidor falso: cabeceras, `not_built` y vigencia de una trayectoria."""

from __future__ import annotations

import hashlib

import pytest

from app.api.backend import events_url, track_is_current
from app.api.errors import not_built
from app.api.headers import (
    IMMUTABLE,
    NO_CACHE,
    PLANE_REV_HEADER,
    SSE_HEADERS,
    accepts_gzip,
    etag_matches,
    etag_of,
    json_with_etag,
    revision_cache_control,
)
from app.contract import EpochInfo, FieldMeta, FieldRequestInfo, PreviewInfo, Progress, TrackPosition, TrackResponse


def test_revision_cache_control_is_immutable_only_for_the_current_revision() -> None:
    assert revision_cache_control(2, 2) == IMMUTABLE == "public, max-age=31536000, immutable"
    for requested in (None, 0, 1, 3):
        assert revision_cache_control(requested, 2) == NO_CACHE == "no-cache", requested
    # Una revision 0 pedida explicitamente tambien es la vigente si el recurso esta en la 0.
    assert revision_cache_control(0, 0) == IMMUTABLE
    assert PLANE_REV_HEADER == "X-Plane-Rev"
    assert SSE_HEADERS == {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def test_etag_is_a_quoted_digest_of_the_body() -> None:
    body = b'{"id":"abc"}'
    etag = etag_of(body)
    assert etag == f'"{hashlib.sha256(body).hexdigest()[:32]}"'
    assert etag_of(body) == etag and etag_of(body + b" ") != etag


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        (None, False),
        ("", False),
        ('"abc"', True),
        ('W/"abc"', True),
        ('"otro", "abc"', True),
        ('"otro" , W/"abc" ', True),
        ("*", True),
        ('"otro"', False),
        ("abc", False),
    ],
)
def test_if_none_match(header: str | None, expected: bool) -> None:
    assert etag_matches(header, '"abc"') is expected


def test_json_with_etag_answers_304_without_a_body() -> None:
    body = b'{"id":"abc"}'
    full = json_with_etag(body, None)
    assert (full.status_code, full.body, full.media_type) == (200, body, "application/json")
    assert full.headers["cache-control"] == "no-cache" and full.headers["etag"] == etag_of(body)
    same = json_with_etag(body, etag_of(body))
    assert (same.status_code, same.body) == (304, b"")
    assert same.headers["etag"] == etag_of(body) and same.headers["cache-control"] == "no-cache"
    assert json_with_etag(body, '"otro"').status_code == 200


@pytest.mark.parametrize(
    ("header", "expected"),
    [
        (None, False),
        ("", False),
        ("gzip", True),
        ("GZIP", True),
        ("x-gzip", True),
        ("gzip, deflate, br, zstd", True),
        ("deflate, gzip;q=0.8", True),
        ("gzip;q=0", False),
        ("gzip; q=0.0, identity", False),
        ("gzip;q=malo", False),
        ("identity", False),
        ("deflate, br", False),
        ("*", True),
        ("identity;q=1, *;q=0", False),
        ("br, *;q=0.1", True),
        ("gzip;q=0, *", False),
        (" , gzip", True),
    ],
)
def test_accepts_gzip(header: str | None, expected: bool) -> None:
    assert accepts_gzip(header) is expected


def test_not_built_is_retryable_unless_the_job_failed() -> None:
    waiting = not_built("el plano todavia no esta construido")
    assert (waiting.code, waiting.http_status, waiting.retryable) == ("not_ready", 409, True)
    assert waiting.message == "el plano todavia no esta construido"
    failed = not_built("el plano todavia no esta construido", job_failed=True)
    assert (failed.code, failed.http_status, failed.retryable) == ("not_ready", 409, False)
    assert failed.message == "el plano todavia no esta construido; el trabajo fallo"


def test_events_url() -> None:
    assert events_url("f3a91c0e52d47b18") == "/api/field/f3a91c0e52d47b18/events"


def _meta(mjds: list[float]) -> FieldMeta:
    return FieldMeta(
        id="abc",
        pipeline="1",
        status="ready",
        request=FieldRequestInfo(ra=10.0, dec=20.0, fov=0.1667),
        epochs=[
            EpochInfo(
                epoch=number, start="2025-08-15", end="2025-10-01", mjd_start=mjd - 1, mjd_end=mjd + 1, mjd_mean=mjd,
                n_exposures=3,
            )
            for number, mjd in enumerate(mjds, start=1)
        ],
        progress=Progress(phase="done"),
        preview=PreviewInfo(status="unavailable", band="W1", wave_um=3.4, hips=""),
    )  # fmt: skip


def _track(points: list[tuple[int, float]]) -> TrackResponse:
    positions = [
        TrackPosition(epoch=epoch, mjd=mjd, ra=10.0, dec=20.0, x=97.0, y=97.0, in_field=True) for epoch, mjd in points
    ]
    return TrackResponse(name="x", positions=positions)


def test_a_saved_track_is_current_while_its_dates_are_the_ones_of_the_epochs() -> None:
    meta = _meta([60914.90004, 61116.24996])
    # Las posiciones llevan la fecha media de su epoca, con 4 decimales (contrato 4.9).
    assert track_is_current(_track([(1, 60914.9), (2, 61116.25)]), meta)
    # Otra fecha (un `refresh` sumo exposiciones), una epoca de mas o de menos: ya no sirve.
    assert not track_is_current(_track([(1, 60914.9), (2, 61116.2501)]), meta)
    assert not track_is_current(_track([(1, 60914.9)]), meta)
    assert not track_is_current(_track([(1, 60914.9), (2, 61116.25), (3, 61300.0)]), meta)
    assert not track_is_current(_track([(1, 60914.9), (1, 60914.9)]), meta)
    assert not track_is_current(_track([(2, 60914.9), (1, 61116.25)]), meta)
    # Sin posiciones (objeto sin movimiento propio) no depende de las epocas.
    assert track_is_current(_track([]), meta) and track_is_current(_track([]), _meta([]))
