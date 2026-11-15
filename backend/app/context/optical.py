"""Capa optica: recortes del Digitized Sky Survey (placas fotograficas de 1949 a 2000) en la grilla del campo.

Sirve para dos cosas del contexto: una parada mas antigua en el viaje entre
misiones y el lado visible de la cortina visible/infrarrojo.

Servicio, verificado el 2026-11-15 (docs/contexto-2.md):

    https://archive.stsci.edu/cgi-bin/dss_search?v=<relevamiento>&r=<ra>&d=<dec>&e=J2000&h=<alto>&w=<ancho>&f=fits&c=none&fov=NONE&v3=

- Es el archivo de STScI (MAST). Los nombres de los parametros y los valores de
  `v` salen del formulario oficial, https://archive.stsci.edu/cgi-bin/dss_form:
  `r` y `d` en grados, `h` y `w` en minutos de arco (maximo 60), `f=fits`,
  `c=none` (sin comprimir).
- `v=poss2ukstu_red` es la segunda generacion en rojo: placas POSS-II del
  Palomar al norte (1987 a 2000) y del UK Schmidt al sur, a 1" por pixel.
- `v=poss1_red` es la primera generacion en rojo: placas POSS-I del Palomar
  (1949 a 1958), a 1,7" por pixel. No llega al sur: para Proxima (-62,7 grados)
  no tiene nada.
- `v=phase2_gsc1` son las placas del primer Guide Star Catalog: al sur, las
  azules SERC-J del UK Schmidt (1974 a 1987; para Proxima, la J2098 del
  1976-03-11); al norte no son POSS-I sino las Quick-V de Palomar, de 1982.
- Responde en 1 a 5 s con un FITS de una sola placa (la que cubre el centro),
  de 0,6 a 1,6 MB para 14,6 minutos de lado.
- Si ese relevamiento no cubre el punto responde HTTP 200 con una pagina HTML
  de titulo "ERROR": hay que mirar el contenido, no el codigo.
- SkyView de NASA (https://skyview.gsfc.nasa.gov/current/cgi/runquery.pl con
  `Survey=DSS2 Red`) tambien respondio, y entrega la imagen ya remuestreada a
  la grilla que se le pida, pero su encabezado no trae la fecha de la placa. Por
  eso se usa STScI.

Lo que trae el encabezado y se usa: `DATE-OBS` (fecha de la placa; la hora
viene a veces con 75 u 80 minutos, asi que se lee solo el dia), `SURVEY`,
`PLTLABEL` (numero de placa), `TELESCOP`, `EMULSION`, `FILTER`, `COPYRGHT` y un
WCS estandar (`RA---TAN` con matriz CD) que astropy lee tal cual. Contra las
posiciones de Gaia llevadas a la fecha de la placa, las estrellas del campo de
Barnard quedaron a 0,4" (1991) y 0,6" (1950) de mediana.

Los valores son densidades de la placa digitalizada, no flujos: la respuesta de
una emulsion no es lineal y cada placa tiene la suya. La capa se guarda con el
fondo restado (la mediana) y sirve para mirar, no para medir. No se puede pasar
a MJy/sr como las de 2MASS y WISE.

Las imagenes tienen derechos: cada encabezado nombra al titular en `COPYRGHT`
(Caltech/Palomar, AAO/ROE, STScI/AURA). Segun la pagina de uso de datos de MAST
(https://archive.stsci.edu/publishing/data-use, a la que redirigen los enlaces
"Acknowledging DSS" y "copyright" del formulario) se pueden usar libremente con
fines cientificos, educativos y sin fines de lucro, citando el relevamiento.
Por eso cada capa guarda el titular y la placa, para mostrarlos al lado de la
imagen.

Formato en disco, al lado del contexto del campo (`data/context/<campo>/`):

    optical.json     documento (`OpticalDocument`): una entrada por capa
    dss2_red.f32     la capa, con el formato de un plano del cubo
    dss1.f32

Va en un documento aparte y no en `context.json` porque ese archivo y su modelo
ya existen y esta etapa solo agrega archivos; al integrar se pueden juntar.
"""

from __future__ import annotations

import contextlib
import datetime
import json
import math
import re
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np
from astropy.io import fits
from numpy.typing import NDArray
from pydantic import ValidationError

from app import geometry
from app.config import Settings
from app.context.http import ContextFetchError, get_bytes
from app.context.reproject import background_level, read_cutout, resample_to_grid, valid_fraction
from app.context.store import LAYER_DTYPE, ContextNotFoundError, ContextStore, LayerTarget
from app.context.surveys import _write_atomic, context_cache_dir
from app.contract import ContractModel, Display, GridInfo
from app.domain import Grid
from app.irsa.limits import get_limiter
from app.pipeline.stats import detector_display

STSCI_DSS_URL = "https://archive.stsci.edu/cgi-bin/dss_search"
OPTICAL_FILENAME = "optical.json"
FORMAT_VERSION = 1

# Lado maximo que acepta el servicio, en minutos de arco (formulario de STScI).
MAX_SIDE_ARCMIN = 60.0
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
_FITS_SIGNATURE = b"SIMPLE  ="

Printer = Callable[[str], None]


@dataclass(frozen=True)
class DssSurvey:
    """Un relevamiento del Digitized Sky Survey tal como lo ofrece STScI."""

    key: str  # nombre del archivo guardado y del parametro `layer` de la API
    versions: tuple[str, ...]  # valores del parametro `v`, en el orden en que se prueban
    generation: Literal["DSS1", "DSS2"]


# De la mas antigua a la mas nueva. La segunda generacion en rojo es la capa optica de
# referencia (mas profunda y con mejor resolucion); la primera suma tres o cuatro decadas.
#
# Para la primera generacion se prueba `poss1_red` (POSS-I, 1949 a 1958) y, si no cubre el
# punto, `phase2_gsc1`, que al sur da las placas SERC-J (1974 a 1987). No se pide
# `phase2_gsc1` de entrada porque al norte no devuelve POSS-I sino las placas Quick-V de
# Palomar, de 1982 (para el campo de Barnard, la ST154 del 1982-06-24).
DSS_SURVEYS: tuple[DssSurvey, ...] = (
    DssSurvey("dss1", ("poss1_red", "phase2_gsc1"), "DSS1"),
    DssSurvey("dss2_red", ("poss2ukstu_red",), "DSS2"),
)
DEFAULT_SURVEY_KEYS: tuple[str, ...] = ("dss1", "dss2_red")


def survey_by_key(key: str) -> DssSurvey:
    """El relevamiento con esa clave. Lanza `KeyError` si no existe."""
    for survey in DSS_SURVEYS:
        if survey.key == key:
            return survey
    raise KeyError(key)


class OpticalUnavailable(Exception):
    """Ese relevamiento no cubre el campo, o el servicio no entrego una imagen."""


# -------------------------------------------------------------------- placas

# Banda de cada emulsion, con su longitud de onda aproximada en micrometros. Son las
# combinaciones de emulsion y filtro de los relevamientos con placas Schmidt (Reid et al.
# 1991, PASP 103, 661, para POSS-II; Minkowski y Abell 1963 para POSS-I): rojo con 103aE o
# IIIaF, azul con 103aO o IIIaJ, infrarrojo cercano con IV-N, y visual con IIaD (Quick-V).
_EMULSION_BANDS: dict[str, tuple[str, float]] = {
    "103AE": ("R", 0.65),
    "IIIAF": ("R", 0.65),
    "103AO": ("B", 0.42),
    "IIIAJ": ("Bj", 0.47),
    "IIAD": ("V", 0.55),
    "IVN": ("I", 0.80),
}

_DATE_RE = re.compile(r"^\s*(\d{4})-(\d{2})-(\d{2})")

# Ordinal del calendario gregoriano del dia MJD 0, el 17 de noviembre de 1858.
_MJD_ZERO_ORDINAL = datetime.date(1858, 11, 17).toordinal()


def plate_band(emulsion: str | None) -> tuple[str, float] | None:
    """Banda y longitud de onda aproximada (micrometros) de una emulsion, o `None` si no se la conoce."""
    key = re.sub(r"[^0-9A-Z]", "", (emulsion or "").upper())
    return _EMULSION_BANDS.get(key)


def plate_mjd(date_obs: str | None) -> float | None:
    """MJD del dia de una placa a partir de `DATE-OBS`, o `None` si no trae fecha.

    Se lee solo el dia. La hora no sirve: en las placas viejas viene con
    minutos imposibles (`1991-06-16T07:80:00`, `1950-07-09T06:75:00`) o sin
    segundos (`1976-03-11T18:13`).
    """
    match = _DATE_RE.match(date_obs or "")
    if match is None:
        return None
    year, month, day = (int(part) for part in match.groups())
    try:
        # Con el calendario y no con astropy: para fechas anteriores a 1960, cuando UTC no
        # existia, `Time` avisa "dubious year" en cada conversion, y aca solo importa el dia.
        return float(datetime.date(year, month, day).toordinal() - _MJD_ZERO_ORDINAL)
    except ValueError:
        return None


def mjd_date(mjd: float) -> str:
    """El dia de una fecha juliana modificada, como texto `AAAA-MM-DD`."""
    return datetime.date.fromordinal(math.floor(mjd) + _MJD_ZERO_ORDINAL).isoformat()


def mjd_year(mjd: float) -> float:
    """Anio juliano con decimales de una fecha juliana modificada: 51544,5 es 2000,0."""
    return 2000.0 + (mjd - 51544.5) / 365.25


# Anios entre los que puede caer una placa de cada generacion. La primera va de POSS-I (1949)
# a las Quick-V del sur (1987); la segunda empieza con las placas rojas del UK Schmidt, a fines
# de los 70, y termina con POSS-II hacia 2002. Los margenes son amplios a proposito: solo
# tienen que atrapar una fecha imposible.
_GENERATION_YEARS: dict[str, tuple[float, float]] = {"DSS1": (1945.0, 1995.0), "DSS2": (1975.0, 2005.0)}


def is_plausible_date(generation: str, year: float) -> bool:
    """Si una fecha de placa es posible para su generacion.

    Hace falta porque el encabezado de alguna placa trae una fecha equivocada:
    la POSS-II SF07095 (campo de RW Aurigae) dice `1952-08-22`, 35 anios antes
    de que empezara ese relevamiento. Una fecha asi no se puede mostrar como la
    de la imagen ni usar para ordenarla en el tiempo.
    """
    low, high = _GENERATION_YEARS.get(generation, (1945.0, 2005.0))
    return low <= year <= high


# -------------------------------------------------------------------- modelos


class OpticalLayer(ContractModel):
    """Una placa del Digitized Sky Survey reproyectada a la grilla del campo."""

    key: str  # "dss2_red"
    survey: Literal["DSS"] = "DSS"
    generation: Literal["DSS1", "DSS2"]
    band: str  # "R", "Bj"
    wave_um: float  # aproximada: es una placa con un filtro ancho
    file: str
    mjd: float
    date: str  # AAAA-MM-DD, el dia de la placa
    year: float
    unit: str  # "plate density": densidad de la placa digitalizada, con el fondo restado
    native_pixel_scale_arcsec: float
    display: Display | None
    valid_fraction: float
    plate: str  # `PLTLABEL`
    plate_survey: str  # `SURVEY`: "POSSII-F", "POSSI-E", "SERC-J", "AAO-GR"
    telescope: str
    emulsion: str
    filter: str
    exposure_min: float | None
    copyright: str  # titular de los derechos de la placa (`COPYRGHT`)
    url: str  # el pedido que la devolvio
    # Falso si la fecha del encabezado es imposible para esa generacion (`is_plausible_date`):
    # la imagen sirve, pero no hay que mostrar esa fecha ni ubicarla en una linea de tiempo.
    date_reliable: bool = True
    # Posicion esperada del objeto del campo en la fecha de la placa; `None` si no se mueve.
    target: LayerTarget | None = None


class OpticalDocument(ContractModel):
    """Las capas opticas guardadas de un campo, de la mas antigua a la mas nueva."""

    version: int = FORMAT_VERSION
    key: str
    grid: GridInfo
    layers: list[OpticalLayer]
    generated_at: str


@dataclass(frozen=True, eq=False)
class BuiltOptical:
    info: OpticalLayer
    image: NDArray[np.float32]


# --------------------------------------------------------------------- pedido


def request_params(version: str, ra: float, dec: float, side_arcmin: float) -> dict[str, str]:
    """Parametros del pedido a STScI (ver el encabezado del modulo). `version` es el valor de `v`."""
    side = min(MAX_SIDE_ARCMIN, side_arcmin)
    return {
        "v": version,
        "r": f"{ra:.6f}",
        "d": f"{dec:.6f}",
        "e": "J2000",
        "h": f"{side:.2f}",
        "w": f"{side:.2f}",
        "f": "fits",
        "c": "none",
        "fov": "NONE",
        "v3": "",
    }


def request_url(version: str, ra: float, dec: float, side_arcmin: float) -> str:
    """El pedido como URL, para dejar constancia de donde salio la imagen."""
    params = request_params(version, ra, dec, side_arcmin)
    return STSCI_DSS_URL + "?" + "&".join(f"{name}={value}" for name, value in params.items())


def cache_path(version: str, ra: float, dec: float, side_arcmin: float, settings: Settings) -> Path:
    name = f"{version}__{ra:.6f}_{dec:+.6f}_{side_arcmin:.2f}.fits"
    return context_cache_dir(settings) / "dss" / name


def side_arcmin(grid: Grid) -> float:
    """Lado del recorte que se pide: el del campo por raiz de 2, mas un margen, como con los otros relevamientos."""
    return round(geometry.cutout_side_deg(grid.fov) * 60.0, 2)


def _error_text(payload: bytes) -> str:
    text = payload[:1200].decode("utf-8", errors="replace")
    plain = " ".join(re.sub(r"<[^>]*>", " ", text).split())
    return plain[:200]


def _fetch_version(version: str, grid: Grid, settings: Settings, refresh: bool, attempts: int) -> Path:
    """El recorte de un valor de `v`, de la cache o de STScI. Lanza `OpticalUnavailable`."""
    side = side_arcmin(grid)
    path = cache_path(version, grid.ra, grid.dec, side, settings)
    if not refresh and path.is_file():
        with contextlib.suppress(OSError):
            if path.read_bytes()[: len(_FITS_SIGNATURE)] == _FITS_SIGNATURE:
                return path
    try:
        payload = get_bytes(
            STSCI_DSS_URL,
            settings,
            # No es IRSA, pero se cuenta en el mismo cupo: asi nunca hay mas pedidos externos a la vez.
            slot=get_limiter(settings).cutout_slot,
            what=f"DSS {version}",
            params=request_params(version, grid.ra, grid.dec, side),
            attempts=attempts,
            max_bytes=MAX_RESPONSE_BYTES,
        )
    except ContextFetchError as exc:
        raise OpticalUnavailable(str(exc)) from exc
    if not payload.startswith(_FITS_SIGNATURE):
        raise OpticalUnavailable(f"DSS {version}: sin imagen para ese punto ({_error_text(payload)})")
    _write_atomic(path, payload)
    return path


def fetch_plate(
    survey: DssSurvey, grid: Grid, settings: Settings, *, refresh: bool = False, attempts: int = 3
) -> tuple[Path, str]:
    """Baja el recorte de la placa (o lo toma de la cache). Devuelve su ruta y el valor de `v` que la dio.

    Prueba los valores de `survey.versions` en orden y se queda con el primero
    que tiene imagen. Lanza `OpticalUnavailable` si ninguno cubre el punto (la
    pagina "ERROR" de STScI) o el servicio no responde.
    """
    errors: list[str] = []
    for version in survey.versions:
        try:
            return _fetch_version(version, grid, settings, refresh, attempts), version
        except OpticalUnavailable as exc:
            errors.append(str(exc))
    raise OpticalUnavailable("; ".join(errors))


# ----------------------------------------------------------------------- capa


def build_layer(
    survey: DssSurvey, grid: Grid, settings: Settings, *, refresh: bool = False, attempts: int = 3
) -> BuiltOptical:
    """Una capa optica en la grilla del campo. Lanza `OpticalUnavailable` si no se puede armar."""
    path, version = fetch_plate(survey, grid, settings, refresh=refresh, attempts=attempts)
    try:
        cutout = read_cutout(path)
        image, _footprint = resample_to_grid(cutout.data, cutout.wcs, grid)
    except ValueError as exc:
        raise OpticalUnavailable(f"DSS {version}: {exc}") from exc
    image = (image - np.float32(background_level(image))).astype(np.float32)
    header: fits.Header = cutout.header
    mjd = plate_mjd(str(header.get("DATE-OBS", "")))
    if mjd is None:
        raise OpticalUnavailable(f"DSS {version}: la placa no trae fecha (DATE-OBS)")
    coverage = valid_fraction(image)
    if coverage <= 0.0:
        raise OpticalUnavailable(f"DSS {version}: la placa no cubre el campo")
    emulsion = str(header.get("EMULSION", "")).strip()
    band = plate_band(emulsion) or ("?", 0.55)
    exposure = header.get("EXPOSURE")
    side = side_arcmin(grid)
    info = OpticalLayer(
        key=survey.key,
        generation=survey.generation,
        band=band[0],
        wave_um=band[1],
        file=f"{survey.key}.f32",
        mjd=round(mjd, 1),
        date=mjd_date(mjd),
        year=round(mjd_year(mjd), 3),
        date_reliable=is_plausible_date(survey.generation, mjd_year(mjd)),
        unit="plate density",
        native_pixel_scale_arcsec=round(cutout.pixel_scale_arcsec, 4),
        display=detector_display([image]),
        valid_fraction=round(coverage, 4),
        plate=str(header.get("PLTLABEL", "")).strip(),
        plate_survey=str(header.get("SURVEY", "")).strip(),
        telescope=str(header.get("TELESCOP", "")).strip(),
        emulsion=emulsion,
        filter=str(header.get("FILTER", "")).strip(),
        exposure_min=float(exposure) if isinstance(exposure, int | float) and math.isfinite(exposure) else None,
        copyright=str(header.get("COPYRGHT", "")).strip(),
        url=request_url(version, grid.ra, grid.dec, side),
    )
    return BuiltOptical(info=info, image=image)


# -------------------------------------------------------------------- almacen


def read_document(store: ContextStore, key: str) -> OpticalDocument:
    """El documento de capas opticas de un campo. Lanza `ContextNotFoundError` si no hay."""
    path = store.folder(key) / OPTICAL_FILENAME
    try:
        return OpticalDocument.model_validate_json(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ContextNotFoundError(f"no hay capas opticas guardadas para {key!r}") from exc
    except (ValidationError, ValueError) as exc:
        raise ContextNotFoundError(f"{path}: no se puede leer: {exc}") from exc


def has_document(store: ContextStore, key: str) -> bool:
    return (store.folder(key) / OPTICAL_FILENAME).is_file()


def read_layer_bytes(store: ContextStore, key: str, layer: str) -> bytes:
    """Bytes de una capa optica tal como van por la API. Comprueba el tamano contra la grilla."""
    document = read_document(store, key)
    entry = next((item for item in document.layers if item.key == layer), None)
    if entry is None:
        raise ContextNotFoundError(f"el campo {key!r} no tiene la capa optica {layer!r}")
    try:
        data = (store.folder(key) / entry.file).read_bytes()
    except OSError as exc:
        raise ContextNotFoundError(f"falta el archivo de la capa optica {layer!r} de {key!r}") from exc
    ny, nx = document.grid.shape
    if len(data) != ny * nx * LAYER_DTYPE.itemsize:
        raise ContextNotFoundError(f"la capa optica {layer!r} de {key!r} no mide lo que pide la grilla")
    return data


def write_document(store: ContextStore, document: OpticalDocument) -> Path:
    path = store.folder(document.key) / OPTICAL_FILENAME
    payload = document.model_dump(mode="json")
    OpticalDocument.model_validate(payload)
    text = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False)
    _write_atomic(path, (text + "\n").encode("utf-8"))
    return path


def build_optical(
    key: str,
    grid: Grid,
    settings: Settings,
    store: ContextStore,
    *,
    survey_keys: Sequence[str] = DEFAULT_SURVEY_KEYS,
    target_at: Callable[[float], LayerTarget | None] | None = None,
    refresh: bool = False,
    out: Printer = print,
) -> OpticalDocument:
    """Arma y guarda las capas opticas de un campo. Lanza `OpticalUnavailable` si no quedo ninguna.

    `target_at(mjd)` da la posicion esperada del objeto del campo en una fecha;
    sin ella las capas quedan sin posicion. Un relevamiento que no cubre el
    campo se informa y se saltea.
    """
    built: list[BuiltOptical] = []
    for survey_key in survey_keys:
        survey = survey_by_key(survey_key)
        started = time.perf_counter()
        try:
            layer = build_layer(survey, grid, settings, refresh=refresh)
        except OpticalUnavailable as exc:
            out(f"      sin {survey_key}: {exc}")
            continue
        # Con una fecha que no es de fiar no se puede decir donde estaba el objeto.
        if target_at is not None and layer.info.date_reliable:
            layer = BuiltOptical(
                info=layer.info.model_copy(update={"target": target_at(layer.info.mjd)}), image=layer.image
            )
        built.append(layer)
        info = layer.info
        doubt = "" if info.date_reliable else " (fecha imposible para esa generacion: no se usa)"
        out(
            f"      {info.generation} {info.plate_survey} placa {info.plate}, {info.date}{doubt}, banda {info.band}, "
            f"{info.valid_fraction:.1%} del campo, {time.perf_counter() - started:.1f} s"
        )
    if not built:
        raise OpticalUnavailable(f"ningun relevamiento optico cubre el campo {key}")
    built.sort(key=lambda layer: layer.info.mjd)
    for layer in built:
        store.write_layer(key, layer.info.file, layer.image, grid.shape)
    document = OpticalDocument(
        key=key,
        grid=geometry.grid_info(grid),
        layers=[layer.info for layer in built],
        generated_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )
    write_document(store, document)
    return document
