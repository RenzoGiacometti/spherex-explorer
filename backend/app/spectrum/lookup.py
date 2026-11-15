"""De un pedido `GET /api/spectrum` al documento: guardado, o medido sobre los recortes en cache.

Orden:

1. Con `field` de un campo que tiene espectros guardados (`saved.py`: los campos
   precalculados), el clic se ajusta a la fuente guardada mas cercana y responde
   su documento con el aviso `snapped_source`. Si no hay ninguna dentro del
   radio, responde el documento `no_source` (HTTP 200, sin puntos, con la fuente
   mas cercana). En esos campos nunca se mide: la respuesta es la misma con o
   sin recortes en disco.
2. Si el punto cae sobre uno de los objetos precalculados (`precomputed.py`), se
   devuelve ese documento (`source: "precomputed"`), tambien con `snapped_source`.
3. En modo `SPHEREX_PRECOMPUTED_ONLY` se termina aca: `not_found`, como
   `/api/field` en ese modo. Nunca se mide sobre recortes.
4. Si no, se buscan en la cache los recortes que cubren el punto. Con `field`,
   solo los de ese campo (los centrados donde dice su `request`); sin `field`,
   cualquiera que lo cubra. Es el camino de los campos armados en vivo.
5. Se mide (`service.compute_spectrum`) y el resultado queda en memoria mientras
   no cambien los recortes: un espectro lleva de 4 a 11 s (de 258 a 539
   exposiciones).

Nunca sale a la red: un campo sin recortes en disco responde `not_found`.
"""

from __future__ import annotations

import math
import threading
from collections import OrderedDict
from typing import Any

from app.api.errors import invalid_request, not_found
from app.config import FIELD_EPOCH, Settings
from app.domain import ResolvedTarget
from app.jobs.store import FieldStore, StoreError
from app.spectrum.cutouts import CachedCutout, covering_cutouts, cutout_dirs, list_cutouts
from app.spectrum.photometry import ApertureConfig
from app.spectrum.precomputed import find_precomputed_match, spectra_dir
from app.spectrum.saved import saved_spectrum, with_snapped_warning
from app.spectrum.service import SpectrumError, SpectrumTarget, compute_spectrum

# El anillo de fondo llega a 8 px del objeto: el recorte tiene que dejar ese aire.
CUTOUT_MARGIN_PX = 3.0
MEMORY_ENTRIES = 32

_lock = threading.Lock()
_memory: OrderedDict[tuple[Any, ...], dict[str, Any]] = OrderedDict()


def _field_center(field: str, settings: Settings) -> tuple[float, float]:
    """Centro del campo `field`, de su documento de metadatos. `not_found` si no existe."""
    store = FieldStore.from_settings(settings)
    try:
        meta = store.read_meta(field)
    except (StoreError, OSError, ValueError) as exc:
        raise not_found(f"no existe el campo {field!r}") from exc
    return float(meta.request.ra), float(meta.request.dec)


def _target(ra: float, dec: float, pm_ra: float | None, pm_dec: float | None, epoch: float) -> SpectrumTarget:
    if (pm_ra is None) != (pm_dec is None):
        raise invalid_request("pm_ra y pm_dec van juntos")
    if pm_ra is None or pm_dec is None or (pm_ra == 0 and pm_dec == 0):
        return SpectrumTarget(ra=ra, dec=dec, epoch=epoch)
    # La posicion pedida es la de `epoch`; se propaga a la fecha de cada exposicion.
    motion = ResolvedTarget(query="", ra=ra, dec=dec, pm_ra=pm_ra, pm_dec=pm_dec, ref_epoch=epoch)
    return SpectrumTarget(ra=ra, dec=dec, epoch=epoch, motion=motion)


def _signature(cutouts: list[CachedCutout]) -> tuple[int, int]:
    """Cantidad de recortes y fecha del mas nuevo: cambia cuando el campo baja mas exposiciones."""
    newest = 0
    for cutout in cutouts:
        try:
            newest = max(newest, cutout.path.stat().st_mtime_ns)
        except OSError:
            continue
    return len(cutouts), newest


def spectrum_for(
    ra: float,
    dec: float,
    settings: Settings,
    *,
    field: str | None = None,
    pm_ra: float | None = None,
    pm_dec: float | None = None,
    epoch: float = FIELD_EPOCH,
    config: ApertureConfig | None = None,
) -> dict[str, Any]:
    """Documento del espectro del punto `(ra, dec)`. Lanza `ApiError` (`invalid_request` o `not_found`)."""
    if not (math.isfinite(ra) and math.isfinite(dec) and math.isfinite(epoch)):
        raise invalid_request("ra, dec y epoch tienen que ser numeros finitos")
    if not -90.0 <= dec <= 90.0:
        raise invalid_request(f"dec={dec!r} fuera de rango: se admite de -90 a 90 grados")
    ra %= 360.0

    if field is not None:
        saved = saved_spectrum(spectra_dir(settings), field, ra, dec, epoch)
        if saved is not None:
            return saved

    precomputed = find_precomputed_match(spectra_dir(settings), ra, dec)
    if precomputed is not None:
        return with_snapped_warning(*precomputed)

    if settings.precomputed_only:
        # Solo lo guardado, sin medir: como `/api/field` en este modo (app/jobs/manager.py).
        raise not_found("este servidor solo sirve los espectros guardados y en ese punto no hay ninguno")

    center = None if field is None else _field_center(field, settings)
    cutouts = covering_cutouts(list_cutouts(cutout_dirs(settings)), ra, dec, margin_px=CUTOUT_MARGIN_PX, center=center)
    if not cutouts:
        raise not_found("no hay recortes en la cache que cubran el punto: el campo todavia no se bajo")

    key = (round(ra, 5), round(dec, 5), field, pm_ra, pm_dec, epoch, config, *_signature(cutouts))
    with _lock:
        cached = _memory.get(key)
        if cached is not None:
            _memory.move_to_end(key)
            return cached
    try:
        document = compute_spectrum(cutouts, _target(ra, dec, pm_ra, pm_dec, epoch), config=config, field_id=field)
    except SpectrumError as exc:
        raise not_found(str(exc)) from exc
    document["source"] = "computed"
    with _lock:
        _memory[key] = document
        while len(_memory) > MEMORY_ENTRIES:
            _memory.popitem(last=False)
    return document
