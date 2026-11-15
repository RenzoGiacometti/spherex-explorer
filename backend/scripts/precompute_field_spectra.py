"""Precalcula el espectro de las fuentes mas brillantes de cada campo precalculado.

Para cada campo de backend/data/fields:

1. Detecta las fuentes mas brillantes sobre los planos del campo
   (`app/spectrum/detect.py`), saturadas incluidas.
2. Suma el objeto con nombre del campo (el de su `track_*.json`), con el
   movimiento propio de la respuesta de Sesame guardada en backend/data/sesame:
   la apertura lo sigue a la fecha de cada exposicion.
3. Mide todas sobre los recortes de la cache, abriendo cada recorte una sola vez
   (`service.compute_spectra`). No baja nada: sin recortes en disco, el campo se
   saltea.
4. Guarda backend/data/spectra/fields/<id>.json.gz (`app/spectrum/saved.py`).

Una fuente detectada cuyo espectro sale `empty` (ninguna exposicion medible) no
se guarda: se detectan algunas de mas para llegar a la cantidad pedida.

Uso, desde backend/:
    uv run python scripts/precompute_field_spectra.py
    uv run python scripts/precompute_field_spectra.py --workers 4
    uv run python scripts/precompute_field_spectra.py --only 95d4d56e51048aa4 --count 20
"""

from __future__ import annotations

import argparse
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from app import geometry  # noqa: E402
from app.config import Settings, get_settings  # noqa: E402
from app.domain import ResolvedTarget  # noqa: E402
from app.jobs.store import FieldStore, StoreError  # noqa: E402
from app.resolve.motion import field_center  # noqa: E402
from app.resolve.sesame import SesameResponseError, cache_path, parse_sesame  # noqa: E402
from app.spectrum.cutouts import covering_cutouts, cutout_dirs, list_cutouts  # noqa: E402
from app.spectrum.detect import DetectConfig, detect_sources  # noqa: E402
from app.spectrum.lookup import CUTOUT_MARGIN_PX  # noqa: E402
from app.spectrum.photometry import ApertureConfig  # noqa: E402
from app.spectrum.precomputed import spectra_dir  # noqa: E402
from app.spectrum.saved import FILE_VERSION, field_spectra_path, write_field_spectra  # noqa: E402
from app.spectrum.service import NATIVE_PIXEL_ARCSEC, SpectrumTarget, compute_spectra  # noqa: E402

# Nombre que se muestra del objeto de cada campo precalculado. Los cinco primeros son los
# objetos de prueba de SPEC.md, seccion 1, con el nombre que ya usa `precompute_spectra.py`.
FIELD_NAMES = {
    "95d4d56e51048aa4": "Barnard's Star",
    "35e036ee3dee68e9": "Epsilon Indi B",
    "bfcb329969cde224": "WISE 0855-0714",
    "09413d9ee9d96187": "RW Aurigae",
    "721817858ae5e0d2": "R Draconis",
    "730d0dd6b3d7fe2a": "Proxima Centauri",
    "61ed7e9a9a710d80": "Luhman 16",
    "71a5e25f75f18168": "Wolf 359",
    "cf57e1e6aa516371": "Teegarden's Star",
    "2748d945632b7032": "Kapteyn's Star",
    "616f2ebaf5239068": "M 82",
    "d1182d95a5142a4d": "M 51",
    "f7b2e086cecaccae": "M 42",
    "12856d74fb2832ab": "M 1",
    "377ccf5770a2ee85": "M 31",
}
# Fuentes que se detectan de mas, por las que salen `empty` y no se guardan.
SPARE_SOURCES = 10


def sesame_target(name: str, settings: Settings) -> ResolvedTarget | None:
    """El objeto `name` segun la respuesta de Sesame guardada en data/sesame, o `None` si no esta."""
    path = settings.data_dir / "sesame" / cache_path(name, settings).name
    try:
        return parse_sesame(path.read_text(encoding="utf-8"), name)
    except (OSError, SesameResponseError):
        return None


def field_planes(store: FieldStore, field_id: str, meta: Any) -> np.ndarray:
    """Pila `(n, ny, nx)` con los planos del campo que estan en disco."""
    planes = []
    for plane in meta.planes or []:
        try:
            planes.append(store.read_plane(field_id, plane.epoch, plane.detector, shape=meta.grid.shape))
        except (StoreError, OSError, ValueError):
            continue
    if not planes:
        raise StoreError(f"el campo {field_id} no tiene planos en disco")
    return np.stack(planes)


def process_field(field_id: str, count: int) -> dict[str, Any]:
    """Detecta, mide y guarda las fuentes de un campo. Devuelve un resumen para mostrar."""
    started = time.perf_counter()
    settings = get_settings()
    store = FieldStore(settings.precomputed_fields_dir)
    meta = store.read_meta(field_id)
    if meta.grid is None:
        return {"field": field_id, "error": "el campo no tiene grilla"}
    grid = geometry.grid_from_info(meta.grid)
    center = (float(meta.request.ra), float(meta.request.dec))

    # El objeto con nombre: el de la trayectoria guardada del campo.
    named: SpectrumTarget | None = None
    catalog_name: str | None = None
    occupied: list[tuple[float, float]] = []
    tracks = store.list_tracks(field_id)
    if tracks:
        track = tracks[0]
        catalog_name = track.name
        resolved = sesame_target(track.name, settings)
        if resolved is not None:
            ra, dec = field_center(resolved, settings.field_epoch)
            named = SpectrumTarget(
                ra=ra, dec=dec, epoch=settings.field_epoch, name=FIELD_NAMES.get(field_id, track.name), motion=resolved
            )
            occupied.append(geometry.sky_to_pixel(grid, ra, dec))
        occupied += [(float(position.x), float(position.y)) for position in track.positions]

    detected = detect_sources(
        field_planes(store, field_id, meta), DetectConfig(max_sources=count + SPARE_SOURCES), exclude=occupied
    )

    cached = list_cutouts(cutout_dirs(settings))
    targets: list[SpectrumTarget] = [] if named is None else [named]
    for source in detected:
        ra, dec = geometry.pixel_to_sky(grid, source.x, source.y)
        # Con los decimales del documento (0,004"): lo que se mide es justo la posicion que se informa.
        targets.append(SpectrumTarget(ra=round(ra, 6), dec=round(dec, 6), epoch=settings.field_epoch))
    jobs = [
        (target, covering_cutouts(cached, target.ra, target.dec, margin_px=CUTOUT_MARGIN_PX, center=center))
        for target in targets
    ]
    if not any(cutouts for _target, cutouts in jobs):
        return {"field": field_id, "error": "no hay recortes del campo en la cache"}
    config = ApertureConfig()
    documents = compute_spectra(jobs, config=config, field_id=field_id)
    computed_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    sources: list[dict[str, Any]] = []
    n_detected = 0
    offset = 0 if named is None else 1
    for index, document in enumerate(documents):
        is_named = named is not None and index == 0
        if document is None:
            continue
        if not is_named and (document["status"] == "empty" or n_detected >= count):
            continue
        document["source"] = "precomputed"
        document["provenance"]["computed_at"] = computed_at
        positions = [{"ra": document["target"]["ra"], "dec": document["target"]["dec"]}]
        entry: dict[str, Any] = {"kind": "named" if is_named else "detected"}
        if is_named:
            document["target"]["catalog_name"] = catalog_name
            positions += [{"ra": point["ra"], "dec": point["dec"]} for point in document["target"]["track"]]
        else:
            found = detected[index - offset]
            entry["saturated"] = found.saturated
            entry["peak"] = None if found.saturated else round(found.peak, 1)
            n_detected += 1
        entry.update(
            {"ra": document["target"]["ra"], "dec": document["target"]["dec"], "positions": positions},
            status=document["status"],
            document=document,
        )
        sources.append(entry)

    path = field_spectra_path(spectra_dir(settings), field_id)
    size = write_field_spectra(
        path,
        {
            "version": FILE_VERSION,
            "field": field_id,
            "name": FIELD_NAMES.get(field_id),
            "computed_at": computed_at,
            "aperture": {
                "radius_px": config.radius_px,
                "radius_arcsec": round(config.radius_px * NATIVE_PIXEL_ARCSEC, 2),
                "annulus_in_px": config.annulus_in_px,
                "annulus_out_px": config.annulus_out_px,
                "correction": "none",
            },
            "sources": sources,
        },
    )
    statuses: dict[str, int] = {}
    for entry in sources:
        statuses[entry["status"]] = statuses.get(entry["status"], 0) + 1
    return {
        "field": field_id,
        "name": FIELD_NAMES.get(field_id),
        "named": next((entry["status"] for entry in sources if entry["kind"] == "named"), None),
        "sources": len(sources),
        "candidates": len(detected),
        "statuses": statuses,
        "cutouts": len({cutout.path for _target, cutouts in jobs for cutout in cutouts}),
        "bytes": size,
        "seconds": round(time.perf_counter() - started, 1),
    }


def report(summary: dict[str, Any]) -> None:
    if "error" in summary:
        print(f"{summary['field']}: {summary['error']}", flush=True)
        return
    print(
        f"{summary['field']} {summary['name'] or ''}: {summary['sources']} fuentes de {summary['candidates']} "
        f"candidatas ({summary['statuses']}; objeto con nombre: {summary['named']}), {summary['cutouts']} recortes, "
        f"{summary['bytes'] / 1024:.0f} KB en {summary['seconds']} s",
        flush=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", nargs="*", default=None, help="ids de campo a calcular; por defecto, todos")
    parser.add_argument("--count", type=int, default=20, help="fuentes detectadas por campo (default 20)")
    parser.add_argument("--workers", type=int, default=1, help="campos en paralelo, uno por proceso (default 1)")
    args = parser.parse_args()

    settings = get_settings()
    ids = FieldStore(settings.precomputed_fields_dir).list_ids()
    if args.only is not None:
        ids = [field_id for field_id in ids if field_id in args.only]
    print(f"{len(ids)} campos; recortes en {[str(folder) for folder in cutout_dirs(settings)]}", flush=True)

    summaries: list[dict[str, Any]] = []
    if args.workers > 1 and len(ids) > 1:
        with ProcessPoolExecutor(max_workers=args.workers) as pool:
            for summary in pool.map(process_field, ids, [args.count] * len(ids)):
                summaries.append(summary)
                report(summary)
    else:
        for field_id in ids:
            summaries.append(process_field(field_id, args.count))
            report(summaries[-1])

    total = sum(summary.get("bytes", 0) for summary in summaries)
    failed = [summary["field"] for summary in summaries if "error" in summary]
    written = len(summaries) - len(failed)
    print(f"Total: {total / 1e6:.2f} MB en {written} archivos; sin espectros: {failed or 'ninguno'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    raise SystemExit(main())
