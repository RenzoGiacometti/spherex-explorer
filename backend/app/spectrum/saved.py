"""Espectros guardados de las fuentes de un campo precalculado.

La imagen publica no lleva los recortes, asi que ahi no se puede medir. Para
cada campo de `data/fields`, `scripts/precompute_field_spectra.py` detecta las
fuentes mas brillantes sobre los planos del campo (`detect.py`), mide su
espectro sobre los recortes de la cache y deja todo en un archivo versionado:

    data/spectra/fields/<id del campo>.json.gz

JSON compacto comprimido con gzip (sin fecha en el encabezado, para que el
archivo no cambie si los datos no cambian):

    version, field, computed_at
    aperture        geometria de la medicion, como en cada documento
    sources[]       kind       "named" (el objeto del campo) o "detected"
                    ra, dec    posicion de la fuente, grados ICRS
                    positions  [{ra, dec}]: donde se la busca. La detectada tiene una
                               sola; el objeto con nombre, la de referencia y la de
                               cada epoca (Barnard se corre 10" por anio)
                    saturated, peak   de la deteccion
                    document   el espectro, tal como lo arma `service.py`

Un clic se ajusta a la fuente guardada mas cercana si esta a menos de
`SNAP_RADIUS_ARCSEC` de alguna de sus posiciones. La respuesta es el documento de
esa fuente con el aviso `snapped_source` (`ra`, `dec` de la posicion a la que se
ajusto y `offset_arcsec`, la distancia al clic). Si no hay ninguna tan cerca, no
es un error: `no_source_document` arma un documento con `status: "no_source"`,
sin puntos, que dice cual es la mas cercana (`nearest`) y cuantas hay
(`saved_sources`).
"""

from __future__ import annotations

import copy
import gzip
import json
import threading
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.spectrum.cutouts import separation_deg
from app.spectrum.photometry import ApertureConfig
from app.spectrum.service import DOCUMENT_VERSION, NATIVE_PIXEL_ARCSEC

FIELDS_SUBDIR = "fields"
FILE_VERSION = 1
# Radio de ajuste: un poco mas que el de la apertura (9,2"), dos pixeles nativos. Las fuentes
# guardadas estan a mas de 21" entre si, asi que un clic nunca queda dentro del radio de dos.
SNAP_RADIUS_ARCSEC = 12.0
# Archivos interpretados que quedan en memoria: cada uno son unos megabytes de objetos.
MEMORY_FILES = 2


@dataclass(frozen=True)
class Nearest:
    """La fuente guardada mas cercana a un punto, y la posicion suya que quedo mas cerca."""

    index: int
    ra: float
    dec: float
    offset_arcsec: float

    def as_dict(self) -> dict[str, float]:
        return {"ra": round(self.ra, 6), "dec": round(self.dec, 6), "offset_arcsec": round(self.offset_arcsec, 2)}


def field_spectra_path(directory: Path, field_id: str) -> Path:
    """Archivo de espectros guardados del campo, dentro de la carpeta `data/spectra`."""
    return directory / FIELDS_SUBDIR / f"{field_id}.json.gz"


def write_field_spectra(path: Path, document: dict[str, Any]) -> int:
    """Guarda el archivo de un campo: JSON compacto con gzip. Devuelve su peso en bytes."""
    text = json.dumps(document, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as packed:
        packed.write(text.encode("utf-8"))
    tmp.replace(path)
    return path.stat().st_size


_lock = threading.Lock()
_memory: OrderedDict[Path, tuple[int, dict[str, Any]]] = OrderedDict()


def load_field_spectra(directory: Path, field_id: str) -> dict[str, Any] | None:
    """El archivo de espectros del campo, o `None` si no tiene o no se puede interpretar."""
    path = field_spectra_path(directory, field_id)
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


def nearest_source(saved: dict[str, Any], ra: float, dec: float) -> Nearest | None:
    """La fuente guardada mas cercana a `(ra, dec)`, mirando todas sus posiciones. `None` si no hay fuentes."""
    best: Nearest | None = None
    for index, source in enumerate(saved["sources"]):
        for position in source.get("positions") or [{"ra": source["ra"], "dec": source["dec"]}]:
            offset = separation_deg(ra, dec, float(position["ra"]), float(position["dec"])) * 3600.0
            if best is None or offset < best.offset_arcsec:
                best = Nearest(index=index, ra=float(position["ra"]), dec=float(position["dec"]), offset_arcsec=offset)
    return best


def snapped_warning(ra: float, dec: float, offset_arcsec: float) -> dict[str, Any]:
    """Aviso `snapped_source`: el clic se ajusto a una fuente guardada."""
    return {
        "code": "snapped_source",
        "ra": round(ra, 6),
        "dec": round(dec, 6),
        "offset_arcsec": round(offset_arcsec, 2),
    }


def with_snapped_warning(document: dict[str, Any], ra: float, dec: float, offset_arcsec: float) -> dict[str, Any]:
    """Copia del documento guardado con el aviso `snapped_source` al final de `warnings`."""
    answer = dict(document)
    answer["warnings"] = [*document.get("warnings", []), snapped_warning(ra, dec, offset_arcsec)]
    return answer


def no_source_document(
    saved: dict[str, Any], field_id: str, ra: float, dec: float, epoch: float, nearest: Nearest | None
) -> dict[str, Any]:
    """Documento de un clic sin fuente guardada cerca: la forma de los demas, sin puntos."""
    config = ApertureConfig()
    aperture = copy.deepcopy(saved.get("aperture")) or {
        "radius_px": config.radius_px,
        "radius_arcsec": round(config.radius_px * NATIVE_PIXEL_ARCSEC, 2),
        "annulus_in_px": config.annulus_in_px,
        "annulus_out_px": config.annulus_out_px,
        "correction": "none",
    }
    aperture["psf_fwhm_arcsec"] = None
    aperture["enclosed_fraction_gaussian"] = None
    return {
        "version": DOCUMENT_VERSION,
        "status": "no_source",
        "target": {
            "name": None,
            "ra": round(ra, 6),
            "dec": round(dec, 6),
            "epoch": epoch,
            "motion": None,
            "track": [],
        },
        "field": field_id,
        "units": {"wavelength": "um", "flux": "mJy"},
        "aperture": aperture,
        "epochs": [],
        "detectors": [],
        "points": [],
        "binned": [],
        "warnings": [],
        "provenance": {
            "source": "SPHEREx / IRSA",
            "n_exposures": 0,
            "n_points": 0,
            "n_unreadable": 0,
            "processing": [],
            "wave_table": None,
        },
        "source": "precomputed",
        "nearest": None if nearest is None else nearest.as_dict(),
        "saved_sources": len(saved["sources"]),
    }


def saved_spectrum(
    directory: Path, field_id: str, ra: float, dec: float, epoch: float, *, radius_arcsec: float = SNAP_RADIUS_ARCSEC
) -> dict[str, Any] | None:
    """Respuesta para un clic en un campo con espectros guardados; `None` si el campo no tiene archivo.

    Dentro del radio de una fuente, su documento con el aviso `snapped_source`;
    si no, el documento `no_source`.
    """
    saved = load_field_spectra(directory, field_id)
    if saved is None:
        return None
    nearest = nearest_source(saved, ra, dec)
    if nearest is not None and nearest.offset_arcsec <= radius_arcsec:
        document = saved["sources"][nearest.index].get("document")
        if isinstance(document, dict):
            return with_snapped_warning(document, nearest.ra, nearest.dec, nearest.offset_arcsec)
    return no_source_document(saved, field_id, ra, dec, epoch, nearest)
