"""Espectros precalculados de los objetos de prueba, guardados en el repositorio.

Los recortes no se versionan (son cientos de megabytes), asi que el espectro de
los cinco objetos de prueba se calcula una vez con `scripts/precompute_spectra.py`
y queda en `data/spectra/`:

    index.json     un renglon por objeto: archivo, nombre y posiciones
    <slug>.json    el documento del espectro, tal como lo arma `service.py`

Un pedido se resuelve con un precalculado cuando el punto cae sobre el objeto:
a menos de `MATCH_RADIUS_ARCSEC` de su posicion de referencia o de la que tenia
en alguna de las epocas (Barnard se corre 10" por anio). Asi el visor recibe el
espectro del objeto aunque el clic no caiga justo en el centro.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import Settings
from app.spectrum.cutouts import separation_deg

INDEX_FILENAME = "index.json"
# Un pixel nativo mide 6,15": un clic a un pixel del objeto todavia es el objeto.
MATCH_RADIUS_ARCSEC = 6.5


@dataclass(frozen=True)
class PrecomputedEntry:
    slug: str
    name: str
    path: Path
    positions: tuple[tuple[float, float], ...]  # (ra, dec) de referencia y de cada epoca

    def distance_arcsec(self, ra: float, dec: float) -> float:
        return min(separation_deg(ra, dec, *position) for position in self.positions) * 3600.0


def spectra_dir(settings: Settings) -> Path:
    """Carpeta de los espectros precalculados (`data/spectra`, versionada)."""
    return settings.data_dir / "spectra"


_lock = threading.Lock()
_cache: dict[Path, tuple[float, list[PrecomputedEntry]]] = {}


def load_index(directory: Path) -> list[PrecomputedEntry]:
    """Lee `index.json`. Devuelve una lista vacia si no existe o no se puede interpretar."""
    index_path = directory / INDEX_FILENAME
    try:
        stamp = index_path.stat().st_mtime
    except OSError:
        return []
    with _lock:
        cached = _cache.get(index_path)
        if cached is not None and cached[0] == stamp:
            return cached[1]
    entries: list[PrecomputedEntry] = []
    try:
        document = json.loads(index_path.read_text(encoding="utf-8"))
        for item in document["objects"]:
            positions = tuple((float(point["ra"]), float(point["dec"])) for point in item["positions"])
            if positions:
                entries.append(
                    PrecomputedEntry(
                        slug=str(item["slug"]),
                        name=str(item["name"]),
                        path=directory / str(item["file"]),
                        positions=positions,
                    )
                )
    except (OSError, ValueError, KeyError, TypeError):
        entries = []
    with _lock:
        _cache[index_path] = (stamp, entries)
    return entries


def find_precomputed(directory: Path, ra: float, dec: float) -> dict[str, Any] | None:
    """Documento precalculado del objeto que esta en `(ra, dec)`, o `None` si ahi no hay ninguno."""
    best: tuple[float, PrecomputedEntry] | None = None
    for entry in load_index(directory):
        distance = entry.distance_arcsec(ra, dec)
        if distance <= MATCH_RADIUS_ARCSEC and (best is None or distance < best[0]):
            best = (distance, entry)
    if best is None:
        return None
    try:
        document = json.loads(best[1].path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return document if isinstance(document, dict) else None
