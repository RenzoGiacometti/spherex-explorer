"""Mide el error real de la curva de luz sobre las estrellas de control y lo guarda en el repositorio.

Pasa dos estrellas que no deberian variar por el mismo camino que cualquier
otra y anota cuanto se apartan de una recta:

    Barnard's Star   satura en los seis detectores: control de las alas
    Epsilon Indi B   no satura: control de la apertura

Escribe `app/lightcurve/data/calibration.json` (ver `app/lightcurve/calibration.py`).
Usa los recortes que haya en la cache (la del backend o la de la Etapa 0 en
spike/cache); no baja nada.

Uso, desde backend/:
    uv run python scripts/calibrate_lightcurve.py
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from app.config import get_settings  # noqa: E402
from app.lightcurve.calibration import (  # noqa: E402
    CALIBRATION_PATH,
    EMPTY,
    VALID_EPOCH_DEVIATION,
    VALID_POINT_SCATTER,
)
from app.lightcurve.exposures import load_frames, measure_frames  # noqa: E402
from app.lightcurve.service import build_series  # noqa: E402
from app.resolve.motion import field_center  # noqa: E402
from app.resolve.sesame import parse_sesame  # noqa: E402
from app.spectrum.cutouts import covering_cutouts, cutout_dirs, list_cutouts  # noqa: E402
from app.spectrum.lookup import CUTOUT_MARGIN_PX  # noqa: E402
from app.spectrum.service import SpectrumTarget, assign_epochs  # noqa: E402
from app.spectrum.wavelength import load_wave_tables  # noqa: E402

SESAME_FIXTURES = BACKEND_DIR / "tests" / "fixtures" / "sesame"

# metodo -> (nombre, respuesta guardada de Sesame)
CONTROLS = {
    "wings": ("Barnard's Star", "barnard_s_star.xml"),
    "aperture": ("Epsilon Indi B", "epsilon_indi_b.xml"),
}


def measure_control(method: str, name: str, sesame_file: str) -> dict[str, Any]:
    settings = get_settings()
    resolved = parse_sesame((SESAME_FIXTURES / sesame_file).read_text(encoding="utf-8"), name)
    if resolved is None:
        raise SystemExit(f"{name}: la respuesta guardada de Sesame no trae posicion")
    ra, dec = field_center(resolved, settings.field_epoch)
    target = SpectrumTarget(ra=ra, dec=dec, epoch=settings.field_epoch, name=name, motion=resolved)
    cutouts = covering_cutouts(list_cutouts(cutout_dirs(settings)), ra, dec, margin_px=CUTOUT_MARGIN_PX)
    if not cutouts:
        raise SystemExit(f"{name}: no hay recortes en la cache")
    tables = load_wave_tables()
    frames, _unreadable = load_frames(cutouts, target, tables)
    measures, annuli = measure_frames(frames)
    numbers, _epochs = assign_epochs([measure.mjd for measure in measures])

    detectors: dict[str, dict[str, Any]] = {}
    for detector in sorted({measure.detector for measure in measures}):
        own = [(m, e) for m, e in zip(measures, numbers, strict=True) if m.detector == detector]
        series = build_series(
            [item[0] for item in own],
            [item[1] for item in own],
            detector,
            method,  # type: ignore[arg-type]
            tables,
            EMPTY,
            annulus=annuli.get(detector),
            enforce_stability=False,
        )
        if series is None or not series["epochs"] or series["scatter"] is None:
            print(f"  D{detector}: sin serie de {method}")
            continue
        deviation = max(abs(row["value"] - 1.0) for row in series["epochs"])
        scatter = series["scatter"]["points"]
        excess = series["scatter"]["excess"]
        valid = deviation <= VALID_EPOCH_DEVIATION and excess is not None and excess <= VALID_POINT_SCATTER
        detectors[str(detector)] = {
            "n_points": series["n_points"],
            "epoch_values": [row["value"] for row in series["epochs"]],
            "epoch_deviation": round(deviation, 4),
            "point_scatter": scatter,
            "excess_scatter": excess,
            "valid": valid,
        }
        print(
            f"  D{detector}: {series['n_points']:3d} medidas, pasadas {detectors[str(detector)]['epoch_values']}, "
            f"apartamiento {deviation * 100:.1f} %, dispersion {scatter * 100:.1f} %, "
            f"{'validado' if valid else 'NO validado'}"
        )
    validated = [item for item in detectors.values() if item["valid"]]
    if not validated:
        raise SystemExit(f"{name}: el metodo {method} no valido en ningun detector")
    return {
        "control": name,
        "n_exposures": len(measures),
        # Los pisos salen de los detectores donde el metodo valido: lo peor que se vio ahi.
        "epoch_floor": round(max(item["epoch_deviation"] for item in validated), 4),
        "point_floor": round(max(item["point_scatter"] for item in validated), 4),
        "detectors": detectors,
    }


def main() -> int:
    methods = {}
    for method, (name, sesame_file) in CONTROLS.items():
        print(f"{name} ({method}):")
        methods[method] = measure_control(method, name, sesame_file)
        floor = methods[method]
        print(f"  piso por pasada {floor['epoch_floor'] * 100:.1f} %, por medida {floor['point_floor'] * 100:.1f} %")
    document = {
        "description": "Error real de la curva de luz, medido sobre estrellas de control que no varian "
        "(scripts/calibrate_lightcurve.py). Fracciones del brillo.",
        "valid_if": {"epoch_deviation_max": VALID_EPOCH_DEVIATION, "excess_scatter_max": VALID_POINT_SCATTER},
        "methods": methods,
    }
    if any(not math.isfinite(item["epoch_floor"]) for item in methods.values()):
        return 1
    CALIBRATION_PATH.parent.mkdir(parents=True, exist_ok=True)
    CALIBRATION_PATH.write_text(json.dumps(document, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"Escrito {CALIBRATION_PATH}")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    raise SystemExit(main())
