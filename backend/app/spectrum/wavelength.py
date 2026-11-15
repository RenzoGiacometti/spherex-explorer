"""Longitud de onda de un pixel de SPHEREx, a partir de la tabla WCS-WAVE.

En una exposicion de SPHEREx cada pixel ve otra longitud de onda (filtro
variable lineal). El archivo la describe con un WCS alternativo `W` de tipo
`WAVE-TAB` (FITS Paper III, seccion 6.1, "-TAB"), declarado en el encabezado de
IMAGE y resuelto con la extension binaria `WCS-WAVE`:

    CTYPE1W = 'WAVE-TAB'   primer eje: longitud de onda central [um]
    CTYPE2W = 'WAVE-TAB'   segundo eje: ancho de banda [um]
    PS1_0W  = 'WCS-WAVE'   extension con la tabla
    PS1_1W  = 'VALUES'     columna con los valores, de forma (nY, nX, 2)
    PS1_2W  = 'X', PS2_2W = 'Y'   columnas con los puntos de control, en pixeles
                                  del detector contados desde 1 (1 a 2040)
    PV1_3W  = 1, PV2_3W = 2       que plano de VALUES es cada eje
    CRVALnW = 1, CDELTnW = 1, CRPIXnW  el pixel del recorte pasa a pixel del
                                       detector: psi = 1 + (p - CRPIXnW)

Esas tarjetas se leyeron de recortes reales (spike/resultados/wcswave.txt). La
tabla resulto identica en todas las exposiciones de un mismo detector (38
recortes completos, tres epocas, DR1 y QR3, procesamiento `l2b-v27`): lo unico
que cambia de un recorte a otro son `CRPIX1W` y `CRPIX2W`, que estan en el
encabezado de IMAGE. Por eso alcanza con una tabla por detector, guardada en
`data/wcs_wave.json` (la arma `scripts/extract_wave_tables.py`), y los recortes
bajados sin WCS-WAVE (los que se cortan antes de EPSF) sirven igual.

La interpolacion es la del estandar: lineal dentro de cada intervalo de los
puntos de control y bilineal sobre VALUES. `scripts/extract_wave_tables.py
--check` la compara con la de astropy/wcslib sobre los recortes completos.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

WAVE_TABLE_PATH = Path(__file__).resolve().parent / "data" / "wcs_wave.json"

# Version de procesamiento en el nombre del archivo: `..._spx_l2b-v27-2026-196`.
_PROCESSING = re.compile(r"_spx_(l\d[a-z]?-v\d+)")


class WaveTableError(ValueError):
    """La tabla de longitud de onda no existe para ese detector o no se puede leer."""


@dataclass(frozen=True)
class WaveTable:
    """Tabla WCS-WAVE de un detector: longitud de onda y ancho de banda sobre una malla de puntos de control."""

    detector: int
    x: NDArray[np.float64]  # puntos de control en X, pixeles del detector desde 1
    y: NDArray[np.float64]  # puntos de control en Y
    wavelength: NDArray[np.float64]  # [len(y), len(x)], um
    bandwidth: NDArray[np.float64]  # [len(y), len(x)], um

    def __post_init__(self) -> None:
        shape = (self.y.size, self.x.size)
        if self.wavelength.shape != shape or self.bandwidth.shape != shape:
            raise WaveTableError(
                f"D{self.detector}: VALUES mide {self.wavelength.shape} y los puntos de control dan {shape}"
            )
        if self.x.size < 2 or self.y.size < 2:
            raise WaveTableError(f"D{self.detector}: hacen falta al menos dos puntos de control por eje")
        if np.any(np.diff(self.x) < 0) or np.any(np.diff(self.y) < 0):
            raise WaveTableError(f"D{self.detector}: los puntos de control no estan ordenados")

    def lookup(self, x_detector: float, y_detector: float) -> tuple[float, float]:
        """`(longitud de onda, ancho de banda)` en um en un pixel del detector contado desde 1.

        Fuera de la malla se usa el valor del borde: los puntos de control van de
        1 a 2040 y un pixel real nunca cae afuera por mas de medio pixel.
        """
        ix, fx = _fractional_index(self.x, x_detector)
        iy, fy = _fractional_index(self.y, y_detector)
        return _bilinear(self.wavelength, ix, fx, iy, fy), _bilinear(self.bandwidth, ix, fx, iy, fy)

    @property
    def wave_range(self) -> tuple[float, float]:
        """Rango de longitud de onda central que cubre el detector, en um."""
        return float(self.wavelength.min()), float(self.wavelength.max())


def _fractional_index(points: NDArray[np.float64], value: float) -> tuple[int, float]:
    """Intervalo `k` de `points` que contiene a `value` y la fraccion recorrida dentro de el."""
    clipped = min(max(float(value), float(points[0])), float(points[-1]))
    k = int(np.searchsorted(points, clipped, side="right")) - 1
    k = min(max(k, 0), points.size - 2)
    span = float(points[k + 1] - points[k])
    return k, 0.0 if span <= 0 else (clipped - float(points[k])) / span


def _bilinear(values: NDArray[np.float64], ix: int, fx: float, iy: int, fy: float) -> float:
    low = values[iy, ix] * (1.0 - fx) + values[iy, ix + 1] * fx
    high = values[iy + 1, ix] * (1.0 - fx) + values[iy + 1, ix + 1] * fx
    return float(low * (1.0 - fy) + high * fy)


def detector_pixel(header: Mapping[str, Any], x: float, y: float) -> tuple[float, float]:
    """Pixel del detector (contado desde 1) que corresponde al pixel `(x, y)` del recorte (contado desde 0).

    Es la parte lineal del WCS `W`: `psi = CRVALnW + CDELTnW * (p - CRPIXnW)`,
    con `p` el pixel FITS del recorte (desde 1). Lanza `WaveTableError` si el
    encabezado no trae esas tarjetas.
    """
    try:
        x_detector = float(header["CRVAL1W"]) + float(header["CDELT1W"]) * (x + 1.0 - float(header["CRPIX1W"]))
        y_detector = float(header["CRVAL2W"]) + float(header["CDELT2W"]) * (y + 1.0 - float(header["CRPIX2W"]))
    except (KeyError, TypeError, ValueError) as exc:
        raise WaveTableError(f"el encabezado de IMAGE no trae el WCS de longitud de onda: {exc}") from exc
    return x_detector, y_detector


def wavelength_at(table: WaveTable, header: Mapping[str, Any], x: float, y: float) -> tuple[float, float]:
    """`(longitud de onda, ancho de banda)` en um en el pixel `(x, y)` de un recorte (contado desde 0)."""
    return table.lookup(*detector_pixel(header, x, y))


def processing_version(filename: str) -> str | None:
    """Version de procesamiento que figura en el nombre de un archivo de nivel 2 (`l2b-v27`), o `None`."""
    match = _PROCESSING.search(filename)
    return None if match is None else match.group(1)


# ------------------------------------------------------------------- en disco


@dataclass(frozen=True)
class WaveTables:
    """Las tablas de los seis detectores y de donde salieron."""

    tables: Mapping[int, WaveTable]
    processing: str | None  # version de procesamiento de los archivos de origen

    def for_detector(self, detector: int) -> WaveTable:
        table = self.tables.get(detector)
        if table is None:
            raise WaveTableError(f"no hay tabla de longitud de onda para el detector {detector}")
        return table


def tables_from_document(document: Mapping[str, Any]) -> WaveTables:
    """Arma las tablas a partir del documento JSON guardado."""
    tables: dict[int, WaveTable] = {}
    try:
        for key, item in document["detectors"].items():
            detector = int(key)
            tables[detector] = WaveTable(
                detector=detector,
                x=np.asarray(item["x"], dtype=np.float64),
                y=np.asarray(item["y"], dtype=np.float64),
                wavelength=np.asarray(item["wavelength"], dtype=np.float64),
                bandwidth=np.asarray(item["bandwidth"], dtype=np.float64),
            )
    except (KeyError, TypeError, ValueError) as exc:
        raise WaveTableError(f"documento de tablas WCS-WAVE invalido: {exc}") from exc
    processing = document.get("processing")
    return WaveTables(tables=tables, processing=None if processing is None else str(processing))


@lru_cache(maxsize=4)
def load_wave_tables(path: Path = WAVE_TABLE_PATH) -> WaveTables:
    """Tablas guardadas en el repositorio. Se leen una sola vez por proceso."""
    try:
        document = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise WaveTableError(f"no se puede leer {path}: {exc}") from exc
    return tables_from_document(document)
