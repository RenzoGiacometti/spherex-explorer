"""Recortes leidos por rangos de un archivo completo, contra un servidor local que hace de bucket. Sin red.

El "archivo completo" se arma con un recorte real de tests/fixtures/cutouts:
sus cuatro imagenes, con FLAGS comprimido como en un nivel 2 real (RICE_1, una
fila por tesela; app/irsa/s3.py), mas EPSF y WCS-WAVE sinteticos al final. Mide
58 x 59 pixeles en vez de 2040 x 2040, pero tiene los encabezados reales.
"""

from __future__ import annotations

import io
import re
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
import pytest
from astropy.io import fits
from test_irsa_support import (
    CUTOUTS_DIR,
    IMAGE_HDUS,
    Behaviour,
    Hit,
    IrsaStub,
    cutout_index,
    epsf_extension,
    exposure_from_entry,
    extension_bytes,
    irsa_response,
    respond,
    serve,
    split_hdus,
    wcs_wave_extension,
)

from app import geometry
from app.config import Settings
from app.domain import Exposure
from app.irsa import s3
from app.irsa.cutouts import IrsaBusy, IrsaPermanent, fetch_cutout
from app.irsa.limits import reset_limiter
from app.pipeline.exposure import load_exposure

INDEX = cutout_index()
ENTRY = INDEX["cutouts"][0]
RA, DEC = INDEX["center"]["ra"], INDEX["center"]["dec"]
FIXTURE = CUTOUTS_DIR / ENTRY["file"]
CUTOUT = FIXTURE.read_bytes()
# Lado que entra entero, con el margen, en los 58 x 59 pixeles del "archivo completo".
SIDE = 0.04
FILE_PATH = urlsplit(ENTRY["url"]).path.removeprefix("/ibe/data/spherex")


def full_file(compressed_flags: bool = True) -> bytes:
    """El recorte guardado, como si fuera el archivo completo de la exposicion."""
    parts = dict(split_hdus(CUTOUT))
    if compressed_flags:
        with fits.open(io.BytesIO(CUTOUT), memmap=False) as hdul:
            flags = hdul["FLAGS"]
            packed = fits.CompImageHDU(
                data=np.array(flags.data, dtype=np.int32),
                header=flags.header,
                name="FLAGS",
                compression_type="RICE_1",
                tile_shape=(1, flags.data.shape[1]),
            )
            parts["FLAGS"] = extension_bytes(packed)
    parts["EPSF"] = epsf_extension(megabytes=0.5)
    parts["WCS-WAVE"] = wcs_wave_extension()
    return b"".join(parts[name] for name in ("PRIMARY", *IMAGE_HDUS, "EPSF", "WCS-WAVE"))


def ranged(body: bytes) -> Behaviour:
    """Responde 206 con el tramo pedido en `Range`, como S3; sin `Range`, 200 con todo."""

    def behaviour(handler: object, hit: Hit) -> None:
        match = re.fullmatch(r"bytes=(\d+)-(\d+)", hit.headers.get("range", ""))
        if match is None:
            respond(200, body, content_type="application/fits")(handler, hit)  # type: ignore[arg-type]
            return
        start, end = int(match.group(1)), min(int(match.group(2)), len(body) - 1)
        piece = body[start : end + 1]
        headers = {"Content-Range": f"bytes {start}-{end}/{len(body)}"}
        respond(206, piece, headers=headers, content_type="application/fits")(handler, hit)  # type: ignore[arg-type]

    return behaviour


@pytest.fixture(autouse=True)
def _fresh_state() -> Iterator[None]:
    reset_limiter()
    s3.reset()
    yield
    reset_limiter()
    s3.reset()


@pytest.fixture
def stub() -> Iterator[IrsaStub]:
    server = IrsaStub()
    try:
        yield server
    finally:
        server.close()


def make_settings(tmp_path: Path, stub: IrsaStub, source: str) -> Settings:
    return Settings(
        cache_dir=tmp_path / "cache",
        irsa_connect_timeout_s=5.0,
        irsa_read_timeout_s=10.0,
        cutout_source=source,
        s3_base_url=stub.url("/bucket"),
        irsa_data_prefix=stub.url("/ibe/data/spherex/"),
    )


@pytest.fixture
def exposure(stub: IrsaStub) -> Exposure:
    return exposure_from_entry(ENTRY, stub.base_url)


def bucket_path() -> str:
    return "/bucket" + FILE_PATH


def irsa_path(exposure: Exposure) -> str:
    return urlsplit(exposure.url).path


def assert_is_window_of_fixture(payload: bytes) -> None:
    """Cada extension es una ventana del recorte guardado: mismos pixeles y mismo encabezado, salvo tamano y CRPIX."""
    moved = {"NAXIS1", "NAXIS2", "CRPIX1", "CRPIX2", "CRPIX1A", "CRPIX2A", "CRPIX1W", "CRPIX2W"}
    with fits.open(io.BytesIO(payload), memmap=False) as got, fits.open(FIXTURE, memmap=False) as reference:
        assert [hdu.name for hdu in got] == ["PRIMARY", *IMAGE_HDUS]
        offsets = set()
        for name in IMAGE_HDUS:
            mine, theirs = got[name], reference[name]
            dx = round(theirs.header["CRPIX1"] - mine.header["CRPIX1"])
            dy = round(theirs.header["CRPIX2"] - mine.header["CRPIX2"])
            offsets.add((dx, dy))
            ny, nx = mine.data.shape
            assert 0 < nx < theirs.data.shape[1] and 0 < ny < theirs.data.shape[0]
            assert mine.data.dtype == theirs.data.dtype
            assert np.array_equal(mine.data, theirs.data[dy : dy + ny, dx : dx + nx], equal_nan=True)
            for axis, shift in (("1", dx), ("2", dy)):
                for version in ("", "A", "W"):
                    key = f"CRPIX{axis}{version}"
                    assert mine.header[key] == pytest.approx(theirs.header[key] - shift)
            keys = {key for key in (*mine.header, *theirs.header) if key not in ("COMMENT", "HISTORY", "")}
            assert {key for key in keys if mine.header.get(key) != theirs.header.get(key)} <= moved
        assert len(offsets) == 1  # las cuatro extensiones, la misma ventana


@pytest.mark.parametrize("compressed", [True, False])
def test_read_cutout_gives_a_window_of_the_file(stub: IrsaStub, tmp_path: Path, compressed: bool) -> None:
    stub.routes[bucket_path()] = ranged(full_file(compressed))
    settings = make_settings(tmp_path, stub, "s3")

    payload, nbytes = s3.read_cutout(stub.url(bucket_path()), RA, DEC, SIDE, settings)

    assert_is_window_of_fixture(payload)
    assert 0 < nbytes < len(full_file(compressed))
    # Nunca se pide el archivo entero ni se llega a EPSF.
    assert all("range" in hit.headers for hit in stub.hits)


def test_read_cutout_matches_the_pipeline_result_of_the_irsa_cutout(stub: IrsaStub, tmp_path: Path) -> None:
    stub.routes[bucket_path()] = ranged(full_file())
    settings = make_settings(tmp_path, stub, "s3")
    payload, _ = s3.read_cutout(stub.url(bucket_path()), RA, DEC, SIDE, settings)
    path = tmp_path / "from_bucket.fits"
    path.write_bytes(payload)
    # Una grilla chica, que cae entera dentro de las dos ventanas.
    grid = geometry.make_grid(RA, DEC, 0.02, 3.075)

    mine, theirs = load_exposure(path, grid), load_exposure(FIXTURE, grid)

    assert mine.footprint.all() and theirs.footprint.all()
    assert np.array_equal(mine.flags, theirs.flags)
    assert mine.flag_bits == theirs.flag_bits
    # El fondo residual es la mediana de la ventana, que no es la misma: se compara sin el.
    assert np.allclose(mine.image + mine.background, theirs.image + theirs.background, equal_nan=True, atol=1e-5)
    assert np.allclose(mine.variance, theirs.variance, equal_nan=True)


def test_read_cutout_far_from_the_image_is_no_overlap(stub: IrsaStub, tmp_path: Path) -> None:
    stub.routes[bucket_path()] = ranged(full_file())
    settings = make_settings(tmp_path, stub, "s3")
    with pytest.raises(s3.S3NoOverlap):
        s3.read_cutout(stub.url(bucket_path()), RA + 1.0, DEC, SIDE, settings)


def test_read_cutout_missing_file_is_unavailable(stub: IrsaStub, tmp_path: Path) -> None:
    settings = make_settings(tmp_path, stub, "s3")
    with pytest.raises(s3.S3Unavailable):
        s3.read_cutout(stub.url(bucket_path()), RA, DEC, SIDE, settings)


def test_read_cutout_server_without_range_is_unavailable(stub: IrsaStub, tmp_path: Path) -> None:
    stub.routes[bucket_path()] = respond(200, full_file(), content_type="application/fits")
    settings = make_settings(tmp_path, stub, "s3")
    with pytest.raises(s3.S3Unavailable):
        s3.read_cutout(stub.url(bucket_path()), RA, DEC, SIDE, settings)


def test_s3_url_only_for_irsa_files(stub: IrsaStub, tmp_path: Path, exposure: Exposure) -> None:
    settings = make_settings(tmp_path, stub, "s3")
    assert s3.s3_url(exposure.url, settings) == stub.url(bucket_path())
    assert s3.s3_url("http://127.0.0.1:1/otra/cosa.fits", settings) is None


def test_fetch_cutout_source_s3_does_not_touch_irsa(stub: IrsaStub, tmp_path: Path, exposure: Exposure) -> None:
    stub.routes[bucket_path()] = ranged(full_file())
    settings = make_settings(tmp_path, stub, "s3")

    cutout = fetch_cutout(exposure, RA, DEC, SIDE, settings)

    assert cutout.mode == "truncated" and not cutout.from_cache and cutout.nbytes > 0
    assert_is_window_of_fixture(cutout.path.read_bytes())
    assert all(hit.path == bucket_path() for hit in stub.hits)
    # La segunda vez sale de la cache.
    hits = len(stub.hits)
    assert fetch_cutout(exposure, RA, DEC, SIDE, settings).from_cache
    assert len(stub.hits) == hits


def test_fetch_cutout_source_s3_falls_back_to_irsa(stub: IrsaStub, tmp_path: Path, exposure: Exposure) -> None:
    stub.routes[irsa_path(exposure)] = serve(irsa_response(CUTOUT))
    settings = make_settings(tmp_path, stub, "s3")

    cutout = fetch_cutout(exposure, RA, DEC, SIDE, settings)

    assert cutout.mode == "truncated"
    assert [hit.path for hit in stub.hits] == [bucket_path(), irsa_path(exposure)]


def test_fetch_cutout_auto_uses_irsa_when_it_answers(stub: IrsaStub, tmp_path: Path, exposure: Exposure) -> None:
    stub.routes[irsa_path(exposure)] = serve(irsa_response(CUTOUT))
    stub.routes[bucket_path()] = ranged(full_file())
    settings = make_settings(tmp_path, stub, "auto")

    fetch_cutout(exposure, RA, DEC, SIDE, settings)

    assert [hit.path for hit in stub.hits] == [irsa_path(exposure)]


def test_fetch_cutout_auto_goes_to_the_bucket_when_irsa_is_busy(
    stub: IrsaStub, tmp_path: Path, exposure: Exposure
) -> None:
    stub.routes[irsa_path(exposure)] = respond(503, b"Server busy, retry later.", headers={"Retry-After": "5"})
    stub.routes[bucket_path()] = ranged(full_file())
    settings = make_settings(tmp_path, stub, "auto")

    cutout = fetch_cutout(exposure, RA, DEC, SIDE, settings)

    assert_is_window_of_fixture(cutout.path.read_bytes())
    assert stub.hits[0].path == irsa_path(exposure)
    assert all(hit.path == bucket_path() for hit in stub.hits[1:])


def test_fetch_cutout_auto_reports_irsa_busy_when_the_bucket_fails_too(
    stub: IrsaStub, tmp_path: Path, exposure: Exposure
) -> None:
    stub.routes[irsa_path(exposure)] = respond(503, b"Server busy, retry later.", headers={"Retry-After": "5"})
    settings = make_settings(tmp_path, stub, "auto")

    with pytest.raises(IrsaBusy) as raised:
        fetch_cutout(exposure, RA, DEC, SIDE, settings)

    assert raised.value.retry_after == 5.0
    assert not list(settings.cutout_cache_dir.glob("*")) if settings.cutout_cache_dir.exists() else True


def test_fetch_cutout_source_irsa_never_asks_the_bucket(stub: IrsaStub, tmp_path: Path, exposure: Exposure) -> None:
    stub.routes[irsa_path(exposure)] = respond(503, b"Server busy, retry later.", headers={"Retry-After": "5"})
    stub.routes[bucket_path()] = ranged(full_file())
    settings = make_settings(tmp_path, stub, "irsa")

    with pytest.raises(IrsaBusy):
        fetch_cutout(exposure, RA, DEC, SIDE, settings)

    assert [hit.path for hit in stub.hits] == [irsa_path(exposure)]


def test_fetch_cutout_no_overlap_is_permanent(stub: IrsaStub, tmp_path: Path, exposure: Exposure) -> None:
    stub.routes[bucket_path()] = ranged(full_file())
    settings = make_settings(tmp_path, stub, "s3")
    with pytest.raises(IrsaPermanent):
        fetch_cutout(exposure, RA + 1.0, DEC, SIDE, settings)


def test_bucket_is_left_alone_after_repeated_failures() -> None:
    assert s3.available()
    for _ in range(8):
        s3.report(False)
    assert not s3.available()
    s3.reset()
    assert s3.available()


def test_a_success_clears_the_failure_count() -> None:
    for _ in range(7):
        s3.report(False)
    s3.report(True)
    for _ in range(7):
        s3.report(False)
    assert s3.available()
