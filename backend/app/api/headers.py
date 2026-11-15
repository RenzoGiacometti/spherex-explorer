"""Cabeceras HTTP del contrato (docs/contrato-cubo.md, seccion 4).

Las usan la aplicacion real (`app.api.main`) y el servidor falso (`app.fake`),
para que los dos respondan lo mismo:

- Cache por revision (4.4 y 4.5): con `?rev=N` la respuesta es `immutable`
  solo si N es la revision vigente; si no, la vigente con `no-cache`.
- `X-Plane-Rev` (4.4 y 4.6): la revision que traen un plano y sus capas
  auxiliares.
- `ETag` de los metadatos (4.3) y respuesta `304` a `If-None-Match`.
- Si el cliente acepta gzip, para servir las capas auxiliares como estan en
  disco (seccion 6).
"""

from __future__ import annotations

import hashlib

from fastapi.responses import Response

IMMUTABLE = "public, max-age=31536000, immutable"
NO_CACHE = "no-cache"

BINARY_MEDIA_TYPE = "application/octet-stream"
EVENT_STREAM_MEDIA_TYPE = "text/event-stream"

PLANE_REV_HEADER = "X-Plane-Rev"

# El flujo de eventos no se guarda ni se junta en un buffer intermedio: `X-Accel-Buffering`
# es la cabecera con la que nginx (y otros proxies que la copiaron) deja pasar cada tramo.
SSE_HEADERS: dict[str, str] = {"Cache-Control": NO_CACHE, "X-Accel-Buffering": "no"}


def revision_cache_control(requested: int | None, current: int) -> str:
    """`Cache-Control` de un plano o del cubo pedido con `?rev=N`.

    `immutable` solo si N es la revision vigente: esa URL va a devolver siempre
    esos bytes. Sin `rev`, o con una revision ya reemplazada o que todavia no
    existe, se sirve la vigente con `no-cache`, porque esa URL no corresponde a
    esos bytes.
    """
    return IMMUTABLE if requested is not None and requested == current else NO_CACHE


def etag_of(body: bytes) -> str:
    """`ETag` fuerte de un cuerpo: los primeros 32 hex de su SHA-256, entre comillas."""
    return f'"{hashlib.sha256(body).hexdigest()[:32]}"'


def etag_matches(if_none_match: str | None, etag: str) -> bool:
    """Si la cabecera `If-None-Match` del pedido nombra ese `ETag` (o es `*`). La comparacion es debil."""
    if not if_none_match:
        return False
    known = {item.strip().removeprefix("W/") for item in if_none_match.split(",")}
    return "*" in known or etag in known


def json_with_etag(body: bytes, if_none_match: str | None) -> Response:
    """Respuesta JSON con `Cache-Control: no-cache` y `ETag`; `304` sin cuerpo si el cliente ya tiene ese documento."""
    etag = etag_of(body)
    headers = {"Cache-Control": NO_CACHE, "ETag": etag}
    if etag_matches(if_none_match, etag):
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)


def accepts_gzip(accept_encoding: str | None) -> bool:
    """Si el pedido admite una respuesta con `Content-Encoding: gzip`.

    Mira `gzip` (o `x-gzip`) y, si no figura, el comodin `*`; un peso `q=0` es
    un rechazo. Sin cabecera se responde sin comprimir.
    """
    if not accept_encoding:
        return False
    weights: dict[str, float] = {}
    for item in accept_encoding.split(","):
        name, _, parameters = item.partition(";")
        name = name.strip().lower()
        if not name:
            continue
        weight = 1.0
        for parameter in parameters.split(";"):
            key, _, value = parameter.partition("=")
            if key.strip().lower() == "q":
                try:
                    weight = float(value.strip())
                except ValueError:
                    weight = 0.0
        weights[name] = weight
    for name in ("gzip", "x-gzip", "*"):
        if name in weights:
            return weights[name] > 0.0
    return False
