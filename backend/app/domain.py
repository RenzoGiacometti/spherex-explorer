"""Tipos internos del backend. No viajan por la API: para eso esta `app.contract`.

Convenciones de los arreglos: forma `(ny, nx)`, fila 0 = sur, columna 0 = este
(contrato, seccion 2).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import numpy as np
from astropy.wcs import WCS
from numpy.typing import NDArray

# ------------------------------------------------------------------ geometria


@dataclass(frozen=True)
class FovStep:
    """Escalon de campo admitido (contrato, seccion 3)."""

    name: Literal["base", "wide"]
    fov: float  # lado del campo, grados
    pixel_scale_arcsec: float  # escala de la grilla de salida
    size: int  # lado de la grilla en pixeles (impar)


@dataclass(frozen=True)
class NormalizedRequest:
    """Pedido de un campo ya normalizado: es lo que identifica al campo."""

    ra: float  # [0, 360), 4 decimales
    dec: float  # 4 decimales
    fov: float  # el del escalon
    band: int  # detector que la persona esta mirando, 1 a 6
    refresh: bool
    step: FovStep
    pipeline: str
    field_id: str


@dataclass(frozen=True, eq=False)
class Grid:
    """Grilla comun del campo: proyeccion TAN, norte arriba, x hacia el oeste."""

    wcs: WCS
    shape: tuple[int, int]  # (ny, nx)
    pixel_scale_arcsec: float
    fov: float  # grados
    ra: float  # centro (crval), grados
    dec: float


# --------------------------------------------------------------- exposiciones


@dataclass(frozen=True)
class Exposure:
    """Una imagen de nivel 2 de SPHEREx que cubre el punto, tal como la lista SIA2."""

    obs_id: str
    collection: str
    detector: int  # 1 a 6
    mjd_start: float
    mjd_end: float
    url: str  # access_url; el recorte se pide agregando ?center=...&size=...
    wave_min_um: float
    wave_max_um: float


@dataclass(frozen=True)
class ExposureList:
    """Resultado de listar exposiciones. `stale` indica que IRSA no respondio y se uso una copia guardada."""

    exposures: list[Exposure]
    listed_at: str  # UTC, formato del contrato (2026-11-15T06:21:10Z)
    stale: bool = False


@dataclass(frozen=True)
class CutoutFile:
    """Recorte ya guardado en la cache de disco."""

    path: Path
    mode: Literal["truncated", "full"]  # cortado antes de EPSF, o respuesta completa
    from_cache: bool
    nbytes: int  # bytes recibidos de IRSA (0 si salio de la cache)


@dataclass(frozen=True)
class EpochSummary:
    """Resumen de una pasada del relevamiento."""

    epoch: int  # desde 1
    mjd_start: float
    mjd_end: float
    mjd_mean: float
    n_exposures: int


@dataclass(frozen=True)
class EpochAssignment:
    """Epoca de cada exposicion (desde 1, en el orden recibido) y resumen por epoca."""

    indices: list[int]
    epochs: list[EpochSummary]


# -------------------------------------------------------------------- pipeline


@dataclass
class ReprojectedExposure:
    """Un recorte ya procesado y llevado a la grilla del campo.

    `image` y `variance` traen NaN en lo descartado (flags enmascarados, valores
    no finitos, fuera de la huella). `flags` conserva todos los bits, por vecino
    mas cercano, para poder decidir saturacion y armar la capa auxiliar.
    """

    image: NDArray[np.float32]  # MJy/sr, con ZODI y fondo residual restados
    variance: NDArray[np.float32]
    flags: NDArray[np.uint32]
    footprint: NDArray[np.bool_]  # True donde el recorte cubre la grilla
    flag_bits: dict[str, int]  # nombre del flag -> numero de bit (MSKNnnnn)
    background: float  # mediana residual restada, MJy/sr
    flag_descriptions: dict[str, str] = field(default_factory=dict)  # nombre -> texto (MSKDnnnn)


@dataclass
class PlaneArrays:
    """Coadd de una epoca y un detector, listo para guardar.

    `image`: NaN sin datos, +Infinity saturado. `coverage` vale 0 exactamente
    donde `image` no es finita.
    """

    image: NDArray[np.float32]
    flags: NDArray[np.uint32]  # bit encendido si lo tiene al menos la mitad de las exposiciones
    coverage: NDArray[np.uint16]  # exposiciones que aportaron un valor valido


@dataclass(frozen=True)
class PreviewImage:
    """Vista provisoria: recorte de WISE en la grilla del campo, en unidades del relevamiento."""

    image: NDArray[np.float32]
    band: Literal["W1", "W2"]
    wave_um: float
    hips: str  # identificador HiPS usado
    survey: str = "WISE"


# ------------------------------------------------------------------- objetivo


@dataclass(frozen=True)
class ResolvedTarget:
    """Objeto resuelto: posicion ICRS en la epoca J2000.0 y movimiento, si el catalogo lo trae."""

    query: str
    ra: float  # grados, epoca 2000.0
    dec: float
    source: Literal["sesame", "coordinates"] = "coordinates"
    name: str | None = None  # nombre principal segun el catalogo
    object_type: str | None = None
    pm_ra: float | None = None  # mas/anio, incluye cos(dec)
    pm_dec: float | None = None  # mas/anio
    parallax: float | None = None  # mas
    radial_velocity: float | None = None  # km/s
    ref_epoch: float = 2000.0  # anio juliano

    @property
    def has_proper_motion(self) -> bool:
        return self.pm_ra is not None and self.pm_dec is not None and bool(self.pm_ra or self.pm_dec)


@dataclass(frozen=True)
class TrackPoint:
    """Posicion esperada de un objeto en una epoca del campo."""

    epoch: int  # desde 1
    mjd: float
    ra: float
    dec: float
    x: float  # pixeles de la grilla, desde 0
    y: float
    in_field: bool
