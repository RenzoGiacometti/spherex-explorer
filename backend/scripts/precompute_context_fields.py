"""Precalcula el contexto de otras misiones de todos los campos ya precalculados. Usa la red (IRSA).

A diferencia de `precompute_context.py`, no resuelve nombres: toma el centro,
el nombre y la posicion del objeto de los metadatos de cada campo de
`backend/data/fields` (ver `app/context/fields.py`). Asi el contexto queda
centrado exactamente donde esta el cubo, sin depender de Sesame.

Uso, desde backend/:

    uv run python scripts/precompute_context_fields.py                 # los campos que no tienen contexto
    uv run python scripts/precompute_context_fields.py --list          # que hay y que falta, sin red
    uv run python scripts/precompute_context_fields.py m-82 730d0dd6   # algunos, por alias o comienzo de id
    uv run python scripts/precompute_context_fields.py --fields-dir ..\\..\\otro-arbol\\backend\\data\\fields
    uv run python scripts/precompute_context_fields.py --refresh       # rehace tambien los que ya estan

Un campo que ya tiene contexto guardado se deja como esta, salvo con
`--refresh`. `index.json` no se reescribe: la API arma el indice leyendo las
carpetas.

Hace los pedidos a IRSA de a uno, en serie: se puede correr mientras otro
proceso arma campos sin sumarle mas de una conexion.

Codigo de salida: 0 si todos los campos pedidos quedaron con sus capas y sus
fuentes de Gaia; 2 si a alguno le falto una parte; 1 si alguno fallo entero.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from collections.abc import Sequence
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    # El backend no es un paquete instalable: se importa desde backend/.
    sys.path.insert(0, str(BACKEND_DIR))

from app.config import Settings, get_settings  # noqa: E402
from app.context import surveys  # noqa: E402
from app.context.build import ContextBuildError  # noqa: E402
from app.context.fields import FieldEntry, build_field_context, list_fields, object_alias, track_motion  # noqa: E402
from app.context.store import ContextStore  # noqa: E402


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


def describe(entry: FieldEntry) -> str:
    request = entry.meta.request
    motion = track_motion(entry.track.positions) if entry.track is not None else None
    moves = "sin movimiento propio" if motion is None else f'{motion.per_year_arcsec:.2f}" por anio'
    return f"{entry.field_id}  {request.ra:9.4f} {request.dec:+9.4f}  {entry.name or '(sin nombre)'}  [{moves}]"


def main(argv: Sequence[str] | None = None, *, settings: Settings | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Precalcula el contexto (2MASS, WISE, Gaia DR3) de los campos ya precalculados. Usa la red (IRSA)."
    )
    parser.add_argument("fields", nargs="*", help="alias, parte del nombre o comienzo del id; por defecto, todos")
    parser.add_argument("--fields-dir", type=Path, default=None, help="carpeta de campos (por defecto data/fields)")
    parser.add_argument(
        "--layers",
        nargs="+",
        default=list(surveys.DEFAULT_BAND_KEYS),
        choices=[band.key for band in surveys.BANDS],
        help="capas a guardar (por defecto twomass_ks y wise_w2)",
    )
    parser.add_argument("--no-gaia", action="store_true", help="no consulta Gaia")
    parser.add_argument("--refresh", action="store_true", help="rehace tambien los campos que ya tienen contexto")
    parser.add_argument(
        "--list", action="store_true", help="muestra los campos y cuales tienen contexto; no usa la red"
    )
    args = parser.parse_args(argv)

    settings = get_settings() if settings is None else settings
    fields_dir = args.fields_dir or settings.precomputed_fields_dir
    store = ContextStore.from_settings(settings)
    entries = [entry for entry in list_fields(fields_dir) if matches(entry, args.fields)]
    print_line(f"Campos en {fields_dir}: {len(entries)}; contexto en {store.root}")

    if args.list:
        for entry in entries:
            print_line(f"  {'con contexto' if store.exists(entry.key) else 'FALTA       '}  {describe(entry)}")
        return 0

    pending = [entry for entry in entries if args.refresh or not store.exists(entry.key)]
    print_line(f"{len(pending)} por armar, {len(entries) - len(pending)} ya tienen contexto")
    started = time.perf_counter()
    failed = 0
    incomplete = 0
    for number, entry in enumerate(pending, start=1):
        print_line(f"[{number}/{len(pending)}] {describe(entry)}")
        try:
            document = build_field_context(
                entry,
                settings,
                store,
                layer_keys=args.layers,
                with_gaia=not args.no_gaia,
                refresh=args.refresh,
                out=print_line,
            )
        except ContextBuildError as exc:
            failed += 1
            print_line(f"      FALLO: {exc}")
            continue
        if len(document.surveys) < len(args.layers) or (not args.no_gaia and document.gaia is None):
            incomplete += 1
        for layer in document.surveys:
            where = (
                "sin posicion del objeto" if layer.target is None else f"objeto en ({layer.target.x}, {layer.target.y})"
            )
            print_line(f"      {layer.survey} {layer.band} {layer.date}: {where}")
        print_line(f"      guardado en {document.key}")
    print_line(f"Total: {time.perf_counter() - started:.1f} s; {failed} fallidos, {incomplete} incompletos")
    if failed:
        return 1
    return 2 if incomplete else 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    raise SystemExit(main())
