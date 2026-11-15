"""Cuanto pesa y cuanto tarda un recorte segun su lado?

Etapa 1, fase A (descartable). Baja un mismo archivo con lados crecientes,
cortando antes de EPSF como en irsa.py, para fijar en el contrato que campos de
vision son viables. Una sola conexion a la vez.

Uso: uv run python explore_cutout_sizes.py
"""

from __future__ import annotations

import io
import sys
import time

import requests
from astropy.io import fits

from irsa import _read_until

# Archivo y posicion del tutorial oficial de cutouts (M101, detector 2).
BASE = (
    "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W21_2C/l2b-v27-2026-199/2/"
    "level2_2025W21_2C_0401_1D2_spx_l2b-v27-2026-199.fits"
)
RA, DEC = 210.80227, 54.34895

# Lado del recorte para cubrir un campo cuadrado con cualquier giro: fov * raiz(2) + 4 px.
MARGIN_DEG = 4 * 6.15 / 3600
CASES = {"5'": 5 / 60, "10'": 10 / 60, "20'": 20 / 60, "30'": 30 / 60, "1 grado": 1.0}


def main() -> None:
    print(f"{'campo':<8} {'lado pedido':>12} {'px':>10} {'bytes':>10} {'primer byte':>12} {'total':>8}")
    for label, fov in CASES.items():
        size = fov * 2**0.5 + MARGIN_DEG
        url = f"{BASE}?center={RA},{DEC}d&size={size:.5f}"
        for attempt in range(1, 6):
            t0 = time.perf_counter()
            with requests.get(url, stream=True, timeout=(15, 300), headers={"Accept-Encoding": "identity"}) as resp:
                if resp.status_code == 503:
                    time.sleep(float(resp.headers.get("Retry-After", "5")) + 1)
                    continue
                first = time.perf_counter() - t0
                if resp.status_code != 200:
                    print(f"{label:<8} HTTP {resp.status_code}: {resp.text[:120]!r}")
                    break
                payload = _read_until(resp.raw, "EPSF")
            total = time.perf_counter() - t0
            with fits.open(io.BytesIO(payload)) as hdul:
                ny, nx = hdul["IMAGE"].data.shape
            print(f"{label:<8} {size:>10.4f} d {nx:>5}x{ny:<4} {len(payload) / 1e3:>8.0f} k {first:>10.2f} s {total:>6.2f} s  (intento {attempt})", flush=True)
            break


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
