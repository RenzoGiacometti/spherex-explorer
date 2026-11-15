"""Aplicacion suelta con la ruta del espectro, para probar el modulo sin el resto del backend.

    uv run uvicorn app.spectrum.server:app --port 8002
    curl "http://127.0.0.1:8002/api/spectrum?ra=133.7598&dec=-7.2422"

Usa el mismo modelo de error que la aplicacion real. Cuando la ruta se sume a
`app/api/main.py` (`app.include_router(router)`), este archivo se puede borrar.
"""

from __future__ import annotations

from fastapi import FastAPI

from app import __version__
from app.api.errors import register_error_handlers
from app.config import Settings, get_settings
from app.spectrum.router import router


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = get_settings() if settings is None else settings
    app = FastAPI(title="SPHEREx Explorer: espectro", version=__version__)
    app.state.settings = settings
    register_error_handlers(app)
    app.include_router(router)
    return app


app = create_app()
