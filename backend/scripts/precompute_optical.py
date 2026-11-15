"""Precalcula la capa optica (Digitized Sky Survey) de los campos que ya tienen contexto. Usa la red (STScI).

Para cada campo precalculado guarda, al lado de su contexto, las placas del DSS
reproyectadas a la grilla del campo: la de primera generacion (anios 50 al
norte, 70 y 80 al sur) y la de segunda generacion en rojo (1987 a 2000), con la
fecha de cada placa. El detalle del servicio esta en `app/context/optical.py`.

Uso, desde backend/:

    uv run python scripts/precompute_optical.py                # los campos que no tienen capa optica
    uv run python scripts/precompute_optical.py --list         # que hay y que falta, sin red
    uv run python scripts/precompute_optical.py barnard m-82   # algunos, por alias o comienzo de id
    uv run python scripts/precompute_optical.py --surveys dss2_red
    uv run python scripts/precompute_optical.py --refresh      # rehace todos con las placas de la cache
    uv run python scripts/precompute_optical.py --fields-dir ..\\..\\otro-arbol\\backend\\data\\fields

El centro y la posicion del objeto en la fecha de cada placa salen de los
metadatos del campo (`app/context/fields.py`), sin Sesame. Un campo sin
contexto guardado se saltea: primero va `precompute_context_fields.py`.

Hace los pedidos de a uno, en serie. Las placas bajadas quedan en
`cache/context/dss`.

Codigo de salida: 0 si todos los campos quedaron con alguna capa; 1 si alguno
se quedo sin ninguna.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
import warnings
from collections.abc import Sequence
from functools import partial
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    # El backend no es un paquete instalable: se importa desde backend/.
    sys.path.insert(0, str(BACKEND_DIR))

from astropy.wcs import FITSFixedWarning  # noqa: E402

from app import geometry  # noqa: E402
from app.config import Settings, get_settings  # noqa: E402
from app.context import optical  # noqa: E402
from app.context.fields import (  # noqa: E402
    FieldEntry,
    LinearMotion,
    field_request,
    list_fields,
    object_alias,
    target_at,
    track_motion,
)
from app.context.store import ContextStore, LayerTarget  # noqa: E402
from app.domain import Grid  # noqa: E402


def print_line(line: str) -> None:
    """Escribe una linea y la manda enseguida. Si la consola no puede con un caracter, lo reemplaza."""
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        print(line.encode("ascii", "replace").decode("ascii"), flush=True)


def matches(entry: FieldEntry, selectors: Sequence[str]) -> bool:
    """Si el campo fue pedido: por comienzo de `id`, por alias o por parte del nombre."""
    if not selectors:
        return True
    name = (entry.name or "").lower()
    alias = object_alias(entry.name) if entry.name else ""
    for selector in selectors:
        text = selector.strip().lower()
        if text and (entry.field_id.startswith(text) or text == alias or text in name):
            return True
    return False


def expected_target(motion: LinearMotion | None, grid: Grid, mjd: float) -> LayerTarget | None:
    """Donde estaba el objeto del campo en la fecha de una placa, o `None` si no se mueve."""
    return None if motion is None else target_at(motion, mjd, grid)


def main(argv: Sequence[str] | None = None, *, settings: Settings | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Precalcula la capa optica (DSS) de los campos que ya tienen contexto. Usa la red (STScI)."
    )
    parser.add_argument("fields", nargs="*", help="alias, parte del nombre o comienzo del id; por defecto, todos")
    parser.add_argument("--fields-dir", type=Path, default=None, help="carpeta de campos (por defecto data/fields)")
    parser.add_argument(
        "--surveys",
        nargs="+",
        default=list(optical.DEFAULT_SURVEY_KEYS),
        choices=[survey.key for survey in optical.DSS_SURVEYS],
        help="relevamientos a guardar (por defecto dss1 y dss2_red)",
    )
    parser.add_argument("--refresh", action="store_true", help="rehace tambien los campos que ya tienen capa optica")
    parser.add_argument("--redownload", action="store_true", help="vuelve a bajar las placas que ya estan en la cache")
    parser.add_argument("--list", action="store_true", help="muestra los campos y cuales tienen capa optica; sin red")
    args = parser.parse_args(argv)

    settings = get_settings() if settings is None else settings
    fields_dir = args.fields_dir or settings.precomputed_fields_dir
    store = ContextStore.from_settings(settings)
    entries = [entry for entry in list_fields(fields_dir) if matches(entry, args.fields)]
    print_line(f"Campos en {fields_dir}: {len(entries)}; contexto en {store.root}")

    if args.list:
        for entry in entries:
            if not store.exists(entry.key):
                state = "sin contexto   "
            elif optical.has_document(store, entry.key):
                layers = optical.read_document(store, entry.key).layers
                state = "con " + ", ".join(f"{layer.key} {layer.date[:4]}" for layer in layers)
            else:
                state = "FALTA          "
            print_line(f"  {entry.field_id}  {entry.name or '(sin nombre)':<28} {state}")
        return 0

    pending = [
        entry
        for entry in entries
        if store.exists(entry.key) and (args.refresh or not optical.has_document(store, entry.key))
    ]
    skipped = [entry for entry in entries if not store.exists(entry.key)]
    for entry in skipped:
        print_line(f"  se saltea {entry.name or entry.field_id}: no tiene contexto guardado")
    print_line(f"{len(pending)} por armar")
    started = time.perf_counter()
    failed = 0
    for number, entry in enumerate(pending, start=1):
        print_line(f"[{number}/{len(pending)}] {entry.field_id} {entry.name or ''}")
        grid = geometry.build_grid(field_request(entry, settings))
        motion = track_motion(entry.track.positions) if entry.track is not None else None
        try:
            document = optical.build_optical(
                entry.key,
                grid,
                settings,
                store,
                survey_keys=args.surveys,
                target_at=partial(expected_target, motion, grid),
                refresh=args.redownload,
                out=print_line,
            )
        except optical.OpticalUnavailable as exc:
            failed += 1
            print_line(f"      FALLO: {exc}")
            continue
        for layer in document.layers:
            if layer.target is None:
                where = "sin posicion del objeto"
            elif layer.target.in_field:
                where = f"objeto en ({layer.target.x}, {layer.target.y})"
            else:
                where = f"el objeto estaba fuera del campo, en ({layer.target.x}, {layer.target.y})"
            print_line(f"      {layer.key} {layer.date}: {where}")
    print_line(f"Total: {time.perf_counter() - started:.1f} s; {failed} fallidos")
    return 1 if failed else 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    # Las placas viejas traen la hora de `DATE-OBS` mal escrita y astropy avisa por cada una; la
    # fecha se lee aparte (`optical.plate_mjd`), asi que el aviso no dice nada util.
    warnings.filterwarnings("ignore", category=FITSFixedWarning)
    raise SystemExit(main())
