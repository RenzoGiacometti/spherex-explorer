"""Prueba real y chica contra IRSA, para correr a mano. No es un test: usa la red.

Lista por SIA2 las exposiciones que cubren el centro del campo de Barnard
(269.4463, 4.7683) en DR1 y QR3, y baja 3 recortes con el lado del escalon
base, de a uno. Muestra tiempos, bytes recibidos, el modo de cada descarga
(`truncated` si se corto antes de EPSF, `full` si hubo que bajar la respuesta
completa) y la estructura del archivo que quedo en la cache.

Uso, desde backend/:

    uv run python scripts/smoke_irsa.py

La cache va a una carpeta temporal fuera del repositorio, que se borra al
terminar; con `--keep` queda, y con `--cache-dir` se elige cual usar.

Es cuidadoso con IRSA: una conexion a la vez, 2 consultas SIA2 (con reintentos
espaciados si responde 502) y 3 recortes, y ante un 503 espera lo que indique
`Retry-After`.

Si SIA2 no responde, la prueba de recortes sigue con exposiciones reales de
tests/fixtures/cutouts/index.json (las listo SIA2 en la Etapa 0) y lo dice.

Codigo de salida: 0 si la lista y los 3 recortes en modo `truncated` salieron
bien; 3 si los recortes salieron bien pero SIA2 no respondio; 1 si algun
recorte fallo o bajo en modo `full`; 2 si no se pudo probar nada.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path

from astropy.io import fits

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    # El backend no es un paquete instalable: se importa desde backend/.
    sys.path.insert(0, str(BACKEND_DIR))

from app import geometry  # noqa: E402
from app.api.errors import ApiError  # noqa: E402
from app.config import Settings  # noqa: E402
from app.domain import CutoutFile, Exposure  # noqa: E402
from app.irsa.cutouts import IrsaBusy, IrsaError, IrsaPermanent, cutout_url, fetch_cutout  # noqa: E402
from app.irsa.sia import list_exposures  # noqa: E402

# Centro del campo de Barnard's Star en la epoca 2026.0, con los 4 decimales del contrato.
RA, DEC = 269.4463, 4.7683
N_CUTOUTS = 3
# Intentos por recorte en esta prueba. El backend usa `settings.cutout_attempts` (6).
ATTEMPTS = 4
MAX_WAIT_S = 30.0
FIXTURE_INDEX = BACKEND_DIR / "tests" / "fixtures" / "cutouts" / "index.json"


def fixture_exposures() -> list[Exposure]:
    """Exposiciones reales del campo de Barnard guardadas con los fixtures, para cuando SIA2 no responde."""
    entries = json.loads(FIXTURE_INDEX.read_text(encoding="utf-8"))["cutouts"]
    return [
        Exposure(
            obs_id=entry["obs_id"],
            collection=entry["collection"],
            detector=entry["detector"],
            mjd_start=entry["mjd"],
            mjd_end=entry["mjd_end"],
            url=entry["url"],
            wave_min_um=entry["wave_min_um"],
            wave_max_um=entry["wave_max_um"],
        )
        for entry in sorted(entries, key=lambda item: item["mjd"])
    ]


def pick(exposures: list[Exposure], count: int) -> list[Exposure]:
    """`count` exposiciones repartidas a lo largo de la lista: la primera, las del medio y la ultima."""
    if len(exposures) <= count:
        return exposures
    step = (len(exposures) - 1) / (count - 1)
    return [exposures[round(i * step)] for i in range(count)]


def download(exposure: Exposure, side_deg: float, settings: Settings) -> CutoutFile | None:
    """Baja un recorte con los reintentos que haria el planificador: espera `Retry-After` y vuelve a pedir."""
    for attempt in range(1, ATTEMPTS + 1):
        started = time.perf_counter()
        try:
            result = fetch_cutout(exposure, RA, DEC, side_deg, settings)
        except IrsaBusy as exc:
            wait = min(max(exc.retry_after, 1.0), MAX_WAIT_S)
            print(f"    intento {attempt}: IRSA ocupado ({exc}); espero {wait:.0f} s")
            time.sleep(wait)
        except IrsaPermanent as exc:
            print(f"    intento {attempt}: error permanente, no se reintenta: {exc}")
            return None
        except IrsaError as exc:
            print(f"    intento {attempt}: error pasajero: {exc}")
            time.sleep(2.0 * attempt)
        else:
            seconds = time.perf_counter() - started
            print(
                f"    intento {attempt}: modo {result.mode}, {result.nbytes} bytes recibidos en {seconds:.2f} s, "
                f"archivo de {result.path.stat().st_size} bytes"
            )
            return result
    print(f"    sin exito tras {ATTEMPTS} intentos")
    return None


def describe(path: Path) -> None:
    """Estructura del archivo guardado: una linea por HDU."""
    with fits.open(path, memmap=False) as hdul:
        for index, hdu in enumerate(hdul):
            shape = "x".join(str(n) for n in hdu.data.shape) if hdu.data is not None else "sin datos"
            kind = type(hdu).__name__
            bitpix = hdu.header.get("BITPIX")
            print(f"      {index}  {hdu.name:<9} {kind:<12} {shape:<10} BITPIX={bitpix}  {len(hdu.header)} cartas")
        flags = hdul["FLAGS"].header
        print(f"      bits declarados en FLAGS (MSKN*): {len(flags['MSKN*'])}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cache-dir", type=Path, help="carpeta de cache (por defecto, una temporal)")
    parser.add_argument("--keep", action="store_true", help="no borrar la carpeta temporal al terminar")
    parser.add_argument("--sia-attempts", type=int, default=10, help="intentos por coleccion ante un 502 de SIA2")
    args = parser.parse_args()

    cache_dir = args.cache_dir or Path(tempfile.mkdtemp(prefix="spherex-smoke-"))
    if BACKEND_DIR.parent in cache_dir.resolve().parents or cache_dir.resolve() == BACKEND_DIR.parent:
        parser.error("la carpeta de cache tiene que estar fuera del repositorio")
    settings = Settings(cache_dir=cache_dir, sia_attempts=args.sia_attempts)
    side_deg = geometry.cutout_side_deg(geometry.FOV_STEPS[0].fov)
    print(f"Cache: {cache_dir}")
    print(f"User-Agent: {settings.user_agent}")
    print(f"Centro: RA {RA}, Dec {DEC}. Lado del recorte (escalon base): {side_deg} grados")

    try:
        print(f"\n1. Lista de exposiciones por SIA2 ({', '.join(settings.collections)})")
        started = time.perf_counter()
        listed = True
        try:
            listing = list_exposures(RA, DEC, settings, refresh=True)
        except ApiError as exc:
            listed = False
            print(f"   IRSA no respondio en {time.perf_counter() - started:.1f} s: {exc.code}: {exc.message}")
            exposures = fixture_exposures()
            print(f"   Sigo con {len(exposures)} exposiciones reales guardadas en {FIXTURE_INDEX.name} (Etapa 0).")
        else:
            seconds = time.perf_counter() - started
            exposures = listing.exposures
            by_collection = Counter(item.collection for item in exposures)
            by_detector = Counter(item.detector for item in exposures)
            print(f"   {len(exposures)} exposiciones en {seconds:.2f} s")
            print(f"   listed_at {listing.listed_at}; stale={listing.stale}")
            print(f"   por coleccion: {dict(sorted(by_collection.items()))}")
            print(f"   por detector: { {f'D{d}': by_detector[d] for d in sorted(by_detector)} }")
            for path in sorted(settings.sia_cache_dir.glob("*.xml")):
                print(f"   guardado {path.name}: {path.stat().st_size} bytes")
            if listing.stale:
                listed = False
        if not exposures:
            print("\nRESULTADO: SIN VERIFICAR. La lista vino vacia.")
            return 2

        print(f"\n2. {N_CUTOUTS} recortes, de a uno")
        results: list[CutoutFile | None] = []
        for exposure in pick(exposures, N_CUTOUTS):
            print(f"  {exposure.obs_id} D{exposure.detector} ({exposure.collection}), MJD {exposure.mjd_start:.4f}")
            print(f"    {cutout_url(exposure, RA, DEC, side_deg)}")
            result = download(exposure, side_deg, settings)
            results.append(result)
            if result is not None:
                describe(result.path)
                again = fetch_cutout(exposure, RA, DEC, side_deg, settings)
                print(f"    segundo pedido: from_cache={again.from_cache}, modo {again.mode}")

        done = [result for result in results if result is not None]
        modes = Counter(result.mode for result in done)
        print(f"\nRecortes bajados: {len(done)} de {N_CUTOUTS}; modos: {dict(modes)}")
        print(f"Bytes recibidos: {sum(result.nbytes for result in done)}")
        leftovers = [path.name for path in settings.cutout_cache_dir.glob("*") if not path.name.endswith(".fits")]
        print(f"Archivos que no son recortes en la cache: {leftovers}")
        if len(done) != N_CUTOUTS or modes != {"truncated": N_CUTOUTS} or leftovers:
            print("\nRESULTADO: NO VERIFICADO del todo. Ver arriba que fallo o que bajo en modo full.")
            return 1
        if not listed:
            print("\nRESULTADO: PARCIAL. El camino cortado funciona contra el servicio real; SIA2 no respondio.")
            return 3
        print("\nRESULTADO: OK. La lista por SIA2 y el camino cortado funcionan contra el servicio real.")
        return 0
    finally:
        if args.cache_dir is None and not args.keep:
            shutil.rmtree(cache_dir, ignore_errors=True)
        else:
            print(f"La cache queda en {cache_dir}")


if __name__ == "__main__":
    sys.exit(main())
