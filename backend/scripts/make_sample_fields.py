"""Campos de muestra y fixtures sin red, armados con las salidas de la Etapa 0 (spike/).

No usa la red ni calcula nada nuevo: convierte lo que dejo `spike/field.py` al
formato de campo en disco del backend (`app/jobs/store.py`) y copia de la cache
del spike las respuestas reales que necesitan los tests. Es idempotente: con
los mismos insumos escribe los mismos bytes.

Uso, desde backend/:

    uv run python scripts/make_sample_fields.py

Insumos (ignorados por git; salen de correr `spike/field.py`):

    spike/out/<etiqueta>/cubo.fits      cubo [epoca][detector][y][x] y extension COVERAGE
    spike/out/<etiqueta>/resumen.json   centro, grilla, epocas, exposiciones y mediciones
    spike/cache/cutouts/*.fits          recortes (tabla de bits de FLAGS y fixtures)
    spike/cache/sia/*.xml               respuestas de SIA2 (rangos de onda y fixtures)
    spike/cache/sesame/*.xml            respuestas de Sesame (fixtures)

Que escribe:

    backend/tests/fixtures/fields/<id>/         tres campos terminados: los sirve el servidor falso
    backend/tests/fixtures/fields/index.json    etiqueta, id y origen de cada muestra
    backend/tests/fixtures/cutouts/             12 recortes de Barnard y su index.json
    backend/tests/fixtures/sia/                 respuestas de SIA2 de Barnard y su index.json
    backend/tests/fixtures/sesame/              respuestas de Sesame de los cinco objetos de prueba
    frontend/src/test/fixtures/meta-<etiqueta>.json   metadatos de cada muestra
    frontend/src/test/fixtures/<etiqueta>/      la muestra en formato de campo, con un solo plano
    frontend/src/test/fixtures/events-new-field.json  eventos SSE de un campo nuevo simulado

Que borra: de la carpeta de cada campo, los archivos del formato de campo que una
corrida anterior dejo y ya no corresponden; de fields/, cutouts/ y sia/, solo lo
que su propio index.json anterior listaba (por ejemplo, la carpeta de una
muestra cuyo `id` cambio). No toca archivos que no escribio.

Las muestras, las tres en el escalon base del contrato (10 minutos, 195 x 195 px):

    wise0855   WISE 0855, 3 epocas, datos en todo el campo.
    epsindb    Epsilon Indi B, 4 epocas, dos planos vacios. Datos solo en los 6 minutos centrales.
    barnard    Barnard's Star, 3 epocas, nucleo saturado en los 18 planos. Datos solo en los 6 minutos centrales.

Decisiones que conviene conocer antes de usarlas:

- Geometria. Las tres cumplen la seccion 3 del contrato: `request.fov` y
  `grid.fov` valen 0.1667, la grilla mide 195 x 195 px a 3.075 segundos de arco
  y el `id` sale de `request` con la formula del contrato. El spike corrio
  epsindb y barnard con un campo de 0.1 grados (117 x 117 px, la misma escala):
  esos cubos se ubican, sin remuestrear, en el centro de la grilla del escalon
  base y el marco de 39 px que los rodea queda en `NaN` con cobertura 0. Es lo
  que daria el pipeline real con recortes de 6 minutos; por eso todos sus planos
  llevan el aviso `low_coverage`. Los datos completos de 10 minutos llegan con
  los campos precalculados.
- Identidad. El `id` usa el pipeline de las muestras
  (`app.config.SAMPLE_PIPELINE_VERSION`), no el del backend real: asi una
  muestra nunca comparte `id` ni URL con el campo real del mismo centro, y el
  navegador no confunde lo que guardo del servidor falso con lo del backend.
- `grid.crval` es el centro real con el que el spike reproyecto (6 decimales);
  `request` lleva ese centro normalizado a 4 decimales. El backend real arma
  la grilla sobre el centro normalizado, asi que ahi `crval` y `request`
  coinciden; en las muestras difieren en menos de 0.2 segundos de arco (0.06
  px). Para ubicar algo en la imagen se usa siempre `grid`, nunca `request`.
- Revisiones. Los planos con datos llevan `rev` 2: la 1 es la provisoria que
  simula el servidor falso, que sirve las revisiones tal como estan en disco.
- Un recorte fallido en el spike queda como en el contrato: plano `partial`,
  campo `partial` y aviso `cutouts_failed`. Les paso a wise0855 y a epsindb.
- Saturacion (solo barnard): los cubos del spike traen NaN en el nucleo. El
  hueco de NaN que toca la posicion esperada de la estrella se marca como
  +Infinity, con los bits OVERFLOW y BLOOM encendidos en la capa de flags. El
  resto de la capa de flags va en cero: el spike no guardo los flags por pixel.
- `flags` es la union de los bits que declaran los encabezados de todos los
  recortes del campo, porque cada archivo declara solo algunos.
- `preview.f32` es sintetica: la media de los planos del detector 4, con los
  huecos rellenados y suavizada, en unidades arbitrarias. No es una imagen de
  WISE. En epsindb y barnard el marco que rodea al cubo se rellena con cielo
  vacio (el fondo de la vista con su ruido), porque una vista real cubre todo
  el campo. En los metadatos va rotulada como W1 con `hips: "muestra"`.
- La transcripcion de eventos la produce el servidor falso (`app/fake.py`) sobre
  la muestra wise0855, con la banda 3 y su duracion por defecto.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from astropy.io import fits
from astropy.io.votable import parse as parse_votable
from numpy.typing import NDArray
from scipy import ndimage

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    # El backend no es un paquete instalable: se importa desde backend/.
    sys.path.insert(0, str(BACKEND_DIR))

from app import geometry  # noqa: E402
from app.config import SAMPLE_PIPELINE_VERSION, Settings  # noqa: E402
from app.contract import (  # noqa: E402
    EVENT_ADAPTERS,
    CutoutsFailedWarning,
    DetectorInfo,
    EpochInfo,
    FewExposuresWarning,
    FieldMeta,
    FieldRequest,
    FieldRequestInfo,
    FlagInfo,
    LowCoverageWarning,
    PlaneEmptyWarning,
    PlaneInfo,
    PlaneRef,
    PreviewInfo,
    Progress,
    Provenance,
    SaturatedSourceWarning,
    TrackPosition,
    TrackResponse,
)
from app.domain import Exposure, FovStep, Grid  # noqa: E402
from app.jobs.store import (  # noqa: E402
    META_FILENAME,
    FieldStore,
    aux_filename,
    plane_filename,
    track_filename,
    with_cube_offsets,
)
from app.pipeline.exposure import MASKED_FLAGS, SATURATION_FLAGS  # noqa: E402
from app.pipeline.stats import detector_display, plane_stats, robust_stats, saturated_regions  # noqa: E402

REPO_DIR = BACKEND_DIR.parent
SPIKE_OUT = REPO_DIR / "spike" / "out"
SPIKE_CACHE = REPO_DIR / "spike" / "cache"

FIXTURES_DIR = BACKEND_DIR / "tests" / "fixtures"
FIELDS_DIR = FIXTURES_DIR / "fields"
CUTOUTS_DIR = FIXTURES_DIR / "cutouts"
SIA_DIR = FIXTURES_DIR / "sia"
SESAME_DIR = FIXTURES_DIR / "sesame"
FRONTEND_DIR = REPO_DIR / "frontend"
FRONTEND_FIXTURES_DIR = FRONTEND_DIR / "src" / "test" / "fixtures"

INDEX_FILENAME = "index.json"
EVENTS_FILENAME = "events-new-field.json"

# Nombres del formato de campo en disco (`app/jobs/store.py`).
FIELD_FILE_PATTERN = re.compile(
    r"^(meta\.json|preview\.f32|plane_e\d+_d\d+\.f32|aux_e\d+_d\d+\.bin\.gz|track_[a-z0-9-]+\.json)$"
)

# Valores por defecto del backend, sin mirar las variables de entorno: el
# resultado no puede depender de quien corre el script.
DEFAULTS = Settings()

# Avisos (contrato, seccion 5): menos de 5 exposiciones y menos del 90 % del plano con datos.
FEW_EXPOSURES_BELOW = 5
LOW_COVERAGE_BELOW = 0.90

# Saturacion. El hueco tiene que tocar la posicion esperada (a esta distancia o
# menos) y no se marca nada mas alla de 6 pixeles nativos, que es donde termina
# el halo medido en spike/resultados/saturacion_barnard.txt.
SATURATION_TOUCH_PX = 1.5
SATURATION_MAX_RADIUS_ARCSEC = 6.0 * geometry.NATIVE_PIXEL_SCALE_ARCSEC

# Vista provisoria sintetica. El detector 4 (2.40 a 3.85 micrones) es el que
# contiene la banda W1 de WISE (3.4 micrones). La ganancia y el desplazamiento
# la dejan en unidades arbitrarias, lejos a proposito de los MJy/sr de los
# planos: si el frontend la dibuja con la escala de un detector, se nota.
PREVIEW_DETECTOR = 4
PREVIEW_FILL_SIGMA_PX = 2.0
PREVIEW_FILL_PASSES = 40
PREVIEW_SMOOTH_SIGMA_PX = 1.0
PREVIEW_GAIN = 25.0
PREVIEW_OFFSET = 4.0

# Recortes guardados para los tests: dos epocas (la primera y la ultima, una de
# DR1 y otra de QR3), dos detectores (uno de onda corta y uno de onda larga) y
# tres exposiciones de cada plano, repartidas a lo largo de la pasada.
CUTOUT_SAMPLE = "barnard"
CUTOUT_EPOCHS = (1, 3)
CUTOUT_DETECTORS = (3, 6)
CUTOUTS_PER_PLANE = 3

# Banda con la que se simula el campo nuevo de la transcripcion: la que el contrato usa por defecto.
EVENTS_SAMPLE = "wise0855"
EVENTS_BAND = 3

Key = tuple[int, int]  # (epoca, detector)


class SampleError(RuntimeError):
    """Los insumos del spike no son los esperados."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SampleError(message)


# ------------------------------------------------------------------ muestras


@dataclass(frozen=True)
class SampleSpec:
    """Una corrida del spike que se convierte en campo de muestra."""

    label: str  # nombre corto: lo usan fields/index.json y los archivos del frontend
    spike_label: str  # carpeta dentro de spike/out
    enlarged_cutouts: bool  # la corrida pidio recortes de lado fov x raiz(2) + 4 px
    mark_saturation: bool  # marcar como saturado el hueco de NaN sobre el objetivo
    frontend_plane: Key | None  # plano que se copia a los fixtures del frontend
    note: str


SAMPLES: tuple[SampleSpec, ...] = (
    SampleSpec(
        label="wise0855",
        spike_label="wise0855-10min",
        enlarged_cutouts=True,
        mark_saturation=False,
        frontend_plane=(2, 6),
        note="Datos en todo el campo. El objeto se ve en los detectores 5 y 6. Un recorte fallido en (2, 3).",
    ),
    SampleSpec(
        label="epsindb",
        spike_label="epsindb",
        enlarged_cutouts=False,
        mark_saturation=False,
        frontend_plane=None,
        note="Cuatro epocas. Planos vacios en (4, 1) y (4, 4), planos pobres en (1, 1) y (1, 4) y un recorte "
        "fallido en (2, 6). Datos solo en los 6 minutos centrales: el resto del campo va sin datos.",
    ),
    SampleSpec(
        label="barnard",
        spike_label="barnard",
        enlarged_cutouts=False,
        mark_saturation=True,
        frontend_plane=(1, 3),
        note="Nucleo saturado (+Infinity) en los 18 planos. La estrella se corre 10 segundos de arco al norte. "
        "Datos solo en los 6 minutos centrales: el resto del campo va sin datos.",
    ),
)


@dataclass
class SpikeRun:
    """Lo que dejo `spike/field.py` para un objeto."""

    spec: SampleSpec
    summary: dict[str, Any]
    cube: NDArray[np.float32]  # [epoca][detector][y][x], NaN sin datos
    coverage: NDArray[np.uint16]
    header: fits.Header

    @property
    def center(self) -> tuple[float, float]:
        return float(self.summary["center"]["ra"]), float(self.summary["center"]["dec"])

    @property
    def fov(self) -> float:
        return float(self.summary["fov_deg"])

    @property
    def cutout_side(self) -> float:
        """Lado de los recortes que bajo la corrida, en grados."""
        return geometry.cutout_side_deg(self.fov) if self.spec.enlarged_cutouts else self.fov

    @property
    def target_name(self) -> str:
        """Nombre principal segun SIMBAD: `oname` de Sesame, que el spike dejo en `target.source`."""
        target = self.summary["target"]
        match = re.search(r"\((.+)\)\s*$", str(target.get("source", "")))
        return match.group(1) if match else str(target["name"])


@dataclass
class BuiltSample:
    """Un campo de muestra ya escrito en disco."""

    spec: SampleSpec
    run: SpikeRun
    meta: FieldMeta
    track: TrackResponse
    margin_px: int  # marco sin datos alrededor del cubo del spike, por lado

    @property
    def id(self) -> str:
        return self.meta.id


def load_spike_run(spec: SampleSpec) -> SpikeRun:
    folder = SPIKE_OUT / spec.spike_label
    summary_path, cube_path = folder / "resumen.json", folder / "cubo.fits"
    for path in (summary_path, cube_path):
        require(path.is_file(), f"falta {path}: hay que correr spike/field.py para {spec.spike_label!r}")
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    with fits.open(cube_path, memmap=False) as hdul:
        header = hdul[0].header.copy()
        # Los FITS guardan big-endian: se pasa al orden de bytes de la maquina.
        cube = np.array(hdul[0].data, dtype=np.float32)
        raw_coverage = np.array(hdul["COVERAGE"].data, dtype=np.int64)
    require(cube.ndim == 4 and cube.shape[1] == 6, f"{cube_path}: se esperaba [epoca][6][y][x], hay {cube.shape}")
    require(raw_coverage.shape == cube.shape, f"{cube_path}: COVERAGE no tiene la forma del cubo")
    require(int(raw_coverage.min()) >= 0, f"{cube_path}: cobertura negativa")
    require(len(summary["epochs"]) == cube.shape[0], f"{cube_path}: el cubo y resumen.json no tienen las mismas epocas")
    require(not np.isinf(cube).any(), f"{cube_path}: el cubo del spike no deberia traer infinitos")
    return SpikeRun(spec=spec, summary=summary, cube=cube, coverage=raw_coverage.astype(np.uint16), header=header)


def build_spike_grid(run: SpikeRun) -> Grid:
    """Grilla del cubo del spike con `app.geometry`, comprobada contra el WCS que el spike dejo en el cubo."""
    ra, dec = run.center
    scale = float(run.summary["grid"]["pixel_scale_arcsec"])
    grid = geometry.make_grid(ra, dec, run.fov, scale)
    require(
        grid.shape == tuple(run.summary["grid"]["shape"]) == run.cube.shape[2:],
        f"{run.spec.spike_label}: la grilla de geometry ({grid.shape}) no es la del cubo ({run.cube.shape[2:]})",
    )
    info = geometry.grid_info(grid)
    header = run.header
    expected = (
        header["CRVAL1"],
        header["CRVAL2"],
        header["CRPIX1"],
        header["CRPIX2"],
        header["CDELT1"],
        header["CDELT2"],
    )
    actual = (*info.crval, *info.crpix, *info.cdelt)
    require(
        bool(np.allclose(actual, expected, rtol=0.0, atol=1e-9)) and header["CTYPE1"] == "RA---TAN",
        f"{run.spec.spike_label}: el WCS de geometry {actual} no coincide con el del cubo {expected}",
    )
    return grid


def build_field_grid(run: SpikeRun, spike_grid: Grid, step: FovStep) -> tuple[Grid, int]:
    """Grilla del campo de muestra (la del escalon del contrato) y el marco, en pixeles, que rodea al cubo del spike.

    La grilla del escalon tiene el mismo centro y la misma escala que la del
    spike, y las dos tienen lado impar: el pixel `(x, y)` del cubo es exactamente
    el `(x + marco, y + marco)` de la grilla del escalon. Por eso el cubo se
    ubica en el centro sin remuestrear. El marco vale 0 si el spike ya corrio en
    el escalon.
    """
    label = run.spec.spike_label
    grid = geometry.make_grid(spike_grid.ra, spike_grid.dec, step.fov, step.pixel_scale_arcsec)
    require(grid.shape == (step.size, step.size), f"{label}: la grilla del escalon mide {grid.shape}")
    require(
        abs(spike_grid.pixel_scale_arcsec - step.pixel_scale_arcsec) < 1e-9,
        f"{label}: el cubo esta a {spike_grid.pixel_scale_arcsec} segundos de arco por pixel y el escalon "
        f"a {step.pixel_scale_arcsec}; habria que remuestrear",
    )
    difference = grid.shape[0] - spike_grid.shape[0]
    require(
        difference >= 0 and difference % 2 == 0 and spike_grid.shape[0] == spike_grid.shape[1],
        f"{label}: un cubo de {spike_grid.shape} no entra centrado en una grilla de {grid.shape}",
    )
    margin = difference // 2
    # El centro de cada grilla es su pixel central: el corrimiento entre las dos es el marco.
    spike_crpix, field_crpix = spike_grid.wcs.wcs.crpix, grid.wcs.wcs.crpix
    require(
        abs(field_crpix[0] - spike_crpix[0] - margin) < 1e-9 and abs(field_crpix[1] - spike_crpix[1] - margin) < 1e-9,
        f"{label}: el centro del cubo no cae en el centro de la grilla del escalon",
    )
    return grid, margin


def embed(array: NDArray[Any], shape: tuple[int, int], margin: int, fill: float) -> NDArray[Any]:
    """Ubica `array` en el centro de un arreglo de forma `shape` y del mismo tipo, con `fill` en el marco."""
    if margin == 0:
        return array.copy()
    out = np.full(shape, fill, dtype=array.dtype)
    out[margin : margin + array.shape[0], margin : margin + array.shape[1]] = array
    return out


# ------------------------------------------------------------- insumos de IRSA


def read_sia_exposures(ra: float, dec: float) -> list[Exposure]:
    """Exposiciones de nivel 2 que lista la respuesta de SIA2 guardada por el spike para ese centro.

    Columnas ObsCore de `spherex.obscore`, las mismas que usa `list_exposures_sia`
    en spike/field.py: obs_id, obs_collection, energy_bandpassname, t_min, t_max,
    access_url, em_min, em_max, calib_level, dataproduct_type, dataproduct_subtype.
    Fuente: TAP_SCHEMA (spike/resultados/tap_schema.txt) y el tutorial
    https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/
    IRSA pone `ID="col_N"` en cada FIELD; los nombres ObsCore estan en `name`.
    """
    exposures: list[Exposure] = []
    for collection in DEFAULTS.collections:
        path = sia_cache_path(collection, ra, dec)
        require(path.is_file(), f"falta la respuesta de SIA2 {path}")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            table = parse_votable(io.BytesIO(path.read_bytes())).get_first_table().to_table(use_names_over_ids=True)
        for row in table:
            kind = (str(row["dataproduct_type"]), str(row["dataproduct_subtype"]), int(row["calib_level"]))
            if kind != ("image", "science", 2):
                continue
            exposures.append(
                Exposure(
                    obs_id=str(row["obs_id"]),
                    collection=str(row["obs_collection"]),
                    detector=int(str(row["energy_bandpassname"]).rsplit("D", 1)[-1]),
                    mjd_start=float(row["t_min"]),
                    mjd_end=float(row["t_max"]),
                    url=str(row["access_url"]),
                    wave_min_um=float(row["em_min"]) * 1e6,
                    wave_max_um=float(row["em_max"]) * 1e6,
                )
            )
    return exposures


def sia_cache_path(collection: str, ra: float, dec: float) -> Path:
    """Nombre con el que `sia_query` (spike/irsa.py) guarda la respuesta de una coleccion."""
    return SPIKE_CACHE / "sia" / f"{collection}__{ra:.6f}_{dec:+.6f}.xml"


def cached_cutouts(ra: float, dec: float, side_deg: float) -> list[Path]:
    """Recortes de ese centro y ese lado en la cache del spike (`_cache_path` en spike/irsa.py)."""
    return sorted((SPIKE_CACHE / "cutouts").glob(f"*__{ra:.6f}_{dec:+.6f}_{side_deg:g}_img.fits"))


def read_flag_table(run: SpikeRun) -> list[FlagInfo]:
    """Bits de FLAGS segun los encabezados de los recortes del campo.

    `MSKNnnnn` da el nombre del bit nnnn y `MSKDnnnn` su descripcion (tutorial
    spherex-intro, seccion 9). Cada archivo declara solo algunos de los bits
    (SNOWBALL falta en uno de cada veinte y SATELLITE_HALO aparece en muy
    pocos), asi que se toma la union de todos los recortes del campo.
    """
    paths = cached_cutouts(*run.center, run.cutout_side)
    require(bool(paths), f"{run.spec.spike_label}: no hay recortes de lado {run.cutout_side:g} en {SPIKE_CACHE}")
    table: dict[int, tuple[str, str]] = {}
    for path in paths:
        with fits.open(path, memmap=False) as hdul:
            header = hdul["FLAGS"].header
            for key in header["MSKN*"]:
                entry = (str(header[key]).strip(), str(header.get(f"MSKD{key[4:]}", "")).strip())
                known = table.setdefault(int(key[4:]), entry)
                require(known == entry, f"{path.name}: el bit {key[4:]} es {entry} y en otro archivo era {known}")
    for name in SATURATION_FLAGS:
        require(any(name == entry[0] for entry in table.values()), f"ningun recorte declara el flag {name}")
    return [
        FlagInfo(
            bit=bit,
            name=name,
            description=description,
            masked=name in MASKED_FLAGS,
            saturation=name in SATURATION_FLAGS,
        )
        for bit, (name, description) in sorted(table.items())
    ]


# ----------------------------------------------------------------- imagenes


def saturated_core(image: NDArray[np.float32], x: float, y: float, max_radius_px: float) -> NDArray[np.bool_]:
    """Mascara del hueco de NaN que rodea la posicion `(x, y)`.

    Son las componentes conexas de NaN (vecindad de 8, como en
    `saturated_regions`) que tienen algun pixel a `SATURATION_TOUCH_PX` o menos
    de la posicion, recortadas a `max_radius_px`.
    """
    missing = np.isnan(image)
    labels, _ = ndimage.label(missing, structure=np.ones((3, 3), dtype=int))
    rows, cols = np.indices(image.shape)
    distance = np.hypot(cols - x, rows - y)
    touching = np.unique(labels[missing & (distance <= SATURATION_TOUCH_PX)])
    return np.isin(labels, touching) & missing & (distance <= max_radius_px)


def synthetic_preview(images: list[NDArray[np.float32]]) -> NDArray[np.float32]:
    """Vista provisoria sintetica: media de las epocas de un detector, sin huecos y suavizada.

    Una imagen real de WISE cubre todo el campo, tambien donde SPHEREx no tiene
    datos o satura. Por eso los huecos se rellenan hacia adentro con el promedio
    de los vecinos antes de suavizar. Si algo queda sin rellenar, va como NaN.

    Un nucleo saturado se ve en WISE como lo mas brillante del campo, no como un
    hueco: cada region saturada en alguna epoca se rellena pareja, con el valor
    mas alto de su borde.
    """
    planes = np.stack(images).astype(np.float64)
    valid = np.isfinite(planes)
    saturated = np.isposinf(planes).any(axis=0)
    count = np.where(saturated, 0, valid.sum(axis=0))
    filled = np.where(count > 0, np.where(valid, planes, 0.0).sum(axis=0) / np.maximum(count, 1), np.nan)
    labels, n_regions = ndimage.label(saturated, structure=np.ones((3, 3), dtype=int))
    for label in range(1, n_regions + 1):
        core = labels == label
        border = ndimage.binary_dilation(core, iterations=2) & ~saturated & np.isfinite(filled)
        if border.any():
            filled[core] = filled[border].max()
    for _ in range(PREVIEW_FILL_PASSES):
        missing = ~np.isfinite(filled)
        if not missing.any():
            break
        weight = ndimage.gaussian_filter((~missing).astype(np.float64), PREVIEW_FILL_SIGMA_PX, mode="constant")
        total = ndimage.gaussian_filter(np.where(missing, 0.0, filled), PREVIEW_FILL_SIGMA_PX, mode="constant")
        reachable = missing & (weight > 0.05)
        if not reachable.any():
            break
        filled[reachable] = total[reachable] / weight[reachable]
    missing = ~np.isfinite(filled)
    weight = ndimage.gaussian_filter((~missing).astype(np.float64), PREVIEW_SMOOTH_SIGMA_PX, mode="nearest")
    total = ndimage.gaussian_filter(np.where(missing, 0.0, filled), PREVIEW_SMOOTH_SIGMA_PX, mode="nearest")
    with np.errstate(invalid="ignore", divide="ignore"):
        smooth = np.where(missing | (weight <= 0.0), np.nan, total / weight)
    return (PREVIEW_GAIN * smooth + PREVIEW_OFFSET).astype(np.float32)


def frame_preview(preview: NDArray[np.float32], shape: tuple[int, int], margin: int, label: str) -> NDArray[np.float32]:
    """Lleva la vista provisoria sintetica a la grilla del campo cuando el cubo del spike es mas chico.

    Una imagen de WISE cubre todo el campo, asi que el marco no puede quedar sin
    datos. Tampoco hay de donde sacar las fuentes que estarian ahi: se rellena
    con cielo vacio, es decir el fondo de la vista (su mediana) con ruido del
    mismo grano. El grano se mide con la diferencia entre pixeles vecinos, que
    casi no depende de las fuentes, y el ruido se suaviza igual que la vista.
    Es determinista: la semilla sale de la etiqueta de la muestra.
    """
    if margin == 0:
        return preview
    values = preview[np.isfinite(preview)].astype(np.float64)
    require(values.size > 0, f"{label}: la vista provisoria no tiene ningun pixel con valor")
    median, _ = robust_stats(values)

    def grain(image: NDArray[np.floating]) -> float:
        steps = np.diff(image.astype(np.float64), axis=1)
        return robust_stats(steps[np.isfinite(steps)])[1]

    seed = int.from_bytes(hashlib.sha256(f"preview|{label}".encode()).digest()[:8], "little")
    noise = ndimage.gaussian_filter(np.random.default_rng(seed).normal(0.0, 1.0, shape), PREVIEW_SMOOTH_SIGMA_PX)
    framed = (median + noise * grain(preview) / grain(noise)).astype(np.float32)
    framed[margin : margin + preview.shape[0], margin : margin + preview.shape[1]] = preview
    return framed


# -------------------------------------------------------- metadatos del campo


def build_track(run: SpikeRun, grid: Grid) -> TrackResponse:
    """Posicion esperada del objetivo en cada epoca (contrato, seccion 4.9).

    `resumen.json` trae la posicion esperada por epoca y detector, propagada a
    la fecha media de las exposiciones de ese plano. Aca se promedian los
    detectores de cada epoca y el resultado se pasa a pixeles de la grilla.
    """
    positions: list[TrackPosition] = []
    for epoch in range(1, run.cube.shape[0] + 1):
        rows = [m for m in run.summary["target_measurements"] if m["epoch"] == epoch]
        if not rows:
            continue
        ra = float(np.mean([m["expected_ra"] for m in rows]))
        dec = float(np.mean([m["expected_dec"] for m in rows]))
        x, y = geometry.sky_to_pixel(grid, ra, dec)
        positions.append(
            TrackPosition(
                epoch=epoch,
                mjd=round(float(np.mean([m["mjd_mean"] for m in rows])), 4),
                ra=round(ra, 7),
                dec=round(dec, 7),
                x=round(x, 3),
                y=round(y, 3),
                in_field=geometry.in_grid(grid, x, y),
            )
        )
    return TrackResponse(name=run.target_name, positions=positions)


def saturated_source_warning(grid: Grid, planes: list[PlaneInfo]) -> SaturatedSourceWarning | None:
    """Un aviso por la fuente saturada del campo: el objetivo. Su region es la mayor de cada plano."""
    cores = [(plane, plane.saturated[0]) for plane in planes if plane.saturated]
    if not cores:
        return None
    x = float(np.mean([region.x for _, region in cores]))
    y = float(np.mean([region.y for _, region in cores]))
    ra, dec = geometry.pixel_to_sky(grid, x, y)
    radius_px = max(region.radius_px for _, region in cores)
    return SaturatedSourceWarning(
        ra=round(ra, 5),
        dec=round(dec, 5),
        radius_arcsec=round(radius_px * grid.pixel_scale_arcsec, 1),
        epochs=sorted({plane.epoch for plane, _ in cores}),
        detectors=sorted({plane.detector for plane, _ in cores}),
    )


def build_warnings(grid: Grid, planes: list[PlaneInfo]) -> list[Any]:
    """Avisos que corresponden a los planos, en un orden fijo."""
    found: list[Any] = [
        PlaneEmptyWarning(epoch=plane.epoch, detector=plane.detector) for plane in planes if plane.status == "empty"
    ]
    found += [
        FewExposuresWarning(epoch=plane.epoch, detector=plane.detector, n=plane.n_used)
        for plane in planes
        if plane.status != "empty" and plane.n_used < FEW_EXPOSURES_BELOW
    ]
    found += [
        LowCoverageWarning(epoch=plane.epoch, detector=plane.detector, valid_fraction=plane.stats.valid_fraction)
        for plane in planes
        if plane.stats is not None and plane.stats.valid_fraction < LOW_COVERAGE_BELOW
    ]
    saturated = saturated_source_warning(grid, planes)
    if saturated is not None:
        found.append(saturated)
    failed = [plane for plane in planes if plane.n_failed > 0]
    if failed:
        found.append(
            CutoutsFailedWarning(
                n=sum(plane.n_failed for plane in failed),
                planes=[PlaneRef(epoch=plane.epoch, detector=plane.detector) for plane in failed],
            )
        )
    return found


def build_sample(spec: SampleSpec, store: FieldStore) -> BuiltSample:
    """Convierte una corrida del spike en un campo terminado y lo escribe con `FieldStore`."""
    run = load_spike_run(spec)
    summary = run.summary
    spike_grid = build_spike_grid(run)
    n_epochs = run.cube.shape[0]
    ra, dec = run.center

    # Identidad y grilla (contrato, seccion 3): el escalon al que se normaliza el campo del spike,
    # con el pipeline de las muestras. Si el spike corrio un campo mas chico que el escalon, su cubo
    # va en el centro de la grilla y el marco queda sin datos.
    request = geometry.normalize_request(ra, dec, run.fov, pipeline=SAMPLE_PIPELINE_VERSION)
    field_id = request.field_id
    grid, margin = build_field_grid(run, spike_grid, request.step)
    shape = grid.shape

    flags = read_flag_table(run)
    saturation_bits = sum(1 << flag.bit for flag in flags if flag.saturation)
    measurements: dict[Key, dict[str, Any]] = {(m["epoch"], m["detector"]): m for m in summary["target_measurements"]}
    max_radius_px = SATURATION_MAX_RADIUS_ARCSEC / spike_grid.pixel_scale_arcsec

    planes: list[PlaneInfo] = []
    images: dict[Key, NDArray[np.float32]] = {}
    aux: dict[Key, tuple[NDArray[np.uint32], NDArray[np.uint16]]] = {}
    preview_sources: list[NDArray[np.float32]] = []  # planos del detector de la vista, en la grilla del spike
    for epoch_info in summary["epochs"]:
        epoch = int(epoch_info["index"])
        for detector in range(1, 7):
            key = (epoch, detector)
            n_exposures = int(epoch_info["by_detector"][f"D{detector}"])
            measurement = measurements.get(key)
            # `n_exposures` de una medicion son las exposiciones que entraron al coadd de ese plano.
            n_used = int(measurement["n_exposures"]) if measurement else 0
            image = run.cube[epoch - 1, detector - 1].copy()
            coverage = run.coverage[epoch - 1, detector - 1]
            require(n_used <= n_exposures, f"{spec.label} {key}: mas exposiciones usadas que listadas")
            require(
                bool(((coverage == 0) == ~np.isfinite(image)).all()),
                f"{spec.label} {key}: la cobertura no vale 0 exactamente donde no hay dato",
            )
            require(int(coverage.max()) <= n_used, f"{spec.label} {key}: cobertura mayor que las exposiciones usadas")
            if n_used == 0:
                require(not np.isfinite(image).any(), f"{spec.label} {key}: plano sin exposiciones pero con datos")
                # Si tenia exposiciones y ninguna sirvio, pasar a vacio es una revision.
                planes.append(
                    PlaneInfo(
                        epoch=epoch,
                        detector=detector,
                        status="empty",
                        rev=1 if n_exposures else 0,
                        n_exposures=n_exposures,
                        n_failed=n_exposures,
                    )
                )
                continue

            assert measurement is not None
            # Comprueba que las dos grillas ubican el objetivo donde lo ubico el spike: la del cubo,
            # en el mismo pixel, y la del campo, corrida en el marco.
            x, y = geometry.sky_to_pixel(spike_grid, measurement["expected_ra"], measurement["expected_dec"])
            field_x, field_y = geometry.sky_to_pixel(grid, measurement["expected_ra"], measurement["expected_dec"])
            require(
                abs(x - measurement["expected_x"]) < 0.01 and abs(y - measurement["expected_y"]) < 0.01,
                f"{spec.label} {key}: la posicion esperada no coincide con la del spike",
            )
            require(
                abs(field_x - x - margin) < 1e-6 and abs(field_y - y - margin) < 1e-6,
                f"{spec.label} {key}: el cubo no queda centrado en la grilla del escalon",
            )
            if spec.mark_saturation:
                image[saturated_core(image, x, y, max_radius_px)] = np.inf
            if detector == PREVIEW_DETECTOR:
                preview_sources.append(image)
            # Recien ahora al centro de la grilla del campo: el marco va sin datos y con cobertura 0.
            image = embed(image, shape, margin, np.nan)
            coverage = embed(coverage, shape, margin, 0)
            plane_flags = np.where(np.isposinf(image), saturation_bits, 0).astype(np.uint32)
            images[key] = image
            aux[key] = (plane_flags, coverage)
            planes.append(
                PlaneInfo(
                    epoch=epoch,
                    detector=detector,
                    status="partial" if n_used < n_exposures else "ready",
                    # La 1 queda para la revision provisoria que simula el servidor falso.
                    rev=2,
                    n_exposures=n_exposures,
                    n_used=n_used,
                    n_failed=n_exposures - n_used,
                    mjd_mean=float(measurement["mjd_mean"]),
                    stats=plane_stats(image),
                    saturated=saturated_regions(image),
                )
            )

    download = summary["download"]
    total = int(summary["exposures"]["total"])
    failed = sum(plane.n_failed for plane in planes)
    require(sum(plane.n_exposures for plane in planes) == total, f"{spec.label}: las exposiciones por plano no suman")
    require(
        failed == int(download["failed_count"]) + len(download["unreadable"]),
        f"{spec.label}: los recortes fallidos por plano no coinciden con resumen.json",
    )
    require("cortado" in str(download["mode"]), f"{spec.label}: se esperaba una descarga cortada antes de EPSF")

    # Rango de onda de cada detector segun SIA2 (`em_min` y `em_max`, en metros).
    exposures = read_sia_exposures(ra, dec)
    require(len(exposures) == total, f"{spec.label}: SIA2 lista {len(exposures)} exposiciones y el spike uso {total}")
    detectors: list[DetectorInfo] = []
    for detector in range(1, 7):
        own = [exposure for exposure in exposures if exposure.detector == detector]
        require(bool(own), f"{spec.label}: SIA2 no lista exposiciones del detector {detector}")
        detectors.append(
            DetectorInfo(
                detector=detector,
                wave_min_um=round(min(exposure.wave_min_um for exposure in own), 4),
                wave_max_um=round(max(exposure.wave_max_um for exposure in own), 4),
                display=detector_display([image for (_, d), image in images.items() if d == detector]),
            )
        )

    require(
        bool(preview_sources), f"{spec.label}: el detector {PREVIEW_DETECTOR} no tiene planos para la vista provisoria"
    )
    preview_image = frame_preview(synthetic_preview(preview_sources), shape, margin, spec.label)
    collections = summary["query"]["collections"]
    status = "partial" if failed else "ready"
    meta = with_cube_offsets(
        FieldMeta(
            id=field_id,
            pipeline=SAMPLE_PIPELINE_VERSION,
            status=status,
            rev=1,
            request=FieldRequestInfo(ra=request.ra, dec=request.dec, fov=request.fov),
            grid=geometry.grid_info(grid),
            detectors=detectors,
            epochs=[
                EpochInfo(
                    epoch=int(item["index"]),
                    start=str(item["start"]),
                    end=str(item["end"]),
                    mjd_start=float(item["mjd_start"]),
                    mjd_end=float(item["mjd_end"]),
                    mjd_mean=float(item["mjd_mean"]),
                    n_exposures=int(item["n_exposures"]),
                )
                for item in summary["epochs"]
            ],
            planes=planes,
            flags=flags,
            progress=Progress(
                phase="done",
                cutouts_total=total,
                cutouts_done=total - failed,
                cutouts_failed=failed,
                cutouts_cached=int(download["from_cache"]),
                # Como en el servidor falso: cuentan todos los planos, y los vacios se dan por terminados.
                planes_total=len(planes),
                planes_ready=len(planes),
                elapsed_s=round(float(summary["total_seconds"]), 1),
            ),
            warnings=build_warnings(grid, planes),
            preview=PreviewInfo(
                status="ready",
                survey="WISE",
                band="W1",
                wave_um=3.4,
                hips="muestra",
                display=detector_display([preview_image]),
            ),
            provenance=Provenance(
                collections=list(DEFAULTS.collections),
                listed_at=max(str(collections[name]["queried_at"]) for name in collections),
                list_stale=False,
                download_mode="truncated",
                built_at=str(summary["run_at"]),
            ),
        )
    )
    require(len(planes) == 6 * n_epochs, f"{spec.label}: faltan planos")

    track = build_track(run, grid)
    written = {store.write_meta(meta).name}
    for key, image in images.items():
        written.add(store.write_plane(field_id, *key, image, shape=shape).name)
        written.add(store.write_aux(field_id, *key, *aux[key], shape=shape).name)
    written.add(store.write_preview(field_id, preview_image, shape=shape).name)
    written.add(store.write_track(field_id, track).name)
    remove_stale_field_files(store.write_root / field_id, written)
    return BuiltSample(spec=spec, run=run, meta=meta, track=track, margin_px=margin)


# ------------------------------------------------------------------ archivos


def dump_json(document: object) -> bytes:
    """JSON con el mismo estilo que escribe `FieldStore`."""
    return (json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def write_bytes(path: Path, data: bytes) -> None:
    """Escribe solo si el contenido cambia, para no tocar la fecha de un archivo que ya esta bien."""
    if path.is_file() and path.read_bytes() == data:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def remove_stale_field_files(folder: Path, keep: set[str]) -> None:
    """Borra de la carpeta de un campo los archivos de una corrida anterior que ya no corresponden.

    Solo toca nombres del formato de campo en disco (por ejemplo, el plano de
    una epoca que ahora esta vacia). Lo que otra persona haya dejado ahi, queda.
    """
    for path in folder.iterdir():
        if path.is_file() and path.name not in keep and FIELD_FILE_PATTERN.match(path.name):
            path.unlink()


def indexed_files(folder: Path, key: str) -> set[str]:
    """Archivos que una corrida anterior de este script anoto en el `index.json` de una carpeta."""
    path = folder / INDEX_FILENAME
    if not path.is_file():
        return set()
    try:
        items = json.loads(path.read_text(encoding="utf-8")).get(key, [])
    except (ValueError, AttributeError):
        return set()
    return {str(item["file"]) for item in items if isinstance(item, dict) and "file" in item}


def remove_stale_indexed_files(folder: Path, before: set[str], now: set[str]) -> None:
    """Borra lo que el indice anterior listaba y el nuevo ya no. No toca archivos que este script no escribio."""
    for name in before - now:
        if Path(name).name == name:
            (folder / name).unlink(missing_ok=True)


def indexed_sample_ids() -> set[str]:
    """Ids de las muestras que una corrida anterior de este script anoto en fields/index.json."""
    path = FIELDS_DIR / INDEX_FILENAME
    if not path.is_file():
        return set()
    try:
        items = json.loads(path.read_text(encoding="utf-8")).get("samples", [])
    except (ValueError, AttributeError):
        return set()
    return {str(item["id"]) for item in items if isinstance(item, dict) and "id" in item}


def remove_stale_samples(before: set[str], now: set[str]) -> None:
    """Borra las carpetas de muestras que el indice anterior listaba y el nuevo ya no (cambio su `id`).

    De cada carpeta borra solo los archivos del formato de campo en disco, y la
    carpeta misma si queda vacia. Lo que otra persona haya dejado ahi, queda.
    """
    for field_id in sorted(before - now):
        folder = FIELDS_DIR / field_id
        if Path(field_id).name != field_id or not folder.is_dir():
            continue
        remove_stale_field_files(folder, set())
        if not any(folder.iterdir()):
            folder.rmdir()
            print(f"  borrada la muestra anterior {field_id}")
        else:
            print(f"  aviso: {folder} tiene archivos que este script no escribio; quedan ahi")


def write_fields_index(samples: list[BuiltSample], before: set[str]) -> None:
    entries = []
    for sample in samples:
        meta = sample.meta
        assert meta.grid is not None and meta.epochs is not None
        data_size = meta.grid.shape[0] - 2 * sample.margin_px
        entries.append(
            {
                "label": sample.spec.label,
                "id": sample.id,
                "pipeline": meta.pipeline,
                "object": sample.run.summary["target"]["name"],
                "track_name": sample.track.name,
                "track_file": track_filename(sample.track.name),
                "source": f"spike/out/{sample.spec.spike_label}",
                "status": meta.status,
                "fov": meta.grid.fov,
                "shape": list(meta.grid.shape),
                "epochs": len(meta.epochs),
                # Todas estan en un escalon del contrato. Lo que cambia es cuanto del campo tiene datos:
                # el cuadrado central de `data_shape` pixeles (el campo de `data_fov` grados que corrio
                # el spike); el resto es marco sin datos.
                "contract_step": True,
                "data_fov": sample.run.fov,
                "data_shape": [data_size, data_size],
                "margin_px": sample.margin_px,
                "note": sample.spec.note,
            }
        )
    document = {"generated_by": "backend/scripts/make_sample_fields.py", "samples": entries}
    write_bytes(FIELDS_DIR / INDEX_FILENAME, dump_json(document))
    known = {sample.id for sample in samples}
    remove_stale_samples(before, known)
    for folder in sorted(FIELDS_DIR.iterdir()):
        if folder.is_dir() and folder.name not in known:
            print(f"  aviso: {folder} no es una muestra de este script; el servidor falso tambien la va a servir")


# -------------------------------------------------------------- fixtures de red


def copy_sesame() -> list[str]:
    """Respuestas de Sesame de los cinco objetos de prueba, tal como las guardo el spike."""
    sources = sorted((SPIKE_CACHE / "sesame").glob("*.xml"))
    require(len(sources) == 5, f"se esperaban 5 respuestas de Sesame en {SPIKE_CACHE / 'sesame'}, hay {len(sources)}")
    for source in sources:
        write_bytes(SESAME_DIR / source.name, source.read_bytes())
    return [source.name for source in sources]


def copy_sia(run: SpikeRun) -> None:
    """Respuestas de SIA2 del campo, una por coleccion, y un indice con la consulta que las produjo."""
    ra, dec = run.center
    before = indexed_files(SIA_DIR, "queries")
    queries = []
    for collection in DEFAULTS.collections:
        source = sia_cache_path(collection, ra, dec)
        require(source.is_file(), f"falta {source}")
        write_bytes(SIA_DIR / source.name, source.read_bytes())
        # El spike guarda al lado de cada respuesta un JSON con la URL y la hora de la consulta.
        sidecar = json.loads(source.with_suffix(".json").read_text(encoding="utf-8"))
        queries.append(
            {
                "file": source.name,
                "collection": collection,
                "url": sidecar["url"],
                "queried_at": sidecar["queried_at"],
                "rows": sidecar["rows"],
            }
        )
    document = {
        "source": "spike/cache/sia (Etapa 0)",
        "object": run.summary["target"]["name"],
        "center": {"ra": ra, "dec": dec},
        "queries": queries,
    }
    write_bytes(SIA_DIR / INDEX_FILENAME, dump_json(document))
    remove_stale_indexed_files(SIA_DIR, before, {query["file"] for query in queries})


def copy_cutouts(run: SpikeRun) -> list[dict[str, Any]]:
    """Guarda 12 recortes reales del campo y un indice que dice de que exposicion es cada uno.

    Detector y fecha se leen del encabezado de IMAGE (`DETECTOR`, `MJD-OBS`); el
    resto del indice sale de la fila de SIA2 de esa exposicion.
    """
    ra, dec = run.center
    side = run.cutout_side
    paths = cached_cutouts(ra, dec, side)
    require(bool(paths), f"no hay recortes de {run.spec.spike_label} en {SPIKE_CACHE / 'cutouts'}")

    headers = []
    for path in paths:
        with fits.open(path, memmap=False) as hdul:
            header = hdul["IMAGE"].header
            names = [hdu.name for hdu in hdul]
            headers.append((float(header["MJD-OBS"]), int(header["DETECTOR"]), str(header["OBSID"]), names, path))
    headers.sort(key=lambda item: (item[0], item[1], item[4].name))

    # Epoca de cada recorte con la regla del contrato: un hueco de mas de 60 dias separa dos pasadas.
    groups: dict[Key, list[tuple[float, int, str, list[str], Path]]] = {}
    n_epochs = 1
    for index, item in enumerate(headers):
        if index > 0 and item[0] - headers[index - 1][0] > DEFAULTS.epoch_gap_days:
            n_epochs += 1
        groups.setdefault((n_epochs, item[1]), []).append(item)
    require(n_epochs == len(run.summary["epochs"]), "las epocas de los recortes no son las de resumen.json")

    by_file = {
        exposure.url.rsplit("/", 1)[-1].removesuffix(".fits"): exposure for exposure in read_sia_exposures(ra, dec)
    }
    before = indexed_files(CUTOUTS_DIR, "cutouts")
    entries: list[dict[str, Any]] = []
    hdus: list[str] = []
    for epoch in CUTOUT_EPOCHS:
        for detector in CUTOUT_DETECTORS:
            group = groups.get((epoch, detector), [])
            require(len(group) >= CUTOUTS_PER_PLANE, f"pocos recortes en la epoca {epoch}, detector {detector}")
            last = len(group) - 1
            picks = sorted({(i * last) // (CUTOUTS_PER_PLANE - 1) for i in range(CUTOUTS_PER_PLANE)})
            for mjd, _, obs_id, names, path in (group[i] for i in picks):
                exposure = by_file.get(path.name.split("__", 1)[0])
                require(exposure is not None, f"{path.name}: SIA2 no lista esa exposicion")
                assert exposure is not None
                require(
                    exposure.detector == detector
                    and exposure.obs_id == obs_id
                    and abs(exposure.mjd_start - mjd) < 1e-4,
                    f"{path.name}: el encabezado no coincide con la fila de SIA2",
                )
                hdus = hdus or names
                require(names == hdus, f"{path.name}: trae las extensiones {names} y los demas {hdus}")
                write_bytes(CUTOUTS_DIR / path.name, path.read_bytes())
                entries.append(
                    {
                        "file": path.name,
                        "obs_id": exposure.obs_id,
                        "collection": exposure.collection,
                        "detector": exposure.detector,
                        "epoch": epoch,
                        "mjd": exposure.mjd_start,
                        "mjd_end": exposure.mjd_end,
                        "wave_min_um": round(exposure.wave_min_um, 4),
                        "wave_max_um": round(exposure.wave_max_um, 4),
                        "url": exposure.url,
                        # Formato del recorte verificado contra el servicio en spike/verify.py.
                        "cutout_url": f"{exposure.url}?center={ra:.6f},{dec:.6f}d&size={side:g}",
                    }
                )
    document = {
        "source": "spike/cache/cutouts (Etapa 0)",
        "object": run.summary["target"]["name"],
        "center": {"ra": ra, "dec": dec},
        "side_deg": side,
        # Descarga cortada antes de EPSF: los archivos no traen EPSF ni WCS-WAVE.
        "mode": "truncated",
        "hdus": hdus,
        "cutouts": entries,
    }
    write_bytes(CUTOUTS_DIR / INDEX_FILENAME, dump_json(document))
    remove_stale_indexed_files(CUTOUTS_DIR, before, {entry["file"] for entry in entries})
    return entries


# ------------------------------------------------------ fixtures del frontend


def simulate_new_field(sample: BuiltSample, band: int) -> list[dict[str, Any]]:
    """Transcripcion de los eventos SSE de un campo nuevo (contrato, secciones 4.2 y 8).

    La produce el servidor falso (`app.fake`) sobre la muestra ya escrita, con
    su duracion por defecto y un reloj manual: es lo mismo que recibe el
    frontend cuando desarrolla contra ese servidor. Cada elemento lleva
    `event`, `id` y `data`.
    """
    # Se importa aca y no arriba: al cargarse, `app.fake` arma un servidor con las
    # muestras que haya en disco, y recien ahora estan escritas.
    from app.fake import FakeBackend

    now = [0.0]
    backend = FakeBackend(
        fields_dir=FIELDS_DIR,
        sesame_dir=SESAME_DIR,
        seconds=DEFAULTS.fake_seconds,
        ping_seconds=DEFAULTS.sse_ping_s,
        progress_interval=1.0 / DEFAULTS.progress_events_per_s,
        field_epoch=DEFAULTS.field_epoch,
        clock=lambda: now[0],
    )
    request = sample.meta.request
    status_code, response = backend.submit(
        FieldRequest(ra=request.ra, dec=request.dec, fov=request.fov, band=band), "new"
    )
    require(
        status_code == 202 and response.id == sample.id, f"el servidor falso no eligio la muestra {sample.spec.label}"
    )
    # Al conectar, lo primero que llega es `state` con el documento tal como esta: recien entro en la cola.
    events: list[dict[str, Any]] = [{"event": "state", "id": 1, "data": response.meta.model_dump(mode="json")}]
    now[0] = DEFAULTS.fake_seconds + 1.0
    backend.state(sample.id)
    run = backend.runs[sample.id]
    events += [{"event": event.name, "id": event.id, "data": event.data} for event in run.events]
    for event in events:
        EVENT_ADAPTERS[event["event"]].validate_python(event["data"])
    require(events[-1]["event"] == "done", "la simulacion del campo nuevo no termino en `done`")
    return events


def write_frontend_fixtures(samples: list[BuiltSample], store: FieldStore) -> list[Path]:
    """Copia al frontend los metadatos de las tres muestras, un plano de dos de ellas y la transcripcion.

    - `meta-<etiqueta>.json`: el documento de metadatos, para importarlo en un test.
    - `<etiqueta>/`: la misma muestra con el formato de campo en disco, pero solo con `meta.json`, la
      trayectoria y, si la muestra lo indica, un plano y su capa auxiliar. Es lo que recorre
      `src/api/fixtures.test.ts` para cruzar estos datos con los esquemas del frontend.
    - `events-new-field.json`: eventos SSE de un campo nuevo simulado.
    """
    if not FRONTEND_DIR.is_dir():
        print(f"  aviso: no existe {FRONTEND_DIR}; no se escriben los fixtures del frontend")
        return []
    written: list[Path] = []
    for sample in samples:
        source = store.locate(sample.id)
        assert source is not None
        meta_bytes = (source / META_FILENAME).read_bytes()
        names = [META_FILENAME, track_filename(sample.track.name)]
        if sample.spec.frontend_plane is not None:
            names += [plane_filename(*sample.spec.frontend_plane), aux_filename(*sample.spec.frontend_plane)]
        folder = FRONTEND_FIXTURES_DIR / sample.spec.label
        for name in names:
            write_bytes(folder / name, (source / name).read_bytes())
            written.append(folder / name)
        remove_stale_field_files(folder, set(names))
        flat = FRONTEND_FIXTURES_DIR / f"meta-{sample.spec.label}.json"
        write_bytes(flat, meta_bytes)
        written.append(flat)

    sample = next(item for item in samples if item.spec.label == EVENTS_SAMPLE)
    events_path = FRONTEND_FIXTURES_DIR / EVENTS_FILENAME
    write_bytes(events_path, dump_json(simulate_new_field(sample, EVENTS_BAND)))
    written.append(events_path)
    return written


# ------------------------------------------------------------------ principal


def folder_size(folder: Path) -> int:
    return sum(path.stat().st_size for path in folder.rglob("*") if path.is_file())


def main() -> None:
    store = FieldStore(FIELDS_DIR)
    previous_ids = indexed_sample_ids()
    print("Campos de muestra:")
    samples: list[BuiltSample] = []
    for spec in SAMPLES:
        sample = build_sample(spec, store)
        samples.append(sample)
        meta = sample.meta
        assert meta.grid is not None and meta.planes is not None and meta.epochs is not None
        with_data = sum(1 for plane in meta.planes if plane.status != "empty")
        codes: dict[str, int] = {}
        for warning in meta.warnings:
            codes[warning.code] = codes.get(warning.code, 0) + 1
        print(
            f"  {spec.label}: id {meta.id}, {meta.status}, grilla {meta.grid.shape[1]} x {meta.grid.shape[0]} "
            f"(marco sin datos de {sample.margin_px} px), {len(meta.epochs)} epocas, "
            f"{with_data} de {len(meta.planes)} planos con datos, avisos {codes or 'ninguno'}"
        )
    write_fields_index(samples, previous_ids)

    print("Fixtures de red:")
    print(f"  sesame: {len(copy_sesame())} respuestas")
    cutout_run = next(sample.run for sample in samples if sample.spec.label == CUTOUT_SAMPLE)
    copy_sia(cutout_run)
    print(f"  sia: {len(DEFAULTS.collections)} respuestas de {cutout_run.summary['target']['name']}")
    print(f"  cutouts: {len(copy_cutouts(cutout_run))} recortes de {cutout_run.summary['target']['name']}")

    print("Fixtures del frontend:")
    written = write_frontend_fixtures(samples, store)
    print(f"  {len(written)} archivos en {FRONTEND_FIXTURES_DIR}")

    print("Tamano en disco:")
    for folder in (FIELDS_DIR, CUTOUTS_DIR, SIA_DIR, SESAME_DIR):
        print(f"  {folder.relative_to(REPO_DIR).as_posix()}: {folder_size(folder) / 1e6:.2f} MB")
    print(f"  {FIXTURES_DIR.relative_to(REPO_DIR).as_posix()} en total: {folder_size(FIXTURES_DIR) / 1e6:.2f} MB")
    if FRONTEND_FIXTURES_DIR.is_dir():
        size = folder_size(FRONTEND_FIXTURES_DIR)
        print(f"  {FRONTEND_FIXTURES_DIR.relative_to(REPO_DIR).as_posix()}: {size / 1e6:.2f} MB")


if __name__ == "__main__":
    try:
        main()
    except SampleError as exc:
        raise SystemExit(f"make_sample_fields: {exc}") from exc
