"""Compresion gzip de las respuestas, negociada con `Accept-Encoding`.

Envuelve al `GZipResponder` de Starlette, que es el que comprime, y cambia solo
como se decide si el cliente acepta gzip: Starlette busca el texto `gzip` en la
cabecera, asi que `gzip;q=0` (un rechazo) le parece un si. Aca decide
`app.api.headers.accepts_gzip`, la misma funcion con la que `/aux` negocia.

Que pasa con cada respuesta cuando el cliente acepta gzip:

- JSON, JavaScript, CSS, HTML, los planos y el cubo (el contrato permite gzip
  negociado para los binarios): salen comprimidos si pesan `minimum_size` bytes
  o mas, con `Content-Encoding: gzip` y `Vary: Accept-Encoding`. Las demas
  cabeceras no cambian; en particular `Cache-Control: immutable` de un plano
  pedido con su revision vigente. El cubo, que se envia por tramos, pierde el
  `Content-Length`.
- El flujo de eventos no se toca: ni se comprime ni pasa por un buffer, cada
  evento sale entero cuando se publica. Starlette ya deja pasar
  `text/event-stream`; ademas aca no se envuelve ninguna ruta `.../events`.
- `/aux` ya llega con `Content-Encoding: gzip` (se sirve como esta en disco) y
  queda como esta: no se comprime dos veces.
- Imagenes y fuentes ya comprimidas (JPEG, PNG, WOFF2) quedan como estan.

Si el cliente no acepta gzip la respuesta sale exactamente como la armo la ruta.
"""

from __future__ import annotations

from starlette.datastructures import Headers
from starlette.middleware.gzip import GZipResponder
from starlette.types import ASGIApp, Receive, Scope, Send

from app.api.headers import accepts_gzip

# Respuestas mas chicas que esto no se comprimen: la envoltura de gzip pesa mas que lo que ahorra.
GZIP_MINIMUM_SIZE = 1024
# Nivel de compresion. Un plano Float32 es casi todo ruido y no baja mucho con ningun nivel (lo que
# se gana son las zonas `NaN`); el 6 cuesta bastante menos tiempo de CPU que el 9.
GZIP_LEVEL = 6
# Final de la ruta del flujo de eventos (`GET /api/field/{id}/events`).
EVENTS_SUFFIX = "/events"


class NegotiatedGZipMiddleware:
    """Comprime con gzip las respuestas de los pedidos que lo aceptan (ver el encabezado del modulo)."""

    def __init__(self, app: ASGIApp, minimum_size: int = GZIP_MINIMUM_SIZE, compresslevel: int = GZIP_LEVEL) -> None:
        self.app = app
        self.minimum_size = minimum_size
        self.compresslevel = compresslevel

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] == "http"
            and not str(scope.get("path", "")).endswith(EVENTS_SUFFIX)
            and accepts_gzip(Headers(scope=scope).get("accept-encoding"))
        ):
            responder = GZipResponder(self.app, self.minimum_size, compresslevel=self.compresslevel)
            await responder(scope, receive, send)
            return
        await self.app(scope, receive, send)
