"""Modelo de error de la API (contrato, seccion 2).

Toda respuesta de error lleva un codigo HTTP y el cuerpo
`{"error": {"code": "...", "message": "...", "retryable": true}}`. El mensaje
es para el log; el texto que ve la persona lo arma el frontend a partir de `code`.

Cualquier capa del backend puede lanzar `ApiError`; `register_error_handlers`
la convierte en la respuesta.
"""

from __future__ import annotations

import math

from fastapi import FastAPI, Request
from fastapi.exception_handlers import http_exception_handler as default_http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.contract import ErrorBody, ErrorCode, ErrorDetail

# Codigo HTTP de cada `code` (tabla de la seccion 2 del contrato).
ERROR_STATUS: dict[ErrorCode, int] = {
    "invalid_request": 422,
    "not_resolved": 404,
    "not_found": 404,
    "not_ready": 409,
    "no_coverage": 404,
    "queue_full": 429,
    "upstream_unavailable": 503,
}

# Si tiene sentido repetir el mismo pedido mas tarde.
ERROR_RETRYABLE: dict[ErrorCode, bool] = {
    "invalid_request": False,
    "not_resolved": False,
    "not_found": False,
    "not_ready": True,
    "no_coverage": False,
    "queue_full": True,
    "upstream_unavailable": True,
}


class ApiError(Exception):
    """Error que la API devuelve con el cuerpo del contrato.

    `http_status` y `retryable` toman el valor de la tabla del contrato si no se
    indican. `retry_after` (segundos) agrega la cabecera `Retry-After`.
    """

    def __init__(
        self,
        code: ErrorCode,
        http_status: int | None = None,
        message: str = "",
        retryable: bool | None = None,
        *,
        retry_after: float | None = None,
    ) -> None:
        if code not in ERROR_STATUS:
            raise ValueError(f"codigo de error desconocido: {code!r}")
        super().__init__(message or code)
        self.code: ErrorCode = code
        self.http_status = ERROR_STATUS[code] if http_status is None else http_status
        self.message = message or code
        self.retryable = ERROR_RETRYABLE[code] if retryable is None else retryable
        self.retry_after = retry_after

    def body(self) -> ErrorBody:
        """Cuerpo de error del contrato."""
        return ErrorBody(error=ErrorDetail(code=self.code, message=self.message, retryable=self.retryable))

    def headers(self) -> dict[str, str]:
        if self.retry_after is None:
            return {}
        return {"Retry-After": str(max(1, math.ceil(self.retry_after)))}

    def response(self) -> JSONResponse:
        return JSONResponse(
            status_code=self.http_status, content=self.body().model_dump(mode="json"), headers=self.headers()
        )


# Constructores cortos, uno por codigo.


def invalid_request(message: str) -> ApiError:
    """422: coordenadas fuera de rango, `fov` no admitido, `band` fuera de 1 a 6."""
    return ApiError("invalid_request", message=message)


def not_resolved(message: str) -> ApiError:
    """404: Sesame no conoce el nombre."""
    return ApiError("not_resolved", message=message)


def not_found(message: str) -> ApiError:
    """404: no existe ese `id`, plano o capa."""
    return ApiError("not_found", message=message)


def not_ready(message: str) -> ApiError:
    """409: se pidio `/cube` o un plano que todavia no esta construido."""
    return ApiError("not_ready", message=message)


def not_built(message: str, *, job_failed: bool = False) -> ApiError:
    """409 `not_ready` para algo de un campo que todavia no esta construido.

    Si el trabajo fallo (`job_failed`) no va a estarlo: repetir el pedido no
    sirve hasta que otro `POST /api/field` reintente el campo, y por eso va con
    `retryable: false` (contrato, seccion 5).
    """
    if not job_failed:
        return not_ready(message)
    return ApiError("not_ready", message=f"{message}; el trabajo fallo", retryable=False)


def no_coverage(message: str) -> ApiError:
    """404: ninguna exposicion de DR1 o QR3 cubre el punto."""
    return ApiError("no_coverage", message=message)


def queue_full(message: str, retry_after: float = 30.0) -> ApiError:
    """429: cola de trabajos llena; lleva `Retry-After`."""
    return ApiError("queue_full", message=message, retry_after=retry_after)


def upstream_unavailable(message: str, retry_after: float | None = None) -> ApiError:
    """503: IRSA o Sesame no responden y no hay copia en cache."""
    return ApiError("upstream_unavailable", message=message, retry_after=retry_after)


# ----------------------------------------------------------------- manejadores


async def api_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Convierte una `ApiError` en el cuerpo de error del contrato."""
    assert isinstance(exc, ApiError)
    return exc.response()


async def validation_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Un cuerpo o un parametro que FastAPI no pudo interpretar es un `invalid_request`."""
    assert isinstance(exc, RequestValidationError)
    parts = []
    for error in exc.errors():
        location = ".".join(str(item) for item in error.get("loc", ()))
        parts.append(f"{location}: {error.get('msg', '')}".strip(": "))
    return invalid_request("; ".join(parts) or "pedido invalido").response()


async def http_exception_handler(request: Request, exc: Exception) -> Response:
    """Los errores HTTP del framework (ruta inexistente, metodo no admitido) con el mismo cuerpo.

    Una ruta inexistente es `not_found` (404). Los demas 4xx del framework son
    `invalid_request` y salen con 422, que es el unico codigo HTTP que la tabla
    del contrato (seccion 2) le da a ese `code`: un metodo no admitido (405 en
    el framework) llega al cliente como 422. El codigo original queda en el
    mensaje, que es para el log, y las cabeceras del error (por ejemplo `Allow`)
    se conservan.

    El contrato no tiene un codigo para fallas internas: las respuestas 5xx que
    no nacen de una `ApiError` quedan como las arma FastAPI.
    """
    assert isinstance(exc, StarletteHTTPException)
    detail = str(exc.detail)
    if exc.status_code == 404:
        return not_found(detail).response()
    if 400 <= exc.status_code < 500:
        response = invalid_request(f"{detail} (HTTP {exc.status_code})").response()
        for name, value in (exc.headers or {}).items():
            response.headers[name] = value
        return response
    return await default_http_exception_handler(request, exc)


def register_error_handlers(app: FastAPI) -> None:
    """Registra los manejadores para que toda respuesta de error tenga el cuerpo del contrato."""
    app.add_exception_handler(ApiError, api_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
