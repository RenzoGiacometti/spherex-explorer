"""Descarga de recortes contra un servidor local que hace de IRSA. Sin red.

Las respuestas se arman con los recortes reales de tests/fixtures/cutouts mas
un EPSF grande y WCS-WAVE al final (ver test_irsa_support.py).
"""

from __future__ import annotations

import os
import shutil
import socket
import threading
import time
from collections.abc import Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor
from email.utils import formatdate
from pathlib import Path
from typing import Any

import pytest
import requests
from astropy.io import fits
from test_irsa_support import (
    CUTOUTS_DIR,
    IMAGE_HDUS,
    IRSA_ORDER,
    Gate,
    IrsaStub,
    cutout_index,
    epsf_extension,
    exposure_from_entry,
    extension_bytes,
    hdu_names,
    irsa_response,
    respond,
    same_images,
    sequence,
    serve,
    split_hdus,
    wcs_wave_extension,
)

from app.config import Settings
from app.domain import CutoutFile, Exposure
from app.irsa import cutouts, transport
from app.irsa.cutouts import (
    IrsaBusy,
    IrsaError,
    IrsaPermanent,
    IrsaTransient,
    cutout_cache_path,
    cutout_url,
    discard_cutout,
    fetch_cutout,
    prune_cutout_cache,
)
from app.irsa.limits import get_limiter, reset_limiter

INDEX = cutout_index()
ENTRY = INDEX["cutouts"][0]
RA, DEC, SIDE = INDEX["center"]["ra"], INDEX["center"]["dec"], INDEX["side_deg"]
FIXTURE = CUTOUTS_DIR / ENTRY["file"]
CUTOUT = FIXTURE.read_bytes()  # lo que queda de la respuesta real al cortar antes de EPSF
RESPONSE = irsa_response(CUTOUT)  # la respuesta completa, con EPSF y WCS-WAVE al final


@pytest.fixture(autouse=True)
def _fresh_limiter() -> Iterator[None]:
    reset_limiter()
    yield
    reset_limiter()


@pytest.fixture
def stub() -> Iterator[IrsaStub]:
    server = IrsaStub()
    try:
        yield server
    finally:
        server.close()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(cache_dir=tmp_path / "cache", irsa_connect_timeout_s=5.0, irsa_read_timeout_s=10.0)


@pytest.fixture
def exposure(stub: IrsaStub) -> Exposure:
    return exposure_from_entry(ENTRY, stub.base_url)


def path_of(exposure: Exposure) -> str:
    return exposure.url.removeprefix(exposure.url.split("/ibe/", 1)[0])


def cache_files(settings: Settings) -> list[str]:
    """Todo lo que hay en la carpeta de recortes, temporales incluidos."""
    folder = settings.cutout_cache_dir
    return sorted(path.name for path in folder.iterdir()) if folder.exists() else []


def with_broken_header(cutout: bytes, name: str, change: Any, order: Sequence[str] = IRSA_ORDER) -> bytes:
    """La respuesta de IRSA con el encabezado del HDU `name` pasado por `change` (el bloque de datos no cambia)."""
    part = dict(split_hdus(cutout))[name]
    end = next(i for i in range(0, len(part), 80) if part[i : i + 80].rstrip() == b"END")
    header_length = (end // 2880 + 1) * 2880
    header = change(part[:header_length])
    assert len(header) == header_length
    return irsa_response(cutout, order=order, replace={name: header + part[header_length:]})


def nulls_after_end(header: bytes) -> bytes:
    """El relleno posterior a END con ceros en vez de espacios: fuera del estandar, pero astropy lo abre."""
    end = next(i for i in range(0, len(header), 80) if header[i : i + 80].rstrip() == b"END")
    return header[: end + 3] + b"\0" * (len(header) - end - 3)


def with_card(key: str, text: str) -> Any:
    """Cambio para `with_broken_header`: la carta `key` reemplazada por `text` (ASCII imprimible, pero mal escrita)."""

    def change(header: bytes) -> bytes:
        start = next(i for i in range(0, len(header), 80) if header[i : i + 8] == key.encode("ascii").ljust(8))
        return header[:start] + text.encode("ascii").ljust(80) + header[start + 80 :]

    return change


def hdu_boundary(*names: str) -> int:
    """Cuantos bytes de la respuesta ocupan esos HDU, que van al comienzo: el punto justo entre dos HDU."""
    parts = dict(split_hdus(CUTOUT))
    return sum(len(parts[name]) for name in names)


# ------------------------------------------------------------------------- URL


def test_cutout_url_is_the_one_verified_against_the_service() -> None:
    for entry in INDEX["cutouts"]:
        exposure = exposure_from_entry(entry, "https://irsa.ipac.caltech.edu")
        assert exposure.url == entry["url"]
        assert cutout_url(exposure, RA, DEC, SIDE) == entry["cutout_url"]
    exposure = exposure_from_entry(ENTRY, "https://irsa.ipac.caltech.edu")
    # WISE 0855 con el lado del escalon base: declinacion negativa y lado con cinco decimales.
    assert (
        cutout_url(exposure, 133.7598, -7.2422, 0.24258) == f"{ENTRY['url']}?center=133.759800,-7.242200d&size=0.24258"
    )


def test_cache_file_is_named_like_the_fixtures(settings: Settings) -> None:
    for entry in INDEX["cutouts"]:
        exposure = exposure_from_entry(entry, "https://irsa.ipac.caltech.edu")
        path = cutout_cache_path(exposure, RA, DEC, SIDE, settings)
        assert path == settings.cutout_cache_dir / entry["file"]
    exposure = exposure_from_entry(ENTRY, "https://irsa.ipac.caltech.edu")
    full = cutout_cache_path(exposure, RA, DEC, SIDE, settings, "full")
    assert full.name == ENTRY["file"].replace("_img.fits", "_full.fits")
    # La clave es exposicion, centro y lado: si cambia cualquiera, es otro archivo.
    other = exposure_from_entry(INDEX["cutouts"][1], "https://irsa.ipac.caltech.edu")
    names = {
        cutout_cache_path(exposure, RA, DEC, SIDE, settings).name,
        cutout_cache_path(other, RA, DEC, SIDE, settings).name,
        cutout_cache_path(exposure, RA + 0.0001, DEC, SIDE, settings).name,
        cutout_cache_path(exposure, RA, DEC - 0.0001, SIDE, settings).name,
        cutout_cache_path(exposure, RA, DEC, 0.24258, settings).name,
    }
    assert len(names) == 5


# ------------------------------------------------------------ lectura por flujo


def test_download_stops_before_epsf(stub: IrsaStub, settings: Settings, exposure: Exposure) -> None:
    stub.routes[path_of(exposure)] = serve(RESPONSE)
    result = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    stub.wait_idle()

    assert result == CutoutFile(
        path=settings.cutout_cache_dir / ENTRY["file"], mode="truncated", from_cache=False, nbytes=len(CUTOUT)
    )
    assert result.reason is None
    # Lo guardado es, byte por byte, el recorte real que dejo la Etapa 0.
    assert result.path.read_bytes() == CUTOUT
    assert hdu_names(result.path) == INDEX["hdus"]
    assert cache_files(settings) == [ENTRY["file"]]

    [hit] = stub.hits
    assert hit.query == {"center": f"{RA:.6f},{DEC:.6f}d", "size": f"{SIDE:g}"}
    assert hit.headers["user-agent"] == settings.user_agent
    assert hit.headers["accept-encoding"] == "identity"
    # El servidor no llego a mandar la respuesta: el cliente corto la conexion antes de recibir EPSF.
    assert hit.aborted
    assert len(CUTOUT) <= hit.bytes_sent < len(RESPONSE) - len(wcs_wave_extension())
    assert len(RESPONSE) > 8_000_000 and len(CUTOUT) < 130_000


@pytest.mark.parametrize("framing", ["length", "close"])
def test_download_stops_before_epsf_with_any_framing(
    stub: IrsaStub, settings: Settings, exposure: Exposure, framing: Any
) -> None:
    stub.routes[path_of(exposure)] = serve(RESPONSE, framing=framing)
    result = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    stub.wait_idle()
    assert (result.mode, result.nbytes) == ("truncated", len(CUTOUT))
    assert result.path.read_bytes() == CUTOUT
    assert stub.hits[0].aborted and stub.hits[0].bytes_sent < len(RESPONSE)


def test_extensions_in_another_order_are_found_by_name(stub: IrsaStub, settings: Settings, exposure: Exposure) -> None:
    # EPSF primero y las de imagen al reves: hay que atravesar todo para juntar las cuatro.
    order = ("PRIMARY", "EPSF", "WCS-WAVE", "ZODI", "VARIANCE", "FLAGS", "IMAGE")
    response = irsa_response(CUTOUT, order=order)
    stub.routes[path_of(exposure)] = serve(response)
    result = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    stub.wait_idle()

    assert (result.mode, result.from_cache, result.nbytes) == ("truncated", False, len(response))
    assert hdu_names(result.path) == ["PRIMARY", "ZODI", "VARIANCE", "FLAGS", "IMAGE"]
    assert same_images(result.path, FIXTURE)
    assert result.path.stat().st_size == len(CUTOUT)
    assert len(stub.hits) == 1 and not stub.hits[0].aborted


def test_reading_stops_as_soon_as_the_four_are_in(stub: IrsaStub, settings: Settings, exposure: Exposure) -> None:
    # Una tabla chica entre las de imagen y EPSF al final: se saltea la tabla y se corta antes de EPSF.
    order = ("PRIMARY", "IMAGE", "WCS-WAVE", "FLAGS", "VARIANCE", "ZODI", "EPSF")
    response = irsa_response(CUTOUT, order=order)
    stub.routes[path_of(exposure)] = serve(response)
    result = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    stub.wait_idle()

    assert (result.mode, result.nbytes) == ("truncated", len(CUTOUT) + len(wcs_wave_extension()))
    assert result.path.read_bytes() == CUTOUT  # la tabla salteada no se guarda
    assert stub.hits[0].aborted and stub.hits[0].bytes_sent < len(response)


def test_extension_names_are_matched_without_case(stub: IrsaStub, settings: Settings, exposure: Exposure) -> None:
    lowered = with_broken_header(CUTOUT, "ZODI", lambda header: header.replace(b"'ZODI    '", b"'zodi    '"))
    stub.routes[path_of(exposure)] = serve(lowered)
    result = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert result.mode == "truncated" and len(stub.hits) == 1
    # Se guarda tal como llego; astropy lo encuentra igual con `hdul["ZODI"]`.
    assert hdu_names(result.path) == ["PRIMARY", "IMAGE", "FLAGS", "VARIANCE", "zodi"]
    assert same_images(result.path, FIXTURE) is False  # el encabezado de ZODI no es el del original
    with fits.open(result.path, memmap=False) as got:
        assert got["ZODI"].data.tobytes() == fits.getdata(FIXTURE, "ZODI").tobytes()


# ------------------------------------------------------------------- modo full


@pytest.mark.filterwarnings("ignore::astropy.utils.exceptions.AstropyUserWarning")
@pytest.mark.parametrize(
    "change",
    [
        nulls_after_end,
        lambda header: header.replace(b"/ Unit of pixel value", b"/ Unit of pixel \xb5alue"),
    ],
    ids=["ceros_despues_de_END", "byte_no_ascii"],
)
def test_unreadable_header_downloads_the_full_response(
    stub: IrsaStub, settings: Settings, exposure: Exposure, change: Any
) -> None:
    response = with_broken_header(CUTOUT, "IMAGE", change)
    assert response != RESPONSE and len(response) == len(RESPONSE)
    stub.routes[path_of(exposure)] = serve(response)
    result = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    stub.wait_idle()

    # Dos pedidos: el que no se pudo leer por flujo, cortado en el encabezado de IMAGE, y el completo.
    first, second = stub.hits
    assert first.aborted and first.bytes_sent < len(response)
    assert not second.aborted and second.bytes_sent == len(response)

    assert result.mode == "full" and not result.from_cache
    # El motivo va al aviso `full_download` del campo.
    assert result.reason == "un encabezado trae bytes que no son ASCII imprimible"
    assert result.path == settings.cutout_cache_dir / ENTRY["file"].replace("_img.fits", "_full.fits")
    assert len(response) < result.nbytes < len(response) + len(CUTOUT)
    # Queda todo menos EPSF, con los bytes tal como llegaron.
    assert hdu_names(result.path) == [name for name in IRSA_ORDER if name != "EPSF"]
    assert result.path.read_bytes() == response.replace(epsf_extension(), b"")
    assert cache_files(settings) == [result.path.name]
    with fits.open(result.path, memmap=False) as got, fits.open(FIXTURE, memmap=False) as expected:
        for name in IMAGE_HDUS:
            assert got[name].data.tobytes() == expected[name].data.tobytes()

    # La proxima vez sale de la cache, y sigue diciendo que se bajo completo.
    again = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert again == CutoutFile(path=result.path, mode="full", from_cache=True, nbytes=0, reason=None)
    assert len(stub.hits) == 2


@pytest.mark.filterwarnings("ignore::astropy.utils.exceptions.AstropyUserWarning")
def test_full_mode_keeps_the_order_of_the_response(stub: IrsaStub, settings: Settings, exposure: Exposure) -> None:
    order = ("PRIMARY", "EPSF", "IMAGE", "FLAGS", "WCS-WAVE", "VARIANCE", "ZODI")
    response = with_broken_header(CUTOUT, "IMAGE", nulls_after_end, order=order)
    stub.routes[path_of(exposure)] = serve(response, framing="length")
    result = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert result.mode == "full" and len(stub.hits) == 2
    assert hdu_names(result.path) == [name for name in order if name != "EPSF"]
    assert result.path.read_bytes() == response.replace(epsf_extension(), b"")
    with fits.open(result.path, memmap=False) as got, fits.open(FIXTURE, memmap=False) as expected:
        for name in IMAGE_HDUS:
            assert got[name].data.tobytes() == expected[name].data.tobytes()


def test_response_without_the_four_extensions_is_permanent(
    stub: IrsaStub, settings: Settings, exposure: Exposure
) -> None:
    response = irsa_response(CUTOUT, order=[name for name in IRSA_ORDER if name != "ZODI"])
    stub.routes[path_of(exposure)] = serve(response)
    with pytest.raises(IrsaPermanent, match="ZODI"):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    # El flujo termino sin las cuatro: probo con la respuesta completa antes de darse por vencido.
    assert len(stub.hits) == 2
    assert cache_files(settings) == []


def test_extensions_with_different_shapes_are_permanent(stub: IrsaStub, settings: Settings, exposure: Exposure) -> None:
    shorter = extension_bytes(fits.ImageHDU(data=fits.getdata(FIXTURE, "ZODI")[:-1], name="ZODI"))
    stub.routes[path_of(exposure)] = serve(irsa_response(CUTOUT, replace={"ZODI": shorter}))
    with pytest.raises(IrsaPermanent, match="formas distintas"):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert len(stub.hits) == 2 and cache_files(settings) == []


@pytest.mark.parametrize(
    "body",
    [
        b"",
        b"<html><body>Bad Gateway</body></html>",
        b"<html><body>" + b"Bad Gateway " * 400 + b"</body></html>",
        b"SIMPLE  = no es un FITS".ljust(2880),
        CUTOUT[2880:],  # empieza en una extension: le falta el PRIMARY
    ],
    ids=["vacio", "html_corto", "html_largo", "sin_END", "sin_PRIMARY"],
)
def test_a_200_that_is_not_fits_is_transient(
    stub: IrsaStub, settings: Settings, exposure: Exposure, body: bytes
) -> None:
    stub.routes[path_of(exposure)] = serve(body, framing="length", content_type="text/html")
    with pytest.raises(IrsaTransient):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    # Lo que llego no es un FITS: pedirlo completo no cambiaria nada, asi que no hay segundo pedido.
    assert len(stub.hits) == 1 and cache_files(settings) == []


@pytest.mark.filterwarnings("ignore::astropy.utils.exceptions.AstropyUserWarning")
@pytest.mark.parametrize(
    "broken",
    [
        lambda header: header.replace(b"BITPIX  =                  -32", b"BITPIX  =                  -31"),
        lambda header: header.replace(b"NAXIS1  =                   58", b"NAXIS1  =                   -8"),
        lambda header: header.replace(b"NAXIS2  = ", b"NAXIS9  = "),
        lambda header: header.replace(b"XTENSION=", b"EXTENSIO="),
        with_card("EXTNAME", "EXTNAME = IMAGE"),
    ],
    ids=["bitpix_imposible", "eje_negativo", "falta_un_eje", "sin_XTENSION", "EXTNAME_sin_comillas"],
)
def test_a_fits_that_nobody_can_read_is_transient(
    stub: IrsaStub, settings: Settings, exposure: Exposure, broken: Any
) -> None:
    stub.routes[path_of(exposure)] = serve(with_broken_header(CUTOUT, "IMAGE", broken))
    with pytest.raises(IrsaTransient):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    # El lector por flujo no lo entendio, y astropy tampoco pudo con la respuesta completa.
    assert len(stub.hits) == 2 and cache_files(settings) == []


@pytest.mark.filterwarnings("ignore::astropy.utils.exceptions.AstropyUserWarning")
@pytest.mark.parametrize("name", ["IMAGE", "FLAGS", "ZODI"])
@pytest.mark.parametrize("text", ["EXTNAME = {}", "EXTNAME = '{}", "EXTNAME = '{}' 'x' / y"])
def test_a_malformed_extname_never_escapes_as_another_exception(
    stub: IrsaStub, settings: Settings, exposure: Exposure, name: str, text: str
) -> None:
    """astropy interpreta la carta recien al leerla y lanza VerifyError: tiene que salir como `IrsaError`."""
    response = with_broken_header(CUTOUT, name, with_card("EXTNAME", text.format(name)))
    stub.routes[path_of(exposure)] = serve(response)
    with pytest.raises(IrsaError) as caught:
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert isinstance(caught.value, IrsaTransient | IrsaPermanent)
    # Un encabezado que no se puede interpretar: se intento bajando la respuesta completa (contrato, seccion 9).
    assert len(stub.hits) == 2 and cache_files(settings) == []
    assert get_limiter(settings).cutouts_in_flight == 0 and cutouts._key_locks == {}


def test_an_unexpected_error_while_reading_is_transient(
    stub: IrsaStub, settings: Settings, exposure: Exposure, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Red de seguridad: de `fetch_cutout` solo salen `IrsaError`, aunque falle algo que nadie previo."""
    stub.routes[path_of(exposure)] = serve(RESPONSE)

    def explode(stream: Any) -> bytes:
        raise fits.VerifyError("Unparsable card (CUALQUIERA)")

    monkeypatch.setattr(cutouts, "_read_image_hdus", explode)
    with pytest.raises(IrsaTransient, match=r"fallo inesperado.*VerifyError.*CUALQUIERA"):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert len(stub.hits) == 1 and cache_files(settings) == []
    assert get_limiter(settings).cutouts_in_flight == 0 and cutouts._key_locks == {}


# ------------------------------------------------- respuesta que no dice su largo


@pytest.mark.filterwarnings("ignore::astropy.utils.exceptions.AstropyUserWarning")
@pytest.mark.parametrize("framing", ["close", "length", "chunked"])
@pytest.mark.parametrize("inside_epsf", [1000, 4_000_000], ids=["encabezado_de_EPSF", "datos_de_EPSF"])
def test_full_response_cut_inside_epsf_is_not_saved_as_complete(
    stub: IrsaStub, settings: Settings, exposure: Exposure, framing: Any, inside_epsf: int
) -> None:
    """Las cuatro imagenes llegaron enteras y el corte cae en EPSF, que no se guarda: igual es una respuesta cortada."""
    response = with_broken_header(CUTOUT, "IMAGE", nulls_after_end)  # obliga a bajar la respuesta completa
    cut = len(CUTOUT) + inside_epsf
    assert len(CUTOUT) < cut < len(CUTOUT) + len(epsf_extension())
    stub.routes[path_of(exposure)] = serve(response, framing=framing, cut_after=cut)
    with pytest.raises(IrsaTransient):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    # Sin WCS-WAVE no es "la respuesta completa menos EPSF": no queda ningun `_full.fits`.
    assert len(stub.hits) == 2 and cache_files(settings) == []


@pytest.mark.parametrize(
    ("framing", "requests_made"),
    [("close", 2), ("length", 1), ("chunked", 1)],
)
def test_cut_right_between_two_hdus_is_transient(
    stub: IrsaStub, settings: Settings, exposure: Exposure, framing: Any, requests_made: int
) -> None:
    cut = hdu_boundary("PRIMARY", "IMAGE", "FLAGS")
    stub.routes[path_of(exposure)] = serve(RESPONSE, framing=framing, cut_after=cut)
    with pytest.raises(IrsaTransient) as caught:
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    # Con `Content-Length` o `chunked` el corte se nota en el primer pedido. Sin ninguna de las dos el
    # flujo "termina" sin VARIANCE ni ZODI: se prueba con la respuesta completa y, como tampoco dice su
    # largo, que falten extensiones puede ser otro corte. Es pasajero, no un 4xx.
    assert len(stub.hits) == requests_made and cache_files(settings) == []
    if framing == "close":
        assert "VARIANCE" in str(caught.value) and "no declara su largo" in str(caught.value)


def test_missing_extensions_without_a_declared_length_are_transient(
    stub: IrsaStub, settings: Settings, exposure: Exposure
) -> None:
    """La misma respuesta sin ZODI es permanente si dice su largo (test de arriba) y pasajera si no lo dice."""
    response = irsa_response(CUTOUT, order=[name for name in IRSA_ORDER if name != "ZODI"])
    stub.routes[path_of(exposure)] = serve(response, framing="close")
    with pytest.raises(IrsaTransient, match="ZODI"):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert len(stub.hits) == 2 and cache_files(settings) == []


@pytest.mark.filterwarnings("ignore::astropy.utils.exceptions.AstropyUserWarning")
def test_a_response_too_big_to_be_a_cutout_is_refused(
    stub: IrsaStub, settings: Settings, exposure: Exposure, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(cutouts, "MAX_RESPONSE_BYTES", 1_000_000)
    stub.routes[path_of(exposure)] = serve(with_broken_header(CUTOUT, "IMAGE", nulls_after_end))
    with pytest.raises(IrsaPermanent, match="1000000 bytes"):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    stub.wait_idle()
    # Dejo de leer al pasar el tope: no bajo los 8 MB.
    assert stub.hits[1].aborted and stub.hits[1].bytes_sent < len(RESPONSE)
    assert cache_files(settings) == []


# ------------------------------------------------------------- errores de HTTP


@pytest.mark.parametrize(
    ("status", "headers", "retry_after"),
    [
        (503, {"Retry-After": "5"}, 5.0),  # lo que manda IRSA cuando esta cargado
        (503, {"Retry-After": "12.5"}, 12.5),
        (503, {"Retry-After": "0"}, 0.0),
        (503, {}, 7.0),  # sin cabecera: el valor por defecto de la configuracion
        (503, {"Retry-After": "pronto"}, 7.0),
        (503, {"Retry-After": "-3"}, 7.0),
        (503, {"Retry-After": "nan"}, 7.0),
        (503, {"Retry-After": "inf"}, 7.0),
        (429, {"Retry-After": "2"}, 2.0),
        (429, {}, 7.0),
        (500, {"Retry-After": "9"}, 9.0),  # cualquier 5xx que pida esperar
        (502, {"Retry-After": "1"}, 1.0),
    ],
)
def test_busy_carries_the_wait_irsa_asks_for(
    stub: IrsaStub, tmp_path: Path, exposure: Exposure, status: int, headers: dict[str, str], retry_after: float
) -> None:
    settings = Settings(cache_dir=tmp_path / "cache", irsa_retry_after_default_s=7.0)
    stub.routes[path_of(exposure)] = respond(status, b"Server busy, retry later.", headers)
    with pytest.raises(IrsaBusy) as caught:
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert caught.value.retry_after == retry_after
    assert f"HTTP {status}" in str(caught.value) and "Server busy, retry later." in str(caught.value)
    # Un solo intento por llamada: reintentar es cosa del planificador.
    assert len(stub.hits) == 1 and cache_files(settings) == []
    assert get_limiter(settings).cutouts_in_flight == 0


def test_retry_after_as_a_date(stub: IrsaStub, settings: Settings, exposure: Exposure) -> None:
    stub.routes[path_of(exposure)] = sequence(
        respond(503, b"busy", {"Retry-After": formatdate(time.time() + 40.0, usegmt=True)}),
        respond(503, b"busy", {"Retry-After": formatdate(time.time() - 3600.0, usegmt=True)}),
    )
    with pytest.raises(IrsaBusy) as caught:
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert 30.0 < caught.value.retry_after <= 41.0
    with pytest.raises(IrsaBusy) as caught:
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert caught.value.retry_after == 0.0  # una fecha que ya paso


@pytest.mark.parametrize("status", [503, 429, 500])
@pytest.mark.parametrize("value", ["86400", "1e12", "61", "Fri, 31 Dec 9999 23:59:59 GMT"])
def test_a_huge_retry_after_is_capped(
    stub: IrsaStub, settings: Settings, exposure: Exposure, status: int, value: str
) -> None:
    """Un `Retry-After` de un dia (o del anio 9999) no puede dejar parado un recorte."""
    stub.routes[path_of(exposure)] = respond(status, b"Server busy, retry later.", {"Retry-After": value})
    with pytest.raises(IrsaBusy) as caught:
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert settings.irsa_retry_after_max_s == 60.0
    assert caught.value.retry_after == 60.0
    # Lo que pidio IRSA no se pierde: queda aparte y en el mensaje, para quien decida no insistir.
    assert caught.value.requested is not None and caught.value.requested > 60.0
    assert "Retry-After de" in str(caught.value) and "60 s" in str(caught.value)


def test_retry_after_cap_comes_from_settings(stub: IrsaStub, tmp_path: Path, exposure: Exposure) -> None:
    settings = Settings(cache_dir=tmp_path / "cache", irsa_retry_after_max_s=3.0, irsa_retry_after_default_s=7.0)
    stub.routes[path_of(exposure)] = sequence(
        respond(503, b"busy", {"Retry-After": "5"}), respond(503, b"busy"), respond(503, b"busy", {"Retry-After": "2"})
    )
    seen = []
    for _ in range(3):
        with pytest.raises(IrsaBusy) as caught:
            fetch_cutout(exposure, RA, DEC, SIDE, settings)
        seen.append((caught.value.retry_after, caught.value.requested))
    # Pedido por IRSA y acotado; sin cabecera, el valor por defecto, tambien acotado; por debajo del tope, tal cual.
    assert seen == [(3.0, 5.0), (3.0, None), (2.0, 2.0)]


@pytest.mark.parametrize("status", [500, 502, 504, 408])
def test_server_errors_without_retry_after_are_transient(
    stub: IrsaStub, settings: Settings, exposure: Exposure, status: int
) -> None:
    stub.routes[path_of(exposure)] = respond(status, b"Internal Server Error")
    with pytest.raises(IrsaTransient, match=f"HTTP {status}") as caught:
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert not isinstance(caught.value, IrsaBusy)
    assert len(stub.hits) == 1 and cache_files(settings) == []


@pytest.mark.parametrize(
    ("status", "body"),
    [(422, b"Arrays do not overlap."), (404, b"Not Found"), (400, b"Bad Request"), (403, b"Forbidden")],
)
def test_client_errors_are_permanent(
    stub: IrsaStub, settings: Settings, exposure: Exposure, status: int, body: bytes
) -> None:
    stub.routes[path_of(exposure)] = respond(status, body)
    with pytest.raises(IrsaPermanent, match=f"HTTP {status}: {body.decode()}"):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert len(stub.hits) == 1 and cache_files(settings) == []


def test_malformed_url_is_permanent(settings: Settings, exposure: Exposure) -> None:
    broken = Exposure(**{**exposure.__dict__, "url": "sin-esquema/archivo.fits"})
    with pytest.raises(IrsaPermanent, match="URL"):
        fetch_cutout(broken, RA, DEC, SIDE, settings)


def test_every_error_is_an_irsa_error() -> None:
    assert issubclass(IrsaBusy, IrsaError) and issubclass(IrsaTransient, IrsaError)
    assert issubclass(IrsaPermanent, IrsaError)


# ------------------------------------------------------------ cortes y demoras


@pytest.mark.parametrize("framing", ["chunked", "length", "close"])
@pytest.mark.parametrize("cut_after", [1000, 2880 + 5000, 30_000, len(CUTOUT) - 1])
def test_connection_cut_in_the_middle_is_transient(
    stub: IrsaStub, settings: Settings, exposure: Exposure, framing: Any, cut_after: int
) -> None:
    stub.routes[path_of(exposure)] = serve(RESPONSE, framing=framing, cut_after=cut_after, block=1024)
    with pytest.raises(IrsaTransient):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    # Un corte no es un problema de formato: no vuelve a pedir la respuesta completa.
    assert len(stub.hits) == 1 and stub.hits[0].bytes_sent == cut_after
    assert cache_files(settings) == []
    assert get_limiter(settings).cutouts_in_flight == 0


def test_connection_closed_without_a_response_is_transient(
    stub: IrsaStub, settings: Settings, exposure: Exposure
) -> None:
    stub.routes[path_of(exposure)] = lambda handler, hit: None  # cierra sin mandar ni la primera linea
    with pytest.raises(IrsaTransient):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert cache_files(settings) == []


def test_nobody_listening_is_transient(tmp_path: Path, exposure: Exposure) -> None:
    # En Windows un puerto cerrado tarda unos 2 s en rechazar: con este timeout sale antes, como demora de conexion.
    settings = Settings(cache_dir=tmp_path / "cache", irsa_connect_timeout_s=0.5, irsa_read_timeout_s=5.0)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]  # al cerrar el socket, en ese puerto no escucha nadie
    nobody = Exposure(**{**exposure.__dict__, "url": f"http://127.0.0.1:{port}/ibe/recorte.fits"})
    with pytest.raises(IrsaTransient):
        fetch_cutout(nobody, RA, DEC, SIDE, settings)
    assert cache_files(settings) == []
    assert get_limiter(settings).cutouts_in_flight == 0


def test_slow_response_hits_the_read_timeout(stub: IrsaStub, tmp_path: Path, exposure: Exposure) -> None:
    settings = Settings(cache_dir=tmp_path / "cache", irsa_connect_timeout_s=5.0, irsa_read_timeout_s=0.3)
    stub.routes[path_of(exposure)] = serve(RESPONSE, delay_s=30.0)
    started = time.perf_counter()
    with pytest.raises(IrsaTransient, match=r"(?i)timed? ?out"):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert time.perf_counter() - started < 5.0
    assert len(stub.hits) == 1 and cache_files(settings) == []
    assert get_limiter(settings).cutouts_in_flight == 0


def test_stall_in_the_middle_of_the_body_hits_the_read_timeout(
    stub: IrsaStub, tmp_path: Path, exposure: Exposure
) -> None:
    settings = Settings(cache_dir=tmp_path / "cache", irsa_connect_timeout_s=5.0, irsa_read_timeout_s=0.3)
    stub.routes[path_of(exposure)] = serve(RESPONSE, stall_after=40_000, stall_s=30.0, block=4096)
    started = time.perf_counter()
    with pytest.raises(IrsaTransient):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert time.perf_counter() - started < 5.0
    assert len(stub.hits) == 1 and cache_files(settings) == []


def test_timeouts_come_from_settings() -> None:
    settings = Settings(irsa_connect_timeout_s=3.0, irsa_read_timeout_s=21.0)
    assert transport.timeouts(settings) == (3.0, 21.0)
    defaults = Settings()
    assert defaults.irsa_connect_timeout_s > 0 and defaults.irsa_read_timeout_s > 0
    # El tope total es mayor que el silencio admitido entre dos tramos: si no, no agregaria nada.
    assert defaults.irsa_total_timeout_s > defaults.irsa_read_timeout_s


# ----------------------------------------------------------------- plazo total


@pytest.mark.parametrize("framing", ["chunked", "length", "close"])
def test_a_trickling_response_hits_the_total_timeout(
    stub: IrsaStub, tmp_path: Path, exposure: Exposure, framing: Any
) -> None:
    """Un servidor que manda de a poco nunca dispara el timeout de lectura: lo corta el plazo total."""
    settings = Settings(
        cache_dir=tmp_path / "cache", irsa_connect_timeout_s=5.0, irsa_read_timeout_s=5.0, irsa_total_timeout_s=0.8
    )
    # 1440 bytes cada 0,1 s: el recorte entero tardaria 8,6 s, sin un solo silencio de mas de 0,1 s.
    stub.routes[path_of(exposure)] = serve(RESPONSE, framing=framing, block=1440, pause_s=0.1)
    started = time.perf_counter()
    with pytest.raises(IrsaTransient, match=r"plazo total de 0\.8 s"):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    elapsed = time.perf_counter() - started
    assert 0.7 < elapsed < 3.0
    assert len(stub.hits) == 1 and cache_files(settings) == []
    assert get_limiter(settings).cutouts_in_flight == 0 and cutouts._key_locks == {}
    stub.wait_idle()
    assert stub.hits[0].aborted or stub.hits[0].bytes_sent < len(CUTOUT)  # el cliente corto: el cupo quedo libre


def test_the_total_timeout_also_cuts_a_silent_server(stub: IrsaStub, tmp_path: Path, exposure: Exposure) -> None:
    """Un silencio que empieza antes del plazo no se espera el timeout de lectura entero."""
    settings = Settings(
        cache_dir=tmp_path / "cache", irsa_connect_timeout_s=5.0, irsa_read_timeout_s=20.0, irsa_total_timeout_s=0.6
    )
    stub.routes[path_of(exposure)] = serve(RESPONSE, stall_after=40_000, stall_s=30.0, block=4096)
    started = time.perf_counter()
    with pytest.raises(IrsaTransient, match="plazo total"):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert time.perf_counter() - started < 3.0
    assert cache_files(settings) == [] and get_limiter(settings).cutouts_in_flight == 0


@pytest.mark.filterwarnings("ignore::astropy.utils.exceptions.AstropyUserWarning")
def test_the_total_timeout_covers_both_requests_of_full_mode(
    stub: IrsaStub, tmp_path: Path, exposure: Exposure
) -> None:
    settings = Settings(
        cache_dir=tmp_path / "cache", irsa_connect_timeout_s=5.0, irsa_read_timeout_s=20.0, irsa_total_timeout_s=1.0
    )
    response = with_broken_header(CUTOUT, "IMAGE", nulls_after_end)
    # El primer pedido responde enseguida y no se puede leer por flujo; el segundo tarda en empezar.
    stub.routes[path_of(exposure)] = sequence(serve(response), serve(response, delay_s=30.0))
    started = time.perf_counter()
    with pytest.raises(IrsaTransient):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    # El plazo es de la llamada entera: el segundo pedido no arranca con 20 s propios.
    assert time.perf_counter() - started < 4.0
    assert len(stub.hits) == 2 and cache_files(settings) == []
    assert get_limiter(settings).cutouts_in_flight == 0


def test_total_timeout_of_zero_means_no_limit(stub: IrsaStub, tmp_path: Path, exposure: Exposure) -> None:
    settings = Settings(cache_dir=tmp_path / "cache", irsa_read_timeout_s=5.0, irsa_total_timeout_s=0.0)
    stub.routes[path_of(exposure)] = serve(RESPONSE, block=16 * 1024, pause_s=0.05)
    result = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert result.mode == "truncated" and result.path.read_bytes() == CUTOUT


def test_deadline() -> None:
    endless = transport.Deadline(0.0)
    assert endless.remaining() is None and not endless.expired()
    endless.check()
    assert endless.cap(7.0) == 7.0
    settings = Settings(irsa_connect_timeout_s=3.0, irsa_read_timeout_s=21.0)
    assert transport.timeouts(settings, endless) == (3.0, 21.0)

    long = transport.Deadline(10.0)
    remaining = long.remaining()
    assert remaining is not None and 9.0 < remaining <= 10.0
    connect, read = transport.timeouts(settings, long)
    assert connect == 3.0 and 9.0 < read <= 10.0  # ningun timeout pasa de lo que queda

    short = transport.Deadline(0.01)
    time.sleep(0.05)
    assert short.expired() and short.remaining() == 0.0
    with pytest.raises(transport.TotalTimeout, match=r"0\.01 s"):
        short.check()
    with pytest.raises(transport.TotalTimeout):
        transport.timeouts(settings, short)
    # Es una demora de `requests`: quien ya las trata no necesita conocerla.
    assert issubclass(transport.TotalTimeout, requests.exceptions.Timeout)
    assert transport.total_deadline(Settings(irsa_total_timeout_s=42.0)).seconds == 42.0


class FakeBody:
    """El cuerpo de una respuesta, entregado de a `step` bytes por lectura, como un socket lento."""

    def __init__(self, data: bytes, step: int, with_read1: bool = True) -> None:
        self._data, self._step = data, step
        self.calls: list[tuple[int, bool]] = []
        if with_read1:
            self.read1 = self._take

    def _take(self, size: int, decode_content: bool = False) -> bytes:
        self.calls.append((size, decode_content))
        piece, self._data = self._data[: min(size, self._step)], self._data[min(size, self._step) :]
        return piece

    def read(self, size: int, decode_content: bool = False) -> bytes:
        return self._take(size, decode_content)


def test_read_some_and_read_body() -> None:
    endless = transport.Deadline(0.0)
    body = bytes(range(256)) * 40
    raw = FakeBody(body, step=1000)
    assert transport.read_some(raw, 300, endless) == body[:300]  # nunca mas de lo pedido
    assert transport.read_some(raw, 5000, endless) == body[300:1300]  # ni espera a juntarlo: lo que haya
    assert transport.read_body(raw, endless, decode=True) == body[1300:]
    assert raw.calls[:2] == [(300, False), (5000, False)] and raw.calls[-1][1] is True
    assert transport.read_some(raw, 10, endless) == b""  # el cuerpo termino

    # Con una version de urllib3 sin `read1` se lee con `read`.
    old = FakeBody(body, step=700, with_read1=False)
    assert transport.read_body(old, endless) == body

    with pytest.raises(ValueError, match="pasa de 2000 bytes"):
        transport.read_body(FakeBody(body, step=900), endless, limit=2000)

    expired = transport.Deadline(0.01)
    time.sleep(0.05)
    untouched = FakeBody(body, step=1000)
    with pytest.raises(transport.TotalTimeout):
        transport.read_some(untouched, 100, expired)
    assert untouched.calls == []  # vencido el plazo, ni se intenta leer


# ----------------------------------------------------------------------- cache


def test_cache_hit_does_not_touch_the_network(stub: IrsaStub, settings: Settings, exposure: Exposure) -> None:
    stub.routes[path_of(exposure)] = serve(RESPONSE)
    first = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert not first.from_cache and len(stub.hits) == 1

    old = time.time() - 86_400.0
    os.utime(first.path, (old, old))
    second = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert second == CutoutFile(path=first.path, mode="truncated", from_cache=True, nbytes=0)
    assert len(stub.hits) == 1
    # Usarlo le actualiza la fecha: el tope de disco borra los menos usados.
    assert first.path.stat().st_mtime > old + 86_000.0
    assert first.path.read_bytes() == CUTOUT


def test_cache_hit_does_not_take_a_slot(settings: Settings, exposure: Exposure) -> None:
    reset_limiter()
    limiter = get_limiter(Settings(max_cutout_downloads=1))
    target = cutout_cache_path(exposure, RA, DEC, SIDE, settings)
    target.parent.mkdir(parents=True)
    shutil.copyfile(FIXTURE, target)
    done = threading.Event()
    results: list[CutoutFile] = []

    def fetch() -> None:
        results.append(fetch_cutout(exposure, RA, DEC, SIDE, settings))
        done.set()

    with limiter.cutout_slot():  # el unico lugar esta ocupado
        thread = threading.Thread(target=fetch)
        thread.start()
        assert done.wait(5.0), "un acierto de cache quedo esperando un lugar de descarga"
    thread.join(5.0)
    assert results[0].from_cache


def test_fixture_copied_to_the_cache_is_a_hit_without_any_server(tmp_path: Path) -> None:
    """Asi se le pueden dar recortes reales al pipeline o al planificador en un test, sin red."""
    settings = Settings(cache_dir=tmp_path / "cache")
    settings.cutout_cache_dir.mkdir(parents=True)
    for entry in INDEX["cutouts"]:
        shutil.copyfile(CUTOUTS_DIR / entry["file"], settings.cutout_cache_dir / entry["file"])
    for entry in INDEX["cutouts"]:
        exposure = exposure_from_entry(entry, "https://irsa.ipac.caltech.edu")
        result = fetch_cutout(exposure, RA, DEC, SIDE, settings)
        assert (result.from_cache, result.mode, result.nbytes) == (True, "truncated", 0)
        assert result.path.name == entry["file"]


@pytest.mark.parametrize(
    "broken",
    [CUTOUT[:50_000], b"", b"<html><body>502 Proxy Error</body></html>".ljust(2880), CUTOUT[2880:] + b" " * 2880],
    ids=["cortado", "vacio", "pagina_de_error", "sin_PRIMARY"],
)
@pytest.mark.parametrize("mode", ["truncated", "full"])
def test_a_file_in_the_cache_that_cannot_be_a_fits_is_downloaded_again(
    stub: IrsaStub, settings: Settings, exposure: Exposure, broken: bytes, mode: Any
) -> None:
    """Los recortes no vencen: un archivo cortado (corte de luz, copia a mano) no puede ser acierto para siempre."""
    stub.routes[path_of(exposure)] = serve(RESPONSE)
    path = cutout_cache_path(exposure, RA, DEC, SIDE, settings, mode)
    path.parent.mkdir(parents=True)
    path.write_bytes(broken)

    first = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert (first.from_cache, first.mode, len(stub.hits)) == (False, "truncated", 1)
    assert first.path.read_bytes() == CUTOUT
    # El roto se borro (si era el `_full`, no queda al lado del nuevo) y el bueno ya es un acierto.
    assert cache_files(settings) == [ENTRY["file"]]
    assert fetch_cutout(exposure, RA, DEC, SIDE, settings).from_cache and len(stub.hits) == 1


def test_discard_cutout_lets_a_cutout_that_cannot_be_read_be_downloaded_again(
    stub: IrsaStub, settings: Settings, exposure: Exposure
) -> None:
    stub.routes[path_of(exposure)] = serve(RESPONSE)
    path = cutout_cache_path(exposure, RA, DEC, SIDE, settings)
    path.parent.mkdir(parents=True)
    # Cortado justo en un limite de bloque, despues de IMAGE: la comprobacion barata del acierto no lo nota.
    path.write_bytes(CUTOUT[: hdu_boundary("PRIMARY", "IMAGE")])
    hit = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert hit.from_cache and len(stub.hits) == 0
    with pytest.raises(KeyError), fits.open(hit.path, memmap=False) as hdul:
        _ = hdul["FLAGS"]  # lo que le pasaria al pipeline

    # Quien no lo pudo leer lo descarta y lo vuelve a pedir.
    assert discard_cutout(hit.path, settings) is True
    assert cache_files(settings) == []
    assert discard_cutout(hit.path, settings) is False  # ya no esta
    again = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert (again.from_cache, len(stub.hits)) == (False, 1) and again.path.read_bytes() == CUTOUT


def test_discard_cutout_only_removes_cutouts_of_the_cache(tmp_path: Path, settings: Settings) -> None:
    settings.cutout_cache_dir.mkdir(parents=True)
    outside = tmp_path / "otro.fits"
    nested = settings.cutout_cache_dir / "subcarpeta" / "recorte_img.fits"
    other = settings.cutout_cache_dir / "notas.txt"
    nested.parent.mkdir()
    for path in (outside, nested, other):
        path.write_bytes(CUTOUT)
        with pytest.raises(ValueError, match="no es un recorte de la cache"):
            discard_cutout(path, settings)
        assert path.read_bytes() == CUTOUT


def test_replace_does_not_settle_for_a_broken_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Windows no deja reemplazar un archivo abierto. Si el que esta es uno roto, no se da por bueno."""
    path = tmp_path / "recorte.fits"
    path.write_bytes(CUTOUT[:50_000])

    def denied(source: Any, target: Any) -> None:
        raise PermissionError(13, "Acceso denegado")

    monkeypatch.setattr(cutouts, "_REPLACE_WAITS_S", (0.0, 0.0))
    monkeypatch.setattr(cutouts.os, "replace", denied)
    with pytest.raises(PermissionError):
        cutouts._write_atomic(path, CUTOUT)
    assert [item.name for item in tmp_path.iterdir()] == ["recorte.fits"]  # sin temporales


def test_different_center_or_side_is_another_download(stub: IrsaStub, settings: Settings, exposure: Exposure) -> None:
    stub.routes[path_of(exposure)] = serve(RESPONSE)
    paths = {
        fetch_cutout(exposure, RA, DEC, SIDE, settings).path,
        fetch_cutout(exposure, RA, DEC, 0.24258, settings).path,
        fetch_cutout(exposure, RA + 0.001, DEC, SIDE, settings).path,
    }
    assert len(paths) == 3 and len(stub.hits) == 3
    assert [hit.query["size"] for hit in stub.hits] == ["0.1", "0.24258", "0.1"]


def test_same_cutout_asked_twice_at_once_is_downloaded_once(
    stub: IrsaStub, settings: Settings, exposure: Exposure
) -> None:
    stub.routes[path_of(exposure)] = serve(RESPONSE, delay_s=0.3)
    barrier = threading.Barrier(6, timeout=10.0)

    def fetch(_: int) -> CutoutFile:
        barrier.wait()
        return fetch_cutout(exposure, RA, DEC, SIDE, settings)

    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(fetch, range(6)))
    stub.wait_idle()

    # Un solo pedido a IRSA: los demas esperaron y lo recibieron de la cache.
    assert len(stub.hits) == 1
    assert sorted(result.from_cache for result in results) == [False, True, True, True, True, True]
    assert {result.path for result in results} == {settings.cutout_cache_dir / ENTRY["file"]}
    assert sum(result.nbytes for result in results) == len(CUTOUT)
    assert results[0].path.read_bytes() == CUTOUT
    assert cache_files(settings) == [ENTRY["file"]]
    assert cutouts._key_locks == {}


def test_after_a_failure_the_one_waiting_tries_on_its_own(
    stub: IrsaStub, settings: Settings, exposure: Exposure
) -> None:
    stub.routes[path_of(exposure)] = sequence(
        respond(503, b"Server busy, retry later.", {"Retry-After": "5"}), serve(RESPONSE)
    )
    with pytest.raises(IrsaBusy):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    result = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert not result.from_cache and result.path.read_bytes() == CUTOUT
    assert len(stub.hits) == 2 and cutouts._key_locks == {}


# ------------------------------------------------------------------ cupo global


def test_global_quota_is_respected_by_thirty_requests_in_sixteen_threads(stub: IrsaStub, settings: Settings) -> None:
    stub.default = serve(RESPONSE)
    stub.gate = Gate(target=10)
    exposures = [
        Exposure(
            obs_id=f"prueba_{i:02d}",
            collection="spherex_dr1",
            detector=3,
            mjd_start=60900.0 + i,
            mjd_end=60900.001 + i,
            url=stub.url(f"/ibe/cupo/level2_prueba_{i:02d}D3_spx.fits"),
            wave_min_um=1.63,
            wave_max_um=2.43,
        )
        for i in range(30)
    ]
    peaks: list[int] = []

    def fetch(exposure: Exposure) -> CutoutFile:
        result = fetch_cutout(exposure, RA, DEC, SIDE, settings)
        peaks.append(get_limiter(settings).cutouts_in_flight)
        return result

    with ThreadPoolExecutor(max_workers=16) as pool:
        results = list(pool.map(fetch, exposures))
    stub.wait_idle()

    assert len(stub.hits) == 30
    # Con 16 hilos empujando, el servidor nunca vio mas de 10 conexiones a la vez, y llego a ver 10.
    assert stub.max_active == 10
    assert max(peaks) <= 10
    assert get_limiter(settings).cutouts_in_flight == 0
    assert len({result.path for result in results}) == 30
    for result in results:
        assert (result.mode, result.from_cache) == ("truncated", False)
        assert result.path.read_bytes() == CUTOUT
    assert len(cache_files(settings)) == 30


def test_each_thread_has_its_own_session() -> None:
    assert transport.session() is transport.session()
    with ThreadPoolExecutor(max_workers=4) as pool:
        barrier = threading.Barrier(4, timeout=10.0)

        def own(_: int) -> int:
            barrier.wait()
            return id(transport.session())

        others = list(pool.map(own, range(4)))
    assert len(set(others)) == 4 and id(transport.session()) not in others


# ------------------------------------------------------------ escritura atomica


def test_writing_over_a_file_someone_is_reading(tmp_path: Path) -> None:
    """En Windows `os.replace` falla si otro tiene abierto el destino: vale el que ya estaba."""
    path = tmp_path / "recorte.fits"
    path.write_bytes(CUTOUT)
    with open(path, "rb") as reader:
        cutouts._write_atomic(path, CUTOUT)
        assert reader.read() == CUTOUT
    assert path.read_bytes() == CUTOUT
    assert [item.name for item in tmp_path.iterdir()] == ["recorte.fits"]


def test_failed_replace_leaves_no_temporary_file(
    stub: IrsaStub, settings: Settings, exposure: Exposure, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub.routes[path_of(exposure)] = serve(RESPONSE)
    attempts: list[str] = []

    def denied(source: Any, target: Any) -> None:
        attempts.append(Path(source).name)
        raise PermissionError(13, "Acceso denegado")

    monkeypatch.setattr(cutouts, "_REPLACE_WAITS_S", (0.0, 0.0))
    monkeypatch.setattr(cutouts.os, "replace", denied)
    with pytest.raises(IrsaTransient, match="no se pudo guardar"):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert len(attempts) == 3 and all(name.endswith(".tmp") for name in attempts)
    assert cache_files(settings) == []


def test_replace_is_retried_while_windows_holds_the_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    real_replace = os.replace
    calls = 0

    def flaky(source: Any, target: Any) -> None:
        nonlocal calls
        calls += 1
        if calls < 3:
            raise PermissionError(13, "Acceso denegado")
        real_replace(source, target)

    monkeypatch.setattr(cutouts, "_REPLACE_WAITS_S", (0.0, 0.0, 0.0))
    monkeypatch.setattr(cutouts.os, "replace", flaky)
    path = tmp_path / "cutouts" / "recorte.fits"
    cutouts._write_atomic(path, CUTOUT)
    assert calls == 3 and path.read_bytes() == CUTOUT
    assert [item.name for item in path.parent.iterdir()] == ["recorte.fits"]


def test_disk_error_while_writing_leaves_nothing(
    stub: IrsaStub, settings: Settings, exposure: Exposure, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub.routes[path_of(exposure)] = serve(RESPONSE)

    def full_disk(source: Any, target: Any) -> None:
        raise OSError(28, "No queda espacio en el dispositivo")

    monkeypatch.setattr(cutouts.os, "replace", full_disk)
    with pytest.raises(IrsaTransient, match="no se pudo guardar"):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert cache_files(settings) == []
    monkeypatch.undo()
    # Sin el problema de disco, el mismo pedido funciona.
    assert fetch_cutout(exposure, RA, DEC, SIDE, settings).path.read_bytes() == CUTOUT


# ---------------------------------------------------------------- tope de disco


def fill_cache(settings: Settings, sizes: dict[str, int], ages_s: dict[str, float]) -> None:
    settings.cutout_cache_dir.mkdir(parents=True, exist_ok=True)
    now = time.time()
    for name, size in sizes.items():
        path = settings.cutout_cache_dir / name
        path.write_bytes(b"\0" * size)
        os.utime(path, (now - ages_s[name], now - ages_s[name]))


def test_prune_removes_the_least_recently_used(tmp_path: Path) -> None:
    settings = Settings(cache_dir=tmp_path / "cache")
    names = [f"recorte_{i}_img.fits" for i in range(10)]
    # recorte_0 es el mas viejo y recorte_9 el mas nuevo; 1000 bytes cada uno.
    fill_cache(settings, {name: 1000 for name in names}, {name: 10_000.0 - 1000.0 * i for i, name in enumerate(names)})

    # Por debajo del tope no borra nada.
    assert prune_cutout_cache(settings, max_bytes=10_000) == cutouts.PruneResult(0, 0, 10_000)
    assert cache_files(settings) == names

    # Por encima, borra los mas viejos hasta quedar en el 90 % del tope.
    result = prune_cutout_cache(settings, max_bytes=8_000)
    assert result == cutouts.PruneResult(files_removed=3, bytes_removed=3000, bytes_kept=7000)
    assert cache_files(settings) == names[3:]

    # Usar un recorte lo salva: fetch_cutout le actualiza la fecha.
    os.utime(settings.cutout_cache_dir / names[3])
    result = prune_cutout_cache(settings, max_bytes=5_000, min_age_s=0.0)
    assert result.files_removed == 3 and result.bytes_kept == 4000
    assert cache_files(settings) == [names[3], *names[7:]]


def test_prune_uses_the_limit_from_settings(tmp_path: Path) -> None:
    settings = Settings(cache_dir=tmp_path / "cache", cutout_cache_max_gb=3000 / 1024**3)
    fill_cache(settings, {"a_img.fits": 2000, "b_img.fits": 2000}, {"a_img.fits": 9000.0, "b_img.fits": 8000.0})
    assert prune_cutout_cache(settings).files_removed == 1
    assert cache_files(settings) == ["b_img.fits"]
    assert Settings().cutout_cache_max_gb > 1.0
    # Con un tope de cero o negativo, no borra.
    off = Settings(cache_dir=tmp_path / "cache", cutout_cache_max_gb=0.0)
    assert prune_cutout_cache(off) == cutouts.PruneResult(0, 0, 2000)


def test_prune_spares_what_was_used_recently(tmp_path: Path) -> None:
    settings = Settings(cache_dir=tmp_path / "cache")
    fill_cache(
        settings,
        {"viejo_img.fits": 1000, "reciente_img.fits": 1000, "nuevo_img.fits": 1000},
        {"viejo_img.fits": 5000.0, "reciente_img.fits": 300.0, "nuevo_img.fits": 5.0},
    )
    # Aunque la cache quede por encima del tope: lo usado en los ultimos 10 minutos puede estar en uso.
    result = prune_cutout_cache(settings, max_bytes=500)
    assert result == cutouts.PruneResult(files_removed=1, bytes_removed=1000, bytes_kept=2000)
    assert cache_files(settings) == ["nuevo_img.fits", "reciente_img.fits"]


def test_prune_only_touches_cutouts_in_its_folder(tmp_path: Path) -> None:
    settings = Settings(cache_dir=tmp_path / "cache")
    fill_cache(
        settings,
        {"a_img.fits": 1000, "b_full.fits": 1000, "notas.txt": 5000, "a_img.fits.1.2.abc.tmp": 700, "viejo.tmp": 700},
        {"a_img.fits": 9000.0, "b_full.fits": 8000.0, "notas.txt": 9999.0, "a_img.fits.1.2.abc.tmp": 60.0,
         "viejo.tmp": 7200.0},
    )  # fmt: skip
    nested = settings.cutout_cache_dir / "subcarpeta"
    nested.mkdir()
    (nested / "c_img.fits").write_bytes(b"\0" * 4000)
    outside = [settings.cache_dir / "fields" / "plano.fits", settings.sia_cache_dir / "lista.xml", tmp_path / "x.fits"]
    for path in outside:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"\0" * 4000)
        os.utime(path, (1.0, 1.0))

    result = prune_cutout_cache(settings, max_bytes=1)
    # Solo cuentan y se borran los .fits sueltos de la carpeta de recortes.
    assert result == cutouts.PruneResult(files_removed=2, bytes_removed=2000, bytes_kept=0)
    # Un temporal de hace mas de una hora es de un proceso que murio; uno reciente puede estar escribiendose.
    assert cache_files(settings) == ["a_img.fits.1.2.abc.tmp", "notas.txt", "subcarpeta"]
    assert (nested / "c_img.fits").stat().st_size == 4000
    assert all(path.stat().st_size == 4000 for path in outside)


def test_prune_without_a_cache_folder_does_nothing(tmp_path: Path) -> None:
    settings = Settings(cache_dir=tmp_path / "no-existe")
    assert prune_cutout_cache(settings) == cutouts.PruneResult(0, 0, 0)
    assert not settings.cache_dir.exists()


def test_prune_skips_a_file_that_cannot_be_removed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(cache_dir=tmp_path / "cache")
    fill_cache(settings, {"a_img.fits": 1000, "b_img.fits": 1000}, {"a_img.fits": 9000.0, "b_img.fits": 8000.0})
    real_unlink = os.unlink

    def unlink(path: Any) -> None:
        if str(path).endswith("a_img.fits"):
            raise PermissionError(13, "lo esta leyendo otro hilo")  # lo que pasa en Windows
        real_unlink(path)

    monkeypatch.setattr(cutouts.os, "unlink", unlink)
    result = prune_cutout_cache(settings, max_bytes=500)
    assert result == cutouts.PruneResult(files_removed=1, bytes_removed=1000, bytes_kept=1000)
    assert cache_files(settings) == ["a_img.fits"]


def old_fixtures_in_the_cache(settings: Settings, stub: IrsaStub, count: int) -> list[Exposure]:
    """Copia `count` recortes reales a la cache, usados por ultima vez hace una hora, y devuelve sus exposiciones."""
    settings.cutout_cache_dir.mkdir(parents=True, exist_ok=True)
    old = time.time() - 3600.0
    for position, entry in enumerate(INDEX["cutouts"][:count]):
        path = settings.cutout_cache_dir / entry["file"]
        shutil.copyfile(CUTOUTS_DIR / entry["file"], path)
        os.utime(path, (old + position, old + position))
    return [exposure_from_entry(entry, stub.base_url) for entry in INDEX["cutouts"][:count]]


def test_prune_spares_a_cutout_handed_out_after_it_listed_the_folder(
    stub: IrsaStub, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Otro trabajo recibe el recorte mas viejo de la cache justo despues de que prune listo la carpeta."""
    exposures = old_fixtures_in_the_cache(settings, stub, 3)
    handed: list[CutoutFile] = []
    real_scandir = os.scandir

    class Listing:
        def __init__(self, folder: Any) -> None:
            self._entries = real_scandir(folder)

        def __enter__(self) -> Any:
            return self._entries.__enter__()

        def __exit__(self, *error: Any) -> None:
            self._entries.__exit__(*error)
            # La carpeta ya esta listada, con la fecha vieja de los tres. Ahora se entrega el primero.
            handed.append(fetch_cutout(exposures[0], RA, DEC, SIDE, settings))

    monkeypatch.setattr(cutouts.os, "scandir", Listing)
    result = prune_cutout_cache(settings, max_bytes=len(CUTOUT))
    monkeypatch.undo()

    assert handed[0].from_cache and len(stub.hits) == 0
    # Prune volvio a mirar la fecha antes de borrar: el recien entregado sigue ahi.
    assert handed[0].path.read_bytes() == (CUTOUTS_DIR / INDEX["cutouts"][0]["file"]).read_bytes()
    assert result == cutouts.PruneResult(files_removed=2, bytes_removed=2 * len(CUTOUT), bytes_kept=len(CUTOUT))
    assert cache_files(settings) == [INDEX["cutouts"][0]["file"]]


def test_prune_counts_out_a_file_that_someone_else_removed(
    stub: IrsaStub, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    old_fixtures_in_the_cache(settings, stub, 3)
    oldest = settings.cutout_cache_dir / INDEX["cutouts"][0]["file"]
    real_scandir = os.scandir

    class Listing:
        def __init__(self, folder: Any) -> None:
            self._entries = real_scandir(folder)

        def __enter__(self) -> Any:
            return self._entries.__enter__()

        def __exit__(self, *error: Any) -> None:
            self._entries.__exit__(*error)
            assert discard_cutout(oldest, settings)  # por ejemplo, el planificador descarto uno que no se leia

    monkeypatch.setattr(cutouts.os, "scandir", Listing)
    result = prune_cutout_cache(settings, max_bytes=int(2.5 * len(CUTOUT)))
    monkeypatch.undo()
    # Sin ese ya quedaba por debajo del objetivo (90 % del tope): no borra ninguno, y lo que quedo son dos recortes.
    assert result == cutouts.PruneResult(files_removed=0, bytes_removed=0, bytes_kept=2 * len(CUTOUT))
    assert len(cache_files(settings)) == 2


def test_no_cutout_handed_out_disappears_while_prune_runs(stub: IrsaStub, settings: Settings) -> None:
    """Tope de disco y aciertos de cache a la vez, en hilos: lo que `fetch_cutout` entrega no se borra.

    Con el tope en un recorte, prune quiere borrar todo. Empieza por 200
    archivos de relleno mas viejos, y mientras los borra otros hilos reciben de
    la cache los recortes reales, que prune ya listo con su fecha vieja. Lo
    entregado queda protegido por su fecha nueva; lo que prune llego a borrar
    antes se vuelve a bajar. Nunca queda una ruta entregada que no exista.
    """
    stub.default = serve(RESPONSE)
    count, filler = len(INDEX["cutouts"]), 200
    handed_from_cache = 0
    for _ in range(5):
        exposures = old_fixtures_in_the_cache(settings, stub, count)
        older = time.time() - 7200.0
        for i in range(filler):
            path = settings.cutout_cache_dir / f"relleno_{i:03d}_img.fits"
            path.write_bytes(b"SIMPLE  =".ljust(2880))
            os.utime(path, (older + i, older + i))
        barrier = threading.Barrier(count + 1, timeout=10.0)

        def fetch(exposure: Exposure, barrier: threading.Barrier = barrier) -> CutoutFile:
            barrier.wait()
            return fetch_cutout(exposure, RA, DEC, SIDE, settings)

        def prune(barrier: threading.Barrier = barrier) -> cutouts.PruneResult:
            barrier.wait()
            return prune_cutout_cache(settings, max_bytes=len(CUTOUT))

        with ThreadPoolExecutor(max_workers=count + 1) as pool:
            pruning = pool.submit(prune)
            results = list(pool.map(fetch, exposures))
            pruned = pruning.result()

        missing = [result.path.name for result in results if not result.path.is_file()]
        assert missing == [], f"prune borro recortes recien entregados: {missing}"
        # Cada recorte o se entrego de la cache o se volvio a bajar despues de que prune lo borrara.
        assert pruned.files_removed == filler + sum(not result.from_cache for result in results)
        assert len(cache_files(settings)) == count
        handed_from_cache += sum(result.from_cache for result in results)
    # El caso que importa ocurrio de verdad: hubo recortes entregados mientras prune borraba.
    assert handed_from_cache > 0


def test_downloaded_cutouts_are_pruned_like_any_other(stub: IrsaStub, settings: Settings, exposure: Exposure) -> None:
    stub.routes[path_of(exposure)] = serve(RESPONSE)
    result = fetch_cutout(exposure, RA, DEC, SIDE, settings)
    assert prune_cutout_cache(settings, max_bytes=1000).files_removed == 0  # recien usado
    assert prune_cutout_cache(settings, max_bytes=1000, min_age_s=0.0).files_removed == 1
    assert not result.path.exists()
    # Borrado de la cache, se vuelve a bajar.
    assert not fetch_cutout(exposure, RA, DEC, SIDE, settings).from_cache
    assert len(stub.hits) == 2
