"""Aplicacion de prueba del contexto, segunda tanda: suma las rutas en vivo y las de la capa optica.

Es `app.context.devapp` (rutas de contexto precalculado y lo justo del contrato
del cubo para ver las epocas de SPHEREx de un campo ya armado) mas:

- `app.context.api_live`: `/api/live/*`, contexto de cualquier campo, en vivo;
- `app.context.api_optical`, si esta: la capa optica del Digitized Sky Survey.

La usan las paginas de prueba `/?dev=ficha` y `/?dev=cortina` del frontend.
Desde backend/:

    uv run uvicorn app.context.devapp2:app --port 8000

Igual que `devapp`, no arma campos de SPHEREx. Las rutas en vivo si le piden a
IRSA el recorte de WISE y las fuentes de Gaia de un campo que no este guardado.
"""

from __future__ import annotations

import importlib

from fastapi import FastAPI

from app.config import Settings
from app.context.api_live import router as live_router
from app.context.devapp import create_app as create_base_app


def create_app(settings: Settings | None = None) -> FastAPI:
    app = create_base_app(settings)
    app.include_router(live_router)
    try:
        optical = importlib.import_module("app.context.api_optical")
    except ModuleNotFoundError:
        optical = None  # la capa optica es opcional: depende de que algun servicio de DSS responda
    if optical is not None:
        app.include_router(optical.router)
    return app


app = create_app()
