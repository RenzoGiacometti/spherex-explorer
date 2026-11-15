"""Aplicacion suelta con las rutas de la curva de luz y del espectro, para probar sin el resto del backend.

    uv run uvicorn app.lightcurve.server:app --port 8003
    curl "http://127.0.0.1:8003/api/lightcurve?ra=248.1672&dec=66.7550"

Usa el mismo modelo de error que la aplicacion real. Cuando las rutas se sumen
a `app/api/main.py` (`app.include_router(router)`), este archivo se puede borrar.
"""

from __future__ import annotations

from fastapi import FastAPI

from app import __version__
from app.api.errors import register_error_handlers
from app.config import Settings, get_settings
from app.lightcurve.router import router as lightcurve_router
from app.spectrum.router import router as spectrum_router


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = get_settings() if settings is None else settings
    app = FastAPI(title="SPHEREx Explorer: curva de luz y espectro", version=__version__)
    app.state.settings = settings
    register_error_handlers(app)
    app.include_router(lightcurve_router)
    app.include_router(spectrum_router)
    return app


app = create_app()
