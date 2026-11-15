"""Aplicacion real del backend: los endpoints del contrato (docs/contrato-cubo.md, seccion 4).

Se arranca con:

    uv run uvicorn app.api.main:app --port 8000 --timeout-graceful-shutdown 5

Un solo proceso (sin `--workers`): el limite de 10 descargas hacia IRSA, la
cola de trabajos y la proteccion de la cache de recortes valen por proceso
(contrato, seccion 10).

`--timeout-graceful-shutdown` es para poder detenerlo con un flujo de eventos
abierto: uvicorn espera a que cierren las conexiones antes de avisarle a la
aplicacion que termina, y el flujo de un campo que esta cargando dura minutos.
Pasado ese plazo corta las conexiones y recien ahi se detiene el gestor.

Como esta armado:

- El gestor de trabajos (`app.jobs.manager.JobManager`) se crea al arrancar la
  aplicacion y se detiene al cerrarla. Los trabajos corren en sus hilos y no
  dependen de ninguna conexion: si el navegador se va, el campo se termina de
  armar y queda en cache.
- Las rutas son `async` y no bloquean el bucle: todo lo que toca el disco, los
  candados del gestor o Sesame va a un hilo (`run_in_threadpool`). Lo que hace
  cada una esta en `app.api.backend.ApiBackend`; aca solo se arma la respuesta.
- El flujo de eventos espera cada evento del gestor con un tope de
  `settings.sse_ping_s`; si no llega ninguno manda el comentario `: ping`. Se
  cierra despues de `done` o `error`, o cuando el gestor se detiene.
- Errores: toda respuesta de error sale con el cuerpo del contrato
  (`app.api.errors`), tambien las del framework y las rutas que no existen.
- No hay CORS: el frontend llega por el mismo origen (el proxy de `/api` de
  Vite en desarrollo). El servidor falso si lo tiene, porque es de desarrollo.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import FastAPI, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response, StreamingResponse

from app import __version__
from app.api.backend import ApiBackend
from app.api.errors import register_error_handlers
from app.api.headers import (
    BINARY_MEDIA_TYPE,
    EVENT_STREAM_MEDIA_TYPE,
    NO_CACHE,
    PLANE_REV_HEADER,
    SSE_HEADERS,
    accepts_gzip,
    json_with_etag,
    revision_cache_control,
)
from app.config import Settings, get_settings
from app.contract import FieldRequest, PriorityRequest
from app.jobs.deps import JobDeps
from app.jobs.events import PING, FieldEvent, encode_sse
from app.jobs.manager import JobManager
from app.jobs.store import cube_nbytes

# Silencio minimo entre dos `: ping`, por si la configuracion trae un valor que no sirve.
_MIN_PING_S = 0.01


async def sse_body(stream: AsyncIterator[FieldEvent], ping_s: float) -> AsyncIterator[bytes]:
    """Cuerpo de `GET .../events`: cada evento del flujo en formato SSE y un `: ping` tras `ping_s` sin eventos.

    Termina cuando termina el flujo (despues de `done` o `error`, o porque el
    gestor se detuvo). Cancelar la espera de un evento para mandar el ping no
    pierde nada: `FieldStream` no es un generador. Al salir, tambien si el
    cliente corto la conexion, el flujo se cierra y deja de recibir eventos; el
    trabajo sigue.
    """
    try:
        while True:
            try:
                event = await asyncio.wait_for(anext(stream), ping_s)
            except TimeoutError:
                yield PING
                continue
            except StopAsyncIteration:
                return
            yield encode_sse(event)
    finally:
        close = getattr(stream, "close", None)
        if close is not None:
            close()


def create_app(
    settings: Settings | None = None, *, deps: JobDeps | None = None, manager: JobManager | None = None
) -> FastAPI:
    """Crea la aplicacion FastAPI con la configuracion dada (por defecto, la del entorno).

    `deps` reemplaza las funciones externas del gestor de trabajos y `manager`
    es un gestor ya armado, que la aplicacion usa sin detenerlo al cerrar: los
    dos son para los tests. Sin ellos el gestor se crea al arrancar, con las
    funciones reales, y se detiene al cerrar.
    """
    if settings is None:
        settings = manager.settings if manager is not None else get_settings()
    backend = ApiBackend(settings, deps=deps, manager=manager)
    ping_s = max(settings.sse_ping_s, _MIN_PING_S)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        await run_in_threadpool(backend.start)
        try:
            yield
        finally:
            await run_in_threadpool(backend.stop)

    app = FastAPI(title="SPHEREx Explorer API", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.state.backend = backend
    register_error_handlers(app)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "pipeline": settings.pipeline_version}

    @app.post("/api/field")
    async def post_field(body: FieldRequest) -> JSONResponse:
        status_code, response = await run_in_threadpool(backend.submit, body)
        return JSONResponse(status_code=status_code, content=response.model_dump(mode="json"))

    @app.get("/api/field/{field_id}/events")
    async def get_events(field_id: str) -> StreamingResponse:
        stream = await run_in_threadpool(backend.subscribe, field_id)
        return StreamingResponse(
            sse_body(stream, ping_s), media_type=EVENT_STREAM_MEDIA_TYPE, headers=dict(SSE_HEADERS)
        )

    @app.get("/api/field/{field_id}/meta")
    async def get_meta(field_id: str, request: Request) -> Response:
        meta = await run_in_threadpool(backend.meta, field_id)
        body = meta.model_dump_json().encode("utf-8")
        return json_with_etag(body, request.headers.get("if-none-match"))

    @app.get("/api/field/{field_id}/plane/{epoch}/{detector}")
    async def get_plane(
        field_id: str, epoch: int, detector: int, rev: Annotated[int | None, Query(ge=0)] = None
    ) -> Response:
        data, plane = await run_in_threadpool(backend.plane, field_id, epoch, detector)
        headers = {"Cache-Control": revision_cache_control(rev, plane.rev), PLANE_REV_HEADER: str(plane.rev)}
        return Response(content=data, media_type=BINARY_MEDIA_TYPE, headers=headers)

    @app.get("/api/field/{field_id}/cube")
    async def get_cube(field_id: str, rev: Annotated[int | None, Query(ge=0)] = None) -> StreamingResponse:
        meta, chunks = await run_in_threadpool(backend.cube, field_id)

        async def body() -> AsyncIterator[bytes]:
            for chunk in chunks:
                yield chunk

        headers = {"Cache-Control": revision_cache_control(rev, meta.rev), "Content-Length": str(cube_nbytes(meta))}
        return StreamingResponse(body(), media_type=BINARY_MEDIA_TYPE, headers=headers)

    @app.get("/api/field/{field_id}/aux/{epoch}/{detector}")
    async def get_aux(field_id: str, epoch: int, detector: int, request: Request) -> Response:
        gzipped = accepts_gzip(request.headers.get("accept-encoding"))
        data, plane = await run_in_threadpool(backend.aux, field_id, epoch, detector, gzipped=gzipped)
        headers = {"Cache-Control": NO_CACHE, "Vary": "Accept-Encoding", PLANE_REV_HEADER: str(plane.rev)}
        if gzipped:
            headers["Content-Encoding"] = "gzip"
        return Response(content=data, media_type=BINARY_MEDIA_TYPE, headers=headers)

    @app.get("/api/field/{field_id}/preview")
    async def get_preview(field_id: str) -> Response:
        data = await run_in_threadpool(backend.preview, field_id)
        return Response(content=data, media_type=BINARY_MEDIA_TYPE, headers={"Cache-Control": NO_CACHE})

    @app.get("/api/field/{field_id}/track")
    async def get_track(field_id: str, name: str) -> JSONResponse:
        track = await run_in_threadpool(backend.track, field_id, name)
        return JSONResponse(content=track.model_dump(mode="json"))

    @app.post("/api/field/{field_id}/priority", status_code=204)
    async def post_priority(field_id: str, body: PriorityRequest) -> Response:
        await run_in_threadpool(backend.set_priority, field_id, body.band)
        return Response(status_code=204)

    @app.get("/api/resolve")
    async def get_resolve(name: str) -> JSONResponse:
        resolved = await run_in_threadpool(backend.resolve, name)
        return JSONResponse(content=resolved.model_dump(mode="json"))

    return app


app = create_app()
