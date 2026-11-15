"""Rutas de solo lectura de la capa optica de un campo (Digitized Sky Survey). Sirven lo precalculado.

    GET /api/context/optical?ra=&dec=&fov=            documento de capas opticas (`OpticalDocument`)
    GET /api/survey/optical?ra=&dec=&fov=&layer=      una capa en Float32 (`dss2_red`, `dss1`)

`ra`, `dec` y `fov` se normalizan igual que en `POST /api/field`. Las capas
tienen el formato de un plano del cubo: `ny x nx` Float32 little-endian, fila
0 = sur, `NaN` sin datos. Los valores son densidades de placa con el fondo
restado, no flujos.

Un campo sin capa optica guardada, o una capa que no existe, responde
`404 not_found` con el cuerpo de error del contrato.

Para montarlas, una linea en `create_app`:

    app.include_router(optical_router)
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response

from app import geometry
from app.api.errors import not_found
from app.config import Settings, get_settings
from app.context import optical
from app.context.store import ContextNotFoundError, ContextStore, context_key

CACHE_CONTROL = "public, max-age=3600"

router = APIRouter(prefix="/api", tags=["context-optical"])


def _settings(request: Request) -> Settings:
    settings = getattr(request.app.state, "settings", None)
    return settings if isinstance(settings, Settings) else get_settings()


def _store(settings: Annotated[Settings, Depends(_settings)]) -> ContextStore:
    return ContextStore.from_settings(settings)


def _key(
    ra: Annotated[float, Query(description="Centro del campo, grados ICRS")],
    dec: Annotated[float, Query(description="Centro del campo, grados ICRS")],
    fov: Annotated[float | None, Query(description="Lado del campo en grados; por defecto 0.1667")] = None,
) -> str:
    normalized = geometry.normalize_request(ra, dec, fov)
    return context_key(normalized.ra, normalized.dec, normalized.fov)


Store = Annotated[ContextStore, Depends(_store)]
Key = Annotated[str, Depends(_key)]


@router.get("/context/optical")
def optical_document(store: Store, key: Key) -> optical.OpticalDocument:
    """Que placas del Digitized Sky Survey hay para el campo, con su fecha, su banda y su titular."""
    try:
        return optical.read_document(store, key)
    except ContextNotFoundError as exc:
        raise not_found(str(exc)) from exc


@router.get("/survey/optical")
def optical_layer(
    store: Store,
    key: Key,
    layer: Annotated[str, Query(description="Clave de la capa: `layers[].key` del documento")],
) -> Response:
    """Una placa en la grilla del campo: `ny x nx` Float32 little-endian, fila 0 = sur."""
    try:
        payload = optical.read_layer_bytes(store, key, layer)
    except ContextNotFoundError as exc:
        raise not_found(str(exc)) from exc
    return Response(payload, media_type="application/octet-stream", headers={"Cache-Control": CACHE_CONTROL})
