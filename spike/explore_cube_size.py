"""Cuanto pesa el cubo en Float32 crudo y cuanto se gana con gzip?

Etapa 1, fase A (descartable). Sirve para fijar en el contrato la disposicion
binaria y el tamano por campo de vision.

Uso: uv run python explore_cube_size.py barnard wise0855
"""

from __future__ import annotations

import gzip
import sys
import time
from pathlib import Path

import numpy as np
from astropy.io import fits

OUT = Path(__file__).parent / "out"


def main() -> None:
    for label in sys.argv[1:]:
        with fits.open(OUT / label / "cubo.fits") as hdul:
            cube = np.ascontiguousarray(hdul[0].data, dtype="<f4")
            coverage = np.ascontiguousarray(hdul["COVERAGE"].data, dtype="<u2")
        raw = cube.tobytes()
        planes = cube.shape[0] * cube.shape[1]
        print(f"== {label}: forma {cube.shape}, {planes} planos de {cube.shape[2]} x {cube.shape[3]}")
        print(f"   Float32 crudo: {len(raw) / 1e6:.2f} MB ({len(raw) / planes / 1e3:.1f} kB por plano); NaN {np.isnan(cube).mean():.1%}")
        for level in (1, 6, 9):
            t0 = time.perf_counter()
            packed = gzip.compress(raw, compresslevel=level)
            print(f"   gzip nivel {level}: {len(packed) / 1e6:.2f} MB ({len(packed) / len(raw):.0%}) en {(time.perf_counter() - t0) * 1e3:.0f} ms")
        cov = coverage.tobytes()
        print(f"   cobertura Uint16: {len(cov) / 1e6:.2f} MB crudo, {len(gzip.compress(cov, compresslevel=6)) / 1e6:.2f} MB con gzip")
        # Float16 como alternativa: cuanto error introduce frente al ruido del plano.
        finite = np.isfinite(cube)
        half = cube.astype("<f2").astype("<f4")
        error = np.abs(half - cube)[finite]
        sigma = np.array([1.4826 * np.median(np.abs(p[np.isfinite(p)] - np.median(p[np.isfinite(p)]))) for e in cube for p in e if np.isfinite(p).any()])
        print(f"   Float16: error maximo {error.max():.2e}, mediano {np.median(error):.2e} MJy/sr; ruido tipico por plano (MAD) {np.median(sigma):.2e}; desbordes {int(np.isinf(half[finite]).sum())}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
