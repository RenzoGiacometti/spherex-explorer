"""Aplicacion real del backend.

Por ahora solo registra el modelo de error y `GET /api/health`. Las rutas del
contrato se agregan cuando esten el gestor de trabajos y el resto del pipeline.
Para desarrollar el frontend mientras tanto esta `app.fake`.

Se arranca con: uv run uvicorn app.api.main:app --port 8000
"""

from __future__ import annotations

from fastapi import FastAPI

from app import __version__
from app.api.errors import register_error_handlers
from app.config import Settings, get_settings


def create_app(settings: Settings | None = None) -> FastAPI:
    """Crea la aplicacion FastAPI con la configuracion dada (por defecto, la del entorno)."""
    settings = get_settings() if settings is None else settings
    app = FastAPI(title="SPHEREx Explorer API", version=__version__)
    app.state.settings = settings
    register_error_handlers(app)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "pipeline": settings.pipeline_version}

    return app


app = create_app()
