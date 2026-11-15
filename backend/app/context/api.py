"""Rutas de solo lectura del contexto de un campo. Sirven lo precalculado; no tocan la red.

    GET /api/context?ra=&dec=&fov=              documento de contexto (`ContextDocument`)
    GET /api/context/gaia?ra=&dec=&fov=         fuentes de Gaia DR3 del campo, por columnas
    GET /api/context/index                      campos que tienen contexto guardado
    GET /api/survey?ra=&dec=&fov=&layer=        una capa en Float32, con el formato de un plano

`ra`, `dec` y `fov` se normalizan igual que en `POST /api/field` (contrato,
seccion 3), asi que el frontend manda los mismos valores que uso para pedir el
campo. `layer` es la clave de `surveys[].key` del documento: `twomass_ks`,
`wise_w2`.

Errores, con el cuerpo del contrato: `invalid_request` (422) si las coordenadas
o el `fov` no son validos, y `not_found` (404) si ese campo no tiene contexto
guardado o no tiene esa capa. Solo hay contexto de los campos precalculados.

Para montarlas en la aplicacion alcanza con una linea en `create_app`:

    app.include_router(context_router)

La pagina de prueba del frontend usa `app.context.devapp`, que ya las trae.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response

from app import geometry
from app.api.errors import not_found
from app.config import Settings, get_settings
from app.context.store import ContextDocument, ContextIndex, ContextNotFoundError, ContextStore, context_key

# Lo guardado no cambia hasta que se vuelve a correr el precalculo: una hora de cache en el navegador.
CACHE_CONTROL = "public, max-age=3600"

router = APIRouter(prefix="/api", tags=["context"])


def _settings(request: Request) -> Settings:
    """La configuracion de la aplicacion (`app.state.settings`), o la del entorno si no la tiene."""
    settings = getattr(request.app.state, "settings", None)
    return settings if isinstance(settings, Settings) else get_settings()


def _store(settings: Annotated[Settings, Depends(_settings)]) -> ContextStore:
    return ContextStore.from_settings(settings)


def _key(
    ra: Annotated[float, Query(description="Centro del campo, grados ICRS")],
    dec: Annotated[float, Query(description="Centro del campo, grados ICRS")],
    fov: Annotated[float | None, Query(description="Lado del campo en grados; por defecto 0.1667")] = None,
) -> str:
    # `normalize_request` lanza `invalid_request` con los mismos limites que `POST /api/field`.
    normalized = geometry.normalize_request(ra, dec, fov)
    return context_key(normalized.ra, normalized.dec, normalized.fov)


Store = Annotated[ContextStore, Depends(_store)]
Key = Annotated[str, Depends(_key)]


@router.get("/context/index")
def context_index(store: Store) -> ContextIndex:
    """Campos con contexto guardado, con su centro, sus capas y la cantidad de fuentes de Gaia."""
    return store.read_index()


@router.get("/context/gaia")
def context_gaia(store: Store, key: Key) -> Response:
    """Fuentes de Gaia DR3 del campo: posicion (epoca 2016,0), movimiento propio, paralaje y magnitud G."""
    try:
        payload = store.read_gaia_bytes(key)
    except ContextNotFoundError as exc:
        raise not_found(str(exc)) from exc
    return Response(payload, media_type="application/json", headers={"Cache-Control": CACHE_CONTROL})


@router.get("/context")
def context_document(store: Store, key: Key) -> ContextDocument:
    """Que capas de otras misiones hay para el campo, con su fecha, y el resumen de Gaia."""
    try:
        return store.read_document(key)
    except ContextNotFoundError as exc:
        raise not_found(str(exc)) from exc


@router.get("/survey")
def survey_layer(
    store: Store,
    key: Key,
    layer: Annotated[str, Query(description="Clave de la capa: `surveys[].key` del documento de contexto")],
) -> Response:
    """Una capa de otra mision en la grilla del campo: `ny x nx` Float32 little-endian, fila 0 = sur."""
    try:
        payload = store.read_layer_bytes(key, layer)
    except ContextNotFoundError as exc:
        raise not_found(str(exc)) from exc
    return Response(payload, media_type="application/octet-stream", headers={"Cache-Control": CACHE_CONTROL})
