"""Ruta `GET /api/spectrum` (SPEC.md, seccion 3.2).

    GET /api/spectrum?ra=133.7598&dec=-7.2422&field=<id>

- `ra`, `dec`: punto a medir, grados ICRS.
- `field` (opcional): id del campo que se esta mirando; limita la busqueda a
  sus recortes. `not_found` si ese campo no existe.
- `pm_ra`, `pm_dec` (opcionales, mas/anio; `pm_ra` incluye cos(dec)) y `epoch`
  (anio juliano de `ra` y `dec`, por defecto 2026,0): si el objeto se mueve, la
  apertura lo sigue a la fecha de cada exposicion. Son los valores de `motion`
  y `field_center` de `/api/resolve`.

Responde el documento de `service.py`. Una fuente saturada no es un error:
llega con `status: "saturated"`, `points` vacio y el aviso `saturated_source`,
que tiene la forma del aviso del mismo nombre del documento del campo.
Errores, con el cuerpo del contrato: `invalid_request` y `not_found`.

La suma a la aplicacion `create_app` de `app/api/main.py` (`app.include_router(router)`).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from app.config import FIELD_EPOCH, Settings, get_settings
from app.spectrum.lookup import spectrum_for

router = APIRouter()

FIELD_ID_PATTERN = r"^[0-9a-f]{16}$"


@router.get("/api/spectrum")
def get_spectrum(
    request: Request,
    ra: Annotated[float, Query(ge=0.0, le=360.0)],
    dec: Annotated[float, Query(ge=-90.0, le=90.0)],
    field: Annotated[str | None, Query(pattern=FIELD_ID_PATTERN)] = None,
    pm_ra: Annotated[float | None, Query(ge=-1.0e5, le=1.0e5)] = None,
    pm_dec: Annotated[float | None, Query(ge=-1.0e5, le=1.0e5)] = None,
    epoch: Annotated[float, Query(ge=1990.0, le=2100.0)] = FIELD_EPOCH,
) -> JSONResponse:
    # Ruta sincronica a proposito: FastAPI la corre en un hilo, y medir cientos de recortes lleva segundos.
    settings = getattr(request.app.state, "settings", None)
    if not isinstance(settings, Settings):
        settings = get_settings()
    document = spectrum_for(ra, dec, settings, field=field, pm_ra=pm_ra, pm_dec=pm_dec, epoch=epoch)
    return JSONResponse(document, headers={"Cache-Control": "no-cache"})
