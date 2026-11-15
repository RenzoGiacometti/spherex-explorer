"""De un pedido `GET /api/lightcurve` al documento: precalculado, o medido sobre los recortes en cache.

Mismo orden que el espectro (`app/spectrum/lookup.py`):

1. Si el punto cae sobre uno de los objetos precalculados (`data/lightcurves`),
   se devuelve ese documento. No hace falta tener los recortes.
   Con `field` de un campo que tiene curvas guardadas (`saved.py`), la de la
   fuente guardada mas cercana; si no hay ninguna cerca, `not_found`. Con
   `SPHEREX_PRECOMPUTED_ONLY` nunca se mide: lo que no esta guardado es `not_found`.
2. Si no, se buscan en la cache los recortes que cubren el punto; con `field`,
   solo los de ese campo.
3. Se mide (`service.compute_lightcurve`) y el resultado queda en memoria
   mientras no cambien los recortes.

Nunca sale a la red: un campo sin recortes en disco responde `not_found`.
"""

from __future__ import annotations

import math
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

from app.api.errors import invalid_request, not_found
from app.config import FIELD_EPOCH, Settings
from app.domain import ResolvedTarget
from app.jobs.store import FieldStore, StoreError
from app.lightcurve.saved import saved_lightcurve
from app.lightcurve.service import LightcurveError, compute_lightcurve
from app.spectrum.cutouts import covering_cutouts, cutout_dirs, list_cutouts
from app.spectrum.lookup import CUTOUT_MARGIN_PX
from app.spectrum.precomputed import find_precomputed
from app.spectrum.service import SpectrumTarget

MEMORY_ENTRIES = 16

_lock = threading.Lock()
_memory: OrderedDict[tuple[Any, ...], dict[str, Any]] = OrderedDict()


def lightcurves_dir(settings: Settings) -> Path:
    """Carpeta de las curvas precalculadas (`data/lightcurves`, versionada)."""
    return settings.data_dir / "lightcurves"


def _field_center(field: str, settings: Settings) -> tuple[float, float]:
    try:
        meta = FieldStore.from_settings(settings).read_meta(field)
    except (StoreError, OSError, ValueError) as exc:
        raise not_found(f"no existe el campo {field!r}") from exc
    return float(meta.request.ra), float(meta.request.dec)


def _target(ra: float, dec: float, pm_ra: float | None, pm_dec: float | None, epoch: float) -> SpectrumTarget:
    if (pm_ra is None) != (pm_dec is None):
        raise invalid_request("pm_ra y pm_dec van juntos")
    if pm_ra is None or pm_dec is None or (pm_ra == 0 and pm_dec == 0):
        return SpectrumTarget(ra=ra, dec=dec, epoch=epoch)
    motion = ResolvedTarget(query="", ra=ra, dec=dec, pm_ra=pm_ra, pm_dec=pm_dec, ref_epoch=epoch)
    return SpectrumTarget(ra=ra, dec=dec, epoch=epoch, motion=motion)


def lightcurve_for(
    ra: float,
    dec: float,
    settings: Settings,
    *,
    field: str | None = None,
    pm_ra: float | None = None,
    pm_dec: float | None = None,
    epoch: float = FIELD_EPOCH,
) -> dict[str, Any]:
    """Documento de la curva de luz del punto `(ra, dec)`. Lanza `ApiError` (`invalid_request` o `not_found`)."""
    if not (math.isfinite(ra) and math.isfinite(dec) and math.isfinite(epoch)):
        raise invalid_request("ra, dec y epoch tienen que ser numeros finitos")
    if not -90.0 <= dec <= 90.0:
        raise invalid_request(f"dec={dec!r} fuera de rango: se admite de -90 a 90 grados")
    ra %= 360.0

    precomputed = find_precomputed(lightcurves_dir(settings), ra, dec)
    if precomputed is not None:
        return precomputed

    # Campo precalculado con curvas guardadas (`saved.py`): como en el espectro, vale lo guardado,
    # aunque los recortes esten en disco. Asi la respuesta es la misma en local y en la imagen publica.
    if field is not None:
        has_file, saved = saved_lightcurve(lightcurves_dir(settings), field, ra, dec)
        if saved is not None:
            return saved
        if has_file:
            raise not_found(
                "en este campo solo hay curvas de luz guardadas de sus fuentes mas brillantes "
                "y el punto no esta cerca de ninguna"
            )
    if settings.precomputed_only:
        # Igual que /api/field en ese modo: nunca se mide sobre recortes.
        raise not_found("este servidor solo sirve las curvas de luz guardadas y en ese punto no hay ninguna")

    center = None if field is None else _field_center(field, settings)
    cutouts = covering_cutouts(list_cutouts(cutout_dirs(settings)), ra, dec, margin_px=CUTOUT_MARGIN_PX, center=center)
    if not cutouts:
        raise not_found("no hay recortes en la cache que cubran el punto: el campo todavia no se bajo")

    newest = 0
    for cutout in cutouts:
        try:
            newest = max(newest, cutout.path.stat().st_mtime_ns)
        except OSError:
            continue
    key = (round(ra, 5), round(dec, 5), field, pm_ra, pm_dec, epoch, len(cutouts), newest)
    with _lock:
        cached = _memory.get(key)
        if cached is not None:
            _memory.move_to_end(key)
            return cached
    try:
        document = compute_lightcurve(cutouts, _target(ra, dec, pm_ra, pm_dec, epoch), field_id=field)
    except LightcurveError as exc:
        raise not_found(str(exc)) from exc
    document["source"] = "computed"
    with _lock:
        _memory[key] = document
        while len(_memory) > MEMORY_ENTRIES:
            _memory.popitem(last=False)
    return document
