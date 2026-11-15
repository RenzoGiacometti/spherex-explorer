"""Que fraccion de la grilla comun queda con datos en cada (epoca, detector)?

Etapa 0, descartable. El recorte de IRSA viene alineado con el detector; al
reproyectar a norte arriba las esquinas pueden quedar vacias.

Uso: uv run python explore_coverage.py barnard wise0855
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from astropy.io import fits

OUT = Path(__file__).parent / "out"


def main() -> None:
    for label in sys.argv[1:]:
        with fits.open(OUT / label / "cubo.fits") as hdul:
            coverage = hdul["COVERAGE"].data
        n_epochs = coverage.shape[0]
        print(f"== {label}: fraccion de pixeles con al menos una exposicion / con al menos la mitad del maximo ==")
        for epoch in range(n_epochs):
            cells = []
            for detector in range(6):
                plane = coverage[epoch, detector]
                top = plane.max()
                any_data = float((plane > 0).mean())
                half = float((plane >= 0.5 * top).mean()) if top > 0 else 0.0
                cells.append(f"D{detector + 1} {any_data:.2f}/{half:.2f} (max {int(top)})")
            print(f"  epoca {epoch + 1}: " + "; ".join(cells))
        total = coverage.reshape(-1, *coverage.shape[2:])
        print(f"  minimo sobre todos los planos: {min(float((p > 0).mean()) for p in total if p.max() > 0):.2f}")
        print(f"  esquina sin datos en algun plano: {bool(np.any([(p == 0).any() for p in total]))}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
