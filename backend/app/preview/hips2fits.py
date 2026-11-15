"""Vista provisoria: recorte de WISE de la misma zona, pedido a hips2fits de CDS (contrato, seccion 4.10).

El backend lo pide al crear el trabajo, en paralelo con la lista de
exposiciones, y lo guarda con el campo (`preview.f32`). Si hips2fits no responde
en `settings.preview_timeout_s`, la vista se descarta y el campo sigue igual.

SIN VERIFICAR CONTRA EL SERVICIO. El 2026-11-15 hips2fits contestaba 404 con una
pagina HTML "Page unavailable" (guardada en tests/fixtures/preview), asi que
nada de lo que sigue se probo con una respuesta real. Sale de estas fuentes:

- Parametros del pedido: codigo de astroquery,
  https://github.com/astropy/astroquery/blob/main/astroquery/hips2fits/core.py
  (`hips2fitsClass._args_to_payload`, leido el 2026-11-15). `query_with_wcs`
  manda `hips`, `format` y `wcs`, donde `wcs` es el JSON de
  `dict(wcs.to_header().items())` con `NAXIS1` y `NAXIS2` agregados. Aca se
  arma igual. `min_cut`, `max_cut`, `stretch` y `cmap`, que astroquery manda
  siempre, son segun su documentacion "only applicable to jpg/png output
  formats": no se mandan.
- URL del servicio y espejo: `astroquery/hips2fits/__init__.py`,
  https://alasky.cds.unistra.fr/hips-image-services/hips2fits y
  https://alaskybis.cds.unistra.fr/hips-image-services/hips2fits (mirror).
- Errores: `hips2fitsClass._parse_result` trata cualquier codigo distinto de
  200 como error, con un cuerpo JSON de claves `title` y `description`.
- Identificadores HiPS: lista del nodo HiPS de IRSA,
  https://irsa.ipac.caltech.edu/data/hips/list (fechada 2026-03-23), que
  espeja los de CDS: `creator_did = ivo://CDS/P/allWISE/W1`, "AllWISE W1
  (3.4um) from raw Atlas Images", y `ivo://CDS/P/allWISE/W2`, "AllWISE W2
  (4.6um) from raw Atlas Images". hips2fits recibe el identificador sin
  `ivo://` (los ejemplos de astroquery usan `CDS/P/DSS2/red`).
- Unidades y tipo: `properties` de ese HiPS,
  https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/W1/properties:
  `hips_pixel_bitpix = -32`, `hips_frame = equatorial`, `hips_pixel_scale =
  4.473E-4` grados (1.6"), `hips_pixel_cut = 0 400`. No declara unidades.
  Por el titulo ("from raw Atlas Images") serian las cuentas de las imagenes
  Atlas de AllWISE, no MJy/sr; el `BUNIT` del FITS que devuelva el servicio
  queda por mirar.

Lo que falta comprobar con una respuesta real: que el servicio acepta `wcs`
sin los parametros de contraste, que los identificadores son esos, que la
imagen vuelve con el WCS pedido y en que unidades. El sondeo lo muestra todo:

    uv run python scripts/probe_hips2fits.py --save tests/fixtures/preview

y con el FITS guardado ahi se activa el test que hoy se saltea
(`test_saved_real_response_is_a_plane_of_its_field`).

Como el servicio recibe el WCS exacto de la grilla, deberia devolver la imagen
ya en ella. Igual se comprueba: si la forma o el WCS devueltos no coinciden con
la grilla se reproyecta, y si no trae un WCS celeste se descarta.

La URL y los identificadores estan en `Settings` (`hips2fits_url`,
`preview_hips_w1`, `preview_hips_w2`) y se cambian con `SPHEREX_HIPS2FITS_URL`,
`SPHEREX_PREVIEW_HIPS_W1` y `SPHEREX_PREVIEW_HIPS_W2`.

Hilos: `fetch_preview` corre en un hilo por trabajo, a la par de los que arman
el campo. Por eso aca no se usa `warnings.catch_warnings` para callar los avisos
de astropy: guarda y repone la lista de filtros de todo el proceso, y con dos
hilos a la vez puede dejar puesto para siempre el filtro que apagaba los avisos.
Si una respuesta trae algo fuera del estandar, el aviso de astropy sale como
cualquier otro; lo que no se puede leer termina en `PreviewUnavailable`.
"""

from __future__ import annotations

import io
import json
import logging
import re
import threading
from dataclasses import dataclass
from typing import Literal

import numpy as np
import requests
import urllib3
from astropy.io import fits
from astropy.wcs import WCS
from numpy.typing import NDArray

from app.config import Settings
from app.contract import PreviewInfo, PreviewStatus
from app.domain import Grid, PreviewImage
from app.irsa import transport
from app.pipeline.stats import detector_display

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT_S = 5.0
# Un plano del escalon amplio en doble precision pesa 0.7 MB; mas que esto no es una respuesta esperable.
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
# Diferencia maxima, en pixeles, entre el WCS devuelto y la grilla para usar la imagen tal cual.
WCS_TOLERANCE_PX = 0.05

_CHUNK_BYTES = 65536
_FITS_SIGNATURE = b"SIMPLE  ="
_FITS_BLOCK = 2880


class PreviewUnavailable(Exception):
    """hips2fits no respondio a tiempo o devolvio algo que no sirve. No es un error del campo."""


def preview_band(band: int) -> tuple[Literal["W1", "W2"], float]:
    """Banda de WISE para la vista provisoria y su longitud de onda en micrones.

    W1 (3.4 um), o W2 (4.6 um) si el detector pedido es 5 o 6 (contrato,
    seccion 4.10). La vista se pide una sola vez, al crear el trabajo: queda con
    la banda de ese primer pedido aunque despues la persona cambie de banda.
    """
    return ("W2", 4.6) if band in (5, 6) else ("W1", 3.4)


def preview_hips(band: int, settings: Settings) -> str:
    """Identificador HiPS de la banda de WISE que le toca al detector pedido."""
    return settings.preview_hips_w2 if preview_band(band)[0] == "W2" else settings.preview_hips_w1


def preview_info(band: int, settings: Settings, status: PreviewStatus = "pending") -> PreviewInfo:
    """El bloque `preview` del documento de metadatos mientras no hay imagen: `pending` o `unavailable`."""
    name, wave_um = preview_band(band)
    return PreviewInfo(status=status, band=name, wave_um=wave_um, hips=preview_hips(band, settings))


def ready_preview_info(preview: PreviewImage) -> PreviewInfo:
    """El bloque `preview` con la imagen ya recibida: `ready` y su escala de contraste."""
    return PreviewInfo(
        status="ready",
        survey=preview.survey,
        band=preview.band,
        wave_um=preview.wave_um,
        hips=preview.hips,
        display=detector_display([preview.image]),
    )


# --------------------------------------------------------------------- pedido


def wcs_header(grid: Grid) -> dict[str, object]:
    """El WCS de la grilla como lo espera hips2fits: las tarjetas de `to_header()` mas `NAXIS1` y `NAXIS2`."""
    cards: dict[str, object] = dict(grid.wcs.to_header().items())
    ny, nx = grid.shape
    cards["NAXIS1"] = nx
    cards["NAXIS2"] = ny
    return cards


def request_params(grid: Grid, hips: str) -> dict[str, str]:
    """Parametros del pedido: el HiPS, salida FITS y el WCS exacto de la grilla."""
    return {"hips": hips, "format": "fits", "wcs": json.dumps(wcs_header(grid))}


@dataclass(frozen=True)
class Reply:
    """Lo que contesto el servicio, sin interpretar."""

    status: int
    content_type: str
    body: bytes
    location: str = ""  # destino, si contesto con una redireccion


def _get(url: str, params: dict[str, str], user_agent: str, timeout: float, deadline: transport.Deadline) -> Reply:
    """Un GET, sin reintentos ni redirecciones, leyendo el cuerpo contra el plazo `deadline`.

    El cuerpo se lee de a una lectura del socket por vez (`transport.read_some`),
    no de a tramos de tamano fijo: con `iter_content(65536)` el plazo se miraba
    recien al juntar 64 kB, y con un servidor que manda de a poco eso puede
    tardar mucho mas que el plazo. Cada lectura tiene como tope lo que queda.
    """
    with requests.get(
        url,
        params=params,
        headers={"User-Agent": user_agent},
        timeout=(deadline.cap(min(CONNECT_TIMEOUT_S, timeout)), deadline.cap(timeout)),
        stream=True,
        allow_redirects=False,
    ) as response:
        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = transport.read_some(response.raw, _CHUNK_BYTES, deadline, decode=True)
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                raise PreviewUnavailable(f"la respuesta pasa de {MAX_RESPONSE_BYTES} bytes")
            chunks.append(chunk)
        return Reply(
            status=response.status_code,
            content_type=response.headers.get("Content-Type", ""),
            body=b"".join(chunks),
            location=response.headers.get("Location", ""),
        )


def request_once(url: str, params: dict[str, str], settings: Settings) -> Reply:
    """El unico pedido a hips2fits, con `settings.preview_timeout_s` como tope de todo el intercambio.

    El timeout de `requests` vale para cada lectura del socket, no para el
    total: un servidor que manda de a poco podria pasarse. Por eso el cuerpo se
    lee contra un plazo (`_get`), y ademas el pedido corre en un hilo aparte al
    que se espera hasta el tope: resolver el nombre del servidor no tiene
    timeout en `requests`. Si el hilo no termino, se lo abandona; no queda
    colgado, porque cada lectura del socket tiene como tope lo que queda del
    plazo y la siguiente ya no se hace.
    """
    timeout = settings.preview_timeout_s
    deadline = transport.Deadline(timeout)
    box: list[Reply | BaseException] = []

    def work() -> None:
        try:
            box.append(_get(url, params, settings.user_agent, timeout, deadline))
        except BaseException as exc:
            box.append(exc)

    thread = threading.Thread(target=work, name="hips2fits", daemon=True)
    thread.start()
    thread.join(timeout)
    if not box:
        raise PreviewUnavailable(f"hips2fits no respondio en {timeout:g} s")
    result = box[0]
    if isinstance(result, PreviewUnavailable):
        raise result
    if isinstance(result, requests.ConnectTimeout):
        waited = min(CONNECT_TIMEOUT_S, timeout)
        raise PreviewUnavailable(f"no se pudo conectar con hips2fits en {waited:g} s") from result
    if isinstance(result, requests.Timeout | urllib3.exceptions.TimeoutError):
        # De `requests`, la demora hasta las cabeceras y el plazo total vencido; de urllib3,
        # un silencio mientras se leia el cuerpo.
        raise PreviewUnavailable(f"hips2fits no respondio en {timeout:g} s") from result
    if isinstance(result, BaseException):
        raise PreviewUnavailable(f"no se pudo consultar hips2fits: {type(result).__name__}: {result}") from result
    return result


def describe_error(reply: Reply) -> str:
    """Resumen de una respuesta que no sirve, para el mensaje de `PreviewUnavailable` y el log."""
    parts = [f"HTTP {reply.status}"]
    if reply.location:
        parts.append(f"redirige a {reply.location}")
    if reply.content_type:
        parts.append(reply.content_type)
    text = reply.body[:4000].decode("utf-8", errors="replace")
    detail = ""
    try:
        # Errores del servicio segun astroquery: JSON con `title` y `description`.
        document = json.loads(reply.body)
        if isinstance(document, dict) and "title" in document:
            detail = ": ".join(str(document[key]) for key in ("title", "description") if key in document)
    except ValueError:
        pass
    if not detail:
        # Pagina HTML (la de "Page unavailable" de CDS): alcanza con el titulo.
        title = re.search(r"<title[^>]*>(.*?)</title>", text, re.IGNORECASE | re.DOTALL)
        detail = " ".join((title.group(1) if title else text[:120]).split())
    if detail:
        parts.append(detail)
    return ", ".join(parts)


# ------------------------------------------------------------------ respuesta


def read_image(content: bytes) -> tuple[NDArray[np.float64], fits.Header]:
    """La primera imagen de dos dimensiones del FITS, en coma flotante con `NaN` sin datos, y su encabezado."""
    if not content.startswith(_FITS_SIGNATURE):
        raise PreviewUnavailable("la respuesta no es un archivo FITS")
    # Un FITS mide un multiplo de 2880 bytes. Lo cortado se descarta aca y mas abajo, antes de
    # leer los datos: astropy lo leeria igual, con un aviso por cada cosa que no le cierra.
    if len(content) % _FITS_BLOCK:
        raise PreviewUnavailable(f"el FITS esta cortado: {len(content)} bytes no son bloques enteros de {_FITS_BLOCK}")
    try:
        # Sin `warnings.catch_warnings`: no es seguro entre hilos (ver el encabezado del modulo).
        with fits.open(io.BytesIO(content), memmap=False) as hdul:
            for index, hdu in enumerate(hdul):
                info = hdul.fileinfo(index)
                if int(info["datLoc"]) + int(info["datSpan"]) > len(content):
                    raise PreviewUnavailable(f"el FITS esta cortado: faltan datos del HDU {index}")
                if not hdu.is_image or hdu.data is None:
                    continue
                raw = np.squeeze(np.asarray(hdu.data))
                if raw.ndim != 2:
                    continue
                data = raw.astype(np.float64)
                # Una imagen entera sin BSCALE conserva su valor BLANK: astropy no lo convierte.
                blank = hdu.header.get("BLANK")
                if raw.dtype.kind in "iu" and blank is not None:
                    data[raw == blank] = np.nan
                data[~np.isfinite(data)] = np.nan
                return data, hdu.header.copy()
    except PreviewUnavailable:
        raise
    except Exception as exc:
        raise PreviewUnavailable(f"no se pudo leer el FITS: {type(exc).__name__}: {exc}") from exc
    raise PreviewUnavailable("el FITS no trae ninguna imagen de dos dimensiones")


def wcs_offset_px(wcs: WCS, grid: Grid) -> float:
    """Cuanto se aparta, en pixeles, el WCS de la imagen recibida del de la grilla.

    Lleva el centro y las cuatro esquinas de la grilla al cielo y de ahi a
    pixeles de la imagen recibida: si los dos WCS son el mismo, cada punto
    vuelve a su pixel. Devuelve la mayor diferencia (infinito si algun punto no
    se puede proyectar).
    """
    ny, nx = grid.shape
    xs = np.array([0.0, nx - 1.0, 0.0, nx - 1.0, (nx - 1) / 2.0])
    ys = np.array([0.0, 0.0, ny - 1.0, ny - 1.0, (ny - 1) / 2.0])
    # `pixel_to_world` y `world_to_pixel` pasan por `SkyCoord`: si la imagen
    # viniera en otro sistema (galactico, FK5) la comparacion sigue valiendo.
    sky = grid.wcs.pixel_to_world(xs, ys)
    back_x, back_y = wcs.world_to_pixel(sky)
    offset = np.hypot(np.asarray(back_x) - xs, np.asarray(back_y) - ys)
    return float(offset.max()) if np.all(np.isfinite(offset)) else float("inf")


def decode_preview(content: bytes, grid: Grid) -> NDArray[np.float32]:
    """Interpreta la respuesta FITS y la deja en la grilla del campo.

    Devuelve Float32 de `grid.shape`, fila 0 = sur, `NaN` sin datos. Si la
    imagen no vino exactamente en la grilla (otra forma u otro WCS) la
    reproyecta. Lanza `PreviewUnavailable` si no es FITS, no trae un WCS
    celeste contra el cual comprobar la orientacion, o no queda ningun pixel
    con datos.
    """
    data, header = read_image(content)
    try:
        wcs = WCS(header).celestial
    except Exception as exc:
        raise PreviewUnavailable(f"el WCS del FITS no se puede interpretar: {type(exc).__name__}: {exc}") from exc
    if not wcs.has_celestial:
        raise PreviewUnavailable("el FITS no trae un WCS celeste: no se puede comprobar contra la grilla")

    try:
        offset = wcs_offset_px(wcs, grid)
        if data.shape != grid.shape or offset > WCS_TOLERANCE_PX:
            logger.warning(
                "hips2fits no devolvio la grilla pedida (forma %s, corrimiento %.3g px): se reproyecta",
                data.shape,
                offset,
            )
            # `reproject` tarda en importarse y este camino no es el normal.
            from reproject import reproject_interp

            data, _footprint = reproject_interp((data, wcs), grid.wcs, shape_out=grid.shape, order="bilinear")
    except PreviewUnavailable:
        raise
    except Exception as exc:
        raise PreviewUnavailable(f"no se pudo llevar la imagen a la grilla: {type(exc).__name__}: {exc}") from exc

    image = np.ascontiguousarray(data, dtype=np.float32)
    image[~np.isfinite(image)] = np.nan
    if not np.isfinite(image).any():
        raise PreviewUnavailable("la imagen no trae ningun pixel con datos en el campo")
    return image


def fetch_preview(grid: Grid, band: int, settings: Settings) -> PreviewImage:
    """Pide a hips2fits un recorte de WISE con la grilla del campo.

    - Misma proyeccion, centro, escala y forma que `grid`, para que el
      resultado tenga el formato de un plano: Float32 de `grid.shape`, fila 0 =
      sur, `NaN` sin datos. Los valores quedan en las unidades del relevamiento.
    - Banda segun `preview_band(band)`.
    - Un solo pedido, con timeout `settings.preview_timeout_s`. Se consulta
      desde el backend, nunca desde el navegador.

    Lanza `PreviewUnavailable` si el servicio no responde a tiempo o la
    respuesta no se puede interpretar. Es la unica excepcion que sale de aca:
    la vista provisoria es opcional y nunca hace fallar al campo. Bloquea hasta
    `settings.preview_timeout_s`; desde codigo `async` va en un hilo.
    """
    name, wave_um = preview_band(band)
    hips = preview_hips(band, settings)
    try:
        reply = request_once(settings.hips2fits_url, request_params(grid, hips), settings)
        if reply.status != 200:
            raise PreviewUnavailable(f"hips2fits no devolvio la imagen: {describe_error(reply)}")
        if not reply.body.startswith(_FITS_SIGNATURE):
            raise PreviewUnavailable(f"hips2fits no devolvio un FITS: {describe_error(reply)}")
        image = decode_preview(reply.body, grid)
    except PreviewUnavailable:
        raise
    except Exception as exc:
        raise PreviewUnavailable(f"fallo inesperado al pedir la vista provisoria: {type(exc).__name__}: {exc}") from exc
    return PreviewImage(image=image, band=name, wave_um=wave_um, hips=hips)
