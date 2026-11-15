"""Que flags forman el hueco sobre una estrella saturada, y que trae IMAGE ahi?

Etapa 1, fase A (descartable). Usa los recortes ya guardados en cache; no toca
la red salvo que falte el nombre en la cache de Sesame. Sirve para definir en el
contrato del cubo como se marca una fuente saturada.

Uso: uv run python explore_saturation.py "Barnard's Star" 0.1
"""

from __future__ import annotations

import logging
import sys
import warnings
from collections import Counter

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

import field


def main() -> None:
    logging.getLogger("astropy").setLevel(logging.ERROR)
    warnings.filterwarnings("ignore")
    target = field.resolve_name(sys.argv[1])
    fov = float(sys.argv[2])
    center_mjd = float(field.Time(field.CENTER_EPOCH, format="jyear").mjd)
    ra0, dec0 = (round(v, 6) for v in target.position_at(center_mjd))
    paths = sorted((field.CACHE_DIR / "cutouts").glob(f"*__{ra0:.6f}_{dec0:+.6f}_{fov:g}_img.fits"))
    print(f"{target.name}: {len(paths)} recortes en cache")

    zones = {"nucleo (r <= 1.5 px)": (0.0, 1.5), "anillo (1.5 < r <= 3 px)": (1.5, 3.0), "halo (3 < r <= 6 px)": (3.0, 6.0)}
    flag_counts: dict[str, Counter[str]] = {zone: Counter() for zone in zones}
    pixels: Counter[str] = Counter()
    masked: Counter[str] = Counter()
    finite_masked: Counter[str] = Counter()
    ratios: dict[str, list[float]] = {zone: [] for zone in zones}
    combos: Counter[tuple[str, ...]] = Counter()
    per_detector_core_masked: dict[int, list[float]] = {d: [] for d in range(1, 7)}

    for path in paths:
        with fits.open(path, memmap=False) as hdul:
            header = hdul["IMAGE"].header
            image = hdul["IMAGE"].data.astype(float)
            zodi = hdul["ZODI"].data.astype(float)
            variance = hdul["VARIANCE"].data.astype(float)
            flags = hdul["FLAGS"].data.astype(np.int64)
            fh = hdul["FLAGS"].header
            bits = {str(fh[k]): int(k[4:]) for k in fh["MSKN*"]}
        bad_bits = sum(1 << bits[name] for name in field.BAD_FLAGS if name in bits)
        ra, dec = target.position_at(float(header["MJD-AVG"]))
        x, y = (float(v) for v in WCS(header).world_to_pixel_values(ra, dec))
        yy, xx = np.indices(image.shape)
        dist = np.hypot(xx - x, yy - y)
        bad = ((flags & bad_bits) != 0) | ~np.isfinite(image) | ~np.isfinite(variance) | (variance <= 0)
        sky = np.nanmedian((image - zodi)[(dist > 12) & ~bad]) if ((dist > 12) & ~bad).any() else 0.0
        for zone, (r0, r1) in zones.items():
            sel = (dist > r0) & (dist <= r1) if r0 > 0 else (dist <= r1)
            if not sel.any():
                continue
            pixels[zone] += int(sel.sum())
            masked[zone] += int((sel & bad).sum())
            finite_masked[zone] += int((sel & bad & np.isfinite(image)).sum())
            for name, bit in bits.items():
                flag_counts[zone][name] += int((((flags >> bit) & 1) == 1)[sel].sum())
            # Valor de IMAGE en pixeles enmascarados, relativo al maximo valido del recorte.
            good_max = np.nanmax(np.where(bad, np.nan, image - zodi - sky)) if (~bad).any() else np.nan
            values = (image - zodi - sky)[sel & bad & np.isfinite(image)]
            if values.size and np.isfinite(good_max) and good_max > 0:
                ratios[zone].extend((values / good_max).tolist())
            if zone.startswith("nucleo"):
                per_detector_core_masked[int(header["DETECTOR"])].append(float(bad[sel].mean()))
                for value in flags[sel & bad]:
                    combos[tuple(sorted(n for n, b in bits.items() if (int(value) >> b) & 1 and n != "SOURCE"))] += 1

    for zone in zones:
        total = max(pixels[zone], 1)
        print(f"\n== {zone}: {pixels[zone]} pixeles, enmascarados {masked[zone] / total:.1%}, de ellos con IMAGE finito {finite_masked[zone] / max(masked[zone], 1):.1%}")
        for name, n in flag_counts[zone].most_common():
            if n:
                print(f"   {name:<13} {n / total:6.1%}")
        if ratios[zone]:
            r = np.array(ratios[zone])
            print(f"   IMAGE enmascarado / maximo valido del recorte: p10 {np.percentile(r, 10):.2f}, mediana {np.median(r):.2f}, p90 {np.percentile(r, 90):.2f}, negativos {np.mean(r < 0):.1%}")

    print("\n== combinaciones de flags en pixeles enmascarados del nucleo (sin SOURCE) ==")
    total = sum(combos.values())
    for combo, n in combos.most_common(12):
        print(f"   {n / total:6.1%}  {' + '.join(combo) or '(ninguno: IMAGE o VARIANCE no finitos)'}")
    print("\n== fraccion del nucleo enmascarada por detector (media sobre recortes) ==")
    print("   " + "; ".join(f"D{d} {np.mean(v):.2f} (n={len(v)})" for d, v in per_detector_core_masked.items() if v))


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
