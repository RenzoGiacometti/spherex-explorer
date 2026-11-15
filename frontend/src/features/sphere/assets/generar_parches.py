"""Genera los parches de detalle de la esfera (assets/parches/).

Un parche es la imagen real de SPHEREx de un campo precalculado, lista para
pegarla sobre la esfera en la posicion del campo. Sale de los planos guardados
en backend/data/fields, sin red.

Uso, desde la raiz del repositorio:

    uv run --no-project --with numpy --with pillow python frontend/src/features/sphere/assets/generar_parches.py

Por cada campo:

- Banda: la de apertura del visor, leida de src/features/entry/featured.ts
  (`band`), que es la unica lista de campos precalculados.
- Epoca: la del plano de esa banda con mas pixeles validos; si empatan, la de
  mas exposiciones usadas y despues la mas antigua.
- Estirado: el que muestra el visor al abrir el campo. Cortes de
  `contrastCuts(display, 0,5)` y curva asinh con a = 0,1
  (src/viewer/stretch.ts). Sin datos (NaN) va a negro y saturado (+Infinity) a
  blanco, como en src/viewer/compose.ts. Una sola diferencia: si mas del 3 %
  de los pixeles validos queda por encima del corte alto, el corte sube al
  percentil 97 del plano. Pasa con los objetos extensos y brillantes (M 1,
  M 42, M 82), que con los cortes del visor quedan como una mancha blanca.
- Orientacion: el plano se guarda con la fila 0 en el sur y la columna 0 en el
  este (docs/contrato-cubo.md, seccion 6). Un PNG tiene la primera fila
  arriba, asi que se invierten las filas: norte arriba, este a la izquierda.

Escribe un PNG en escala de grises por campo, con los pixeles del plano tal
cual (195 x 195), y `parches.json` con el centro y el tamano angular de cada
uno, que es lo que usa la escena para ubicarlos.
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]
FIELDS_DIR = REPO / "backend" / "data" / "fields"
FEATURED_TS = REPO / "frontend" / "src" / "features" / "entry" / "featured.ts"
OUTPUT_DIR = HERE / "parches"

# Las mismas constantes que src/viewer/stretch.ts.
ASINH_STRETCH_A = 0.1
DEFAULT_CONTRAST = 0.5
MIN_SPAN_SIGMAS = 4
MIN_SPAN_FRACTION = 1 / 256

# Percentil de los pixeles validos por debajo del cual no baja el corte alto.
HIGH_CUT_FLOOR_PERCENTILE = 97

# Diferencia maxima, en grados, entre el centro de featured.ts y el del campo.
SAME_CENTER_DEG = 1e-4

OBJECT_PATTERN = re.compile(
    r'id:\s*"(?P<id>[^"]+)".*?\bra:\s*(?P<ra>-?[\d.]+),\s*dec:\s*(?P<dec>-?[\d.]+),.*?\bband:\s*(?P<band>\d)',
    re.DOTALL,
)


def read_objects() -> list[dict]:
    """Campos precalculados de featured.ts: id, centro y banda de apertura."""
    text = FEATURED_TS.read_text(encoding="utf-8")
    objects = [
        {
            "id": match["id"],
            "ra": float(match["ra"]),
            "dec": float(match["dec"]),
            "band": int(match["band"]),
        }
        for match in OBJECT_PATTERN.finditer(text)
    ]
    if not objects:
        raise SystemExit(f"no se encontraron objetos en {FEATURED_TS}")
    return objects


def read_fields() -> list[dict]:
    fields = []
    for meta_path in sorted(FIELDS_DIR.glob("*/meta.json")):
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["_dir"] = meta_path.parent
        fields.append(meta)
    return fields


def find_field(obj: dict, fields: list[dict]) -> dict:
    for meta in fields:
        request = meta["request"]
        if (
            abs(request["ra"] - obj["ra"]) < SAME_CENTER_DEG
            and abs(request["dec"] - obj["dec"]) < SAME_CENTER_DEG
        ):
            return meta
    raise SystemExit(f"{obj['id']}: no hay un campo en {FIELDS_DIR} con ese centro")


def pick_plane(meta: dict, band: int) -> dict:
    planes = [
        plane
        for plane in meta["planes"]
        if plane["detector"] == band and plane["status"] in ("ready", "partial")
    ]
    if not planes:
        raise SystemExit(f"{meta['id']}: no hay planos de la banda {band}")
    return max(
        planes,
        key=lambda plane: (
            plane.get("stats", {}).get("valid_fraction", 0.0),
            plane.get("n_used", 0),
            -plane["epoch"],
        ),
    )


def contrast_cuts(display: dict) -> tuple[float, float]:
    """`contrastCuts(display, DEFAULT_CONTRAST)` de src/viewer/stretch.ts."""
    low = display["vmin"]
    full = display["vmax"] - display["vmin"]
    if not full > 0:
        return low, display["vmax"]
    sigma = display.get("sigma")
    narrowest = min(full, MIN_SPAN_SIGMAS * sigma) if sigma and sigma > 0 else full * MIN_SPAN_FRACTION
    span = full * (narrowest / full) ** DEFAULT_CONTRAST
    return low, low + span


def render(values: np.ndarray, low: float, high: float) -> np.ndarray:
    """Niveles de 0 a 255 con la fila 0 arriba (norte)."""
    span = max(high - low, 1e-30)
    saturated = np.isposinf(values)
    valid = np.isfinite(values)
    position = np.clip((np.where(valid, values, low) - low) / span, 0.0, 1.0)
    level = np.arcsinh(position / ASINH_STRETCH_A) / math.asinh(1 / ASINH_STRETCH_A)
    level = np.where(valid, level, 0.0)
    level = np.where(saturated, 1.0, level)
    image = np.round(np.clip(level, 0.0, 1.0) * 255).astype(np.uint8)
    # Fila 0 del plano = sur: se invierte para que el norte quede arriba.
    return image[::-1, :]


def main() -> None:
    objects = read_objects()
    fields = read_fields()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for stale in OUTPUT_DIR.glob("*.png"):
        stale.unlink()

    manifest: dict[str, dict] = {}
    total = 0
    for obj in objects:
        meta = find_field(obj, fields)
        grid = meta["grid"]
        if grid["projection"] != "TAN":
            raise SystemExit(f"{obj['id']}: proyeccion {grid['projection']}, se esperaba TAN")
        ny, nx = grid["shape"]
        plane = pick_plane(meta, obj["band"])
        path = meta["_dir"] / f"plane_e{plane['epoch']}_d{plane['detector']}.f32"
        values = np.fromfile(path, dtype="<f4")
        if values.size != ny * nx:
            raise SystemExit(f"{path}: {values.size} valores, se esperaban {ny * nx}")
        values = values.reshape(ny, nx)

        display = next(d["display"] for d in meta["detectors"] if d["detector"] == obj["band"])
        low, high = contrast_cuts(display)
        finite = values[np.isfinite(values)]
        if finite.size > 0:
            high = max(high, float(np.percentile(finite, HIGH_CUT_FLOOR_PERCENTILE)))
        image = Image.fromarray(render(values, low, high), mode="L")
        target = OUTPUT_DIR / f"{obj['id']}.png"
        image.save(target, "PNG", optimize=True)
        size = target.stat().st_size
        total += size

        # Tamano sobre el plano tangente, en grados de la proyeccion TAN: el
        # lado mide (180 / pi) * 2 * tan(mitad del angulo).
        manifest[obj["id"]] = {
            "file": target.name,
            "field": meta["id"],
            "ra": grid["crval"][0],
            "dec": grid["crval"][1],
            "width_deg": round(abs(grid["cdelt"][0]) * nx, 6),
            "height_deg": round(abs(grid["cdelt"][1]) * ny, 6),
            "band": obj["band"],
            "epoch": plane["epoch"],
        }
        print(
            f"{obj['id']:18s} campo {meta['id']} banda {obj['band']} epoca {plane['epoch']} "
            f"cortes [{low:.4g}, {high:.4g}] {size} bytes"
        )

    used = {entry["field"] for entry in manifest.values()}
    unused = [meta["id"] for meta in fields if meta["id"] not in used]
    if unused:
        print(f"aviso: campos sin objeto en featured.ts: {', '.join(unused)}", file=sys.stderr)

    manifest_path = OUTPUT_DIR / "parches.json"
    # Saltos de linea de Unix tambien en Windows: es lo que espera Biome.
    manifest_path.write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n"
    )
    print(f"{len(manifest)} parches, {total} bytes en total; indice en {manifest_path}")


if __name__ == "__main__":
    main()
