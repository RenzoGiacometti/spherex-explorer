"""Precalcula el espectro de los cinco objetos de prueba y lo guarda en el repositorio.

Mide cada objeto sobre los recortes que haya en la cache (la del backend o la de
la Etapa 0 en spike/cache; no baja nada) y escribe:

    backend/data/spectra/<slug>.json    documento del espectro
    backend/data/spectra/index.json     indice para `app/spectrum/precomputed.py`
    frontend/src/features/spectrum/fixtures/<slug>.json   copia para la pagina de prueba

La copia del frontend se pasa por el formateador del proyecto (Biome), que
revisa todos los JSON de frontend/src; hace falta haber corrido `pnpm install`.

La posicion de cada objeto sale de la respuesta de Sesame guardada en
tests/fixtures/sesame (posicion J2000, movimiento propio y paralaje) y se
propaga a la fecha de cada exposicion: Barnard y WISE 0855 se mueven mas de un
pixel entre epocas.

Uso, desde backend/:
    uv run python scripts/precompute_spectra.py
    uv run python scripts/precompute_spectra.py --only wise0855 rwaur
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from app import geometry  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.resolve.motion import field_center  # noqa: E402
from app.resolve.sesame import parse_sesame  # noqa: E402
from app.spectrum.cutouts import covering_cutouts, cutout_dirs, list_cutouts  # noqa: E402
from app.spectrum.lookup import CUTOUT_MARGIN_PX  # noqa: E402
from app.spectrum.precomputed import INDEX_FILENAME, spectra_dir  # noqa: E402
from app.spectrum.service import SpectrumTarget, compute_spectrum  # noqa: E402

SESAME_FIXTURES = BACKEND_DIR / "tests" / "fixtures" / "sesame"
FRONTEND_DIR = BACKEND_DIR.parent / "frontend"
FRONTEND_FIXTURES = FRONTEND_DIR / "src" / "features" / "spectrum" / "fixtures"


@dataclass(frozen=True)
class SampleObject:
    slug: str
    name: str  # como se muestra en la interfaz
    query: str  # nombre con el que se resolvio en Sesame
    sesame_file: str


# Los cinco objetos de prueba de SPEC.md, seccion 1.
OBJECTS = (
    SampleObject("barnard", "Barnard's Star", "Barnard's Star", "barnard_s_star.xml"),
    SampleObject("epsindb", "Epsilon Indi B", "Epsilon Indi B", "epsilon_indi_b.xml"),
    SampleObject("wise0855", "WISE 0855-0714", "WISE J085510.83-071442.5", "wise_j085510_83_071442_5.xml"),
    SampleObject("rwaur", "RW Aurigae", "RW Aurigae", "rw_aurigae.xml"),
    SampleObject("rdra", "R Draconis", "R Draconis", "r_draconis.xml"),
)


def dump(document: dict[str, Any]) -> str:
    """JSON con una sangria por nivel y cada punto del espectro en un renglon: legible y sin miles de lineas."""
    compact = {key: document[key] for key in ("points", "binned") if key in document}
    head = {key: ("@@" + key if key in compact else value) for key, value in document.items()}
    text = json.dumps(head, indent=1, ensure_ascii=False)
    for key, rows in compact.items():
        lines = ",\n".join("  " + json.dumps(row, ensure_ascii=False, separators=(", ", ": ")) for row in rows)
        text = text.replace(f'"@@{key}"', "[\n" + lines + "\n ]" if rows else "[]")
    return text + "\n"


def format_frontend_copies() -> bool:
    """Pasa las copias del frontend por Biome, como pide `pnpm lint`. Devuelve False si no pudo."""
    binary = FRONTEND_DIR / "node_modules" / ".bin" / ("biome.cmd" if os.name == "nt" else "biome")
    if not binary.is_file():
        return False
    try:
        result = subprocess.run(
            [str(binary), "format", "--write", str(FRONTEND_FIXTURES.relative_to(FRONTEND_DIR))],
            cwd=FRONTEND_DIR,
            capture_output=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", nargs="*", default=None, help="slugs a calcular; por defecto, todos")
    parser.add_argument("--no-frontend", action="store_true", help="no copiar a los datos de la pagina de prueba")
    args = parser.parse_args()

    settings = get_settings()
    output = spectra_dir(settings)
    output.mkdir(parents=True, exist_ok=True)
    cached = list_cutouts(cutout_dirs(settings))
    print(f"{len(cached)} recortes en {[str(folder) for folder in cutout_dirs(settings)]}")

    failed = False
    for item in OBJECTS:
        if args.only is not None and item.slug not in args.only:
            continue
        resolved = parse_sesame((SESAME_FIXTURES / item.sesame_file).read_text(encoding="utf-8"), item.query)
        if resolved is None:
            print(f"{item.slug}: la respuesta guardada de Sesame no trae posicion")
            failed = True
            continue
        ra, dec = field_center(resolved, settings.field_epoch)
        request = geometry.normalize_request(ra, dec)
        cutouts = covering_cutouts(cached, ra, dec, margin_px=CUTOUT_MARGIN_PX)
        if not cutouts:
            print(f"{item.slug}: no hay recortes en la cache que cubran {ra:.5f} {dec:+.5f}")
            failed = True
            continue
        started = time.perf_counter()
        target = SpectrumTarget(ra=ra, dec=dec, epoch=settings.field_epoch, name=item.name, motion=resolved)
        document = compute_spectrum(cutouts, target, field_id=request.field_id)
        document["source"] = "precomputed"
        document["target"]["catalog_name"] = resolved.name
        document["provenance"]["computed_at"] = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        path = output / f"{item.slug}.json"
        path.write_text(dump(document), encoding="utf-8", newline="\n")
        print(
            f"{item.slug}: {document['status']}, {len(document['points'])} puntos de "
            f"{document['provenance']['n_exposures']} exposiciones en {time.perf_counter() - started:.1f} s"
        )

    # El indice se arma con lo que hay en disco, asi `--only` no pierde a los demas.
    entries = []
    for item in OBJECTS:
        path = output / f"{item.slug}.json"
        if not path.is_file():
            continue
        target_info = json.loads(path.read_text(encoding="utf-8"))["target"]
        positions = [{"ra": target_info["ra"], "dec": target_info["dec"]}]
        positions += [{"ra": point["ra"], "dec": point["dec"]} for point in target_info["track"]]
        entries.append({"slug": item.slug, "name": item.name, "file": path.name, "positions": positions})
    index = {"version": 1, "objects": entries}
    (output / INDEX_FILENAME).write_text(json.dumps(index, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"Indice con {len(entries)} objetos en {output / INDEX_FILENAME}")

    if not args.no_frontend:
        FRONTEND_FIXTURES.mkdir(parents=True, exist_ok=True)
        for entry in entries:
            shutil.copyfile(output / entry["file"], FRONTEND_FIXTURES / entry["file"])
        print(f"Copiados a {FRONTEND_FIXTURES}")
        if not format_frontend_copies():
            print(
                "Aviso: no se pudo correr Biome sobre las copias. Desde frontend/: "
                "pnpm exec biome format --write src/features/spectrum/fixtures"
            )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    raise SystemExit(main())
