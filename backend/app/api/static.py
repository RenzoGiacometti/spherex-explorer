"""Frontend compilado (`frontend/dist`), servido por el backend en el despliegue de un solo proceso.

Cabeceras de cache:

- `/assets/...`: Vite le pone a cada archivo un hash de su contenido en el
  nombre, asi que esa URL devuelve siempre los mismos bytes. Salen con
  `Cache-Control: public, max-age=31536000, immutable`.
- Todo lo demas (`index.html` y lo que haya en la raiz, que no lleva hash):
  `no-cache`. El navegador lo revalida con el `ETag` que ya pone `StaticFiles`
  y recibe un `304` si no cambio; despues de un redeploy ve enseguida el
  `index.html` nuevo, que apunta a los archivos nuevos de `/assets`.

La compresion no se hace aca: la aplica `GZipMiddleware` a toda la aplicacion
(`app/api/main.py`).
"""

from __future__ import annotations

import os
from typing import Any

from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

from app.api.headers import IMMUTABLE, NO_CACHE

# Carpeta en la que Vite deja los archivos con hash en el nombre (`build.assetsDir`, por defecto).
HASHED_PREFIX = "/assets/"


class FrontendFiles(StaticFiles):
    """`StaticFiles` con `Cache-Control` segun el archivo: `immutable` en `/assets`, `no-cache` en el resto."""

    def file_response(
        self,
        full_path: str | os.PathLike[str],
        stat_result: os.stat_result,
        scope: Scope,
        status_code: int = 200,
    ) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        # `scope["path"]` es la ruta pedida entera: el frontend se monta en `/`.
        path: Any = scope.get("path", "")
        hashed = isinstance(path, str) and path.startswith(HASHED_PREFIX)
        # Vale tambien para el `304`: sin la cabecera, el navegador se quedaria con la politica anterior.
        response.headers["Cache-Control"] = IMMUTABLE if hashed else NO_CACHE
        return response
