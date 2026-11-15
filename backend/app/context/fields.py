"""Contexto de los campos ya precalculados, a partir de sus metadatos. No consulta Sesame.

Cada campo de `data/fields/<id>/` trae lo que hace falta:

- `meta.json` da el centro y el lado (`request`), que es la posicion del objeto
  propagada a la epoca 2026,0 (contrato, seccion 4.8).
- `track_<nombre>.json` (contrato, seccion 4.9) da el nombre principal del
  objeto y su posicion esperada en cada epoca de SPHEREx, con movimiento propio
  y paralaje ya aplicados. Para un objeto sin movimiento propio (una galaxia)
  `positions` viene vacio.

De la trayectoria sale tambien donde estaba el objeto en la fecha de 2MASS y de
WISE, que es lo que el viaje entre misiones necesita para la mira. Se estima un
movimiento lineal con dos epocas separadas casi exactamente un anio (SPHEREx
pasa cada seis meses, asi que la primera y la tercera lo estan): en esas dos
fechas la Tierra esta en el mismo lugar de su orbita, el desplazamiento por
paralaje es el mismo y se cancela al restar. Lo que queda de error:

- en el movimiento, la paralaje por el desfasaje de las dos fechas: con una
  semana de diferencia, 0,12 veces la paralaje por anio. Para Proxima (0,77")
  son 0,09" por anio, o 2,4" al llevarla 26 anios atras;
- en la posicion, hasta dos veces la paralaje (1,5" en Proxima), porque la
  fecha de la imagen vieja cae en otro momento del anio.

Las dos cosas quedan por debajo de un pixel de la grilla (3,075"), que es lo
que hace falta para una mira. Contra las posiciones calculadas con el
movimiento propio del catalogo, la diferencia medida en los cinco objetos de
prueba esta en tests/test_context_fields.py y en docs/contexto-2.md.

Un campo que ya tiene contexto guardado no se vuelve a armar, salvo que se
pida: los archivos existentes no se tocan.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from app import geometry
from app.config import Settings
from app.context import surveys
from app.context.build import ContextBuildError, build_context
from app.context.store import (
    INDEX_FILENAME,
    ContextDocument,
    ContextObject,
    ContextStore,
    LayerTarget,
    context_key,
)
from app.contract import FINISHED_FIELD_STATUSES, FieldMeta, TrackPosition, TrackResponse
from app.domain import Grid, NormalizedRequest
from app.jobs.store import FieldStore, StoreError

DAYS_PER_YEAR = 365.25

# Separacion minima, en anios, entre las dos epocas con las que se estima el movimiento. Con
# menos (dos pasadas a seis meses) la paralaje no se cancela y contamina la estimacion.
MIN_BASELINE_YEARS = 0.75

Printer = Callable[[str], None]


@dataclass(frozen=True)
class LinearMotion:
    """Movimiento lineal de un objeto sobre el cielo, estimado de su trayectoria guardada."""

    ra: float  # posicion de referencia, grados
    dec: float
    mjd: float  # fecha de esa posicion
    rate_east: float  # segundos de arco por anio hacia el este (ya incluye cos(dec))
    rate_north: float  # segundos de arco por anio hacia el norte
    baseline_years: float  # separacion entre las dos epocas usadas

    @property
    def per_year_arcsec(self) -> float:
        return math.hypot(self.rate_east, self.rate_north)

    def position_at(self, mjd: float) -> tuple[float, float]:
        """`(ra, dec)` en grados en la fecha `mjd`."""
        years = (mjd - self.mjd) / DAYS_PER_YEAR
        dec = self.dec + self.rate_north * years / 3600.0
        ra = self.ra + self.rate_east * years / 3600.0 / math.cos(math.radians(self.dec))
        return ra % 360.0, dec


def _phase_error(years: float) -> float:
    """Cuanto se aparta una separacion de un numero entero de anios (0 es lo mejor)."""
    return abs(years - round(years))


def track_motion(positions: Sequence[TrackPosition]) -> LinearMotion | None:
    """Movimiento lineal estimado de una trayectoria, o `None` si no se puede.

    Usa el par de epocas separadas por al menos `MIN_BASELINE_YEARS` cuya
    separacion esta mas cerca de un numero entero de anios (ahi la paralaje se
    cancela); a igual cercania, el par mas separado. La posicion de referencia
    es el punto medio del par.
    """
    points = sorted(positions, key=lambda item: item.mjd)
    best: tuple[float, float, TrackPosition, TrackPosition] | None = None
    for i, first in enumerate(points):
        for second in points[i + 1 :]:
            years = (second.mjd - first.mjd) / DAYS_PER_YEAR
            if years < MIN_BASELINE_YEARS:
                continue
            score = (_phase_error(years), -years)
            if best is None or score < best[:2]:
                best = (score[0], score[1], first, second)
    if best is None:
        return None
    _, _, first, second = best
    years = (second.mjd - first.mjd) / DAYS_PER_YEAR
    dec_mid = (first.dec + second.dec) / 2.0
    delta_ra = (second.ra - first.ra + 180.0) % 360.0 - 180.0  # por si cruza el meridiano 0
    return LinearMotion(
        ra=(first.ra + delta_ra / 2.0) % 360.0,
        dec=dec_mid,
        mjd=(first.mjd + second.mjd) / 2.0,
        rate_east=delta_ra * math.cos(math.radians(dec_mid)) * 3600.0 / years,
        rate_north=(second.dec - first.dec) * 3600.0 / years,
        baseline_years=years,
    )


def target_at(motion: LinearMotion, mjd: float, grid: Grid) -> LayerTarget | None:
    """Posicion esperada del objeto en la fecha de una capa, en cielo y en pixeles de la grilla."""
    ra, dec = motion.position_at(mjd)
    x, y = geometry.sky_to_pixel(grid, ra, dec)
    if not (math.isfinite(x) and math.isfinite(y)):
        return None
    return LayerTarget(
        ra=round(ra, 6), dec=round(dec, 6), x=round(x, 2), y=round(y, 2), in_field=geometry.in_grid(grid, x, y)
    )


# ---------------------------------------------------------------------- campos


@dataclass(frozen=True)
class FieldEntry:
    """Un campo precalculado, con lo que hace falta para armar su contexto."""

    field_id: str
    meta: FieldMeta
    name: str | None  # nombre principal del objeto, de su trayectoria
    track: TrackResponse | None

    @property
    def key(self) -> str:
        request = self.meta.request
        return context_key(request.ra, request.dec, request.fov)


def object_alias(name: str) -> str:
    """Alias corto de un nombre de catalogo: `NAME Luhman 16` da `luhman-16`, `V* R Dra` da `r-dra`."""
    text = re.sub(r"^(NAME|V\*|\*\*?|EM\*|HD|GJ)\s+", "", name.strip(), flags=re.IGNORECASE) or name
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "campo"


def list_fields(fields_dir: Path) -> list[FieldEntry]:
    """Campos terminados de una carpeta de campos (`data/fields`), ordenados por id.

    De cada uno toma la primera trayectoria guardada: el precalculo guarda una
    sola, la del objeto para el que se armo el campo.
    """
    store = FieldStore(Path(fields_dir), [Path(fields_dir)])
    entries: list[FieldEntry] = []
    for field_id in store.list_ids():
        try:
            meta = store.read_meta(field_id)
            tracks = store.list_tracks(field_id)
        except StoreError:
            continue
        if meta.status not in FINISHED_FIELD_STATUSES:
            continue
        track = tracks[0] if tracks else None
        entries.append(FieldEntry(field_id=field_id, meta=meta, name=track.name if track else None, track=track))
    return entries


class _KeepIndexStore(ContextStore):
    """Almacen que no reescribe `index.json`: ese archivo ya existe y esta etapa solo agrega archivos.

    El indice que sirve la API se arma leyendo las carpetas (`read_index`), asi
    que no depende de que `index.json` este al dia.
    """

    def write_index(self) -> Path:
        return self.root / INDEX_FILENAME


def field_request(entry: FieldEntry, settings: Settings) -> NormalizedRequest:
    """Pedido normalizado del campo, con su mismo centro y su mismo lado."""
    request = entry.meta.request
    return geometry.normalize_request(request.ra, request.dec, request.fov, pipeline=entry.meta.pipeline)


def build_field_context(
    entry: FieldEntry,
    settings: Settings,
    store: ContextStore,
    *,
    layer_keys: Sequence[str] = surveys.DEFAULT_BAND_KEYS,
    with_gaia: bool = True,
    refresh: bool = False,
    out: Printer = print,
) -> ContextDocument:
    """Arma y guarda el contexto de un campo precalculado. Lanza `ContextBuildError` si no quedo nada.

    Las capas y las fuentes de Gaia se arman igual que para los objetos de
    prueba (`app.context.build`); lo unico que cambia es de donde salen el
    centro, el nombre y la posicion esperada del objeto en cada capa.
    """
    request = field_request(entry, settings)
    if request.field_id != entry.field_id:
        # El `id` sale de la geometria y del pipeline: si no coincide, los metadatos no son de ese campo.
        raise ContextBuildError(f"el campo {entry.field_id} no coincide con su pedido ({request.field_id})")
    name = entry.name
    context_object = None if name is None else ContextObject(alias=object_alias(name), query=name, name=name)
    quiet = _KeepIndexStore(store.root)
    document = build_context(
        request,
        settings,
        quiet,
        context_object=context_object,
        target=None,
        layer_keys=layer_keys,
        with_gaia=with_gaia,
        refresh=refresh,
        out=out,
    )
    motion = track_motion(entry.track.positions) if entry.track is not None else None
    if motion is None:
        return document
    grid = geometry.grid_from_info(document.grid)
    layers = [layer.model_copy(update={"target": target_at(motion, layer.mjd, grid)}) for layer in document.surveys]
    document = document.model_copy(update={"surveys": layers})
    quiet.write_document(document)
    return document
