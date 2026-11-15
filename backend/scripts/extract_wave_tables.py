"""Arma `app/spectrum/data/wcs_wave.json` a partir de recortes completos de SPHEREx.

La tabla WCS-WAVE viene despues de EPSF y la descarga cortada no la trae
(SPEC.md, seccion 3.2). Como resulto identica en todas las exposiciones de un
mismo detector, alcanza con sacarla una vez de un recorte completo por detector
y guardarla en el repositorio. Este script hace eso con los recortes `_full`
que haya en una carpeta (por defecto, los de la Etapa 0 en spike/cache), y
falla si dos archivos del mismo detector traen tablas distintas.

Uso, desde backend/:
    uv run python scripts/extract_wave_tables.py            # escribe el JSON
    uv run python scripts/extract_wave_tables.py --check    # ademas compara con astropy

No usa la red.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import warnings
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from app.spectrum.wavelength import (  # noqa: E402
    WAVE_TABLE_PATH,
    WaveTable,
    processing_version,
    wavelength_at,
)

DEFAULT_CUTOUTS = BACKEND_DIR.parent / "spike" / "cache" / "cutouts"
# Extension y columnas, segun las tarjetas PSn_mW del encabezado de IMAGE
# (PS1_0W = 'WCS-WAVE', PS1_1W = 'VALUES', PS1_2W = 'X', PS2_2W = 'Y').
EXTENSION = "WCS-WAVE"


def read_table(path: Path) -> tuple[int, WaveTable]:
    with fits.open(path, memmap=False) as hdul:
        detector = int(hdul["IMAGE"].header["DETECTOR"])
        table = hdul[EXTENSION].data
        values = np.asarray(table["VALUES"][0], dtype=np.float64)
        return detector, WaveTable(
            detector=detector,
            x=np.asarray(table["X"][0], dtype=np.float64),
            y=np.asarray(table["Y"][0], dtype=np.float64),
            wavelength=values[..., 0],
            bandwidth=values[..., 1],
        )


def same(a: WaveTable, b: WaveTable) -> bool:
    return (
        np.array_equal(a.x, b.x)
        and np.array_equal(a.y, b.y)
        and np.array_equal(a.wavelength, b.wavelength)
        and np.array_equal(a.bandwidth, b.bandwidth)
    )


def check_against_astropy(path: Path, table: WaveTable, rng: np.random.Generator, samples: int = 25) -> float:
    """Mayor diferencia en um entre la interpolacion propia y la de astropy/wcslib en pixeles al azar."""
    worst = 0.0
    with fits.open(path, memmap=False) as hdul, warnings.catch_warnings():
        warnings.simplefilter("ignore")
        header = hdul["IMAGE"].header
        wave_wcs = WCS(header, fobj=hdul, key="W")
        wave_wcs.sip = None
        ny, nx = hdul["IMAGE"].data.shape
        xs = rng.uniform(0, nx - 1, samples)
        ys = rng.uniform(0, ny - 1, samples)
        expected_wave, expected_band = wave_wcs.all_pix2world(xs, ys, 0)
        for x, y, wave, band in zip(xs, ys, expected_wave, expected_band, strict=True):
            got_wave, got_band = wavelength_at(table, header, float(x), float(y))
            worst = max(worst, abs(got_wave - float(wave)), abs(got_band - float(band)))
    return worst


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cutouts", type=Path, default=DEFAULT_CUTOUTS, help="carpeta con recortes *_full.fits")
    parser.add_argument("--output", type=Path, default=WAVE_TABLE_PATH)
    parser.add_argument("--check", action="store_true", help="comparar la interpolacion con astropy")
    args = parser.parse_args()
    logging.getLogger("astropy").setLevel(logging.ERROR)

    paths = sorted(args.cutouts.glob("*_full.fits"))
    if not paths:
        print(f"No hay recortes completos (*_full.fits) en {args.cutouts}")
        return 1

    tables: dict[int, WaveTable] = {}
    origin: dict[int, str] = {}
    counts: dict[int, int] = {}
    versions: set[str] = set()
    for path in paths:
        detector, table = read_table(path)
        counts[detector] = counts.get(detector, 0) + 1
        version = processing_version(path.name)
        if version is not None:
            versions.add(version)
        if detector not in tables:
            tables[detector] = table
            origin[detector] = path.name.split("__", 1)[0]
        elif not same(tables[detector], table):
            print(f"D{detector}: {path.name} trae una tabla distinta de la de {origin[detector]}")
            return 1

    missing = [detector for detector in range(1, 7) if detector not in tables]
    if missing:
        print(f"Faltan recortes completos de los detectores {missing}")
        return 1

    if args.check:
        rng = np.random.default_rng(2026)
        worst = 0.0
        for path in paths:
            detector, _ = read_table(path)
            worst = max(worst, check_against_astropy(path, tables[detector], rng))
        print(f"Diferencia maxima con astropy en {len(paths)} recortes: {worst:.3e} um")
        if worst > 1e-6:
            print("La interpolacion propia no coincide con la de astropy")
            return 1

    document = {
        "description": "Tabla WCS-WAVE de SPHEREx por detector: longitud de onda central y ancho de banda (um) "
        "sobre puntos de control en pixeles del detector contados desde 1.",
        "source": "Extension WCS-WAVE de recortes de nivel 2 servidos por IRSA "
        "(https://irsa.ipac.caltech.edu, colecciones spherex_dr1 y spherex_qr3)",
        "processing": sorted(versions)[0] if len(versions) == 1 else None,
        "processing_versions": sorted(versions),
        "files_compared": {str(detector): counts[detector] for detector in sorted(counts)},
        "detectors": {
            str(detector): {
                "extracted_from": origin[detector],
                "x": tables[detector].x.tolist(),
                "y": tables[detector].y.tolist(),
                "wavelength": tables[detector].wavelength.tolist(),
                "bandwidth": tables[detector].bandwidth.tolist(),
            }
            for detector in sorted(tables)
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(document, indent=1) + "\n", encoding="utf-8")
    for detector in sorted(tables):
        low, high = tables[detector].wave_range
        print(f"D{detector}: {counts[detector]} recortes iguales, {low:.3f} a {high:.3f} um")
    print(f"Escrito {args.output}")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    raise SystemExit(main())
