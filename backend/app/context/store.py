"""Formato en disco del contexto de un campo y documento que lo describe.

El contexto depende solo de la geometria del campo (centro y lado), no de la
version del pipeline de SPHEREx: por eso su carpeta lleva la geometria en el
nombre y no el `id` del campo, que cambia con el pipeline.

    data/context/
      index.json                          un renglon por campo guardado
      269.4463_+4.7683_0.1667/
        context.json                      documento de contexto (`ContextDocument`)
        twomass_ks.f32                    una capa por relevamiento y banda
        wise_w2.f32
        gaia.json                         fuentes de Gaia, por columnas

Cada capa tiene el formato de un plano del cubo (docs/contrato-cubo.md, seccion
6): `ny x nx` Float32 little-endian, sin encabezado, fila 0 = sur y columna 0 =
este, `NaN` sin datos. No trae `+Infinity`: las capas no marcan saturacion.

`gaia.json` va por columnas para que pese poco (un campo cerca del plano de la
galaxia tiene miles de fuentes): cada clave es una lista y la fuente `i` es el
elemento `i` de cada una. `source_id` va como texto, porque no entra en un
numero de JavaScript. Las fuentes estan ordenadas de la mas brillante a la mas
debil, asi que las primeras `n` son las `n` mas brillantes.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Literal

import numpy as np
from numpy.typing import NDArray
from pydantic import ValidationError

from app.config import Settings
from app.context.gaia import GaiaSources
from app.context.surveys import _write_atomic
from app.contract import ContractModel, Display, FieldRequestInfo, GridInfo

DOCUMENT_FILENAME = "context.json"
GAIA_FILENAME = "gaia.json"
INDEX_FILENAME = "index.json"
LAYER_DTYPE = np.dtype("<f4")
FORMAT_VERSION = 1


class ContextNotFoundError(Exception):
    """No hay contexto guardado para ese campo, o le falta el archivo pedido."""


class ContextObject(ContractModel):
    """El objeto de prueba para el que se armo el contexto."""

    alias: str  # "barnard"
    query: str  # el texto que se resolvio: "Barnard's Star"
    name: str | None  # nombre principal del catalogo


class LayerImage(ContractModel):
    """Una de las imagenes de origen de una capa."""

    obs_id: str
    url: str  # `access_url` de IRSA, sin los parametros del recorte
    mjd: float
    date: str  # AAAA-MM-DD
    coverage: float  # fraccion de la grilla que cubre con datos


class LayerTarget(ContractModel):
    """Donde estaba el objeto en la fecha de una capa, con movimiento propio y paralaje (como `/track`)."""

    ra: float
    dec: float
    x: float  # pixel de la grilla, indices desde 0
    y: float
    in_field: bool


class SurveyLayer(ContractModel):
    """Un recorte de otra mision, reproyectado a la grilla del campo."""

    key: str  # "twomass_ks"; es el nombre del archivo y el valor de `layer` en la API
    survey: Literal["2MASS", "WISE"]
    band: str  # "Ks", "W2"
    wave_um: float
    file: str
    # Fecha de observacion. En 2MASS, la noche de la imagen que mas cubre el campo. En WISE,
    # la fecha media de las exposiciones sumadas (`MIDOBS`); el intervalo va en `*_start` y `*_end`.
    mjd: float
    date: str
    year: float  # anio juliano con decimales, para ordenar y para propagar posiciones
    mjd_start: float
    mjd_end: float
    date_start: str
    date_end: str
    unit: str  # "MJy/sr"
    native_pixel_scale_arcsec: float
    display: Display | None  # misma definicion que `detectors[].display` del contrato
    valid_fraction: float
    collection: str  # coleccion de SIA2 de donde salio
    images: list[LayerImage]
    # Posicion esperada del objeto en `mjd`. `None` si el contexto no es de un objeto con movimiento propio.
    target: LayerTarget | None = None


class GaiaInfo(ContractModel):
    """Resumen del catalogo guardado en `gaia.json`."""

    file: str
    catalog: str  # "gaia_dr3_source"
    ref_epoch: float  # epoca de las posiciones, 2016.0 en DR3
    n_sources: int
    radius_arcsec: float  # radio del cono consultado
    g_mag_min: float | None
    g_mag_max: float | None


class ContextDocument(ContractModel):
    """Todo lo que se guardo de un campo."""

    version: int = FORMAT_VERSION
    key: str  # nombre de la carpeta
    field_id: str  # `id` del campo con el pipeline vigente al generarlo; informativo
    pipeline: str
    object: ContextObject | None
    request: FieldRequestInfo
    grid: GridInfo
    surveys: list[SurveyLayer]  # en orden de fecha
    gaia: GaiaInfo | None
    generated_at: str  # AAAA-MM-DDTHH:MM:SSZ


class IndexEntry(ContractModel):
    key: str
    field_id: str
    alias: str | None
    name: str | None
    ra: float
    dec: float
    fov: float
    layers: list[str]
    gaia_sources: int


class ContextIndex(ContractModel):
    version: int = FORMAT_VERSION
    fields: list[IndexEntry]


def context_key(ra: float, dec: float, fov: float) -> str:
    """Nombre de la carpeta de un campo: centro y lado ya normalizados, con los decimales del contrato."""
    return f"{ra:.4f}_{dec:+.4f}_{fov:.4f}"


def _finite_or_none(value: float, decimals: int) -> float | None:
    return round(float(value), decimals) if math.isfinite(value) else None


def gaia_document(sources: GaiaSources) -> dict[str, object]:
    """Las fuentes como van en `gaia.json`: una lista por columna, `null` donde no hay valor."""
    return {
        "catalog": "gaia_dr3_source",
        "ref_epoch": sources.ref_epoch,
        "count": len(sources),
        "source_id": [str(int(value)) for value in sources.source_id],
        # 7 decimales de grado son 0,36 mas: menos que el error de una fuente debil.
        "ra": [round(float(value), 7) for value in sources.ra],
        "dec": [round(float(value), 7) for value in sources.dec],
        "pmra": [_finite_or_none(value, 3) for value in sources.pmra],
        "pmdec": [_finite_or_none(value, 3) for value in sources.pmdec],
        "parallax": [_finite_or_none(value, 3) for value in sources.parallax],
        "g_mag": [_finite_or_none(value, 2) for value in sources.g_mag],
    }


class ContextStore:
    """Lee y escribe el contexto guardado en una carpeta raiz (`data/context`)."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    @classmethod
    def from_settings(cls, settings: Settings) -> ContextStore:
        """Almacen versionado en el repositorio, al lado de los campos precalculados."""
        return cls(settings.data_dir / "context")

    # ---------------------------------------------------------------- lectura

    def folder(self, key: str) -> Path:
        return self.root / key

    def exists(self, key: str) -> bool:
        return (self.folder(key) / DOCUMENT_FILENAME).is_file()

    def read_document(self, key: str) -> ContextDocument:
        path = self.folder(key) / DOCUMENT_FILENAME
        try:
            return ContextDocument.model_validate_json(path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise ContextNotFoundError(f"no hay contexto guardado para {key!r}") from exc
        except (ValidationError, ValueError) as exc:
            raise ContextNotFoundError(f"{path}: no se puede leer: {exc}") from exc

    def read_layer_bytes(self, key: str, layer: str) -> bytes:
        """Bytes de una capa tal como van por la API. Comprueba el tamano contra la grilla."""
        document = self.read_document(key)
        entry = next((item for item in document.surveys if item.key == layer), None)
        if entry is None:
            raise ContextNotFoundError(f"el campo {key!r} no tiene la capa {layer!r}")
        try:
            data = (self.folder(key) / entry.file).read_bytes()
        except OSError as exc:
            raise ContextNotFoundError(f"falta el archivo de la capa {layer!r} de {key!r}") from exc
        ny, nx = document.grid.shape
        if len(data) != ny * nx * LAYER_DTYPE.itemsize:
            raise ContextNotFoundError(f"la capa {layer!r} de {key!r} mide {len(data)} bytes, no los de la grilla")
        return data

    def read_layer(self, key: str, layer: str) -> NDArray[np.float32]:
        document = self.read_document(key)
        data = self.read_layer_bytes(key, layer)
        return np.frombuffer(data, dtype=LAYER_DTYPE).reshape(document.grid.shape).astype(np.float32)

    def read_gaia_bytes(self, key: str) -> bytes:
        document = self.read_document(key)
        if document.gaia is None:
            raise ContextNotFoundError(f"el campo {key!r} no tiene fuentes de Gaia guardadas")
        try:
            return (self.folder(key) / document.gaia.file).read_bytes()
        except OSError as exc:
            raise ContextNotFoundError(f"falta el archivo de Gaia de {key!r}") from exc

    def list_keys(self) -> list[str]:
        if not self.root.is_dir():
            return []
        return sorted(child.name for child in self.root.iterdir() if (child / DOCUMENT_FILENAME).is_file())

    def read_index(self) -> ContextIndex:
        """El indice, armado con lo que hay en disco (no depende de que `index.json` este al dia)."""
        entries: list[IndexEntry] = []
        for key in self.list_keys():
            document = self.read_document(key)
            entries.append(
                IndexEntry(
                    key=key,
                    field_id=document.field_id,
                    alias=document.object.alias if document.object else None,
                    name=document.object.name if document.object else None,
                    ra=document.request.ra,
                    dec=document.request.dec,
                    fov=document.request.fov,
                    layers=[layer.key for layer in document.surveys],
                    gaia_sources=document.gaia.n_sources if document.gaia else 0,
                )
            )
        return ContextIndex(fields=entries)

    # -------------------------------------------------------------- escritura

    def write_layer(self, key: str, filename: str, image: NDArray[np.floating], shape: tuple[int, int]) -> Path:
        array = np.ascontiguousarray(image, dtype=LAYER_DTYPE)
        if array.shape != tuple(shape):
            raise ValueError(f"la capa mide {array.shape} y la grilla {tuple(shape)}")
        if np.isinf(array).any():
            raise ValueError("una capa de contexto no lleva infinitos")
        path = self.folder(key) / filename
        _write_atomic(path, array.tobytes())
        return path

    def write_gaia(self, key: str, sources: GaiaSources) -> Path:
        path = self.folder(key) / GAIA_FILENAME
        text = json.dumps(gaia_document(sources), ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        _write_atomic(path, (text + "\n").encode("utf-8"))
        return path

    def write_document(self, document: ContextDocument) -> Path:
        """Guarda el documento. Va al final: mientras falta, el almacen no ve la carpeta."""
        path = self.folder(document.key) / DOCUMENT_FILENAME
        payload = document.model_dump(mode="json")
        ContextDocument.model_validate(payload)  # un NaN se serializaria como `null` sin avisar
        text = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False)
        _write_atomic(path, (text + "\n").encode("utf-8"))
        return path

    def write_index(self) -> Path:
        path = self.root / INDEX_FILENAME
        text = json.dumps(self.read_index().model_dump(mode="json"), ensure_ascii=False, indent=2, allow_nan=False)
        _write_atomic(path, (text + "\n").encode("utf-8"))
        return path
