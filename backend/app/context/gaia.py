"""Fuentes de Gaia DR3 de un campo, por consulta de cono a Gator de IRSA. Usa la red.

Verificado contra el servicio el 2026-11-15 (docs/contexto.md):

- Servicio: `https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query`, la interfaz
  de programa de Gator, documentada en
  https://irsa.ipac.caltech.edu/applications/Gator/GatorAid/irsa/catsearch.html
  Parametros usados: `catalog`, `spatial=cone`, `objstr` (centro, "ra dec" en
  grados), `radius`, `radunits=arcsec`, `outfmt=1` (tabla IPAC en texto) y
  `selcols`.
- Catalogo: `gaia_dr3_source`. La respuesta real lo confirma en su encabezado:
  `\\DATABASE= 'Gaia Source Catalogue (DR3) (gaia_dr3_source)'`.
- Columnas, con la descripcion y la unidad que trae esa misma respuesta:
  `source_id`, `ra` (deg), `dec` (deg), `ref_epoch` (yr), `pmra` (mas/yr),
  `pmdec` (mas/yr), `parallax` (mas) y `phot_g_mean_mag` (mag). Gator agrega
  `clon`, `clat`, `dist` y `angle`, que no se usan.
- `pmra` es el movimiento en ascension recta por el coseno de la declinacion,
  como en todo Gaia (documentacion de `gaia_source`, columna `pmra`).
- Las posiciones son ICRS en la epoca `ref_epoch` = 2016,0.
- Para el campo de Barnard (radio de 430") devolvio 3524 fuentes en 4,7 s.
- El TAP de IRSA (`gaia_dr3_source`) y el cono `SCS` no respondieron en 90 y
  100 s, y el archivo de ESA (`gea.esac.esa.int`) no acepto la conexion.

Un valor ausente llega como `null`: una fuente con solucion de dos parametros no
tiene movimiento propio ni paralaje. Aca quedan como `NaN` y en el archivo
guardado, como `null`.
"""

from __future__ import annotations

import contextlib
import io
import math
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from astropy.io import ascii as ascii_tables
from numpy.typing import NDArray

from app.config import Settings
from app.context.http import ContextFetchError, get_bytes
from app.context.surveys import _write_atomic, context_cache_dir
from app.domain import Grid
from app.irsa.limits import get_limiter

GATOR_URL = "https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query"
CATALOG = "gaia_dr3_source"
COLUMNS: tuple[str, ...] = ("source_id", "ra", "dec", "ref_epoch", "pmra", "pmdec", "parallax", "phot_g_mean_mag")

MAS_PER_DEG = 3.6e6
MAX_RESPONSE_BYTES = 256 * 1024 * 1024

# Fechas en las que se mira si una fuente cae dentro del campo: 2MASS (1997 a 2001), WISE
# (2010), la epoca de Gaia y SPHEREx. Una estrella rapida entra o sale del campo en ese lapso.
FIELD_EPOCHS: tuple[float, ...] = (1998.0, 2010.5, 2016.0, 2026.0)

_ROWS_RE = re.compile(rb"\\RowsRetrieved\s*=\s*(\d+)")


@dataclass(frozen=True, eq=False)
class GaiaSources:
    """Fuentes de Gaia por columnas, ordenadas de la mas brillante a la mas debil. `NaN` es sin valor."""

    source_id: NDArray[np.int64]
    ra: NDArray[np.float64]  # grados ICRS, epoca `ref_epoch`
    dec: NDArray[np.float64]
    pmra: NDArray[np.float64]  # mas/anio, incluye cos(dec)
    pmdec: NDArray[np.float64]  # mas/anio
    parallax: NDArray[np.float64]  # mas
    g_mag: NDArray[np.float64]
    ref_epoch: float

    def __len__(self) -> int:
        return int(self.source_id.size)

    def take(self, keep: NDArray[np.bool_] | NDArray[np.intp]) -> GaiaSources:
        return GaiaSources(
            source_id=self.source_id[keep],
            ra=self.ra[keep],
            dec=self.dec[keep],
            pmra=self.pmra[keep],
            pmdec=self.pmdec[keep],
            parallax=self.parallax[keep],
            g_mag=self.g_mag[keep],
            ref_epoch=self.ref_epoch,
        )


def cone_radius_arcsec(grid: Grid, margin_arcsec: float = 6.0) -> float:
    """Radio del cono que cubre toda la grilla: la mitad de su diagonal mas un margen."""
    ny, nx = grid.shape
    return math.hypot(nx, ny) / 2.0 * grid.pixel_scale_arcsec + margin_arcsec


def query_params(ra: float, dec: float, radius_arcsec: float) -> dict[str, str]:
    """Parametros de la consulta de cono a Gator (ver el encabezado del modulo)."""
    return {
        "catalog": CATALOG,
        "spatial": "cone",
        "objstr": f"{ra:.6f} {dec:+.6f}",
        "radius": f"{radius_arcsec:.1f}",
        "radunits": "arcsec",
        "outfmt": "1",
        "selcols": ",".join(COLUMNS),
    }


def cache_path(ra: float, dec: float, radius_arcsec: float, settings: Settings) -> Path:
    return context_cache_dir(settings) / "gaia" / f"{CATALOG}__{ra:.6f}_{dec:+.6f}_{radius_arcsec:.1f}.tbl"


def _column(table: object, name: str) -> NDArray[np.float64]:
    column = table[name]  # type: ignore[index]
    filled = column.filled(np.nan) if hasattr(column, "filled") else column
    return np.asarray(filled, dtype=np.float64)


def parse_sources(payload: bytes) -> GaiaSources:
    """Interpreta la tabla IPAC que devuelve Gator. Lanza `ValueError` si no lo es o esta incompleta."""
    if not payload.lstrip().startswith(b"\\"):
        # Un error de Gator llega como texto o HTML, sin las lineas de encabezado que empiezan con "\".
        raise ValueError(f"la respuesta no es una tabla IPAC: {payload[:160]!r}")
    try:
        table = ascii_tables.read(io.BytesIO(payload), format="ipac")
    except Exception as exc:  # astropy lanza varias clases con una tabla cortada
        raise ValueError(f"tabla IPAC ilegible: {type(exc).__name__}: {exc}") from exc
    missing = [name for name in COLUMNS if name not in table.colnames]
    if missing:
        raise ValueError(f"faltan las columnas {missing}")
    declared = _ROWS_RE.search(payload)
    if declared is not None and int(declared.group(1)) != len(table):
        raise ValueError(f"la tabla trae {len(table)} filas y declara {int(declared.group(1))}: esta cortada")

    if len(table) == 0:
        empty = np.zeros(0, dtype=np.float64)
        return GaiaSources(np.zeros(0, dtype=np.int64), empty, empty, empty, empty, empty, empty, 2016.0)
    epochs = _column(table, "ref_epoch")
    ref_epoch = float(epochs[0])
    if not np.allclose(epochs, ref_epoch):
        raise ValueError("las fuentes no comparten epoca de referencia")
    sources = GaiaSources(
        source_id=np.asarray(table["source_id"], dtype=np.int64),
        ra=_column(table, "ra"),
        dec=_column(table, "dec"),
        pmra=_column(table, "pmra"),
        pmdec=_column(table, "pmdec"),
        parallax=_column(table, "parallax"),
        g_mag=_column(table, "phot_g_mean_mag"),
        ref_epoch=ref_epoch,
    )
    # De la mas brillante a la mas debil; sin magnitud, al final. El orden es estable.
    order = np.argsort(np.where(np.isfinite(sources.g_mag), sources.g_mag, np.inf), kind="stable")
    return sources.take(order)


def position_at(sources: GaiaSources, year: float) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Posicion de cada fuente en `year` (anio juliano), con movimiento propio lineal. Sin movimiento, la de catalogo.

    Alcanza para dibujar: en las tres decadas que cubre el contexto la
    diferencia con la propagacion rigurosa es de milesimas de segundo de arco,
    y la paralaje (0,55" en Barnard, el maximo del cielo) no se aplica.
    """
    years = year - sources.ref_epoch
    pmra = np.where(np.isfinite(sources.pmra), sources.pmra, 0.0)
    pmdec = np.where(np.isfinite(sources.pmdec), sources.pmdec, 0.0)
    dec = sources.dec + pmdec * years / MAS_PER_DEG
    ra = sources.ra + pmra * years / MAS_PER_DEG / np.cos(np.radians(sources.dec))
    return ra % 360.0, dec


def select_in_field(sources: GaiaSources, grid: Grid, epochs: tuple[float, ...] = FIELD_EPOCHS) -> GaiaSources:
    """Las fuentes que caen dentro de la grilla en alguna de las fechas de `epochs`."""
    if len(sources) == 0:
        return sources
    ny, nx = grid.shape
    wcs = grid.wcs.deepcopy()
    keep = np.zeros(len(sources), dtype=bool)
    for year in epochs:
        ra, dec = position_at(sources, year)
        x, y = wcs.all_world2pix(ra, dec, 0)
        with np.errstate(invalid="ignore"):
            keep |= (x >= -0.5) & (x < nx - 0.5) & (y >= -0.5) & (y < ny - 0.5)
    return sources.take(keep)


def fetch_sources(
    ra: float, dec: float, radius_arcsec: float, settings: Settings, *, refresh: bool = False
) -> GaiaSources:
    """Fuentes de Gaia DR3 del cono, de la cache o de Gator. Lanza `ContextFetchError` si IRSA no responde."""
    path = cache_path(ra, dec, radius_arcsec, settings)
    if not refresh and path.is_file():
        with contextlib.suppress(OSError, ValueError):
            return parse_sources(path.read_bytes())
    last: Exception | None = None
    for _ in range(2):  # una tabla cortada se vuelve a pedir una vez
        payload = get_bytes(
            GATOR_URL,
            settings,
            slot=get_limiter(settings).sia_slot,
            what=f"Gator {CATALOG}",
            params=query_params(ra, dec, radius_arcsec),
            max_bytes=MAX_RESPONSE_BYTES,
        )
        try:
            sources = parse_sources(payload)
        except ValueError as exc:
            last = exc
            continue
        with contextlib.suppress(OSError):
            _write_atomic(path, payload)
        return sources
    raise ContextFetchError(f"Gator {CATALOG}: {last}")


def fetch_field_sources(grid: Grid, settings: Settings, *, refresh: bool = False) -> tuple[GaiaSources, float]:
    """Fuentes de Gaia DR3 que caen en el campo, y el radio del cono consultado en segundos de arco."""
    radius = cone_radius_arcsec(grid)
    sources = fetch_sources(grid.ra, grid.dec, radius, settings, refresh=refresh)
    return select_in_field(sources, grid), radius
