"""Precalcula el contexto de otras misiones de los objetos de prueba y lo deja en backend/data/context. Usa la red.

Para cada objeto guarda un recorte de 2MASS y uno de WISE reproyectados a la
grilla de su campo base (10 minutos), con su fecha de observacion, y las fuentes
de Gaia DR3 del campo con posicion, movimiento propio y paralaje. Todo sale de
IRSA; los servicios y sus URL estan en docs/contexto.md.

Uso, desde backend/:

    uv run python scripts/precompute_context.py                  # los cinco objetos
    uv run python scripts/precompute_context.py barnard wise0855 # algunos, por su alias
    uv run python scripts/precompute_context.py --layers twomass_ks wise_w1 wise_w2
    uv run python scripts/precompute_context.py --refresh        # vuelve a pedir todo a IRSA
    uv run python scripts/precompute_context.py --offline-names  # no consulta Sesame

Objetos: `barnard`, `epsindb`, `wise0855`, `rwaur` y `rdra`, los mismos alias
que el precalculo de campos. Cualquier otro texto se toma como un nombre para
Sesame.

Capas disponibles: `twomass_j`, `twomass_h`, `twomass_ks`, `wise_w1` y
`wise_w2`. Por defecto, `twomass_ks` y `wise_w2`.

Las listas de imagenes, los recortes y las tablas de Gaia quedan en
`cache/context`: repetir el script no vuelve a bajar nada. Respeta el limite
global de conexiones hacia IRSA, que vale por proceso: no conviene correrlo
mientras otro proceso arma campos.

Codigo de salida: 0 si todos los objetos quedaron con sus capas y sus fuentes
de Gaia; 2 si a alguno le falto una parte; 1 si alguno fallo entero.
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
from app.context.build import (  # noqa: E402
    TEST_OBJECTS,
    ContextBuildError,
    build_context,
    field_request,
    resolve_object,
)
from app.context.store import ContextDocument, ContextObject, ContextStore  # noqa: E402


def print_line(line: str) -> None:
    """Escribe una linea y la manda enseguida. Si la consola no puede con un caracter, lo reemplaza."""
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        print(line.encode("ascii", "replace").decode("ascii"), flush=True)


def select_objects(texts: Sequence[str]) -> list[tuple[str, str]]:
    """Pares (alias, texto a resolver). Sin argumentos, los cinco objetos de prueba."""
    if not texts:
        return list(TEST_OBJECTS.items())
    by_query = {query: alias for alias, query in TEST_OBJECTS.items()}
    chosen: list[tuple[str, str]] = []
    for text in texts:
        alias = text.strip().lower()
        query = TEST_OBJECTS.get(alias, " ".join(text.split()))
        pair = (by_query.get(query, alias.replace(" ", "-")), query)
        if query and pair not in chosen:
            chosen.append(pair)
    return chosen


def describe(document: ContextDocument) -> str:
    layers = ", ".join(f"{layer.survey} {layer.band} {layer.date}" for layer in document.surveys) or "ninguna capa"
    sources = f"{document.gaia.n_sources} fuentes de Gaia" if document.gaia else "sin Gaia"
    return f"{document.key}: {layers}; {sources}"


def main(argv: Sequence[str] | None = None, *, settings: Settings | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Precalcula el contexto (2MASS, WISE, Gaia DR3) de los objetos de prueba. Usa la red (IRSA).",
        epilog="Alias: " + ", ".join(f"{alias} ({name})" for alias, name in TEST_OBJECTS.items()),
    )
    parser.add_argument("objects", nargs="*", help="alias o nombres; por defecto, los cinco objetos de prueba")
    parser.add_argument(
        "--layers",
        nargs="+",
        default=list(surveys.DEFAULT_BAND_KEYS),
        choices=[band.key for band in surveys.BANDS],
        help="capas a guardar (por defecto twomass_ks y wise_w2)",
    )
    parser.add_argument("--no-gaia", action="store_true", help="no consulta Gaia")
    parser.add_argument("--refresh", action="store_true", help="vuelve a pedir a IRSA lo que ya esta en la cache")
    parser.add_argument(
        "--offline-names", action="store_true", help="no consulta Sesame: usa las respuestas guardadas en los tests"
    )
    args = parser.parse_args(argv)

    settings = get_settings() if settings is None else settings
    store = ContextStore.from_settings(settings)
    objects = select_objects(args.objects)
    print_line(f"Contexto en {store.root}; cache en {settings.cache_dir / 'context'}; {len(objects)} objetos")

    started = time.perf_counter()
    failed = 0
    incomplete = 0
    for number, (alias, query) in enumerate(objects, start=1):
        print_line(f"[{number}/{len(objects)}] {query}")
        try:
            target, origin = resolve_object(query, settings, offline=args.offline_names)
            request = field_request(target, settings)
            source = "Sesame" if origin == "sesame" else "respuesta de Sesame guardada"
            print_line(
                f"      {target.name or query} ({source}): centro {request.ra:.4f} {request.dec:+.4f}, "
                f"campo {request.field_id}"
            )
            document = build_context(
                request,
                settings,
                store,
                context_object=ContextObject(alias=alias, query=query, name=target.name),
                target=target,
                layer_keys=args.layers,
                with_gaia=not args.no_gaia,
                refresh=args.refresh,
                out=print_line,
            )
        except ContextBuildError as exc:
            failed += 1
            print_line(f"      FALLO: {exc}")
            continue
        missing_layers = len(args.layers) - len(document.surveys)
        missing_gaia = not args.no_gaia and document.gaia is None
        if missing_layers or missing_gaia:
            incomplete += 1
        print_line(f"      guardado {describe(document)}")
    print_line(f"Total: {time.perf_counter() - started:.1f} s; {failed} fallidos, {incomplete} incompletos")
    if failed:
        return 1
    return 2 if incomplete else 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    raise SystemExit(main())
