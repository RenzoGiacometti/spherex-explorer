"""La tabla WCS-WAVE, es la misma para todas las exposiciones de un detector?

Etapa 0, descartable. Mira los recortes completos que haya en cache
(`field.py --full`). Importa para la Etapa 2: si WCS-WAVE es fija por detector,
alcanza con bajarla una vez y cortar todas las demas descargas antes de EPSF.

Uso: uv run python explore_wcswave.py
"""

from __future__ import annotations

import logging
import sys
import warnings
from collections import defaultdict
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

CUTOUTS = Path(__file__).parent / "cache" / "cutouts"


def main() -> None:
    logging.getLogger("astropy").setLevel(logging.ERROR)
    by_detector: dict[int, list[tuple[str, dict[str, np.ndarray], dict[str, object], float]]] = defaultdict(list)
    for path in sorted(CUTOUTS.glob("*_full.fits")):
        with fits.open(path, memmap=False) as hdul:
            header = hdul["IMAGE"].header
            table = hdul["WCS-WAVE"].data
            columns = {name: np.array(table[name][0]) for name in table.names}
            w_keys = {k: header[k] for k in header if k.endswith("W") and k[:5] in ("CTYPE", "CRPIX", "CRVAL", "CDELT", "CUNIT", "PS1_0", "PS1_1", "PS1_2", "PS2_0", "PS2_1", "PS2_2", "PV1_3", "PV2_3", "PC1_1", "PC1_2", "PC2_1", "PC2_2", "WCSNA")}
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                wave_wcs = WCS(header, fobj=hdul, key="W")
                wave_wcs.sip = None
                ny, nx = hdul["IMAGE"].data.shape
                wavelength, _ = wave_wcs.pixel_to_world((nx - 1) / 2, (ny - 1) / 2)
            by_detector[int(header["DETECTOR"])].append((path.name, columns, w_keys, float(wavelength.to_value("um"))))

    if not by_detector:
        print("No hay recortes completos en cache; correr field.py con --full.")
        return
    for detector, items in sorted(by_detector.items()):
        name0, ref, keys0, _ = items[0]
        print(f"== D{detector}: {len(items)} recortes ==")
        print(f"   columnas: { {k: v.shape for k, v in ref.items()} }")
        print(f"   X = {ref['X']}")
        print(f"   Y = {ref['Y']}")
        print(f"   claves W del primero ({name0[:40]}...): {keys0}")
        same_values = sum(all(np.array_equal(cols[k], ref[k]) for k in ref) for _, cols, _, _ in items)
        max_diff = max(float(np.nanmax(np.abs(cols["VALUES"] - ref["VALUES"]))) for _, cols, _, _ in items)
        print(f"   tablas identicas a la primera: {same_values}/{len(items)}; diferencia maxima en VALUES: {max_diff:.3e}")
        crpix = sorted({(keys.get("CRPIX1W"), keys.get("CRPIX2W")) for _, _, keys, _ in items}, key=str)
        print(f"   CRPIX1W/CRPIX2W distintos: {len(crpix)} (ej. {crpix[:3]})")
        waves = sorted(round(w, 3) for *_, w in items)
        print(f"   longitud de onda en el centro del recorte [um]: {waves}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
