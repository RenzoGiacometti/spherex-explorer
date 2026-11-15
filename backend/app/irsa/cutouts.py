"""Descarga de un recorte de IRSA, leyendo la respuesta de a un HDU (contrato, seccion 9).

Referencia probada contra el servicio: `cutout_url`, `_read_until` y
`fetch_cutout` en spike/irsa.py. Diferencias con el spike:

- Aca se hace UN intento por llamada. Los reintentos, la espera de
  `Retry-After` y la segunda pasada los decide el planificador
  (app/jobs/manager.py), para que una conexion en espera quede libre.
- Las extensiones se identifican por `EXTNAME`, no por posicion: se lee hasta
  juntar IMAGE, FLAGS, VARIANCE y ZODI y ahi se corta la conexion. Si el flujo
  termina sin las cuatro o un encabezado no se puede interpretar, se baja la
  respuesta completa y se abre con astropy (modo `full`).

Lo que queda en la cache (`settings.cutout_cache_dir`), con el mismo nombre de
archivo que usaba el spike:

    <archivo de la exposicion>__<ra>_<dec>_<lado>_img.fits    modo `truncated`
    <archivo de la exposicion>__<ra>_<dec>_<lado>_full.fits   modo `full`

- `_img`: PRIMARY mas las cuatro extensiones de imagen, con los bytes tal como
  los mando IRSA. Es el formato de tests/fixtures/cutouts.
- `_full`: la respuesta completa menos EPSF (queda tambien WCS-WAVE), con los
  bytes tal como llegaron.

Nombres de las extensiones (IMAGE, FLAGS, VARIANCE, ZODI, EPSF, WCS-WAVE):
spike/RESULTADOS.md, seccion 2, leidos de un recorte real.

Lo que el resto del backend puede dar por hecho:

- De `fetch_cutout` solo salen `IrsaBusy`, `IrsaTransient` e `IrsaPermanent`.
- Una llamada no ocupa su cupo mas de `settings.irsa_total_timeout_s`, aunque
  IRSA mande el cuerpo de la respuesta de a poco. El plazo no corta mientras
  llegan las cabeceras: ahi valen solo los timeouts de conexion y de silencio
  (`transport.Deadline`).
- La cache no entrega un archivo que a simple vista no es un FITS entero: lo
  borra y lo vuelve a bajar. Para el que pasa esa prueba y despues no se puede
  leer esta `discard_cutout`.
- `prune_cutout_cache` no borra un recorte que se entrego mientras corria.
"""

from __future__ import annotations

import contextlib
import http.client
import io
import math
import os
import threading
import time
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import requests
import urllib3
from astropy.io import fits

from app.config import Settings
from app.domain import CutoutFile, Exposure
from app.irsa import transport
from app.irsa.limits import get_limiter

Mode = Literal["truncated", "full"]

FITS_BLOCK = 2880
CARD_LENGTH = 80
# Las cuatro extensiones que usa el pipeline. Se buscan por nombre, en el orden en que lleguen.
IMAGE_HDUS = ("IMAGE", "FLAGS", "VARIANCE", "ZODI")
# Lo que no se guarda de una respuesta completa: la tabla EPSF son 3,9 MB por recorte.
DROPPED_HDUS = ("EPSF",)

# Un encabezado real de IMAGE ocupa 8 bloques. Si en 100 no aparecio END, no es un encabezado.
MAX_HEADER_BLOCKS = 100
# Tope de lo que se acepta guardar en memoria de una respuesta. Un recorte del
# escalon amplio son 2,9 MB de imagenes mas 3,9 MB de EPSF; el archivo entero
# de una exposicion, 65 MB.
MAX_RESPONSE_BYTES = 256 * 1024 * 1024

_READ_CHUNK = 64 * 1024
_FITS_SIGNATURE = b"SIMPLE  ="
_END_CARD = b"END".ljust(CARD_LENGTH)
# Un encabezado FITS solo admite ASCII imprimible (estandar FITS 4.0, seccion 4.1.2).
_HEADER_BYTES = bytes(range(0x20, 0x7F))
_VALID_BITPIX = (8, 16, 32, 64, -32, -64)
_MODE_SUFFIX: dict[Mode, str] = {"truncated": "img", "full": "full"}

# Windows: `os.replace` falla con PermissionError mientras otro hilo o proceso (o
# un antivirus) tiene abierto el destino o el temporal. Se reintenta con estas esperas.
_REPLACE_WAITS_S = (0.02, 0.05, 0.1, 0.2, 0.4)
# Un temporal mas viejo que esto es de un proceso que murio a mitad de una escritura.
_STALE_TMP_S = 3600.0
# Al pasar el tope se borra hasta dejar la cache en esta fraccion, para no volver a borrar enseguida.
_PRUNE_TARGET = 0.9


class IrsaError(Exception):
    """Fallo al pedir un recorte a IRSA."""


class IrsaBusy(IrsaError):
    """IRSA respondio 503 o 429 y pide esperar antes de reintentar.

    - `retry_after`: segundos a esperar. Nunca pasa de
      `settings.irsa_retry_after_max_s`, asi que se puede usar tal cual como
      espera: un `Retry-After` de horas no deja parado un recorte.
    - `requested`: lo que pidio IRSA en `Retry-After`, sin acotar, o `None` si
      no mando la cabecera o no se entiende. Si es mayor que `retry_after`, IRSA
      pidio mas espera de la que el backend hace; quien planifica puede preferir
      dejar ese recorte para la segunda pasada en vez de insistir enseguida.
    """

    def __init__(self, message: str, retry_after: float = 0.0, requested: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after
        self.requested = requested


class IrsaTransient(IrsaError):
    """Corte de conexion, timeout, 5xx sin `Retry-After` o FITS truncado: tiene sentido reintentar."""


class IrsaPermanent(IrsaError):
    """Respuesta 4xx (por ejemplo 422 "Arrays do not overlap."): reintentar no la arregla."""


class _Unreadable(Exception):
    """El lector por flujo no pudo interpretar la respuesta: hay que bajarla completa y abrirla con astropy."""


class _Truncated(Exception):
    """La respuesta se corto a mitad de un HDU, o lo que llego no es un FITS: pedirla completa no cambia nada."""


class _InvalidCutout(Exception):
    """La respuesta es un FITS entero, pero no trae las cuatro extensiones con la misma forma."""


class _MissingExtensions(_InvalidCutout):
    """Falta alguna de las cuatro extensiones. Si la respuesta no decia su largo, puede ser un corte entre dos HDU."""


# Fallas de red al abrir la conexion (requests) o al leer el flujo (urllib3, http.client, sockets).
_NETWORK_ERRORS = (requests.RequestException, urllib3.exceptions.HTTPError, http.client.HTTPException, OSError)
# Una URL mal formada no se arregla reintentando.
_BAD_URL_ERRORS = (
    requests.exceptions.MissingSchema,
    requests.exceptions.InvalidSchema,
    requests.exceptions.InvalidURL,
)


# ------------------------------------------------------------------ URL y cache


def cutout_url(exposure: Exposure, ra: float, dec: float, side_deg: float) -> str:
    """URL del recorte: `<access_url>?center=<ra>,<dec>d&size=<lado>`.

    Formato verificado contra el servicio en la Etapa 0 (spike/RESULTADOS.md,
    seccion 2): `size` sin unidad esta en grados y la unidad de `center` va una
    sola vez, despues del segundo valor.
    """
    return f"{exposure.url}?center={ra:.6f},{dec:.6f}d&size={side_deg:g}"


def cutout_cache_path(
    exposure: Exposure, ra: float, dec: float, side_deg: float, settings: Settings, mode: Mode = "truncated"
) -> Path:
    """Archivo de la cache para ese recorte. La clave es la exposicion, el centro y el lado.

    La exposicion entra por el nombre de archivo de su `url`, que lleva la
    observacion, el detector y la version de procesamiento. Es el nombre que
    usaba el spike, asi que un recorte de tests/fixtures/cutouts copiado a
    `settings.cutout_cache_dir` cuenta como acierto de cache.
    """
    stem = exposure.url.split("?", 1)[0].rstrip("/").rsplit("/", 1)[-1].removesuffix(".fits")
    name = f"{stem}__{ra:.6f}_{dec:+.6f}_{side_deg:g}_{_MODE_SUFFIX[mode]}.fits"
    return settings.cutout_cache_dir / name


# Entregar un recorte de la cache (renovarle la fecha) y borrarlo por el tope de disco (mirarle
# la fecha y borrar) son excluyentes. Es reentrante para que un mismo hilo no se trabe consigo mismo.
_handout_lock = threading.RLock()


def _looks_broken(path: Path) -> bool:
    """Comprobacion barata de un archivo de la cache: True si seguro no es un FITS entero.

    Un FITS mide un multiplo de 2880 bytes y empieza con `SIMPLE  =`. No se abre
    con astropy, asi que un recorte cortado justo en un limite de bloque pasa
    igual; para ese caso esta `discard_cutout`. Si el archivo no se puede mirar
    (Windows: otro lo tiene abierto en exclusiva), no se lo da por roto.
    """
    try:
        size = path.stat().st_size
        if size == 0 or size % FITS_BLOCK:
            return True
        with open(path, "rb") as handle:
            return handle.read(len(_FITS_SIGNATURE)) != _FITS_SIGNATURE
    except OSError:
        return False


def _cached(
    exposure: Exposure, ra: float, dec: float, side_deg: float, settings: Settings, remove_broken: bool = False
) -> CutoutFile | None:
    """El recorte de la cache, si esta. Le actualiza la fecha: el tope de disco borra los menos usados.

    Un archivo que a simple vista no es un FITS entero (`_looks_broken`) cuenta
    como que no esta: los recortes no vencen, y entregarlo seria dejar esa
    exposicion rota para siempre. Con `remove_broken` ademas se lo borra; eso se
    pide solo con el candado de la clave tomado, cuando nadie mas puede estar
    escribiendo ese mismo archivo.
    """
    modes: tuple[Mode, ...] = ("truncated", "full")
    for mode in modes:
        path = cutout_cache_path(exposure, ra, dec, side_deg, settings, mode)
        try:
            # Con el candado, renovar la fecha y el "mirar la fecha y borrar" de
            # `prune_cutout_cache` no se cruzan: o prune ve la fecha nueva y deja el archivo,
            # o ya lo borro y aca no esta.
            with _handout_lock:
                os.utime(path)
        except FileNotFoundError:
            continue
        except OSError:
            # Windows no deja cambiar la fecha de un archivo que otro tiene abierto en exclusiva: igual sirve.
            if not path.is_file():
                continue
        if _looks_broken(path):
            # Por ejemplo, un corte de luz a mitad de una escritura (no hay fsync) o una copia a mano.
            if remove_broken:
                with contextlib.suppress(OSError):
                    os.unlink(path)
            continue
        return CutoutFile(path=path, mode=mode, from_cache=True, nbytes=0)
    return None


def discard_cutout(path: Path, settings: Settings) -> bool:
    """Borra de la cache un recorte que no sirve, para que el proximo `fetch_cutout` lo vuelva a bajar.

    Un acierto de cache solo comprueba lo barato (tamano en bloques de 2880 y
    comienzo `SIMPLE  =`); no abre el archivo. Si `load_exposure` no puede leer
    un recorte, quien planifica llama a esto con `CutoutFile.path` y lo pide de
    nuevo. Los recortes no vencen: sin esto, un archivo danado dejaria esa
    exposicion perdida para ese centro y ese lado hasta borrarlo a mano.

    Devuelve True si lo borro y False si ya no estaba o no se pudo borrar
    (Windows: alguien lo tiene abierto). Lanza `ValueError` si `path` no es un
    `.fits` suelto de `settings.cutout_cache_dir`: no borra nada fuera de la cache.

    No comprueba el contenido: si otro hilo volvio a bajar el recorte entre la
    lectura fallida y esta llamada, borra el nuevo y habra que pedirlo otra vez.
    """
    path = Path(path)
    folder = settings.cutout_cache_dir
    inside = os.path.normcase(os.path.abspath(path.parent)) == os.path.normcase(os.path.abspath(folder))
    if not inside or path.suffix != ".fits":
        raise ValueError(f"{path} no es un recorte de la cache ({folder})")
    try:
        os.unlink(path)
    except OSError:
        return False
    return True


_key_locks: dict[str, list[Any]] = {}  # clave -> [candado, cuantos lo esperan o lo tienen]
_key_locks_guard = threading.Lock()


@contextlib.contextmanager
def _exclusive(key: str) -> Iterator[None]:
    """Un solo hilo a la vez por clave: el segundo que pide el mismo recorte espera y lo encuentra en la cache."""
    with _key_locks_guard:
        entry = _key_locks.setdefault(key, [threading.Lock(), 0])
        entry[1] += 1
    try:
        with entry[0]:
            yield
    finally:
        with _key_locks_guard:
            entry[1] -= 1
            if entry[1] == 0:
                _key_locks.pop(key, None)


# ----------------------------------------------------------------- lectura FITS


class _Stream:
    """El cuerpo de la respuesta como flujo de bytes, contando lo recibido y contra un plazo total.

    `delimited` dice si la respuesta declaro su largo (`Content-Length` o
    `Transfer-Encoding: chunked`). Si no, el cuerpo termina cuando el servidor
    cierra la conexion y un corte justo entre dos HDU no se distingue del final.
    """

    def __init__(self, raw: Any, deadline: transport.Deadline | None = None, delimited: bool = True) -> None:
        self._raw = raw
        self._deadline = deadline if deadline is not None else transport.Deadline(0.0)  # sin plazo
        self.delimited = delimited
        self.nbytes = 0

    def _some(self, size: int) -> bytes:
        """Lo que llegue en una lectura del socket, hasta `size` bytes. Lanza `TotalTimeout` si vencio el plazo."""
        chunk = transport.read_some(self._raw, min(size, _READ_CHUNK), self._deadline)
        self.nbytes += len(chunk)
        return chunk

    def read(self, size: int) -> bytes:
        """Lee `size` bytes. Devuelve menos solo si el flujo termino antes."""
        parts: list[bytes] = []
        missing = size
        while missing > 0:
            chunk = self._some(missing)
            if not chunk:
                break
            parts.append(chunk)
            missing -= len(chunk)
        return b"".join(parts)

    def skip(self, size: int) -> int:
        """Lee y descarta `size` bytes. Devuelve cuantos llegaron."""
        skipped = 0
        while skipped < size:
            chunk = self._some(size - skipped)
            if not chunk:
                break
            skipped += len(chunk)
        return skipped

    def read_all(self, limit: int) -> bytes:
        """Lee hasta el final. Lanza `IrsaPermanent` si la respuesta pasa de `limit` bytes."""
        parts: list[bytes] = []
        total = 0
        while True:
            chunk = self._some(_READ_CHUNK)
            if not chunk:
                return b"".join(parts)
            total += len(chunk)
            if total > limit:
                raise IrsaPermanent(f"la respuesta pasa de {limit} bytes: no es un recorte")
            parts.append(chunk)


def _read_header(stream: _Stream, first: bool) -> bytes | None:
    """Los bloques del encabezado del HDU que sigue, o `None` si el flujo termino justo entre dos HDU."""
    blocks: list[bytes] = []
    for _ in range(MAX_HEADER_BLOCKS):
        block = stream.read(FITS_BLOCK)
        if not block and not blocks:
            if first:
                raise _Truncated("respuesta vacia")
            return None
        if len(block) < FITS_BLOCK:
            raise _Truncated("la respuesta se corto dentro de un encabezado")
        if first and not blocks and not block.startswith(b"SIMPLE  ="):
            raise _Truncated("la respuesta no empieza como un archivo FITS")
        if not first and not blocks and not block.startswith(b"XTENSION="):
            raise _Unreadable("una extension no empieza con XTENSION")
        if block.translate(None, _HEADER_BYTES):
            raise _Unreadable("un encabezado trae bytes que no son ASCII imprimible")
        blocks.append(block)
        if any(block[i : i + CARD_LENGTH] == _END_CARD for i in range(0, FITS_BLOCK, CARD_LENGTH)):
            return b"".join(blocks)
    raise _Unreadable(f"un encabezado no trae END en {MAX_HEADER_BLOCKS} bloques")


def _data_size(header: fits.Header) -> int:
    """Bytes que ocupa el bloque de datos de un HDU, relleno incluido (estandar FITS 4.0, ecuacion 2)."""
    try:
        naxis = int(header["NAXIS"])
        axes = [int(header[f"NAXIS{axis}"]) for axis in range(1, naxis + 1)]
        bitpix = int(header["BITPIX"])
        pcount = int(header.get("PCOUNT", 0))
        gcount = int(header.get("GCOUNT", 1))
        groups = bool(header.get("GROUPS", False))
    except Exception as exc:  # astropy lanza KeyError, ValueError o VerifyError segun la carta que falle
        raise _Unreadable(f"encabezado sin tamano legible: {type(exc).__name__}: {exc}") from exc
    if bitpix not in _VALID_BITPIX or naxis < 0 or pcount < 0 or gcount < 0 or any(axis < 0 for axis in axes):
        raise _Unreadable("encabezado con un tamano imposible")
    if groups:
        # Grupos aleatorios: el tamano se calcula de otra manera y aca no se esperan.
        raise _Unreadable("HDU de grupos aleatorios")
    if naxis == 0:
        return 0
    size = abs(bitpix) // 8 * gcount * (pcount + math.prod(axes))
    return math.ceil(size / FITS_BLOCK) * FITS_BLOCK


def _extension_name(header: fits.Header) -> str:
    """`EXTNAME` de una extension, en mayusculas; vacio si no lo trae."""
    try:
        return str(header.get("EXTNAME", "")).strip().upper()
    except Exception as exc:
        # astropy interpreta cada carta recien al leerla: una `EXTNAME` mal escrita (sin la
        # comilla de cierre, por ejemplo) lanza VerifyError aca y no al armar el encabezado.
        raise _Unreadable(f"encabezado con EXTNAME ilegible: {type(exc).__name__}: {exc}") from exc


def _read_image_hdus(stream: _Stream) -> bytes:
    """Lee el FITS de a un HDU y devuelve PRIMARY mas las cuatro extensiones de imagen, con sus bytes originales.

    Vuelve apenas junta las cuatro, sin leer lo que sigue: con el orden actual
    de IRSA eso es antes de EPSF, que es el 96 % de la respuesta. Si el orden
    cambia, sigue leyendo (y descartando lo que no es de imagen) hasta juntarlas.

    Lanza `_Unreadable` si un encabezado no se puede interpretar o el flujo
    termina sin las cuatro, y `_Truncated` si se corta a mitad de un HDU.
    """
    kept: list[bytes] = []
    found: list[str] = []
    index = 0
    while len(found) < len(IMAGE_HDUS):
        header_bytes = _read_header(stream, first=index == 0)
        if header_bytes is None:
            missing = [name for name in IMAGE_HDUS if name not in found]
            raise _Unreadable(f"la respuesta termino sin las extensiones {missing}")
        try:
            header = fits.Header.fromstring(header_bytes.decode("ascii"))
        except Exception as exc:  # astropy lanza varias clases segun la carta que falle
            raise _Unreadable(f"encabezado ilegible: {type(exc).__name__}: {exc}") from exc
        size = _data_size(header)
        name = "PRIMARY" if index == 0 else _extension_name(header)
        if index == 0 or (name in IMAGE_HDUS and name not in found):
            if size > MAX_RESPONSE_BYTES:
                raise _Unreadable(f"la extension {name} declara {size} bytes")
            data = stream.read(size)
            if len(data) < size:
                raise _Truncated(f"la respuesta se corto dentro de los datos de {name}")
            kept.append(header_bytes + data)
            if index > 0:
                found.append(name)
        elif stream.skip(size) < size:
            raise _Truncated(f"la respuesta se corto dentro de los datos de {name or 'una extension sin nombre'}")
        index += 1
    return b"".join(kept)


def _hdu_name(hdu: Any) -> str:
    """Nombre de un HDU sin distinguir mayusculas, como lo busca astropy con `hdul["IMAGE"]`."""
    return str(hdu.name).strip().upper()


def _check_image_hdus(hdul: fits.HDUList) -> None:
    """Comprueba que esten las cuatro extensiones de imagen y que tengan la misma forma."""
    names = [_hdu_name(hdu) for hdu in hdul]
    missing = [name for name in IMAGE_HDUS if name not in names]
    if missing:
        raise _MissingExtensions(f"faltan las extensiones {missing}; la respuesta trae {names}")
    shapes: dict[str, tuple[int, ...]] = {}
    for name in IMAGE_HDUS:
        data = hdul[names.index(name)].data  # leer los datos tambien detecta un archivo cortado
        if data is None or data.ndim != 2 or data.dtype.names is not None:
            raise _InvalidCutout(f"la extension {name} no es una imagen de dos dimensiones")
        shapes[name] = data.shape
    if len(set(shapes.values())) != 1:
        raise _InvalidCutout(f"extensiones con formas distintas: {shapes}")


def _open_and_check(payload: bytes) -> None:
    """Abre un FITS en memoria con astropy y comprueba sus cuatro extensiones: lo mismo que va a hacer el pipeline.

    Lanza `_InvalidCutout` si se abre pero no sirve y `_Truncated` si astropy no lo puede abrir.
    """
    try:
        with fits.open(io.BytesIO(payload), memmap=False) as hdul:
            _check_image_hdus(hdul)
    except _InvalidCutout:
        raise
    except Exception as exc:  # astropy lanza OSError, ValueError o TypeError segun donde falle
        raise _Truncated(f"astropy no lo abre como FITS: {type(exc).__name__}: {exc}") from exc


def _validate_truncated(payload: bytes) -> None:
    """Comprueba lo que armo el lector por flujo. Si astropy no lo abre, hay que bajar la respuesta completa."""
    try:
        _open_and_check(payload)
    except _Truncated as exc:
        raise _Unreadable(f"lo leido por flujo no sirve: {exc}") from exc


def _extract_full(payload: bytes) -> bytes:
    """Abre la respuesta completa con astropy, la valida y devuelve todo menos EPSF, con los bytes tal como llegaron.

    Lanza `_Truncated` si no se puede abrir como FITS o esta cortada, e
    `_InvalidCutout` si se abre pero no trae las cuatro extensiones con la misma forma.

    "Cortada" se mira en todos los HDU, tambien en los que no se guardan: una
    respuesta que termina a mitad de EPSF no es la respuesta completa, y lo que
    venia despues (WCS-WAVE) no llego. Tampoco puede sobrar nada despues del
    ultimo HDU que astropy reconoce: seria un encabezado cortado.
    """
    if not payload:
        raise _Truncated("respuesta vacia")
    try:
        with fits.open(io.BytesIO(payload), memmap=False) as hdul:
            pieces: list[bytes] = []
            covered = 0
            for index, hdu in enumerate(hdul):
                info = hdul.fileinfo(index)
                start, end = int(info["hdrLoc"]), int(info["datLoc"]) + int(info["datSpan"])
                if end > len(payload):
                    raise _Truncated(f"la respuesta se corto dentro de {_hdu_name(hdu) or 'una extension sin nombre'}")
                covered = max(covered, end)
                if _hdu_name(hdu) not in DROPPED_HDUS:
                    pieces.append(payload[start:end])
            if covered < len(payload):
                raise _Truncated(
                    f"sobran {len(payload) - covered} bytes despues del ultimo HDU: "
                    "la respuesta se corto dentro de un encabezado o no es un FITS entero"
                )
            _check_image_hdus(hdul)
    except (_InvalidCutout, _Truncated):
        raise
    except Exception as exc:  # astropy lanza OSError, ValueError o TypeError segun donde falle
        raise _Truncated(f"la respuesta no se abre como FITS: {type(exc).__name__}: {exc}") from exc
    kept = b"".join(pieces)
    # Lo que se guarda ya no es la respuesta entera: tiene que abrirse igual sin EPSF.
    _open_and_check(kept)
    return kept


# -------------------------------------------------------------------- descarga


def _body_excerpt(response: requests.Response) -> str:
    """Comienzo del cuerpo de una respuesta de error, en una linea, para el mensaje."""
    try:
        text = response.raw.read(300, decode_content=True).decode("utf-8", errors="replace")
    except Exception:  # el cuerpo es solo para el log: si no se puede leer, el error sale sin el
        return ""
    return " ".join(text.split())


def _raise_for_status(response: requests.Response, settings: Settings) -> None:
    """Convierte una respuesta que no es 200 en la excepcion que le toca."""
    status = response.status_code
    if status == 200:
        return
    requested = transport.parse_retry_after(response.headers.get("Retry-After"))
    message = f"HTTP {status}: {_body_excerpt(response)}".rstrip(": ")
    # `Retry-After` puede traer cualquier numero o fecha: la espera que se informa tiene un maximo.
    longest = max(0.0, settings.irsa_retry_after_max_s)
    if requested is not None and requested > longest:
        message += f" (Retry-After de {requested:g} s; se informa el maximo, {longest:g} s)"
    if status in (429, 503):
        # IRSA cargado: 503 "Server busy, retry later." con `Retry-After: 5` (spike/RESULTADOS.md, seccion 3).
        wait = settings.irsa_retry_after_default_s if requested is None else requested
        raise IrsaBusy(message, min(wait, longest), requested)
    if status >= 500:
        if requested is not None:
            raise IrsaBusy(message, min(requested, longest), requested)
        raise IrsaTransient(message)
    if status == 408:
        raise IrsaTransient(message)
    if status >= 400:
        # Por ejemplo 422 "Arrays do not overlap.": el punto cae fuera de la imagen.
        raise IrsaPermanent(message)
    raise IrsaTransient(f"respuesta inesperada, {message}")


def _declares_length(response: requests.Response) -> bool:
    """Si la respuesta dice donde termina su cuerpo: `Content-Length` o `Transfer-Encoding: chunked`.

    IRSA manda los recortes con `chunked` (spike/resultados/cutout_transfer.txt).
    Con cualquiera de las dos un corte se nota; sin ellas el cuerpo termina
    cuando el servidor cierra la conexion, y un corte parece el final.
    """
    encoding = response.headers.get("Transfer-Encoding", "")
    return "chunked" in encoding.lower() or "Content-Length" in response.headers


@contextlib.contextmanager
def _open(url: str, settings: Settings, deadline: transport.Deadline) -> Iterator[_Stream]:
    """Pide `url` y entrega el cuerpo como flujo. Al salir cierra la conexion, se haya leido todo o no."""
    headers = transport.request_headers(settings)
    # El servicio de recortes no comprime (spike/RESULTADOS.md, seccion 2); se pide sin
    # compresion para que los bytes del flujo sean los del FITS.
    headers["Accept-Encoding"] = "identity"
    timeouts = transport.timeouts(settings, deadline)
    response = transport.session().get(url, stream=True, timeout=timeouts, headers=headers)
    try:
        _raise_for_status(response, settings)
        yield _Stream(response.raw, deadline, _declares_length(response))
    finally:
        response.close()


def _download(url: str, settings: Settings) -> tuple[bytes, Mode, int, str | None]:
    """Baja el recorte y devuelve (bytes para guardar, modo, bytes recibidos, motivo del modo `full`).

    Un intento, sin esperas, con `settings.irsa_total_timeout_s` como tope de
    toda la llamada (los dos pedidos del modo `full` incluidos). El motivo es
    `None` en modo `truncated`. Solo lanza `IrsaError`.
    """
    deadline = transport.total_deadline(settings)
    received = 0
    reason = ""
    delimited = True
    try:
        with _open(url, settings, deadline) as stream:
            try:
                payload = _read_image_hdus(stream)
                _validate_truncated(payload)
                return payload, "truncated", stream.nbytes, None
            except (_Unreadable, _InvalidCutout) as exc:
                reason = str(exc)
            finally:
                received = stream.nbytes
        # No se pudo cortar la descarga: la respuesta completa, abierta con astropy.
        with _open(url, settings, deadline) as stream:
            delimited = stream.delimited
            body = stream.read_all(MAX_RESPONSE_BYTES)
            received += stream.nbytes
        return _extract_full(body), "full", received, reason
    except IrsaError:
        raise
    except _MissingExtensions as exc:
        if not delimited:
            # Sin `Content-Length` ni `chunked`, un corte justo entre dos HDU se ve igual que una
            # respuesta a la que le faltan extensiones. Puede ser pasajero: que se reintente.
            raise IrsaTransient(
                f"{exc}; la respuesta no declara su largo y pudo haberse cortado (lectura por flujo: {reason})"
            ) from exc
        raise IrsaPermanent(f"{exc} (lectura por flujo: {reason})") from exc
    except _InvalidCutout as exc:
        raise IrsaPermanent(f"{exc} (lectura por flujo: {reason})") from exc
    except _Truncated as exc:
        raise IrsaTransient(str(exc)) from exc
    except _BAD_URL_ERRORS as exc:
        raise IrsaPermanent(f"URL de recorte invalida: {exc}") from exc
    except _NETWORK_ERRORS as exc:
        raise IrsaTransient(f"{type(exc).__name__}: {exc}") from exc
    except Exception as exc:
        # Red de seguridad: de aca solo sale `IrsaError`. Una excepcion que nadie previo, al
        # interpretar lo que mando IRSA, no puede tumbar el trabajo; se reintenta como un corte.
        raise IrsaTransient(f"fallo inesperado al leer la respuesta: {type(exc).__name__}: {exc}") from exc


# ------------------------------------------------------------------- escritura


def _replace(source: Path, target: Path) -> None:
    """`os.replace`, tolerando el bloqueo de Windows cuando alguien tiene abierto el destino."""
    for wait in (*_REPLACE_WAITS_S, None):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if target.is_file() and not _looks_broken(target):
                # Ya hay un recorte entero con esa clave (toda escritura es atomica) y alguien
                # lo esta leyendo: vale ese y el temporal se descarta.
                return
            if wait is None:
                raise
            time.sleep(wait)


def _write_atomic(path: Path, payload: bytes) -> None:
    """Deja `payload` en `path` sin que nadie pueda ver el archivo a medio escribir. No deja temporales."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with open(tmp, "wb") as handle:
            handle.write(payload)
        _replace(tmp, path)
    finally:
        with contextlib.suppress(OSError):
            tmp.unlink()


def fetch_cutout(exposure: Exposure, ra: float, dec: float, side_deg: float, settings: Settings) -> CutoutFile:
    """Deja en la cache de disco el recorte de una exposicion y devuelve donde quedo. Hace UN intento.

    - Si el recorte ya esta en `settings.cutout_cache_dir` (clave: exposicion,
      centro y lado), lo devuelve con `from_cache=True` sin tocar la red.
    - Si no, lo pide dentro de `limiter.cutout_slot()`, con timeout, y lee la
      respuesta de a un HDU hasta tener IMAGE, FLAGS, VARIANCE y ZODI
      (`mode="truncated"`). Si eso falla por el formato, baja la respuesta
      completa (`mode="full"`) y guarda todo menos EPSF.
    - Valida que las cuatro extensiones tengan la misma forma y escribe el
      archivo de forma atomica.

    Excepciones: `IrsaBusy(retry_after)` para 503 y 429, `IrsaTransient` para
    cortes y timeouts, `IrsaPermanent` para 4xx. No sale ninguna otra: lo que
    nadie previo al interpretar la respuesta llega como `IrsaTransient`.

    Precisiones:

    - Un acierto de cache no ocupa cupo y le actualiza la fecha al archivo. Solo
      comprueba lo barato: que el archivo mida un multiplo de 2880 bytes y
      empiece como un FITS; si no, lo borra y lo baja de nuevo. No lo abre: si
      despues `load_exposure` no lo puede leer, hay que llamar a
      `discard_cutout(cutout.path, settings)` y volver a pedirlo.
    - Si dos hilos piden el mismo recorte a la vez, el segundo espera al primero
      y lo recibe de la cache: a IRSA le llega un solo pedido.
    - `IrsaBusy` tambien sale de cualquier 5xx que traiga `Retry-After`; un 503 o
      429 sin esa cabecera lleva `settings.irsa_retry_after_default_s`.
      `retry_after` nunca pasa de `settings.irsa_retry_after_max_s`; lo que
      pidio IRSA sin acotar queda en `requested`.
    - `IrsaTransient` cubre ademas 5xx sin `Retry-After`, 408, un FITS cortado,
      una falla al escribir en la cache y una llamada que pasa de
      `settings.irsa_total_timeout_s` en total (una respuesta que llega de a
      poco no dispara el timeout de lectura). `IrsaPermanent`, una respuesta
      entera que no trae las cuatro extensiones con la misma forma.
    - El modo `full` son dos pedidos dentro de la misma llamada, del mismo cupo
      y del mismo plazo total: el que no se pudo leer por flujo y el completo.
      `reason` dice por que no se pudo cortar; sirve para el aviso
      `full_download`. En un acierto de cache viene `None`.
    - Si la respuesta no declara su largo (ni `Content-Length` ni `chunked`; no
      es el caso de IRSA), un corte justo entre dos HDU no se distingue del
      final: que falten extensiones es entonces `IrsaTransient`, no
      `IrsaPermanent`. Un corte justo despues de las cuatro no se puede notar.
    - Tras un fallo no queda ningun archivo, ni entero ni parcial.
    """
    cached = _cached(exposure, ra, dec, side_deg, settings)
    if cached is not None:
        return cached
    key = str(cutout_cache_path(exposure, ra, dec, side_deg, settings))
    with _exclusive(key):
        # Otro hilo pudo haberlo bajado mientras este esperaba. Si lo que hay es un archivo roto, se
        # borra aca, con el candado: asi no queda al lado del nuevo ni se le borra a otro uno recien bajado.
        cached = _cached(exposure, ra, dec, side_deg, settings, remove_broken=True)
        if cached is not None:
            return cached
        with get_limiter(settings).cutout_slot():
            payload, mode, nbytes, reason = _download(cutout_url(exposure, ra, dec, side_deg), settings)
        path = cutout_cache_path(exposure, ra, dec, side_deg, settings, mode)
        try:
            _write_atomic(path, payload)
        except OSError as exc:
            raise IrsaTransient(f"no se pudo guardar el recorte en la cache: {type(exc).__name__}: {exc}") from exc
    return CutoutFile(path=path, mode=mode, from_cache=False, nbytes=nbytes, reason=reason)


# ---------------------------------------------------------------- tope de disco


@dataclass(frozen=True)
class PruneResult:
    """Lo que hizo `prune_cutout_cache`."""

    files_removed: int
    bytes_removed: int
    bytes_kept: int  # lo que ocupan los recortes que quedaron


_prune_lock = threading.Lock()


def prune_cutout_cache(settings: Settings, max_bytes: int | None = None, min_age_s: float = 600.0) -> PruneResult:
    """Borra los recortes menos usados si la cache pasa del tope de disco (contrato, seccion 11).

    - El tope es `settings.cutout_cache_max_gb`, o `max_bytes` si se indica. Con
      un tope de 0 o menos no borra nada.
    - "Menos usado" es el de fecha de modificacion mas vieja: `fetch_cutout` se
      la actualiza a cada recorte que entrega, tambien si salio de la cache.
    - Al pasar el tope borra hasta dejar la cache en el 90 % del tope.
    - No borra recortes usados en los ultimos `min_age_s` segundos, aunque la
      cache quede por encima del tope: los puede estar leyendo un trabajo en curso.
    - Justo antes de borrar cada archivo le vuelve a mirar la fecha: si alguien
      lo uso despues de que se listo la carpeta, lo deja. Mirar y borrar van
      bajo el mismo candado con el que `fetch_cutout` renueva la fecha, asi que
      dentro de este proceso no se le saca a otro trabajo un recorte que se le
      acaba de entregar de la cache.
    - Solo mira los archivos sueltos de `settings.cutout_cache_dir`: los `.fits`
      son recortes, y los `.tmp` de mas de una hora, restos de un proceso que
      murio. No entra en subcarpetas ni toca nada mas.

    No se llama sola: le toca a quien planifica los trabajos, por ejemplo al
    terminar cada uno. La proteccion es por proceso, como el cupo hacia IRSA:
    dos procesos sobre la misma carpeta no se ven entre si.
    """
    limit = int(settings.cutout_cache_max_gb * 1024**3) if max_bytes is None else int(max_bytes)
    folder = settings.cutout_cache_dir
    now = time.time()
    with _prune_lock:
        cutouts: list[tuple[int, int, str]] = []  # (fecha en ns, bytes, ruta)
        try:
            with os.scandir(folder) as entries:
                for entry in entries:
                    try:
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        # La fecha sale del listado de la carpeta, sin abrir cada archivo (27 veces mas
                        # rapido en Windows). Si alguna viniera atrasada respecto de la del archivo,
                        # mas abajo no coincide y ese recorte se deja para la proxima: nunca se borra de mas.
                        stat = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue  # desaparecio mientras se listaba
                    if entry.name.endswith(".fits"):
                        cutouts.append((stat.st_mtime_ns, stat.st_size, entry.path))
                    elif entry.name.endswith(".tmp") and now - stat.st_mtime > _STALE_TMP_S:
                        with contextlib.suppress(OSError):
                            os.unlink(entry.path)
        except FileNotFoundError:
            return PruneResult(files_removed=0, bytes_removed=0, bytes_kept=0)

        total = sum(size for _, size, _ in cutouts)
        removed_files = removed_bytes = 0
        if limit > 0 and total > limit:
            target = int(limit * _PRUNE_TARGET)
            for mtime_ns, size, path in sorted(cutouts):
                if total - removed_bytes <= target:
                    break
                # Con `min_age_s` en 0 no se protege nada: la fecha de un archivo recien escrito
                # puede quedar una fraccion por delante del reloj y la resta dar negativa.
                if min_age_s > 0 and now - mtime_ns / 1e9 < min_age_s:
                    break  # de aca en adelante son todos mas nuevos
                # La fecha del listado puede ser vieja: `fetch_cutout` la renueva cuando entrega
                # el recorte de la cache, y eso pudo pasar mientras se borraban los anteriores.
                # Mirarla de nuevo y borrar van juntos, sin que en el medio se entregue el archivo.
                with _handout_lock:
                    try:
                        current_ns = os.stat(path, follow_symlinks=False).st_mtime_ns
                    except OSError:
                        total -= size  # ya no esta: lo borro otro
                        continue
                    if current_ns != mtime_ns:
                        continue  # lo usaron despues del listado
                    try:
                        os.unlink(path)
                    except OSError:
                        continue  # Windows: alguien lo tiene abierto. Queda para la proxima.
                removed_files += 1
                removed_bytes += size
        return PruneResult(files_removed=removed_files, bytes_removed=removed_bytes, bytes_kept=total - removed_bytes)
