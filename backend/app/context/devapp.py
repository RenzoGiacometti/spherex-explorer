"""Aplicacion minima para la pagina de prueba del contexto (`/?dev=context` en el frontend).

Trae las rutas de contexto (`app.context.api`) y lo justo del contrato del cubo
para que la pagina pueda mostrar las epocas de SPHEREx de un campo ya armado:

    POST /api/field                              solo campos terminados; 404 si no esta
    GET  /api/field/{id}/plane/{epoch}/{detector}

No arma campos ni toca la red. Los campos se buscan, en orden, en los
precalculados (`data/fields`), en la cache (`cache/fields`), en las carpetas de
`SPHEREX_CONTEXT_DEV_FIELDS` (separadas por `;` en Windows) y en los campos de
muestra de los tests. Como las muestras tienen otra version de pipeline, el
`id` se prueba con las dos.

Se arranca, desde backend/, con:

    uv run uvicorn app.context.devapp:app --port 8000

No reemplaza al backend: cuando `app.api.main` tenga las rutas del contrato,
alcanza con sumarle `context_router` y esta aplicacion sobra.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import Response

from app import __version__, geometry
from app.api.errors import not_found, register_error_handlers
from app.config import SAMPLE_PIPELINE_VERSION, Settings, get_settings
from app.context.api import router as context_router
from app.contract import FINISHED_FIELD_STATUSES, FieldRequest, FieldResponse
from app.jobs.store import FieldStore, StoreError

EXTRA_FIELDS_ENV = "SPHEREX_CONTEXT_DEV_FIELDS"


def _field_store(settings: Settings) -> FieldStore:
    extra = [Path(part) for part in os.environ.get(EXTRA_FIELDS_ENV, "").split(os.pathsep) if part.strip()]
    roots = [settings.precomputed_fields_dir, settings.cached_fields_dir, *extra, settings.fake_fields_dir]
    return FieldStore(settings.cached_fields_dir, roots)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = get_settings() if settings is None else settings
    app = FastAPI(title="SPHEREx Explorer: contexto (pagina de prueba)", version=__version__)
    app.state.settings = settings
    register_error_handlers(app)
    app.include_router(context_router)
    fields = _field_store(settings)

    @app.post("/api/field")
    def post_field(body: FieldRequest) -> FieldResponse:
        """El campo ya armado de ese centro, si existe con el pipeline vigente o como muestra."""
        for pipeline in (settings.pipeline_version, SAMPLE_PIPELINE_VERSION):
            request = geometry.normalize_request(body.ra, body.dec, body.fov, body.band, pipeline=pipeline)
            if not fields.exists(request.field_id):
                continue
            try:
                meta = fields.read_meta(request.field_id)
            except StoreError:
                continue
            if meta.status in FINISHED_FIELD_STATUSES:
                return FieldResponse(
                    id=meta.id, status=meta.status, events_url=f"/api/field/{meta.id}/events", meta=meta
                )
        raise not_found("ese campo no esta armado: esta aplicacion solo sirve campos terminados")

    @app.get("/api/field/{field_id}/plane/{epoch}/{detector}")
    def get_plane(field_id: str, epoch: int, detector: int) -> Response:
        try:
            payload = fields.read_plane_bytes(field_id, epoch, detector)
        except StoreError as exc:
            raise not_found(str(exc)) from exc
        return Response(payload, media_type="application/octet-stream", headers={"Cache-Control": "no-cache"})

    return app


app = create_app()
