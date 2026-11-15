"""Rutas del contexto para cualquier campo: el precalculado si existe y, si no, armado en vivo.

    GET /api/live/context?ra=&dec=&fov=              documento de contexto
    GET /api/live/context/gaia?ra=&dec=&fov=         fuentes de Gaia DR3 del campo
    GET /api/live/survey?ra=&dec=&fov=&layer=        una capa en Float32 (`wise_w2` por defecto)

Son las mismas tres rutas de `app.context.api` bajo el prefijo `/api/live`, con
las mismas respuestas. La diferencia es que no se limitan a los campos
precalculados: para un campo nuevo piden a IRSA el recorte de WISE y las
fuentes de Gaia, con un plazo corto (`app.context.live`), y lo dejan en la
cache. El frontend usa el mismo cliente con otro prefijo:
`createContextApi({ baseUrl: "/api/live" })`.

Para un campo nuevo, cada ruta arma solo lo que necesita: `/survey` la capa,
`/context/gaia` las fuentes, y `/context` las dos, una detras de la otra. Lo
normal es pedir primero `/survey`, que es lo que se muestra mientras carga
SPHEREx (2 a 9 s la primera vez, del disco despues).

Si IRSA no responde a tiempo la respuesta es `503 upstream_unavailable`, con el
cuerpo de error del contrato y `Retry-After`: no es un error del campo, que
carga igual. Durante ese lapso la ruta contesta lo mismo sin volver a pedirle
nada a IRSA. Una capa que no existe o que no se arma en vivo (las de 2MASS)
responde `404 not_found`.

En `/context`, una parte que no se pudo armar simplemente falta (`surveys`
vacio o `gaia` en `null`); responde 503 solo si no hay ninguna.

Para montarlas, una linea en `create_app`:

    app.include_router(live_router)
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response

from app import geometry
from app.api.errors import not_found, upstream_unavailable
from app.config import Settings, get_settings
from app.context import live
from app.context.live_service import LiveContextService, PartUnavailable, get_service
from app.context.store import ContextDocument
from app.domain import NormalizedRequest

# Lo armado en vivo no cambia: son relevamientos cerrados.
CACHE_CONTROL = "public, max-age=3600"

router = APIRouter(prefix="/api/live", tags=["context-live"])


def _settings(request: Request) -> Settings:
    settings = getattr(request.app.state, "settings", None)
    return settings if isinstance(settings, Settings) else get_settings()


def _service(settings: Annotated[Settings, Depends(_settings)]) -> LiveContextService:
    return get_service(settings)


def _field(
    settings: Annotated[Settings, Depends(_settings)],
    ra: Annotated[float, Query(description="Centro del campo, grados ICRS")],
    dec: Annotated[float, Query(description="Centro del campo, grados ICRS")],
    fov: Annotated[float | None, Query(description="Lado del campo en grados; por defecto 0.1667")] = None,
) -> NormalizedRequest:
    # Mismos limites y mismo redondeo que `POST /api/field`; lanza `invalid_request`.
    return geometry.normalize_request(ra, dec, fov, pipeline=settings.pipeline_version)


Service = Annotated[LiveContextService, Depends(_service)]
Field = Annotated[NormalizedRequest, Depends(_field)]


def _unavailable(exc: PartUnavailable) -> Exception:
    """El error de la API que corresponde: 404 si esa parte no existe, 503 si IRSA no respondio."""
    if exc.permanent:
        return not_found(str(exc))
    return upstream_unavailable(str(exc), retry_after=max(1.0, exc.retry_after))


@router.get("/context/gaia")
def live_gaia(service: Service, field: Field) -> Response:
    """Fuentes de Gaia DR3 del campo, con el formato de `gaia.json`."""
    try:
        payload = service.gaia_bytes(field)
    except PartUnavailable as exc:
        raise _unavailable(exc) from exc
    return Response(payload, media_type="application/json", headers={"Cache-Control": CACHE_CONTROL})


@router.get("/context")
def live_context(service: Service, field: Field) -> ContextDocument:
    """Documento de contexto del campo, con lo que haya: precalculado, o WISE y Gaia armados en vivo."""
    try:
        return service.document(field)
    except PartUnavailable as exc:
        raise _unavailable(exc) from exc


@router.get("/survey")
def live_layer(
    service: Service,
    field: Field,
    layer: Annotated[str, Query(description="Clave de la capa; en vivo, `wise_w2` o `wise_w1`")] = live.DEFAULT_LAYER,
) -> Response:
    """Una capa en la grilla del campo: `ny x nx` Float32 little-endian, fila 0 = sur."""
    try:
        payload = service.layer_bytes(field, layer)
    except PartUnavailable as exc:
        raise _unavailable(exc) from exc
    return Response(payload, media_type="application/octet-stream", headers={"Cache-Control": CACHE_CONTROL})
