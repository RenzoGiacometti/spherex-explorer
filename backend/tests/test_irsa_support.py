"""Apoyo de los tests de app/irsa: un servidor HTTP local que hace de IRSA. No tiene tests propios.

El servidor escucha en 127.0.0.1 con puerto 0 (el que este libre) y corre en un
hilo. Cada ruta tiene una conducta: responder un FITS de a tramos, cortar la
conexion a mitad de camino, quedarse callado, devolver un codigo de error. De
cada pedido queda anotado que se pidio, cuantos bytes del cuerpo se llegaron a
escribir y si el cliente cerro antes de recibir todo.

Las respuestas de recortes se arman con los recortes reales de
tests/fixtures/cutouts, que son lo que queda de una respuesta de IRSA al cortar
antes de EPSF, mas dos extensiones sinteticas al final con los nombres de las
reales (EPSF y WCS-WAVE; spike/RESULTADOS.md, seccion 2).
"""

from __future__ import annotations

import io
import json
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from functools import cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Literal
from urllib.parse import parse_qsl, urlsplit

import numpy as np
from astropy.io import fits

from app.domain import Exposure

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"
CUTOUTS_DIR = FIXTURES_DIR / "cutouts"
SIA_DIR = FIXTURES_DIR / "sia"

IMAGE_HDUS = ("IMAGE", "FLAGS", "VARIANCE", "ZODI")
# Orden en que IRSA manda las extensiones de un recorte (spike/RESULTADOS.md, seccion 2).
IRSA_ORDER = ("PRIMARY", "IMAGE", "FLAGS", "VARIANCE", "ZODI", "EPSF", "WCS-WAVE")

Framing = Literal["chunked", "length", "close"]


# ------------------------------------------------------------------- servidor


@dataclass
class Hit:
    """Un pedido que llego al servidor y lo que paso con su respuesta."""

    path: str
    query: dict[str, str]
    headers: dict[str, str]  # nombres en minusculas
    bytes_sent: int = 0  # bytes del cuerpo que el servidor llego a escribir
    aborted: bool = False  # el cliente cerro la conexion antes de recibir todo
    done: threading.Event = field(default_factory=threading.Event)


Behaviour = Callable[["_Handler", Hit], None]


@dataclass
class Gate:
    """Retiene cada pedido antes de responderlo, para medir cuantos hay a la vez.

    Los pedidos esperan hasta que haya `target` retenidos al mismo tiempo (o
    pase `timeout_s`) y despues `hold_s` mas. El cliente tiene la conexion
    abierta durante toda la retencion, asi que el maximo que ve el servidor
    nunca supera las conexiones simultaneas del cliente.
    """

    target: int
    hold_s: float = 0.05
    timeout_s: float = 3.0


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64
    stub: IrsaStub

    def handle_error(self, request: Any, client_address: Any) -> None:
        """Un cliente que corta la conexion no es un error del test: sin traza."""


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: _Server

    def log_message(self, format: str, *args: Any) -> None:
        """Sin registro de pedidos en la salida de los tests."""

    def do_GET(self) -> None:
        stub = self.server.stub
        parts = urlsplit(self.path)
        hit = Hit(
            path=parts.path,
            query=dict(parse_qsl(parts.query)),
            headers={name.lower(): value for name, value in self.headers.items()},
        )
        behaviour = stub.register(hit)
        self.close_connection = True
        try:
            stub.hold()
            behaviour(self, hit)
        except OSError:
            hit.aborted = True
        finally:
            hit.done.set()


class IrsaStub:
    """Servidor HTTP local. `routes` asocia una ruta (sin la consulta) a su conducta; el resto va a `default`."""

    def __init__(self) -> None:
        self.routes: dict[str, Behaviour] = {}
        self.default: Behaviour = respond(404, b"not found")
        self.hits: list[Hit] = []
        self.stop = threading.Event()  # corta las esperas de las conductas lentas al cerrar
        self.gate: Gate | None = None
        self.active = 0
        self.max_active = 0
        self._lock = threading.Lock()
        self._full = threading.Event()
        self._server = _Server(("127.0.0.1", 0), _Handler)
        self._server.stub = self
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def url(self, path: str) -> str:
        return self.base_url + path

    def register(self, hit: Hit) -> Behaviour:
        with self._lock:
            self.hits.append(hit)
            return self.routes.get(hit.path, self.default)

    def hold(self) -> None:
        gate = self.gate
        if gate is None:
            return
        with self._lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            if self.active >= gate.target:
                self._full.set()
        self._full.wait(gate.timeout_s)
        time.sleep(gate.hold_s)
        with self._lock:
            self.active -= 1

    def wait_idle(self, timeout: float = 10.0) -> None:
        """Espera a que el servidor termine de atender todos los pedidos que recibio."""
        for hit in list(self.hits):
            assert hit.done.wait(timeout), f"el servidor no termino de atender {hit.path}"

    def close(self) -> None:
        self.stop.set()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5.0)


# ------------------------------------------------------------------ conductas


def respond(
    status: int, body: bytes = b"", headers: dict[str, str] | None = None, content_type: str = "text/plain"
) -> Behaviour:
    """Una respuesta entera, con `Content-Length`."""

    def behaviour(handler: _Handler, hit: Hit) -> None:
        handler.send_response(status)
        handler.send_header("Content-Type", content_type)
        handler.send_header("Content-Length", str(len(body)))
        handler.send_header("Connection", "close")
        for name, value in (headers or {}).items():
            handler.send_header(name, value)
        handler.end_headers()
        handler.wfile.write(body)
        hit.bytes_sent = len(body)

    return behaviour


def serve(
    body: bytes,
    *,
    framing: Framing = "chunked",
    block: int = 16 * 1024,
    cut_after: int | None = None,
    stall_after: int | None = None,
    stall_s: float = 30.0,
    delay_s: float = 0.0,
    pause_s: float = 0.0,
    content_type: str = "application/fits",
) -> Behaviour:
    """Un 200 que manda `body` de a tramos de `block` bytes.

    `framing`: `chunked` es lo que usa el servicio de recortes de IRSA
    (spike/resultados/cutout_transfer.txt); `length` manda `Content-Length`;
    `close` no manda ninguna de las dos y el cuerpo termina al cerrar la conexion.

    `cut_after`: corta la conexion tras escribir esa cantidad de bytes.
    `stall_after`: tras esa cantidad se queda callado `stall_s` segundos y corta.
    `delay_s`: espera antes de mandar la primera linea.
    `pause_s`: espera despues de cada tramo, para una respuesta que llega de a poco
    sin quedarse nunca callada mas que eso.
    """

    def behaviour(handler: _Handler, hit: Hit) -> None:
        stop = handler.server.stub.stop
        if delay_s and stop.wait(delay_s):
            return
        handler.send_response(200)
        handler.send_header("Content-Type", content_type)
        if framing == "chunked":
            handler.send_header("Transfer-Encoding", "chunked")
        elif framing == "length":
            handler.send_header("Content-Length", str(len(body)))
        handler.send_header("Connection", "close")
        handler.end_headers()
        limit = min(value for value in (len(body), cut_after, stall_after) if value is not None)
        try:
            while hit.bytes_sent < limit:
                piece = body[hit.bytes_sent : min(hit.bytes_sent + block, limit)]
                if framing == "chunked":
                    handler.wfile.write(f"{len(piece):x}\r\n".encode("ascii") + piece + b"\r\n")
                else:
                    handler.wfile.write(piece)
                hit.bytes_sent += len(piece)
                if pause_s and stop.wait(pause_s):
                    return
            if limit < len(body):
                if stall_after is not None and limit == stall_after:
                    stop.wait(stall_s)
                return  # al volver, el servidor cierra la conexion con la respuesta a medias
            if framing == "chunked":
                handler.wfile.write(b"0\r\n\r\n")
        except OSError:
            hit.aborted = True

    return behaviour


def sequence(*behaviours: Behaviour) -> Behaviour:
    """Una conducta por pedido, en orden; la ultima se repite."""
    lock = threading.Lock()
    count = 0

    def behaviour(handler: _Handler, hit: Hit) -> None:
        nonlocal count
        with lock:
            current = behaviours[min(count, len(behaviours) - 1)]
            count += 1
        current(handler, hit)

    return behaviour


def by_collection(behaviours: dict[str, Behaviour]) -> Behaviour:
    """Para la ruta de SIA2: una conducta segun el parametro `COLLECTION`."""

    def behaviour(handler: _Handler, hit: Hit) -> None:
        behaviours[hit.query["COLLECTION"]](handler, hit)

    return behaviour


# ------------------------------------------------------------------------ FITS


def cutout_index() -> dict[str, Any]:
    return json.loads((CUTOUTS_DIR / "index.json").read_text(encoding="utf-8"))


def split_hdus(payload: bytes) -> list[tuple[str, bytes]]:
    """(nombre, bytes) de cada HDU de un FITS, con los bytes tal como estan en el archivo."""
    with fits.open(io.BytesIO(payload), memmap=False) as hdul:
        parts = []
        for index, hdu in enumerate(hdul):
            info = hdul.fileinfo(index)
            parts.append((hdu.name, payload[info["hdrLoc"] : info["datLoc"] + info["datSpan"]]))
    return parts


def extension_bytes(hdu: Any) -> bytes:
    """Los bytes de una extension armada con astropy, sin el PRIMARY que la acompana al escribirla."""
    buffer = io.BytesIO()
    fits.HDUList([fits.PrimaryHDU(), hdu]).writeto(buffer)
    return split_hdus(buffer.getvalue())[1][1]


@cache
def epsf_extension(megabytes: float = 8.0) -> bytes:
    """Una extension EPSF sintetica: una tabla grande, llena de ceros.

    La real es una tabla de 441 filas y 3,9 MB (spike/RESULTADOS.md, seccion 2).
    Aca solo importa que se llame igual y que pese bastante mas que las
    imagenes, para que se note si el cliente la baja. La columna `RELLENO` es
    inventada: no es la de IRSA.
    """
    rows = 441
    width = int(megabytes * 1024 * 1024 / rows / 4)
    column = fits.Column(name="RELLENO", format=f"{width}E", array=np.zeros((rows, width), dtype=np.float32))
    return extension_bytes(fits.BinTableHDU.from_columns([column], name="EPSF"))


@cache
def wcs_wave_extension() -> bytes:
    """Una extension WCS-WAVE sintetica, con las columnas y dimensiones de una real del detector 3.

    Estructura tomada de un recorte completo real (spike/resultados/wcswave.txt):
    una fila con X (9), Y (14) y VALUES (14 x 9 x 2). Los valores son ceros.
    """
    columns = [
        fits.Column(name="X", format="9J", dim="(9)", array=np.zeros((1, 9), dtype=np.int32)),
        fits.Column(name="Y", format="14J", dim="(14)", array=np.zeros((1, 14), dtype=np.int32)),
        fits.Column(name="VALUES", format="252E", dim="(2,9,14)", array=np.zeros((1, 14, 9, 2), dtype=np.float32)),
    ]
    return extension_bytes(fits.BinTableHDU.from_columns(columns, name="WCS-WAVE"))


def irsa_response(cutout: bytes, order: Sequence[str] = IRSA_ORDER, replace: dict[str, bytes] | None = None) -> bytes:
    """La respuesta de IRSA para un recorte guardado: sus HDU mas EPSF y WCS-WAVE, en el orden pedido.

    `replace` cambia los bytes de un HDU por otros, para armar respuestas rotas.
    """
    parts = dict(split_hdus(cutout))
    parts["EPSF"] = epsf_extension()
    parts["WCS-WAVE"] = wcs_wave_extension()
    parts.update(replace or {})
    return b"".join(parts[name] for name in order)


def hdu_names(path: Path) -> list[str]:
    with fits.open(path, memmap=False) as hdul:
        return [hdu.name for hdu in hdul]


def same_images(path: Path, reference: Path) -> bool:
    """Si las cuatro extensiones de imagen de `path` tienen los mismos encabezados y datos que las de `reference`."""
    with fits.open(path, memmap=False) as got, fits.open(reference, memmap=False) as expected:
        return all(
            got[name].header == expected[name].header
            and np.array_equal(got[name].data, expected[name].data, equal_nan=True)
            for name in IMAGE_HDUS
        )


def exposure_from_entry(entry: dict[str, Any], base_url: str) -> Exposure:
    """La exposicion de una entrada de tests/fixtures/cutouts/index.json, con la URL apuntando al servidor local."""
    return Exposure(
        obs_id=entry["obs_id"],
        collection=entry["collection"],
        detector=entry["detector"],
        mjd_start=entry["mjd"],
        mjd_end=entry["mjd_end"],
        url=base_url + urlsplit(entry["url"]).path,
        wave_min_um=entry["wave_min_um"],
        wave_max_um=entry["wave_max_um"],
    )
