"""Verificacion de los puntos [VERIFICAR] de SPEC.md contra IRSA (Etapa 0).

1. Escala de pixel: columna `s_pixel_scale` de `spherex.obscore` (nombre tomado
   de TAP_SCHEMA, leida por SIA2), contrastada con la escala que sale del WCS
   de un archivo real.
2. Formato de la URL de recorte: `<uri>?center=<ra>,<dec>d&size=<valor>`, segun
   el tutorial oficial https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts/

El archivo de prueba es uno de los que lista la salida de ese tutorial (M101, D2).

Uso: uv run python verify.py
"""

from __future__ import annotations

import io
import logging
import sys
import time
import warnings
from collections import Counter
from pathlib import Path

import numpy as np
import requests
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning
from astropy.wcs.utils import proj_plane_pixel_scales

from irsa import IrsaError, sia_query

IRSA = "https://irsa.ipac.caltech.edu/"
CACHE_DIR = Path(__file__).resolve().parent / "cache"

# URI y posicion tomados de la salida publicada del tutorial de cutouts (M101, detector 2).
TEST_URI = (
    "ibe/data/spherex/dr1/level2/2025W21_2C/l2b-v27-2026-199/2/"
    "level2_2025W21_2C_0401_1D2_spx_l2b-v27-2026-199.fits"
)
TEST_RA, TEST_DEC = 210.80227, 54.34895

SIZE_VARIANTS = ["0.1", "0.1deg", "6arcmin", "360arcsec", "59px", "0.05", "0.1,0.05"]


def check_pixel_scale_sia() -> None:
    """Lee `s_pixel_scale` por SIA2, que expone las columnas ObsCore de `spherex.obscore`.

    No se hace por TAP: el 2026-11-15 las consultas espaciales de SPHEREx en TAP
    agotaban el tiempo de espera (ver check_tap.py).
    """
    print("== 1a. Escala de pixel segun ObsCore (SIA2) ==")
    wanted = ("obs_collection", "s_pixel_scale", "s_fov", "s_xel1", "s_xel2", "s_resolution")
    for collection in ("spherex_dr1", "spherex_qr3"):
        t0 = time.perf_counter()
        try:
            rows, _ = sia_query(TEST_RA, TEST_DEC, collection, CACHE_DIR, refresh=True)
        except IrsaError as exc:
            print(f"{collection}: NO VERIFICADO ({exc})")
            continue
        values = Counter(tuple(row[name] for name in wanted) for row in rows)
        print(f"{collection}: {len(rows)} imagenes en {time.perf_counter() - t0:.1f} s; {wanted}")
        for combo, n in values.items():
            print(f"    {combo}: {n} filas")


def fetch(url: str) -> tuple[fits.HDUList | None, int, float, str]:
    t0 = time.perf_counter()
    try:
        resp = requests.get(url, timeout=(15, 120))
    except requests.RequestException as exc:
        return None, 0, time.perf_counter() - t0, f"{type(exc).__name__}: {exc}"
    dt = time.perf_counter() - t0
    if resp.status_code != 200:
        return None, len(resp.content), dt, f"HTTP {resp.status_code}: {resp.text[:200]!r}"
    try:
        hdul = fits.open(io.BytesIO(resp.content), memmap=False)
    except OSError as exc:
        return None, len(resp.content), dt, f"no es FITS ({exc}): {resp.content[:200]!r}"
    return hdul, len(resp.content), dt, "ok"


def describe(hdul: fits.HDUList, coord: SkyCoord) -> None:
    for i, hdu in enumerate(hdul):
        shape = getattr(hdu, "shape", None) or ()
        print(f"      HDU {i}: {hdu.name:<9} {type(hdu).__name__:<13} shape={shape} BUNIT={hdu.header.get('BUNIT')}")
    header = hdul["IMAGE"].header
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        wcs = WCS(header)
    scales = proj_plane_pixel_scales(wcs.celestial) * 3600.0
    ny, nx = hdul["IMAGE"].data.shape
    x, y = wcs.world_to_pixel(coord)
    print(f"      NAXIS1 x NAXIS2 = {nx} x {ny}; CTYPE = {list(wcs.wcs.ctype)}; SIP = {wcs.sip is not None}")
    print(f"      escala WCS = {scales[0]:.4f} x {scales[1]:.4f} arcsec/px")
    print(f"      lado = {nx * scales[0] / 3600:.4f} x {ny * scales[1] / 3600:.4f} grados")
    print(f"      centro pedido cae en pixel (x={float(x):.2f}, y={float(y):.2f}); centro geometrico ({(nx - 1) / 2}, {(ny - 1) / 2})")


def check_cutout_url() -> None:
    coord = SkyCoord(TEST_RA, TEST_DEC, unit="deg")
    base = IRSA + TEST_URI

    print("\n== 1b. Escala de pixel segun el WCS del archivo completo ==")
    hdul, nbytes, dt, status = fetch(base)
    print(f"archivo completo: {status}, {nbytes / 1e6:.1f} MB en {dt:.1f} s")
    if hdul is not None:
        describe(hdul, coord)
        print("      Bits de FLAGS (MSKNnnnn / MSKDnnnn):")
        fh = hdul["FLAGS"].header
        for key in fh["MSKN*"]:
            bit = key[4:]
            print(f"        {int(bit):2d}  {fh[key]:<13} {fh.get('MSKD' + bit)}")
        ih = hdul["IMAGE"].header
        for key in ["DETECTOR", "OBSID", "DATE-OBS", "DATE-AVG", "MJD-OBS", "MJD-AVG", "EXPTIME", "XPOSURE", "PSF_FWHM"]:
            print(f"      IMAGE.{key} = {ih.get(key)}")
        print(f"      PRIMARY: {dict(hdul[0].header)}")

    print("\n== 2. Formato de la URL de recorte ==")
    for size in SIZE_VARIANTS:
        url = f"{base}?center={TEST_RA},{TEST_DEC}d&size={size}"
        hdul, nbytes, dt, status = fetch(url)
        print(f"size={size}: {status}, {nbytes / 1e3:.0f} kB en {dt:.1f} s")
        print(f"   {url}")
        if hdul is not None:
            describe(hdul, coord)

    print("\n== 2b. Variantes del parametro center ==")
    for center in [f"{TEST_RA},{TEST_DEC}", f"{TEST_RA},{TEST_DEC}deg", f"{TEST_RA}d,{TEST_DEC}d"]:
        url = f"{base}?center={center}&size=0.1"
        hdul, nbytes, dt, status = fetch(url)
        print(f"center={center}: {status}, {nbytes / 1e3:.0f} kB en {dt:.1f} s")
        if hdul is not None:
            ny, nx = hdul["IMAGE"].data.shape
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", FITSFixedWarning)
                x, y = WCS(hdul["IMAGE"].header).world_to_pixel(coord)
            print(f"      {nx} x {ny}, centro pedido en (x={float(x):.2f}, y={float(y):.2f})")

    print("\n== 2c. Recorte fuera de la imagen ==")
    url = f"{base}?center={TEST_RA + 10},{TEST_DEC}d&size=0.1"
    hdul, nbytes, dt, status = fetch(url)
    print(f"center a 10 grados: {status}, {nbytes} bytes en {dt:.1f} s")

    print("\n== 2d. Contenido de un recorte (size=0.1) ==")
    hdul, _, _, status = fetch(f"{base}?center={TEST_RA},{TEST_DEC}d&size=0.1")
    if hdul is not None:
        img = hdul["IMAGE"].data
        zodi = hdul["ZODI"].data
        var = hdul["VARIANCE"].data
        flags = hdul["FLAGS"].data
        print(f"      IMAGE dtype={img.dtype} mediana={np.nanmedian(img):.4f} NaN={int(np.isnan(img).sum())}")
        print(f"      ZODI mediana={np.nanmedian(zodi):.4f}; IMAGE-ZODI mediana={np.nanmedian(img - zodi):.4f}")
        print(f"      VARIANCE mediana={np.nanmedian(var):.6f} (sigma={np.sqrt(np.nanmedian(var)):.4f})")
        print(f"      FLAGS dtype={flags.dtype}; bits presentes:")
        fh = hdul["FLAGS"].header
        for key in fh["MSKN*"]:
            bit = int(key[4:])
            n = int(((flags >> bit) & 1).sum())
            if n:
                print(f"        {bit:2d} {fh[key]:<13} {n} px")
        print(f"      EPSF: {hdul['EPSF'].header.get('NAXIS2')} filas; WCS-WAVE: {hdul['WCS-WAVE'].columns.names}")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            wave_wcs = WCS(hdul["IMAGE"].header, fobj=hdul, key="W")
            wave_wcs.sip = None
            ny, nx = img.shape
            wl, bw = wave_wcs.pixel_to_world((nx - 1) / 2, (ny - 1) / 2)
        print(f"      longitud de onda en el centro = {wl.to('um'):.4f}, ancho = {bw.to('um'):.4f}")
    else:
        print(f"      {status}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    logging.getLogger("astropy").setLevel(logging.ERROR)
    check_pixel_scale_sia()
    check_cutout_url()
