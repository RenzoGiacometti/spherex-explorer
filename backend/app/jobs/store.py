"""Campo en disco: metadatos, planos, capas auxiliares, vista provisoria y trayectorias.

Formato, igual para los campos precalculados (data/fields), la cache de
ejecucion (cache/fields) y las muestras de los tests:

    <raiz>/<id>/meta.json                 documento de metadatos del contrato
    <raiz>/<id>/plane_e<E>_d<D>.f32       Float32 little-endian, ny*nx, fila 0 = sur
    <raiz>/<id>/aux_e<E>_d<D>.bin.gz      gzip de: Uint32 flags (ny*nx) y despues Uint16 cobertura (ny*nx)
    <raiz>/<id>/preview.f32               vista provisoria de WISE (opcional)
    <raiz>/<id>/track_<slug>.json         trayectoria de un objeto (opcional)

El cubo no se guarda: `/cube` se arma concatenando los planos al servirlo
(contrato, seccion 11). De cada plano se conserva solo la revision vigente.

Las escrituras son atomicas (archivo temporal y `replace`), asi un lector nunca
ve un archivo a medio escribir. Cada binario se valida contra `grid.shape`.
"""

from __future__ import annotations

import gzip
import json
import os
import re
import threading
import time
import zlib
from collections.abc import Iterator, Sequence
from pathlib import Path

import numpy as np
from numpy.typing import NDArray
from pydantic import ValidationError

from app.config import Settings
from app.contract import CUBE_PLANE_STATUSES, FieldMeta, TrackResponse

META_FILENAME = "meta.json"
PREVIEW_FILENAME = "preview.f32"

PLANE_DTYPE = np.dtype("<f4")
FLAGS_DTYPE = np.dtype("<u4")
COVERAGE_DTYPE = np.dtype("<u2")

Shape = tuple[int, int]  # (ny, nx)

# El id llega desde la URL: solo se acepta un nombre de carpeta simple, sin
# separadores ni puntos, para que no pueda salir de la raiz.
_ID_PATTERN = re.compile(r"^[0-9a-z][0-9a-z_-]{0,63}$")


class StoreError(Exception):
    """Problema con un campo guardado."""


class FieldNotFoundError(StoreError):
    """No hay ningun campo con ese id."""


class ResourceNotFoundError(StoreError):
    """El campo existe pero no tiene ese archivo (plano, capa auxiliar o vista provisoria)."""


class SizeMismatchError(StoreError):
    """Un binario no mide lo que indica `grid.shape`."""


# ---------------------------------------------------------- nombres y tamanos


def plane_filename(epoch: int, detector: int) -> str:
    return f"plane_e{int(epoch)}_d{int(detector)}.f32"


def aux_filename(epoch: int, detector: int) -> str:
    return f"aux_e{int(epoch)}_d{int(detector)}.bin.gz"


def track_slug(name: str) -> str:
    """Nombre de archivo de un objeto: minusculas, y lo que no es letra ni numero pasa a guion."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "objeto"


def track_filename(name: str) -> str:
    return f"track_{track_slug(name)}.json"


def plane_nbytes(shape: Shape) -> int:
    """Bytes de un plano o de la vista provisoria: `4 x ny x nx`."""
    return PLANE_DTYPE.itemsize * shape[0] * shape[1]


def aux_nbytes(shape: Shape) -> int:
    """Bytes de la capa auxiliar sin comprimir: `6 x ny x nx`."""
    return (FLAGS_DTYPE.itemsize + COVERAGE_DTYPE.itemsize) * shape[0] * shape[1]


def cube_planes(meta: FieldMeta) -> list[tuple[int, int]]:
    """(epoca, detector) de los planos que entran en `/cube`, en el orden de `planes`."""
    return [(plane.epoch, plane.detector) for plane in meta.planes or () if plane.status in CUBE_PLANE_STATUSES]


def cube_nbytes(meta: FieldMeta) -> int:
    """Tamano de `/cube` en bytes."""
    if meta.grid is None:
        return 0
    return plane_nbytes(meta.grid.shape) * len(cube_planes(meta))


def with_cube_offsets(meta: FieldMeta) -> FieldMeta:
    """Copia del documento con `cube_offset` calculado para cada plano.

    Los planos `ready` y `partial` van uno detras de otro en el orden de
    `planes`; los demas no ocupan lugar y quedan en `null`. Se llama al terminar
    el trabajo: antes, `cube_offset` es `null` en todos.
    """
    updated = meta.model_copy(deep=True)
    if updated.grid is None or updated.planes is None:
        return updated
    size = plane_nbytes(updated.grid.shape)
    offset = 0
    for plane in updated.planes:
        if plane.status in CUBE_PLANE_STATUSES:
            plane.cube_offset = offset
            offset += size
        else:
            plane.cube_offset = None
    return updated


# ------------------------------------------------------------------ almacen


class FieldStore:
    """Lee campos de una lista de raices, en orden, y escribe siempre en una.

    El backend usa `FieldStore.from_settings`: busca primero en los campos
    precalculados (data/fields) y despues en la cache (cache/fields), y escribe
    en la cache. El script de precalculo escribe en data/fields.

    Los metodos que leen o escriben binarios aceptan `shape=(ny, nx)` para no
    releer `meta.json` cada vez; si no se pasa, sale de `grid.shape` del campo.
    """

    def __init__(self, write_root: Path, read_roots: Sequence[Path] = ()) -> None:
        self.write_root = Path(write_root)
        roots = [Path(root) for root in read_roots]
        if self.write_root not in roots:
            roots.append(self.write_root)
        self.read_roots: tuple[Path, ...] = tuple(roots)

    @classmethod
    def from_settings(cls, settings: Settings, *, write_precomputed: bool = False) -> FieldStore:
        """Almacen del backend. Con `write_precomputed=True` escribe en data/fields (script de precalculo)."""
        roots = (settings.precomputed_fields_dir, settings.cached_fields_dir)
        return cls(roots[0] if write_precomputed else roots[1], roots)

    # ------------------------------------------------------------- ubicacion

    def locate(self, field_id: str) -> Path | None:
        """Carpeta del campo en la primera raiz que lo tiene, o `None`."""
        if not _ID_PATTERN.match(field_id):
            return None
        for root in self.read_roots:
            folder = root / field_id
            if (folder / META_FILENAME).is_file():
                return folder
        return None

    def exists(self, field_id: str) -> bool:
        """Si hay un campo guardado con ese id. No dice si esta terminado: para eso, `read_meta(...).status`."""
        return self.locate(field_id) is not None

    def list_ids(self) -> list[str]:
        """Ids de todos los campos guardados, ordenados."""
        ids: set[str] = set()
        for root in self.read_roots:
            if not root.is_dir():
                continue
            for child in root.iterdir():
                if _ID_PATTERN.match(child.name) and (child / META_FILENAME).is_file():
                    ids.add(child.name)
        return sorted(ids)

    def _folder(self, field_id: str) -> Path:
        folder = self.locate(field_id)
        if folder is None:
            raise FieldNotFoundError(f"no existe el campo {field_id!r}")
        return folder

    def _write_folder(self, field_id: str) -> Path:
        if not _ID_PATTERN.match(field_id):
            raise StoreError(f"id de campo invalido: {field_id!r}")
        return self.write_root / field_id

    def _shape(self, field_id: str, shape: Shape | None) -> Shape:
        if shape is not None:
            ny, nx = int(shape[0]), int(shape[1])
            if ny <= 0 or nx <= 0:
                raise StoreError(f"forma invalida: {shape!r}")
            return ny, nx
        meta = self.read_meta(field_id)
        if meta.grid is None:
            raise StoreError(f"el campo {field_id!r} todavia no tiene grilla")
        return meta.grid.shape

    # -------------------------------------------------------------- metadatos

    def read_meta(self, field_id: str) -> FieldMeta:
        path = self._folder(field_id) / META_FILENAME
        try:
            return FieldMeta.model_validate_json(path.read_text(encoding="utf-8"))
        except (ValidationError, ValueError) as exc:
            raise StoreError(f"{path}: no cumple el contrato: {exc}") from exc

    def write_meta(self, meta: FieldMeta) -> Path:
        """Guarda el documento de metadatos.

        Antes lo valida contra el contrato: los modelos no validan al asignar un
        atributo, y un NaN se serializaria como `null` sin avisar.
        """
        path = self._write_folder(meta.id) / META_FILENAME
        document = meta.model_dump(mode="json", warnings=False)
        try:
            FieldMeta.model_validate(document)
        except ValidationError as exc:
            raise StoreError(f"los metadatos del campo {meta.id!r} no cumplen el contrato: {exc}") from exc
        text = json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False)
        _atomic_write(path, (text + "\n").encode("utf-8"))
        return path

    # ----------------------------------------------------------------- planos

    def read_plane_bytes(self, field_id: str, epoch: int, detector: int, *, shape: Shape | None = None) -> bytes:
        """Bytes del plano tal como van en `/plane/{e}/{d}`."""
        return self._read_float32(field_id, plane_filename(epoch, detector), shape)

    def read_plane(
        self, field_id: str, epoch: int, detector: int, *, shape: Shape | None = None
    ) -> NDArray[np.float32]:
        shape = self._shape(field_id, shape)
        data = self.read_plane_bytes(field_id, epoch, detector, shape=shape)
        return np.frombuffer(data, dtype=PLANE_DTYPE).reshape(shape).astype(np.float32)

    def write_plane(
        self, field_id: str, epoch: int, detector: int, image: NDArray[np.floating], *, shape: Shape | None = None
    ) -> Path:
        return self._write_float32(field_id, plane_filename(epoch, detector), image, shape)

    # ------------------------------------------------------- capas auxiliares

    def read_aux_gzip(self, field_id: str, epoch: int, detector: int, *, shape: Shape | None = None) -> bytes:
        """La capa auxiliar comprimida, como esta en disco, ya validada. Sirve para `Content-Encoding: gzip`."""
        shape = self._shape(field_id, shape)
        path = self._folder(field_id) / aux_filename(epoch, detector)
        compressed = _read_file(path)
        _decompress_aux(path, compressed, shape)
        return compressed

    def read_aux_bytes(self, field_id: str, epoch: int, detector: int, *, shape: Shape | None = None) -> bytes:
        """Bytes de `/aux/{e}/{d}`: Uint32 de flags y, a continuacion, Uint16 de cobertura."""
        shape = self._shape(field_id, shape)
        path = self._folder(field_id) / aux_filename(epoch, detector)
        return _decompress_aux(path, _read_file(path), shape)

    def read_aux(
        self, field_id: str, epoch: int, detector: int, *, shape: Shape | None = None
    ) -> tuple[NDArray[np.uint32], NDArray[np.uint16]]:
        """Devuelve `(flags, cobertura)`."""
        shape = self._shape(field_id, shape)
        data = self.read_aux_bytes(field_id, epoch, detector, shape=shape)
        return split_aux(data, shape)

    def write_aux(
        self,
        field_id: str,
        epoch: int,
        detector: int,
        flags: NDArray[np.integer],
        coverage: NDArray[np.integer],
        *,
        shape: Shape | None = None,
    ) -> Path:
        shape = self._shape(field_id, shape)
        path = self._write_folder(field_id) / aux_filename(epoch, detector)
        _atomic_write(path, compress_aux(flags, coverage, shape))
        return path

    # -------------------------------------------------------- vista provisoria

    def has_preview(self, field_id: str) -> bool:
        folder = self.locate(field_id)
        return folder is not None and (folder / PREVIEW_FILENAME).is_file()

    def read_preview_bytes(self, field_id: str, *, shape: Shape | None = None) -> bytes:
        return self._read_float32(field_id, PREVIEW_FILENAME, shape)

    def read_preview(self, field_id: str, *, shape: Shape | None = None) -> NDArray[np.float32]:
        shape = self._shape(field_id, shape)
        data = self.read_preview_bytes(field_id, shape=shape)
        return np.frombuffer(data, dtype=PLANE_DTYPE).reshape(shape).astype(np.float32)

    def write_preview(self, field_id: str, image: NDArray[np.floating], *, shape: Shape | None = None) -> Path:
        return self._write_float32(field_id, PREVIEW_FILENAME, image, shape)

    # ------------------------------------------------------------ trayectorias

    def read_track(self, field_id: str, name: str) -> TrackResponse | None:
        """Trayectoria guardada de un objeto, o `None` si no hay."""
        path = self._folder(field_id) / track_filename(name)
        if not path.is_file():
            return None
        try:
            return TrackResponse.model_validate_json(path.read_text(encoding="utf-8"))
        except (ValidationError, ValueError) as exc:
            raise StoreError(f"{path}: no cumple el contrato: {exc}") from exc

    def list_tracks(self, field_id: str) -> list[TrackResponse]:
        """Todas las trayectorias guardadas del campo."""
        tracks: list[TrackResponse] = []
        for path in sorted(self._folder(field_id).glob("track_*.json")):
            try:
                tracks.append(TrackResponse.model_validate_json(path.read_text(encoding="utf-8")))
            except (ValidationError, ValueError) as exc:
                raise StoreError(f"{path}: no cumple el contrato: {exc}") from exc
        return tracks

    def write_track(self, field_id: str, track: TrackResponse) -> Path:
        path = self._write_folder(field_id) / track_filename(track.name)
        text = json.dumps(track.model_dump(mode="json"), ensure_ascii=False, indent=2, allow_nan=False)
        _atomic_write(path, (text + "\n").encode("utf-8"))
        return path

    # ------------------------------------------------------------------- cubo

    def iter_cube(self, field_id: str, meta: FieldMeta | None = None) -> Iterator[bytes]:
        """Bytes de `/cube`: los planos `ready` y `partial`, en el orden de `planes`, de a uno.

        Antes de devolver el iterador comprueba que todos los archivos existan
        y midan lo que corresponde, para que un problema se vea como error y no
        como una respuesta cortada.
        """
        meta = self.read_meta(field_id) if meta is None else meta
        if meta.grid is None or meta.planes is None:
            raise StoreError(f"el campo {field_id!r} todavia no tiene planos")
        folder = self._folder(field_id)
        expected = plane_nbytes(meta.grid.shape)
        paths = [folder / plane_filename(epoch, detector) for epoch, detector in cube_planes(meta)]
        for path in paths:
            if not path.is_file():
                raise ResourceNotFoundError(f"falta {path.name} en el campo {field_id!r}")
            size = path.stat().st_size
            if size != expected:
                raise SizeMismatchError(f"{path}: mide {size} bytes y deberia medir {expected}")
        return self._iter_files(paths, expected)

    @staticmethod
    def _iter_files(paths: list[Path], expected: int) -> Iterator[bytes]:
        for path in paths:
            data = path.read_bytes()
            if len(data) != expected:
                raise SizeMismatchError(f"{path}: mide {len(data)} bytes y deberia medir {expected}")
            yield data

    # --------------------------------------------------------------- internos

    def _read_float32(self, field_id: str, filename: str, shape: Shape | None) -> bytes:
        shape = self._shape(field_id, shape)
        path = self._folder(field_id) / filename
        data = _read_file(path)
        expected = plane_nbytes(shape)
        if len(data) != expected:
            raise SizeMismatchError(f"{path}: mide {len(data)} bytes y deberia medir {expected}")
        return data

    def _write_float32(self, field_id: str, filename: str, image: NDArray[np.floating], shape: Shape | None) -> Path:
        shape = self._shape(field_id, shape)
        array = np.asarray(image)
        if array.shape != shape:
            raise SizeMismatchError(f"{filename}: forma {array.shape}, y la grilla es {shape}")
        path = self._write_folder(field_id) / filename
        _atomic_write(path, np.ascontiguousarray(array, dtype=PLANE_DTYPE).tobytes())
        return path


# ----------------------------------------------------------------- auxiliares


def compress_aux(flags: NDArray[np.integer], coverage: NDArray[np.integer], shape: Shape) -> bytes:
    """Capa auxiliar comprimida: gzip de los flags (Uint32) seguidos de la cobertura (Uint16).

    Con `mtime=0` el resultado depende solo del contenido, asi los campos
    precalculados no cambian en el repositorio al regenerarlos.
    """
    flags_array = np.asarray(flags)
    coverage_array = np.asarray(coverage)
    if flags_array.shape != shape or coverage_array.shape != shape:
        raise SizeMismatchError(
            f"capa auxiliar: flags {flags_array.shape} y cobertura {coverage_array.shape}, y la grilla es {shape}"
        )
    payload = (
        np.ascontiguousarray(flags_array, dtype=FLAGS_DTYPE).tobytes()
        + np.ascontiguousarray(coverage_array, dtype=COVERAGE_DTYPE).tobytes()
    )
    return gzip.compress(payload, compresslevel=6, mtime=0)


def split_aux(data: bytes, shape: Shape) -> tuple[NDArray[np.uint32], NDArray[np.uint16]]:
    """Separa los bytes de `/aux` en `(flags, cobertura)`."""
    if len(data) != aux_nbytes(shape):
        raise SizeMismatchError(f"capa auxiliar: mide {len(data)} bytes y deberia medir {aux_nbytes(shape)}")
    split = FLAGS_DTYPE.itemsize * shape[0] * shape[1]
    flags = np.frombuffer(data[:split], dtype=FLAGS_DTYPE).reshape(shape).astype(np.uint32)
    coverage = np.frombuffer(data[split:], dtype=COVERAGE_DTYPE).reshape(shape).astype(np.uint16)
    return flags, coverage


def _decompress_aux(path: Path, compressed: bytes, shape: Shape) -> bytes:
    try:
        data = gzip.decompress(compressed)
    except (OSError, EOFError, zlib.error) as exc:
        raise StoreError(f"{path}: no es un gzip valido: {exc}") from exc
    expected = aux_nbytes(shape)
    if len(data) != expected:
        raise SizeMismatchError(f"{path}: mide {len(data)} bytes sin comprimir y deberia medir {expected}")
    return data


def _read_file(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except FileNotFoundError as exc:
        raise ResourceNotFoundError(f"falta {path.name}") from exc


def _atomic_write(path: Path, data: bytes) -> None:
    """Escribe en un archivo temporal de la misma carpeta y lo renombra sobre el destino."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        tmp.write_bytes(data)
        _replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _replace(source: Path, target: Path, attempts: int = 6) -> None:
    """`os.replace` con reintentos: en Windows falla si otro proceso tiene abierto el destino en ese instante."""
    for attempt in range(1, attempts + 1):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if attempt == attempts:
                raise
            time.sleep(0.02 * attempt)
