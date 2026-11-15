"""Ruta `GET /api/lightcurve`.

    GET /api/lightcurve?ra=248.1672&dec=66.7550&field=<id>

Mismos parametros que `/api/spectrum`: `ra` y `dec` (grados ICRS), `field`
(opcional, id del campo) y `pm_ra`, `pm_dec`, `epoch` (opcionales) para seguir
a un objeto que se mueve.

Responde el documento de `service.py`: brillo relativo contra fecha, por
detector. Que no haya curva no es un error: llega `status: "empty"` y cada serie
dice por que no se pudo (`unstable`, `blended`, `insufficient`), con sus avisos.
Errores, con el cuerpo del contrato: `invalid_request` y `not_found`.

Para sumarla al backend: `app.include_router(router)` en `app/api/main.py`.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from app.config import FIELD_EPOCH, Settings, get_settings
from app.lightcurve.lookup import lightcurve_for

router = APIRouter()

FIELD_ID_PATTERN = r"^[0-9a-f]{16}$"


@router.get("/api/lightcurve")
def get_lightcurve(
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
    document = lightcurve_for(ra, dec, settings, field=field, pm_ra=pm_ra, pm_dec=pm_dec, epoch=epoch)
    return JSONResponse(document, headers={"Cache-Control": "no-cache"})
