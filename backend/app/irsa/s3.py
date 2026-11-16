"""Recorte de una exposicion leido por rangos de bytes del archivo completo en el bucket publico de AWS.

IRSA publica los mismos archivos de nivel 2 en `s3://nasa-irsa-spherex`, con
las mismas rutas que cuelgan de `https://irsa.ipac.caltech.edu/ibe/data/spherex/`
(columna `cloud_access` de SIA2; SPEC.md, seccion 8). S3 respeta `Range`, asi
que en vez de pedirle un recorte a IRSA se leen los encabezados y solo las
filas de pixeles que hacen falta. El bucket no responde 503 ni pide esperas.

Disposicion de un archivo, leida de uno real el 15 de noviembre de 2026
(`dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_...fits`, 64 952 640 bytes):

    PRIMARY   sin datos
    IMAGE     float32 2040 x 2040, sin comprimir
    FLAGS     tabla binaria: imagen int32 comprimida con RICE_1, una fila por tesela (ZTILE2 = 1)
    VARIANCE  float32 2040 x 2040, sin comprimir
    ZODI      float32 2040 x 2040, sin comprimir
    EPSF      tabla binaria, 3,9 MB
    WCS-WAVE  tabla binaria

Lo que devuelve `read_cutout` tiene el formato de un recorte `_img` de IRSA
(app/irsa/cutouts.py): PRIMARY mas IMAGE, FLAGS, VARIANCE y ZODI como
imagenes sin comprimir. Comparado con un recorte real de IRSA de esa misma
exposicion, los encabezados son los mismos salvo `NAXIS1`, `NAXIS2` y los
`CRPIX` del WCS primario y de los alternativos (A y W), que IRSA corre en la
esquina del recorte; aca se corren igual. La ventana se calcula por separado y
puede diferir de la de IRSA en un pixel por lado.

Las extensiones se buscan por `EXTNAME`, no por posicion. Si el archivo no
tiene la forma esperada (FLAGS comprimido de otra manera, una extension que
no es una imagen de dos dimensiones), sale `S3Unavailable` y quien llama pide
el recorte a IRSA.

FLAGS se descomprime con astropy sin usar nada interno: con las filas pedidas
se arma en memoria una tabla comprimida chica (los descriptores de esas filas
y el tramo del monton que ocupan) y se abre como cualquier FITS.
"""

from __future__ import annotations

import io
import math
import re
import threading
import time
from dataclasses import dataclass

import numpy as np
import requests
import urllib3
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales

from app.config import Settings
from app.irsa import transport
from app.pipeline.exposure import wcs_cards

FITS_BLOCK = 2880
CARD_LENGTH = 80
IMAGE_HDUS = ("IMAGE", "FLAGS", "VARIANCE", "ZODI")

# Un encabezado real ocupa de 1 a 8 bloques (IMAGE, 8; FLAGS, 6; VARIANCE y ZODI, 4). Con
# este primer tramo entran enteros PRIMARY e IMAGE, o cualquiera de los otros, en un pedido.
_HEADER_GUESS_BLOCKS = 10
_MAX_HEADER_BLOCKS = 100
# PRIMARY, las cuatro de imagen, EPSF y WCS-WAVE son 7. Con mas que esto sin juntar las cuatro, no es un nivel 2.
_MAX_HDUS = 12
# Margen de la ventana, en pixeles por lado, sobre el lado pedido.
_MARGIN_PX = 1
# Tope de lo que se acepta leer de una sola extension: un archivo entero son 16,6 MB por imagen.
_MAX_READ_BYTES = 64 * 1024 * 1024

_CRPIX = re.compile(r"CRPIX([12])[A-Z]?")
# Sumas de control del archivo completo: no valen para un recorte.
_STALE_CARDS = ("CHECKSUM", "DATASUM", "ZHECKSUM", "ZDATASUM")

_NETWORK_ERRORS = (requests.RequestException, urllib3.exceptions.HTTPError, OSError)

# Tras estos fallos seguidos se deja de probar el bucket durante `_PAUSE_S` segundos, para
# que una caida de S3 no le sume un pedido perdido a cada recorte.
_MAX_MISSES = 8
_PAUSE_S = 300.0


class S3Unavailable(Exception):
    """El recorte no se pudo armar desde el bucket (no esta, no responde o tiene otra forma): pedirlo a IRSA."""


class S3NoOverlap(Exception):
    """El punto cae fuera de la imagen: lo mismo que el 422 "Arrays do not overlap." del servicio de recortes."""


# ----------------------------------------------------------------- disponibilidad

_state_lock = threading.Lock()
_misses = 0
_paused_until = 0.0


def available() -> bool:
    """Si vale la pena probar el bucket ahora (falso durante la pausa que sigue a varios fallos seguidos)."""
    with _state_lock:
        return time.monotonic() >= _paused_until


def report(ok: bool) -> None:
    """Anota el resultado de un intento contra el bucket."""
    global _misses, _paused_until
    with _state_lock:
        if ok:
            _misses = 0
            return
        _misses += 1
        if _misses >= _MAX_MISSES:
            _misses = 0
            _paused_until = time.monotonic() + _PAUSE_S


def reset() -> None:
    """Olvida los fallos anotados. Para los tests."""
    global _misses, _paused_until
    with _state_lock:
        _misses = 0
        _paused_until = 0.0


def s3_url(exposure_url: str, settings: Settings) -> str | None:
    """URL del mismo archivo en el bucket, o `None` si `exposure_url` no cuelga del prefijo de IRSA."""
    base = exposure_url.split("?", 1)[0]
    prefix = settings.irsa_data_prefix
    if not prefix or not settings.s3_base_url or not base.startswith(prefix):
        return None
    return settings.s3_base_url.rstrip("/") + "/" + base[len(prefix) :].lstrip("/")


# ------------------------------------------------------------------------ lectura


class _Remote:
    """Lecturas por rango de un archivo, con un plazo total y la cuenta de bytes recibidos."""

    def __init__(self, url: str, settings: Settings, deadline: transport.Deadline) -> None:
        self._url = url
        self._settings = settings
        self._deadline = deadline
        self.nbytes = 0
        self.size: int | None = None  # tamano del archivo, de `Content-Range`

    def read(self, start: int, length: int) -> bytes:
        """`length` bytes desde `start`. Devuelve menos solo si el archivo termina antes."""
        if length <= 0:
            return b""
        if length > _MAX_READ_BYTES:
            raise S3Unavailable(f"lectura de {length} bytes: no es un recorte")
        self._deadline.check()
        headers = transport.request_headers(self._settings)
        headers["Range"] = f"bytes={start}-{start + length - 1}"
        headers["Accept-Encoding"] = "identity"
        try:
            response = transport.session().get(
                self._url, headers=headers, stream=True, timeout=transport.timeouts(self._settings, self._deadline)
            )
            try:
                if response.status_code != 206:
                    # 404 o 403: el archivo todavia no esta en el bucket. 200: el servidor ignoro `Range`.
                    raise S3Unavailable(f"HTTP {response.status_code} al leer por rango")
                self._note_size(response.headers.get("Content-Range"))
                body = transport.read_body(response.raw, self._deadline, decode=False, limit=length)
            finally:
                response.close()
        except S3Unavailable:
            raise
        except _NETWORK_ERRORS as exc:
            raise S3Unavailable(f"{type(exc).__name__}: {exc}") from exc
        self.nbytes += len(body)
        if len(body) < length and (self.size is None or start + len(body) < self.size):
            raise S3Unavailable("la lectura por rango se corto")
        return body

    def _note_size(self, content_range: str | None) -> None:
        if content_range and "/" in content_range:
            total = content_range.rsplit("/", 1)[1].strip()
            if total.isdigit():
                self.size = int(total)


@dataclass(frozen=True)
class _Hdu:
    name: str
    header: fits.Header
    data_offset: int
    data_size: int  # con relleno


def _find_end(buffer: bytes) -> int | None:
    """Posicion de la tarjeta END de un encabezado que empieza en `buffer[0]`, o `None` si todavia no llego."""
    for position in range(0, len(buffer) - CARD_LENGTH + 1, CARD_LENGTH):
        if buffer[position : position + 8] == b"END     ":
            return position
    return None


def _data_size(header: fits.Header) -> int:
    """Bytes del bloque de datos de un HDU, relleno incluido (estandar FITS 4.0, ecuacion 2)."""
    naxis = int(header.get("NAXIS", 0))
    if naxis == 0:
        return 0
    axes = [int(header[f"NAXIS{axis}"]) for axis in range(1, naxis + 1)]
    size = (
        abs(int(header["BITPIX"]))
        // 8
        * int(header.get("GCOUNT", 1))
        * (int(header.get("PCOUNT", 0)) + math.prod(axes))
    )
    return math.ceil(size / FITS_BLOCK) * FITS_BLOCK


def _walk(remote: _Remote) -> tuple[fits.Header, dict[str, _Hdu]]:
    """Recorre los encabezados hasta juntar las cuatro extensiones de imagen. Devuelve PRIMARY y las cuatro."""
    found: dict[str, _Hdu] = {}
    primary: fits.Header | None = None
    offset = 0
    buffer = b""  # lo leido a partir de `offset` y todavia no consumido
    for index in range(_MAX_HDUS):
        end = _find_end(buffer)
        while end is None:
            if len(buffer) >= _MAX_HEADER_BLOCKS * FITS_BLOCK:
                raise S3Unavailable("un encabezado no trae END")
            chunk = remote.read(offset + len(buffer), _HEADER_GUESS_BLOCKS * FITS_BLOCK)
            if not chunk:
                raise S3Unavailable(
                    f"el archivo termino sin las extensiones {[n for n in IMAGE_HDUS if n not in found]}"
                )
            buffer += chunk
            end = _find_end(buffer)
        try:
            header = fits.Header.fromstring(buffer[:end].decode("ascii"))
            size = _data_size(header)
            name = "PRIMARY" if index == 0 else str(header.get("EXTNAME", "")).strip().upper()
        except Exception as exc:  # astropy lanza varias clases segun la tarjeta que falle
            raise S3Unavailable(f"encabezado ilegible: {type(exc).__name__}: {exc}") from exc
        header_size = math.ceil((end + CARD_LENGTH) / FITS_BLOCK) * FITS_BLOCK
        if index == 0:
            if not buffer.startswith(b"SIMPLE  ="):
                raise S3Unavailable("el archivo no empieza como un FITS")
            primary = header
        elif name in IMAGE_HDUS and name not in found:
            found[name] = _Hdu(name, header, offset + header_size, size)
            if len(found) == len(IMAGE_HDUS):
                assert primary is not None
                return primary, found
        consumed = header_size + size
        offset += consumed
        # Lo que sobra del tramo leido sirve si el HDU que sigue empieza adentro (PRIMARY no tiene datos).
        buffer = buffer[consumed:] if consumed < len(buffer) else b""
    raise S3Unavailable(f"no aparecieron las extensiones {[n for n in IMAGE_HDUS if n not in found]}")


def _window(header: fits.Header, ra: float, dec: float, side_deg: float) -> tuple[int, int, int, int]:
    """Caja `[x0, x1) x [y0, y1)` en pixeles del detector que cubre un cuadrado de `side_deg` centrado en el punto."""
    try:
        wcs = WCS(wcs_cards(header))
        x, y = (float(value) for value in wcs.all_world2pix(ra, dec, 0))
        scale_x, scale_y = (float(value) for value in proj_plane_pixel_scales(wcs))
        nx, ny = int(header["NAXIS1"]), int(header["NAXIS2"])
    except Exception as exc:  # wcslib sin convergencia (el punto esta lejos) o un WCS ilegible
        if type(exc).__name__ == "NoConvergence":
            raise S3NoOverlap("el punto cae lejos de la imagen") from exc
        raise S3Unavailable(f"WCS ilegible: {type(exc).__name__}: {exc}") from exc
    if not (math.isfinite(x) and math.isfinite(y) and scale_x > 0 and scale_y > 0):
        raise S3NoOverlap("el punto no cae sobre la imagen")
    half_x = side_deg / scale_x / 2 + _MARGIN_PX
    half_y = side_deg / scale_y / 2 + _MARGIN_PX
    x0, x1 = max(0, math.floor(x - half_x + 0.5)), min(nx, math.ceil(x + half_x + 0.5))
    y0, y1 = max(0, math.floor(y - half_y + 0.5)), min(ny, math.ceil(y + half_y + 0.5))
    if x0 >= x1 or y0 >= y1:
        raise S3NoOverlap("el recorte no toca la imagen")
    return x0, x1, y0, y1


def _is_plain_image(header: fits.Header) -> bool:
    return str(header.get("XTENSION", "")).strip().upper() == "IMAGE" and int(header.get("NAXIS", 0)) == 2


def _plain_rows(remote: _Remote, hdu: _Hdu, box: tuple[int, int, int, int]) -> np.ndarray:
    """Las filas `[y0, y1)` de una imagen sin comprimir, recortadas a `[x0, x1)`, con el tipo del archivo."""
    x0, x1, y0, y1 = box
    header = hdu.header
    if not _is_plain_image(header):
        raise S3Unavailable(f"{hdu.name} no es una imagen de dos dimensiones sin comprimir")
    bitpix, nx = int(header["BITPIX"]), int(header["NAXIS1"])
    kind = {-32: ">f4", -64: ">f8", 8: "u1", 16: ">i2", 32: ">i4", 64: ">i8"}.get(bitpix)
    if kind is None or "BSCALE" in header or "BZERO" in header:
        raise S3Unavailable(f"{hdu.name}: BITPIX={bitpix} con escala: no se lee por rangos")
    row_bytes = nx * abs(bitpix) // 8
    raw = remote.read(hdu.data_offset + y0 * row_bytes, (y1 - y0) * row_bytes)
    if len(raw) != (y1 - y0) * row_bytes:
        raise S3Unavailable(f"{hdu.name}: faltan filas")
    return np.frombuffer(raw, dtype=kind).reshape(y1 - y0, nx)[:, x0:x1]


def _compressed_rows(remote: _Remote, hdu: _Hdu, box: tuple[int, int, int, int]) -> tuple[np.ndarray, fits.Header]:
    """Filas de una imagen comprimida por teselas de una fila: `(datos recortados, encabezado como imagen)`.

    Convencion de imagenes comprimidas por teselas (estandar FITS 4.0, seccion 10): cada fila
    de la tabla es una tesela, y su unica columna es un descriptor `1P` de dos enteros de 32
    bits, cuantos bytes ocupa y donde empiezan dentro del monton.
    """
    x0, x1, y0, y1 = box
    header = hdu.header
    try:
        row_tiles = (
            bool(header.get("ZIMAGE", False))
            and int(header["ZNAXIS"]) == 2
            and int(header.get("ZTILE2", 1)) == 1
            and int(header.get("ZTILE1", header["ZNAXIS1"])) == int(header["ZNAXIS1"])
            and int(header["NAXIS1"]) == 8
            and int(header["TFIELDS"]) == 1
            and str(header["TFORM1"]).strip().upper().startswith(("1PB", "PB"))
        )
        rows_total, width = int(header["NAXIS2"]), int(header["NAXIS1"])
        heap_start = hdu.data_offset + int(header.get("THEAP", width * rows_total))
    except Exception as exc:
        raise S3Unavailable(f"{hdu.name}: encabezado comprimido ilegible: {type(exc).__name__}: {exc}") from exc
    if not row_tiles:
        raise S3Unavailable(f"{hdu.name}: comprimido de una forma que no se lee por filas")
    rows = y1 - y0
    table = remote.read(hdu.data_offset + y0 * width, rows * width)
    if len(table) != rows * width:
        raise S3Unavailable(f"{hdu.name}: faltan descriptores")
    descriptors = np.frombuffer(table, dtype=">i4").reshape(rows, 2).astype(np.int64)
    lengths, starts = descriptors[:, 0], descriptors[:, 1]
    if (lengths < 0).any() or (starts < 0).any():
        raise S3Unavailable(f"{hdu.name}: descriptores imposibles")
    low, high = int(starts.min()), int((starts + lengths).max())
    heap = remote.read(heap_start + low, high - low)
    if len(heap) != high - low:
        raise S3Unavailable(f"{hdu.name}: falta parte del monton")

    # La misma tabla, solo con esas filas: los descriptores apuntan al tramo de monton leido.
    small = header.copy()
    small["NAXIS2"] = rows
    small["ZNAXIS2"] = rows
    small["PCOUNT"] = len(heap)
    small.remove("THEAP", ignore_missing=True)
    for key in _STALE_CARDS:
        small.remove(key, ignore_missing=True)
    moved = np.stack([lengths, starts - low], axis=1).astype(">i4").tobytes()
    body = moved + heap
    payload = (
        fits.PrimaryHDU().header.tostring(padding=True).encode("ascii")
        + small.tostring(padding=True).encode("ascii")
        + body
        + b"\0" * (-len(body) % FITS_BLOCK)
    )
    try:
        with fits.open(io.BytesIO(payload), memmap=False) as hdul:
            data = np.array(hdul[1].data)
            image_header = hdul[1].header.copy()
    except Exception as exc:
        raise S3Unavailable(f"{hdu.name}: no se pudo descomprimir: {type(exc).__name__}: {exc}") from exc
    if data.ndim != 2 or data.shape[0] != rows:
        raise S3Unavailable(f"{hdu.name}: la descompresion dio {data.shape}")
    return data[:, x0:x1], image_header


def _cutout_header(header: fits.Header, x0: int, y0: int) -> fits.Header:
    """El encabezado de la extension con los `CRPIX` corridos a la esquina del recorte, como hace IRSA.

    Se corren los del WCS primario y los de los alternativos (A, pixeles del detector, y W,
    la tabla de longitud de onda): con `CRPIX1W` y `CRPIX2W` el modulo de espectro ubica el
    recorte dentro de la tabla WCS-WAVE (SPEC.md, seccion 2).
    """
    out = header.copy()
    for key in _STALE_CARDS:
        out.remove(key, ignore_missing=True)
    for card in header.cards:
        match = _CRPIX.fullmatch(card.keyword)
        if match:
            out[card.keyword] = float(card.value) - (x0 if match.group(1) == "1" else y0)
    return out


def read_cutout(
    url: str, ra: float, dec: float, side_deg: float, settings: Settings, deadline: transport.Deadline | None = None
) -> tuple[bytes, int]:
    """Arma el recorte leyendo `url` por rangos. Devuelve `(FITS del recorte, bytes recibidos)`.

    Son unos nueve pedidos: los encabezados (PRIMARY e IMAGE juntos, y uno por
    cada una de las otras tres), las filas de IMAGE, VARIANCE y ZODI, y los
    descriptores y el monton de FLAGS.

    Lanza `S3NoOverlap` si el punto cae fuera de la imagen y `S3Unavailable`
    por cualquier otra cosa (red, archivo ausente, formato inesperado, plazo
    vencido). Ninguna otra excepcion.
    """
    remote = _Remote(url, settings, deadline if deadline is not None else transport.total_deadline(settings))
    try:
        primary, hdus = _walk(remote)
        box = _window(hdus["IMAGE"].header, ra, dec, side_deg)
        x0, _, y0, _ = box
        out = fits.HDUList([fits.PrimaryHDU(header=primary)])
        for name in IMAGE_HDUS:
            hdu = hdus[name]
            if _is_plain_image(hdu.header):
                data, header = _plain_rows(remote, hdu, box), hdu.header
            else:
                data, header = _compressed_rows(remote, hdu, box)
            out.append(fits.ImageHDU(data=data, header=_cutout_header(header, x0, y0), name=name))
        buffer = io.BytesIO()
        out.writeto(buffer)
    except (S3Unavailable, S3NoOverlap):
        raise
    except _NETWORK_ERRORS as exc:  # incluye el plazo total vencido (`TotalTimeout`)
        raise S3Unavailable(f"{type(exc).__name__}: {exc}") from exc
    except Exception as exc:
        # Red de seguridad: lo que nadie previo al interpretar el archivo se resuelve pidiendo el recorte a IRSA.
        raise S3Unavailable(f"fallo inesperado: {type(exc).__name__}: {exc}") from exc
    return buffer.getvalue(), remote.nbytes
