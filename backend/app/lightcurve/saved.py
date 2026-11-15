"""Curvas de luz guardadas por campo precalculado: `data/lightcurves/fields/<id>.json.gz`.

La imagen publica no lleva los recortes, asi que la curva de cada fuente que
tiene espectro guardado (`app/spectrum/saved.py`: el objeto con nombre del campo
y sus fuentes mas brillantes) se mide una vez con
`scripts/precompute_field_lightcurves.py` y queda en el repositorio. El archivo
de un campo es JSON compacto con gzip:

    { version, field, name, computed_at,
      sources: [ { kind, ra, dec, positions, status, document } ] }

`ra`, `dec` y `positions` son los de la fuente en el archivo de espectros, y un
pedido se ajusta a la fuente mas cercana con el mismo radio que el espectro, asi
la pestana de la curva muestra la misma fuente que la del espectro.
"""

from __future__ import annotations

import gzip
import json
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any

from app.spectrum.saved import SNAP_RADIUS_ARCSEC, nearest_source

FIELDS_SUBDIR = "fields"
FILE_VERSION = 1
MEMORY_FILES = 2

_lock = threading.Lock()
_memory: OrderedDict[Path, tuple[int, dict[str, Any]]] = OrderedDict()


def field_curves_path(directory: Path, field_id: str) -> Path:
    """Archivo de curvas guardadas del campo, dentro de la carpeta `data/lightcurves`."""
    return directory / FIELDS_SUBDIR / f"{field_id}.json.gz"


def load_field_curves(directory: Path, field_id: str) -> dict[str, Any] | None:
    """El archivo de curvas del campo, o `None` si no tiene o no se puede interpretar."""
    path = field_curves_path(directory, field_id)
    try:
        stamp = path.stat().st_mtime_ns
    except OSError:
        return None
    with _lock:
        cached = _memory.get(path)
        if cached is not None and cached[0] == stamp:
            _memory.move_to_end(path)
            return cached[1]
    try:
        document = json.loads(gzip.decompress(path.read_bytes()).decode("utf-8"))
    except (OSError, ValueError, EOFError):
        return None
    if not isinstance(document, dict) or not isinstance(document.get("sources"), list):
        return None
    with _lock:
        _memory[path] = (stamp, document)
        while len(_memory) > MEMORY_FILES:
            _memory.popitem(last=False)
    return document


def saved_lightcurve(
    directory: Path, field_id: str, ra: float, dec: float, *, radius_arcsec: float = SNAP_RADIUS_ARCSEC
) -> tuple[bool, dict[str, Any] | None]:
    """Curva guardada para un punto de un campo: `(el campo tiene archivo, documento o None)`.

    El documento es el de la fuente guardada mas cercana si esta dentro del
    radio; si el campo tiene archivo pero no hay ninguna fuente cerca, o esa
    fuente no tiene curva, devuelve `(True, None)`.
    """
    saved = load_field_curves(directory, field_id)
    if saved is None:
        return False, None
    nearest = nearest_source(saved, ra, dec)
    if nearest is None or nearest.offset_arcsec > radius_arcsec:
        return True, None
    document = saved["sources"][nearest.index].get("document")
    return True, document if isinstance(document, dict) else None
