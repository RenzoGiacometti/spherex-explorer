"""Recortes de la cache que cubren un punto del cielo.

El espectro no baja nada: usa los recortes que dejo en disco el armado del
campo. El nombre de cada archivo dice de que exposicion es y que zona cubre
(`app/irsa/cutouts.py`, el mismo formato que uso la Etapa 0 en spike/irsa.py):

    <archivo de la exposicion>__<ra>_<dec>_<lado>_img.fits    descarga cortada
    <archivo de la exposicion>__<ra>_<dec>_<lado>_full.fits   descarga completa

con el centro en grados (6 decimales) y el lado en grados. Aca solo se leen los
nombres; el archivo se abre recien al medir.
"""

from __future__ import annotations

import math
import os
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from app.config import BACKEND_DIR, Settings

# Variable de entorno con carpetas adicionales de recortes, separadas como PATH.
CUTOUT_DIRS_ENV = "SPHEREX_SPECTRUM_CUTOUT_DIRS"

# Recortes de la Etapa 0 (git los ignora): sirven de cache si estan en disco.
SPIKE_CUTOUT_DIR = BACKEND_DIR.parent / "spike" / "cache" / "cutouts"

# Lado de un pixel nativo en grados (6,15"), para pasar margenes de pixeles a grados.
NATIVE_PIXEL_DEG = 6.15 / 3600.0

_NAME = re.compile(
    r"^(?P<exposure>.+)__(?P<ra>\d+(?:\.\d+)?)_(?P<dec>[+-]\d+(?:\.\d+)?)_(?P<side>\d+(?:\.\d+)?(?:e[+-]?\d+)?)"
    r"_(?P<mode>img|full)\.fits$"
)


@dataclass(frozen=True)
class CachedCutout:
    """Un recorte en disco, segun su nombre."""

    path: Path
    exposure: str  # nombre del archivo de la exposicion, sin `.fits`
    ra: float  # centro del recorte, grados
    dec: float
    side_deg: float
    mode: str  # "img" o "full"


def parse_cutout_name(path: Path) -> CachedCutout | None:
    """Interpreta el nombre de un recorte de la cache; `None` si no tiene ese formato."""
    match = _NAME.match(path.name)
    if match is None:
        return None
    try:
        ra, dec, side = float(match["ra"]), float(match["dec"]), float(match["side"])
    except ValueError:
        return None
    if not (0.0 <= ra <= 360.0 and -90.0 <= dec <= 90.0 and side > 0.0):
        return None
    return CachedCutout(path=path, exposure=match["exposure"], ra=ra, dec=dec, side_deg=side, mode=match["mode"])


def cutout_dirs(settings: Settings) -> list[Path]:
    """Carpetas donde se buscan recortes: la cache del backend, las de `SPHEREX_SPECTRUM_CUTOUT_DIRS` y la del spike."""
    extra = [Path(part).expanduser() for part in os.environ.get(CUTOUT_DIRS_ENV, "").split(os.pathsep) if part.strip()]
    dirs: list[Path] = []
    for folder in (settings.cutout_cache_dir, *extra, SPIKE_CUTOUT_DIR):
        if folder not in dirs:
            dirs.append(folder)
    return dirs


def list_cutouts(dirs: Iterable[Path]) -> list[CachedCutout]:
    """Todos los recortes con nombre valido de las carpetas dadas. Una carpeta que no existe se saltea."""
    found: list[CachedCutout] = []
    for folder in dirs:
        try:
            entries = list(os.scandir(folder))
        except OSError:
            continue
        for entry in entries:
            if not entry.name.endswith(".fits"):
                continue
            cutout = parse_cutout_name(Path(entry.path))
            if cutout is not None:
                found.append(cutout)
    return found


def separation_deg(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    """Separacion angular entre dos puntos, en grados (formula del haversine)."""
    phi1, phi2 = math.radians(dec1), math.radians(dec2)
    dphi = phi2 - phi1
    dlam = math.radians(ra2 - ra1)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2.0) ** 2
    return math.degrees(2.0 * math.asin(min(1.0, math.sqrt(a))))


def room_deg(cutout: CachedCutout, ra: float, dec: float) -> float:
    """Cuanto falta para que el punto se salga del recorte, en grados, con cualquier giro del detector.

    Es la mitad del lado menos la distancia al centro: positivo si el punto cae
    dentro del circulo inscripto en el recorte.
    """
    return cutout.side_deg / 2.0 - separation_deg(cutout.ra, cutout.dec, ra, dec)


def covering_cutouts(
    cutouts: Sequence[CachedCutout],
    ra: float,
    dec: float,
    *,
    margin_px: float = 3.0,
    center: tuple[float, float] | None = None,
    center_tolerance_deg: float = 3e-4,
) -> list[CachedCutout]:
    """Un recorte por exposicion entre los que contienen el punto con `margin_px` pixeles de aire.

    Si hay varios recortes de la misma exposicion (dos campos que se pisan, o
    dos tamanos), queda el que deja mas lugar alrededor del punto. Con `center`
    solo se consideran los recortes centrados ahi (los de un campo), con
    `center_tolerance_deg` de tolerancia. El resultado va ordenado por
    exposicion.
    """
    margin = margin_px * NATIVE_PIXEL_DEG
    best: dict[str, tuple[float, CachedCutout]] = {}
    for cutout in cutouts:
        if center is not None and separation_deg(cutout.ra, cutout.dec, *center) > center_tolerance_deg:
            continue
        room = room_deg(cutout, ra, dec)
        if room < margin:
            continue
        current = best.get(cutout.exposure)
        if current is None or room > current[0]:
            best[cutout.exposure] = (room, cutout)
    return [best[exposure][1] for exposure in sorted(best)]
