"""Vista provisoria de WISE (contrato, seccion 4.10): eleccion de la banda y pedido a hips2fits.

Sin red. hips2fits es un servidor HTTP local en 127.0.0.1 que arma un FITS con
astropy: el dia que se escribio esto (2026-11-15) el servicio real estaba caido
y no hay ninguna respuesta suya guardada, salvo la pagina de error
(tests/fixtures/preview/cds_page_unavailable.html). El servidor local hace lo
que la documentacion de astroquery dice que hace el real: recibe `hips`,
`format` y `wcs` y devuelve la imagen con ese WCS.
"""

from __future__ import annotations

import io
import json
import socket
import threading
import time
import warnings
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import numpy as np
import pytest
import requests
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS

from app import geometry
from app.config import Settings
from app.contract import GridInfo
from app.domain import Grid, PreviewImage
from app.preview import hips2fits
from app.preview.hips2fits import (
    PreviewUnavailable,
    decode_preview,
    fetch_preview,
    preview_band,
    preview_hips,
    preview_info,
    ready_preview_info,
    request_params,
    wcs_header,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"
CDS_DOWN_HTML = (FIXTURES / "preview" / "cds_page_unavailable.html").read_bytes()

# Campo base de WISE 0855 (SPEC.md): 195 x 195 px de 3.075".
RA, DEC = 133.7598, -7.2422
BACKGROUND = 10.0
# Dos fuentes, en pixeles de la grilla (x, y): la brillante al noreste del centro, la debil al suroeste.
BRIGHT_PIXEL, FAINT_PIXEL = (60, 140), (150, 30)


@pytest.fixture(scope="module")
def grid() -> Grid:
    return geometry.make_grid(RA, DEC, 0.1667, 3.075)


@pytest.mark.parametrize(
    ("band", "expected"),
    [(1, ("W1", 3.4)), (2, ("W1", 3.4)), (3, ("W1", 3.4)), (4, ("W1", 3.4)), (5, ("W2", 4.6)), (6, ("W2", 4.6))],
)
def test_preview_band_is_w2_only_for_the_two_longest_detectors(band: int, expected: tuple[str, float]) -> None:
    assert preview_band(band) == expected


def test_defaults_come_from_the_documented_sources() -> None:
    """URL de astroquery.hips2fits e identificadores de la lista HiPS de IRSA. Sin verificar contra el servicio."""
    settings = Settings()
    assert settings.hips2fits_url == "https://alasky.cds.unistra.fr/hips-image-services/hips2fits"
    assert [preview_hips(band, settings) for band in (1, 4, 5, 6)] == [
        "CDS/P/allWISE/W1",
        "CDS/P/allWISE/W1",
        "CDS/P/allWISE/W2",
        "CDS/P/allWISE/W2",
    ]
    assert settings.preview_timeout_s == 20.0


def test_service_and_surveys_can_be_changed_from_the_environment() -> None:
    """Por si el identificador o la URL resultan ser otros cuando el servicio vuelva, o para usar el espejo."""
    settings = Settings.from_env(
        {
            "SPHEREX_HIPS2FITS_URL": "https://alaskybis.cds.unistra.fr/hips-image-services/hips2fits",
            "SPHEREX_PREVIEW_HIPS_W1": "otro/relevamiento/W1",  # un texto cualquiera, no un identificador real
            "SPHEREX_PREVIEW_TIMEOUT_S": "8",
        }
    )
    assert settings.hips2fits_url == "https://alaskybis.cds.unistra.fr/hips-image-services/hips2fits"
    assert preview_hips(3, settings) == "otro/relevamiento/W1" and preview_hips(6, settings) == "CDS/P/allWISE/W2"
    assert settings.preview_timeout_s == 8.0


def test_preview_info_before_the_image_arrives() -> None:
    settings = Settings(preview_hips_w2="otro/W2")
    pending = preview_info(3, settings)
    assert pending.model_dump() == {
        "status": "pending",
        "survey": "WISE",
        "band": "W1",
        "wave_um": 3.4,
        "hips": "CDS/P/allWISE/W1",
        "display": None,
    }
    lost = preview_info(6, settings, "unavailable")
    assert (lost.status, lost.band, lost.wave_um, lost.hips) == ("unavailable", "W2", 4.6, "otro/W2")
    assert lost.display is None


def test_wcs_header_is_the_grid_plus_the_image_size(grid: Grid) -> None:
    """Como `hips2fitsClass._args_to_payload` de astroquery: `to_header()` mas NAXIS1 y NAXIS2."""
    cards = wcs_header(grid)
    assert cards["NAXIS1"] == 195 and cards["NAXIS2"] == 195
    assert (cards["CTYPE1"], cards["CTYPE2"]) == ("RA---TAN", "DEC--TAN")
    assert (cards["CRVAL1"], cards["CRVAL2"]) == (RA, DEC)
    assert (cards["CRPIX1"], cards["CRPIX2"]) == (98.0, 98.0)
    assert cards["CDELT1"] == pytest.approx(-3.075 / 3600.0) and cards["CDELT2"] == pytest.approx(3.075 / 3600.0)
    assert set(dict(grid.wcs.to_header().items())) | {"NAXIS1", "NAXIS2"} == set(cards)

    params = request_params(grid, "CDS/P/allWISE/W1")
    assert set(params) == {"hips", "format", "wcs"}
    assert params["hips"] == "CDS/P/allWISE/W1" and params["format"] == "fits"
    assert json.loads(params["wcs"]) == cards
    # El WCS que viaja reconstruye la grilla.
    rebuilt = WCS(fits.Header(json.loads(params["wcs"])))
    assert hips2fits.wcs_offset_px(rebuilt, grid) < 1e-6

    wide = geometry.make_grid(RA, DEC, 0.5, 6.15)
    assert (wcs_header(wide)["NAXIS1"], wcs_header(wide)["NAXIS2"]) == (293, 293)


# ------------------------------------------------------------- cielo de prueba


def render(wcs: WCS, shape: tuple[int, int], grid: Grid, *, dtype: type = np.float32) -> np.ndarray:
    """Imagen de `shape` con el WCS dado: fondo plano y dos fuentes puestas por su posicion en el cielo."""
    yy, xx = np.indices(shape, dtype=np.float64)
    scale = float(np.sqrt(np.abs(np.linalg.det(wcs.pixel_scale_matrix)))) * 3600.0
    sigma_px = 5.0 / scale  # fuentes de 5" de sigma, sea cual sea la escala de la imagen
    image = np.full(shape, BACKGROUND, dtype=np.float64)
    for (px, py), flux in ((BRIGHT_PIXEL, 500.0), (FAINT_PIXEL, 80.0)):
        sky = grid.wcs.pixel_to_world(float(px), float(py))
        x, y = wcs.world_to_pixel(sky)
        image += flux * np.exp(-((xx - float(x)) ** 2 + (yy - float(y)) ** 2) / (2.0 * sigma_px**2))
    return image.astype(dtype)


def to_fits(data: np.ndarray | None, wcs: WCS | None = None, **cards: object) -> bytes:
    header = wcs.to_header() if wcs is not None else fits.Header()
    for key, value in cards.items():
        header[key] = value
    buffer = io.BytesIO()
    fits.PrimaryHDU(data=data, header=header).writeto(buffer)
    return buffer.getvalue()


def tan_wcs(
    ra: float, dec: float, shape: tuple[int, int], scale_arcsec: float, *, east_left: bool = True, north_up: bool = True
) -> WCS:
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [ra, dec]
    wcs.wcs.crpix = [(shape[1] + 1) / 2.0, (shape[0] + 1) / 2.0]
    step = scale_arcsec / 3600.0
    wcs.wcs.cdelt = [-step if east_left else step, step if north_up else -step]
    return wcs


# ------------------------------------------------------------------ servidor


@dataclass
class Canned:
    """Respuesta que da el servidor local."""

    status: int = 200
    body: bytes = b""
    content_type: str = "application/fits"
    headers: dict[str, str] = field(default_factory=dict)
    delay: float = 0.0  # espera antes de contestar
    trickle: tuple[int, float] | None = None  # (bytes por tramo, pausa): manda el cuerpo de a poco


class LocalHips2fits:
    """Servidor HTTP en 127.0.0.1 que hace de hips2fits. Anota los parametros de cada pedido."""

    def __init__(self, responder: Callable[[dict[str, str]], Canned]) -> None:
        self.queries: list[dict[str, str]] = []
        self.user_agents: list[str] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                params = dict(parse_qsl(urlsplit(self.path).query))
                outer.queries.append(params)
                outer.user_agents.append(self.headers.get("User-Agent", ""))
                canned = responder(params)
                if canned.delay:
                    time.sleep(canned.delay)
                try:
                    self.send_response(canned.status)
                    self.send_header("Content-Type", canned.content_type)
                    self.send_header("Content-Length", str(len(canned.body)))
                    for key, value in canned.headers.items():
                        self.send_header(key, value)
                    self.end_headers()
                    if canned.trickle is None:
                        self.wfile.write(canned.body)
                    else:
                        size, pause = canned.trickle
                        for start in range(0, len(canned.body), size):
                            self.wfile.write(canned.body[start : start + size])
                            self.wfile.flush()
                            time.sleep(pause)
                except OSError:
                    pass  # el cliente ya corto

            def log_message(self, *_args: object) -> None:
                pass

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._httpd.daemon_threads = True
        threading.Thread(target=self._httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._httpd.server_address[1]}/hips-image-services/hips2fits"

    def close(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()


Responder = Callable[[dict[str, str]], Canned]
ServerFactory = Callable[[Responder | Canned], LocalHips2fits]


@pytest.fixture
def serve(monkeypatch: pytest.MonkeyPatch) -> Iterator[ServerFactory]:
    """Crea servidores locales y los cierra al terminar el test."""
    # Si la maquina tiene un proxy configurado, que no se use para 127.0.0.1.
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    servers: list[LocalHips2fits] = []

    def factory(responder: Responder | Canned) -> LocalHips2fits:
        server = LocalHips2fits((lambda _params: responder) if isinstance(responder, Canned) else responder)
        servers.append(server)
        return server

    yield factory
    for server in servers:
        server.close()


def honest_service(grid: Grid) -> Responder:
    """Un hips2fits que hace lo documentado: devuelve la imagen con el WCS y el tamano que le pidieron."""

    def responder(params: dict[str, str]) -> Canned:
        cards = json.loads(params["wcs"])
        shape = (int(cards.pop("NAXIS2")), int(cards.pop("NAXIS1")))
        wcs = WCS(fits.Header(cards))
        return Canned(body=to_fits(render(wcs, shape, grid), wcs))

    return responder


def settings_for(url: str, timeout: float = 5.0) -> Settings:
    return Settings(hips2fits_url=url, preview_timeout_s=timeout)


def closed_url() -> str:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    return f"http://127.0.0.1:{port}/hips-image-services/hips2fits"


def brightest(image: np.ndarray) -> tuple[int, int]:
    """Pixel `(x, y)` del maximo."""
    y, x = np.unravel_index(int(np.nanargmax(image)), image.shape)
    return int(x), int(y)


def assert_oriented_like_the_grid(image: np.ndarray, grid: Grid, tolerance: int = 0) -> None:
    """Forma de un plano y las dos fuentes donde las pone la grilla: fila 0 = sur, columna 0 = este."""
    assert image.shape == grid.shape and image.dtype == np.float32 and image.flags.c_contiguous
    x, y = brightest(image)
    assert abs(x - BRIGHT_PIXEL[0]) <= tolerance and abs(y - BRIGHT_PIXEL[1]) <= tolerance
    # La fuente brillante quedo al norte (fila alta) y al este (columna baja) del centro.
    assert y > grid.shape[0] // 2 and x < grid.shape[1] // 2
    faint_x, faint_y = FAINT_PIXEL
    window = image[faint_y - 3 : faint_y + 4, faint_x - 3 : faint_x + 4]
    assert np.nanmax(window) > BACKGROUND + 40.0  # la debil, al suroeste
    assert image[faint_x, faint_y] < BACKGROUND + 1.0  # y no en la posicion traspuesta


# ------------------------------------------------------------- respuesta buena


def test_good_response_is_a_plane_of_the_field(grid: Grid, serve: ServerFactory) -> None:
    server = serve(honest_service(grid))
    settings = settings_for(server.url)

    preview = fetch_preview(grid, 3, settings)

    assert isinstance(preview, PreviewImage)
    assert (preview.band, preview.wave_um, preview.hips, preview.survey) == ("W1", 3.4, "CDS/P/allWISE/W1", "WISE")
    assert_oriented_like_the_grid(preview.image, grid)
    # La imagen es la que mando el servicio, sin tocar: ya venia en la grilla.
    np.testing.assert_array_equal(preview.image, render(grid.wcs, grid.shape, grid))
    assert np.isfinite(preview.image).all()

    # Un solo pedido, con los tres parametros documentados y el User-Agent del backend.
    assert len(server.queries) == 1
    assert server.queries[0] == request_params(grid, "CDS/P/allWISE/W1")
    assert server.user_agents == [settings.user_agent]


@pytest.mark.parametrize(("band", "name", "hips"), [(5, "W2", "CDS/P/allWISE/W2"), (6, "W2", "CDS/P/allWISE/W2")])
def test_the_two_longest_detectors_ask_for_w2(
    grid: Grid, serve: ServerFactory, band: int, name: str, hips: str
) -> None:
    server = serve(honest_service(grid))
    preview = fetch_preview(grid, band, settings_for(server.url))
    assert (preview.band, preview.wave_um, preview.hips) == (name, 4.6, hips)
    assert server.queries[0]["hips"] == hips


def test_the_wide_step_has_its_own_shape(serve: ServerFactory) -> None:
    wide = geometry.make_grid(RA, DEC, 0.5, 6.15)
    server = serve(honest_service(wide))
    preview = fetch_preview(wide, 1, settings_for(server.url))
    assert preview.image.shape == (293, 293) and brightest(preview.image) == BRIGHT_PIXEL


def test_ready_preview_info_has_the_display_scale(grid: Grid, serve: ServerFactory) -> None:
    server = serve(honest_service(grid))
    info = ready_preview_info(fetch_preview(grid, 6, settings_for(server.url)))
    assert (info.status, info.survey, info.band, info.wave_um, info.hips) == (
        "ready", "WISE", "W2", 4.6, "CDS/P/allWISE/W2",
    )  # fmt: skip
    assert info.display is not None
    assert info.display.median == pytest.approx(BACKGROUND, abs=0.5)
    assert info.display.vmin < BACKGROUND < info.display.vmax


def test_pixels_without_data_are_nan(grid: Grid, serve: ServerFactory) -> None:
    data = render(grid.wcs, grid.shape, grid)
    data[0:20, :] = np.nan  # franja sur sin datos
    data[100, 100] = np.inf
    data[101, 100] = -np.inf
    server = serve(Canned(body=to_fits(data, grid.wcs)))

    image = fetch_preview(grid, 3, settings_for(server.url)).image

    assert np.isnan(image[0:20, :]).all() and np.isnan(image[100, 100]) and np.isnan(image[101, 100])
    assert np.isfinite(image[20:, :]).sum() == image[20:, :].size - 2
    assert not np.isinf(image).any()


def test_integer_image_with_blank(grid: Grid, serve: ServerFactory) -> None:
    data = np.round(render(grid.wcs, grid.shape, grid)).astype(np.int16)
    data[0:5, 0:7] = -32768
    server = serve(Canned(body=to_fits(data, grid.wcs, BLANK=-32768)))
    image = fetch_preview(grid, 3, settings_for(server.url)).image
    assert image.dtype == np.float32 and np.isnan(image[0:5, 0:7]).all()
    assert np.isfinite(image).sum() == image.size - 35 and brightest(image) == BRIGHT_PIXEL


def test_scaled_integer_image(grid: Grid, serve: ServerFactory) -> None:
    """Con BSCALE y BZERO los valores llegan ya en sus unidades."""
    data = render(grid.wcs, grid.shape, grid, dtype=np.float64)
    buffer = io.BytesIO()
    hdu = fits.PrimaryHDU(data=data.copy(), header=grid.wcs.to_header())  # `scale` modifica el arreglo
    hdu.scale("int16", bscale=0.05, bzero=500.0)
    hdu.writeto(buffer)
    server = serve(Canned(body=buffer.getvalue()))
    image = fetch_preview(grid, 3, settings_for(server.url)).image
    np.testing.assert_allclose(image, data, atol=0.05)


def test_image_with_a_degenerate_third_axis(grid: Grid, serve: ServerFactory) -> None:
    data = render(grid.wcs, grid.shape, grid)[np.newaxis, :, :]
    server = serve(Canned(body=to_fits(data, grid.wcs)))
    assert_oriented_like_the_grid(fetch_preview(grid, 3, settings_for(server.url)).image, grid)


# ----------------------------------------------- otra forma u otra orientacion


def test_fits_of_another_shape_is_reprojected(grid: Grid, serve: ServerFactory) -> None:
    """El servicio ignora el WCS pedido: otra escala, otro tamano, corrido y con el norte abajo."""
    shape = (300, 320)
    other = tan_wcs(RA + 0.004, DEC - 0.003, shape, 2.5, north_up=False)
    server = serve(Canned(body=to_fits(render(other, shape, grid), other)))

    image = fetch_preview(grid, 3, settings_for(server.url)).image

    assert_oriented_like_the_grid(image, grid, tolerance=1)
    assert np.isfinite(image).all()  # la imagen recibida cubre todo el campo
    assert np.nanmedian(image) == pytest.approx(BACKGROUND, abs=0.1)
    assert len(server.queries) == 1


@pytest.mark.parametrize(("east_left", "north_up"), [(False, True), (True, False), (False, False)])
def test_same_shape_but_mirrored_is_reprojected(
    grid: Grid, serve: ServerFactory, east_left: bool, north_up: bool
) -> None:
    """La forma coincide pero la imagen viene espejada: sin mirar el WCS quedaria al reves."""
    mirrored = tan_wcs(RA, DEC, grid.shape, 3.075, east_left=east_left, north_up=north_up)
    served = render(mirrored, grid.shape, grid)
    assert brightest(served) != BRIGHT_PIXEL
    server = serve(Canned(body=to_fits(served, mirrored)))
    assert_oriented_like_the_grid(fetch_preview(grid, 3, settings_for(server.url)).image, grid, tolerance=1)


def test_image_in_galactic_coordinates_is_reprojected(grid: Grid, serve: ServerFactory) -> None:
    center = SkyCoord(RA, DEC, unit="deg", frame="icrs").galactic
    shape = (380, 380)
    galactic = WCS(naxis=2)
    galactic.wcs.ctype = ["GLON-TAN", "GLAT-TAN"]
    galactic.wcs.crval = [float(center.l.deg), float(center.b.deg)]
    galactic.wcs.crpix = [190.5, 190.5]
    galactic.wcs.cdelt = [-2.5 / 3600.0, 2.5 / 3600.0]
    server = serve(Canned(body=to_fits(render(galactic, shape, grid), galactic)))

    image = fetch_preview(grid, 3, settings_for(server.url)).image

    assert_oriented_like_the_grid(image, grid, tolerance=1)
    assert np.isfinite(image).all()


def test_image_that_covers_part_of_the_field_keeps_nan_outside(grid: Grid, serve: ServerFactory) -> None:
    """Una imagen mas chica que el campo, centrada en la fuente brillante: el resto queda sin datos."""
    ra, dec = geometry.pixel_to_sky(grid, *map(float, BRIGHT_PIXEL))
    shape = (61, 61)
    small = tan_wcs(ra, dec, shape, 3.075)
    server = serve(Canned(body=to_fits(render(small, shape, grid), small)))

    image = fetch_preview(grid, 3, settings_for(server.url)).image

    assert image.shape == grid.shape and brightest(image) == BRIGHT_PIXEL
    assert 0.08 < np.isfinite(image).mean() < 0.11  # 61 x 61 de 195 x 195
    assert np.isnan(image[FAINT_PIXEL[1], FAINT_PIXEL[0]]) and np.isnan(image[0, 0])


def test_a_tiny_wcs_difference_is_not_reprojected(grid: Grid) -> None:
    """Redondeo en el encabezado devuelto: milesimas de pixel. La imagen se usa tal cual."""
    nearly = grid.wcs.deepcopy()
    nearly.wcs.crval = [RA + 1e-7, DEC - 1e-7]
    data = render(grid.wcs, grid.shape, grid)
    np.testing.assert_array_equal(decode_preview(to_fits(data, nearly), grid), data)
    assert hips2fits.wcs_offset_px(nearly, grid) < hips2fits.WCS_TOLERANCE_PX
    # Medio pixel de corrimiento si se corrige.
    shifted = grid.wcs.deepcopy()
    shifted.wcs.crpix = [98.5, 98.0]
    assert hips2fits.wcs_offset_px(shifted, grid) == pytest.approx(0.5, abs=1e-6)
    corrected = decode_preview(to_fits(data, shifted), grid)
    assert not np.array_equal(corrected, data, equal_nan=True)


@pytest.mark.parametrize("shape", [(195, 195), (120, 300)])
def test_fits_without_wcs_is_discarded(grid: Grid, serve: ServerFactory, shape: tuple[int, int]) -> None:
    """Sin WCS no se puede saber si la imagen esta en la grilla, aunque la forma coincida."""
    server = serve(Canned(body=to_fits(np.ones(shape, dtype=np.float32))))
    with pytest.raises(PreviewUnavailable, match="WCS"):
        fetch_preview(grid, 3, settings_for(server.url))


def test_image_of_another_part_of_the_sky_is_discarded(grid: Grid, serve: ServerFactory) -> None:
    elsewhere = tan_wcs(RA + 5.0, DEC, grid.shape, 3.075)
    server = serve(Canned(body=to_fits(np.ones(grid.shape, dtype=np.float32), elsewhere)))
    with pytest.raises(PreviewUnavailable, match="ningun pixel"):
        fetch_preview(grid, 3, settings_for(server.url))


# ------------------------------------------------------------------ sin vista


def test_all_nan_is_unavailable(grid: Grid, serve: ServerFactory) -> None:
    server = serve(Canned(body=to_fits(np.full(grid.shape, np.nan, dtype=np.float32), grid.wcs)))
    with pytest.raises(PreviewUnavailable, match="ningun pixel"):
        fetch_preview(grid, 3, settings_for(server.url))
    assert len(server.queries) == 1


def test_slow_service_times_out(grid: Grid, serve: ServerFactory) -> None:
    """El servicio tarda mas que `preview_timeout_s` en contestar: sin vista, sin reintento."""
    server = serve(Canned(body=to_fits(render(grid.wcs, grid.shape, grid), grid.wcs), delay=4.0))
    started = time.perf_counter()
    with pytest.raises(PreviewUnavailable, match=r"no respondio en 0\.4 s"):
        fetch_preview(grid, 3, settings_for(server.url, timeout=0.4))
    assert time.perf_counter() - started < 3.0  # el tope de 0.4 s, no los 4 s del servicio
    assert len(server.queries) == 1


def test_service_that_sends_the_body_too_slowly_times_out(grid: Grid, serve: ServerFactory) -> None:
    """Contesta enseguida pero manda la imagen de a poco: el tope es para todo el intercambio."""
    body = to_fits(render(grid.wcs, grid.shape, grid), grid.wcs)
    server = serve(Canned(body=body, trickle=(2048, 0.1)))  # 76 tramos: casi 8 s
    started = time.perf_counter()
    with pytest.raises(PreviewUnavailable):
        fetch_preview(grid, 3, settings_for(server.url, timeout=0.5))
    assert time.perf_counter() - started < 3.0
    assert len(server.queries) == 1


def request_threads() -> set[threading.Thread]:
    """Los hilos de pedidos a hips2fits que siguen vivos."""
    return {thread for thread in threading.enumerate() if thread.name == "hips2fits" and thread.is_alive()}


@pytest.mark.parametrize("piece", [1000, 20_000], ids=["de_a_1_kB", "de_a_20_kB"])
def test_the_abandoned_request_stops_reading_at_the_deadline(grid: Grid, serve: ServerFactory, piece: int) -> None:
    """Vencido el tope, el hilo del pedido no sigue leyendo: no queda con su conexion abierta.

    Leyendo de a tramos fijos de 64 kB el plazo se miraba recien al completar
    cada tramo; con un servidor que manda 1 kB cada 0,1 s, eso son 6,5 s mas.
    """
    body = to_fits(render(grid.wcs, grid.shape, grid), grid.wcs)
    assert len(body) > 150_000
    server = serve(Canned(body=body, trickle=(piece, 0.1)))  # 1 kB cada 0,1 s: 15 s; 20 kB: 0,8 s
    before = request_threads()
    started = time.perf_counter()
    with pytest.raises(PreviewUnavailable, match=r"no respondio en 0\.5 s"):
        fetch_preview(grid, 3, settings_for(server.url, timeout=0.5))
    while request_threads() - before and time.perf_counter() - started < 2.0:
        time.sleep(0.02)
    assert request_threads() - before == set(), "el hilo del pedido sigue leyendo despues del tope"
    assert time.perf_counter() - started < 2.0 and len(server.queries) == 1


def test_all_the_preview_fits_when_it_arrives_slowly_but_in_time(grid: Grid, serve: ServerFactory) -> None:
    """Leer de a una lectura del socket no pierde ni repite nada: la imagen llega entera."""
    body = to_fits(render(grid.wcs, grid.shape, grid), grid.wcs)
    server = serve(Canned(body=body, trickle=(7001, 0.005)))
    preview = fetch_preview(grid, 3, settings_for(server.url, timeout=10.0))
    assert np.array_equal(preview.image, render(grid.wcs, grid.shape, grid), equal_nan=True)


def test_connection_timeout_says_so(grid: Grid, monkeypatch: pytest.MonkeyPatch) -> None:
    """No poder conectar no es lo mismo que no recibir respuesta en `preview_timeout_s`: el mensaje lo distingue."""

    def unreachable(*_args: object, **_kwargs: object) -> None:
        raise requests.ConnectTimeout("no hay ruta")

    monkeypatch.setattr(hips2fits.requests, "get", unreachable)
    with pytest.raises(PreviewUnavailable, match=r"no se pudo conectar con hips2fits en 5 s"):
        fetch_preview(grid, 3, settings_for("http://127.0.0.1:9/hips2fits", timeout=20.0))
    with pytest.raises(PreviewUnavailable, match=r"no se pudo conectar con hips2fits en 0\.5 s"):
        fetch_preview(grid, 3, settings_for("http://127.0.0.1:9/hips2fits", timeout=0.5))


def test_decoding_from_many_threads_leaves_the_warning_filters_alone(grid: Grid) -> None:
    """`warnings.catch_warnings` no es seguro entre hilos: usado aca, podia dejar apagados los avisos del proceso."""
    body = to_fits(render(grid.wcs, grid.shape, grid), grid.wcs)
    expected = hips2fits.decode_preview(body, grid)
    before = list(warnings.filters)
    with ThreadPoolExecutor(max_workers=8) as pool:
        images = list(pool.map(lambda _: hips2fits.decode_preview(body, grid), range(64)))
    assert warnings.filters == before
    assert all(np.array_equal(image, expected, equal_nan=True) for image in images)
    with pytest.warns(UserWarning, match="de prueba"):
        warnings.warn("de prueba", UserWarning, stacklevel=1)


@pytest.mark.parametrize("status", [404, 200])
def test_html_error_page_is_unavailable(grid: Grid, serve: ServerFactory, status: int) -> None:
    """La pagina "Page unavailable" de CDS, con 404 (como el 2026-11-15) o con 200."""
    server = serve(Canned(status=status, body=CDS_DOWN_HTML, content_type="text/html"))
    with pytest.raises(PreviewUnavailable) as caught:
        fetch_preview(grid, 3, settings_for(server.url))
    message = str(caught.value)
    assert f"HTTP {status}" in message and "Page unavailable" in message and "text/html" in message
    assert len(server.queries) == 1


def test_json_error_of_the_service_is_unavailable(grid: Grid, serve: ServerFactory) -> None:
    """Formato de error segun astroquery (`_parse_result`): JSON con `title` y `description`. El texto es inventado."""
    body = json.dumps({"title": "Bad Request", "description": "texto de prueba"}).encode()
    server = serve(Canned(status=400, body=body, content_type="application/json"))
    with pytest.raises(PreviewUnavailable, match=r"HTTP 400.*Bad Request: texto de prueba"):
        fetch_preview(grid, 3, settings_for(server.url))


def test_busy_service_is_not_retried(grid: Grid, serve: ServerFactory) -> None:
    server = serve(Canned(status=503, body=b"busy", content_type="text/plain", headers={"Retry-After": "1"}))
    with pytest.raises(PreviewUnavailable, match="HTTP 503"):
        fetch_preview(grid, 3, settings_for(server.url))
    assert len(server.queries) == 1


def test_redirect_is_not_followed(grid: Grid, serve: ServerFactory) -> None:
    """CDS caido tambien redirige a su pagina de aviso: es un solo pedido, no se sigue."""
    target = serve(Canned(body=CDS_DOWN_HTML, content_type="text/html"))
    server = serve(Canned(status=302, headers={"Location": target.url}, content_type="text/html"))
    with pytest.raises(PreviewUnavailable, match=r"HTTP 302.*redirige a"):
        fetch_preview(grid, 3, settings_for(server.url))
    assert len(server.queries) == 1 and target.queries == []


def test_unreachable_service_is_unavailable(grid: Grid) -> None:
    started = time.perf_counter()
    with pytest.raises(PreviewUnavailable):
        fetch_preview(grid, 3, settings_for(closed_url(), timeout=0.5))
    assert time.perf_counter() - started < 3.0


@pytest.mark.parametrize("url", ["no-es-una-url", "http://", "ftp://127.0.0.1/hips2fits"])
def test_bad_url_is_unavailable(grid: Grid, url: str) -> None:
    with pytest.raises(PreviewUnavailable):
        fetch_preview(grid, 3, settings_for(url, timeout=0.5))


# Con el encabezado entero y sin datos, astropy avisa al abrirlo que el archivo parece cortado. El
# aviso se deja salir (el modulo no toca los filtros del proceso); aca se sabe que viene.
@pytest.mark.filterwarnings("ignore:File may have been truncated")
def test_truncated_fits_is_unavailable(grid: Grid, serve: ServerFactory) -> None:
    body = to_fits(render(grid.wcs, grid.shape, grid), grid.wcs)
    for cut in (1000, 2880, 50000):
        server = serve(Canned(body=body[:cut]))
        with pytest.raises(PreviewUnavailable, match="esta cortado"):
            fetch_preview(grid, 3, settings_for(server.url))


def test_fits_without_an_image_is_unavailable(grid: Grid, serve: ServerFactory) -> None:
    server = serve(Canned(body=to_fits(None)))
    with pytest.raises(PreviewUnavailable, match="ninguna imagen"):
        fetch_preview(grid, 3, settings_for(server.url))
    cube = np.ones((3, 195, 195), dtype=np.float32)  # tres planos: no se sabe cual usar
    server = serve(Canned(body=to_fits(cube, grid.wcs)))
    with pytest.raises(PreviewUnavailable, match="ninguna imagen"):
        fetch_preview(grid, 3, settings_for(server.url))


def test_empty_answer_is_unavailable(grid: Grid, serve: ServerFactory) -> None:
    server = serve(Canned(body=b""))
    with pytest.raises(PreviewUnavailable, match="no devolvio un FITS"):
        fetch_preview(grid, 3, settings_for(server.url))


def test_any_other_failure_is_also_preview_unavailable(
    grid: Grid, serve: ServerFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """La vista es opcional: de `fetch_preview` no sale ninguna otra excepcion."""
    server = serve(honest_service(grid))

    def broken(_content: bytes, _grid: Grid) -> np.ndarray:
        raise RuntimeError("falla que nadie previo")

    monkeypatch.setattr(hips2fits, "decode_preview", broken)
    with pytest.raises(PreviewUnavailable, match="falla que nadie previo"):
        fetch_preview(grid, 3, settings_for(server.url))


# ------------------------------------------------ respuestas reales guardadas

REAL_RESPONSES = sorted((FIXTURES / "preview").glob("*.fits"))


@pytest.mark.skipif(
    not REAL_RESPONSES,
    reason="no hay ninguna respuesta real de hips2fits guardada (el servicio estaba caido el 2026-11-15); "
    "se guardan con scripts/probe_hips2fits.py --save tests/fixtures/preview",
)
@pytest.mark.parametrize("path", REAL_RESPONSES or [None], ids=lambda path: path.name if path else "ninguna")
def test_saved_real_response_is_a_plane_of_its_field(path: Path) -> None:
    """Cada FITS real guardado por el sondeo, contra la grilla con la que se pidio (esta en su `.json`).

    Es la verificacion que quedo pendiente: que el servicio devuelve la imagen
    en el WCS pedido (sin reproyectar), con datos y con la orientacion de un plano.
    """
    report = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
    grid = geometry.grid_from_info(GridInfo.model_validate(report["grid"]))
    content = path.read_bytes()

    data, header = hips2fits.read_image(content)
    assert data.shape == grid.shape
    assert hips2fits.wcs_offset_px(WCS(header).celestial, grid) < hips2fits.WCS_TOLERANCE_PX

    image = decode_preview(content, grid)
    assert image.shape == grid.shape and image.dtype == np.float32
    assert np.isfinite(image).mean() > 0.5
    np.testing.assert_array_equal(image, data.astype(np.float32))
