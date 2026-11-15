"""Modelo de error de la API y aplicacion real minima."""

from __future__ import annotations

from typing import Annotated

import pytest
from fastapi import FastAPI, HTTPException, Query
from fastapi.testclient import TestClient

from app.api import errors
from app.api.errors import ApiError, register_error_handlers
from app.api.main import create_app
from app.config import Settings
from app.contract import ErrorBody, PriorityRequest


def test_defaults_come_from_the_contract_table() -> None:
    expected = {
        "invalid_request": (422, False),
        "not_resolved": (404, False),
        "not_found": (404, False),
        "not_ready": (409, True),
        "no_coverage": (404, False),
        "queue_full": (429, True),
        "upstream_unavailable": (503, True),
    }
    for code, (status, retryable) in expected.items():
        error = ApiError(code, message="detalle")  # type: ignore[arg-type]
        assert (error.http_status, error.retryable, error.message) == (status, retryable, "detalle")
        assert error.body().model_dump(mode="json") == {
            "error": {"code": code, "message": "detalle", "retryable": retryable}
        }


def test_explicit_values_and_unknown_code() -> None:
    error = ApiError("upstream_unavailable", 502, "IRSA devolvio 502", False)
    assert (error.code, error.http_status, error.message, error.retryable) == (
        "upstream_unavailable",
        502,
        "IRSA devolvio 502",
        False,
    )
    assert str(error) == "IRSA devolvio 502"
    with pytest.raises(ValueError):
        ApiError("otro", 500, "x", False)  # type: ignore[arg-type]


def test_shortcuts() -> None:
    assert errors.invalid_request("x").code == "invalid_request"
    assert errors.not_resolved("x").code == "not_resolved"
    assert errors.not_found("x").code == "not_found"
    assert errors.not_ready("x").code == "not_ready"
    assert errors.no_coverage("x").code == "no_coverage"
    assert errors.upstream_unavailable("x").headers() == {}
    full = errors.queue_full("cola llena", retry_after=12.3)
    assert (full.code, full.http_status) == ("queue_full", 429)
    assert full.headers() == {"Retry-After": "13"}


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    register_error_handlers(app)

    @app.get("/boom/{code}")
    async def boom(code: str) -> None:
        if code == "queue_full":
            raise errors.queue_full("cola llena", retry_after=30)
        raise ApiError(code, message=f"fallo {code}")  # type: ignore[arg-type]

    @app.get("/number")
    async def number(value: Annotated[int, Query(ge=1)]) -> dict[str, int]:
        return {"value": value}

    @app.post("/priority")
    async def priority(body: PriorityRequest) -> dict[str, int]:
        return {"band": body.band}

    return TestClient(app)


@pytest.mark.parametrize(
    ("code", "status"),
    [("not_found", 404), ("not_ready", 409), ("no_coverage", 404), ("upstream_unavailable", 503)],
)
def test_handler_returns_the_contract_body(client: TestClient, code: str, status: int) -> None:
    response = client.get(f"/boom/{code}")
    assert response.status_code == status
    body = ErrorBody.model_validate(response.json())
    assert body.error.code == code
    assert body.error.message == f"fallo {code}"
    assert set(response.json()) == {"error"}
    assert set(response.json()["error"]) == {"code", "message", "retryable"}


def test_queue_full_carries_retry_after(client: TestClient) -> None:
    response = client.get("/boom/queue_full")
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "30"
    assert response.json()["error"] == {"code": "queue_full", "message": "cola llena", "retryable": True}


def test_validation_errors_become_invalid_request(client: TestClient) -> None:
    for response in [
        client.get("/number", params={"value": "abc"}),
        client.get("/number", params={"value": 0}),
        client.get("/number"),
        client.post("/priority", json={"band": 9}),
        client.post("/priority", content=b"no es json", headers={"Content-Type": "application/json"}),
    ]:
        assert response.status_code == 422
        body = ErrorBody.model_validate(response.json())
        assert body.error.code == "invalid_request"
        assert body.error.retryable is False
        assert body.error.message
    assert client.get("/number", params={"value": 3}).json() == {"value": 3}


def test_framework_errors_use_the_same_body(client: TestClient) -> None:
    missing = client.get("/no-existe")
    assert missing.status_code == 404
    assert ErrorBody.model_validate(missing.json()).error.code == "not_found"
    # Un metodo no admitido es un 405 del framework: sale como `invalid_request`, con el unico
    # codigo HTTP que la tabla del contrato le da a ese `code`, y conserva la cabecera `Allow`.
    wrong_method = client.post("/number")
    assert wrong_method.status_code == 422
    error = ErrorBody.model_validate(wrong_method.json()).error
    assert (error.code, error.retryable) == ("invalid_request", False)
    assert "405" in error.message
    assert wrong_method.headers["allow"] == "GET"


def test_every_error_code_goes_out_with_the_status_of_the_contract_table() -> None:
    """Ningun camino del manejador de errores del framework produce un par `code`/HTTP fuera de la tabla."""
    app = FastAPI()
    register_error_handlers(app)

    @app.get("/raise/{status}")
    async def raise_status(status: int) -> None:
        raise HTTPException(status_code=status, detail="detalle")

    client = TestClient(app, raise_server_exceptions=False)
    for status in (400, 401, 403, 404, 405, 409, 413, 415, 429):
        response = client.get(f"/raise/{status}")
        code = ErrorBody.model_validate(response.json()).error.code
        assert code == ("not_found" if status == 404 else "invalid_request"), status
        assert response.status_code == errors.ERROR_STATUS[code], status
    # Una falla interna no tiene codigo en el contrato: queda como la arma el framework.
    internal = client.get("/raise/500")
    assert internal.status_code == 500 and "error" not in internal.json()


def test_real_app_has_health_and_the_error_model() -> None:
    client = TestClient(create_app(Settings(pipeline_version="9")))
    assert client.get("/api/health").json() == {"status": "ok", "pipeline": "9"}
    response = client.get("/api/field/0123456789abcdef/meta")
    assert response.status_code == 404
    assert ErrorBody.model_validate(response.json()).error.code == "not_found"
