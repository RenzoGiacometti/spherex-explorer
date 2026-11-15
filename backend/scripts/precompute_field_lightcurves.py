"""Precalcula la curva de luz de las fuentes guardadas de cada campo precalculado. No usa la red.

Para cada campo con espectros guardados (`data/spectra/fields/<id>.json.gz`,
de `scripts/precompute_field_spectra.py`) mide la curva de luz de esas mismas
fuentes, el objeto con nombre y las mas brillantes del campo, sobre los
recortes de `cache/cutouts`, y escribe:

    backend/data/lightcurves/fields/<id>.json.gz

Asi la version publica, que no lleva los recortes, tiene curva de luz en las
mismas fuentes que tienen espectro (`app/lightcurve/saved.py`). El objeto con
nombre se mide siguiendo su movimiento propio, como en el espectro.

Hay que correrlo despues de `precompute_field_spectra.py`, cada vez que se
agrega o se rearma un campo precalculado. Cada curva tarda de 5 a 10 s.

Uso, desde backend/:
    uv run python scripts/precompute_field_lightcurves.py --workers 4
    uv run python scripts/precompute_field_lightcurves.py --only 721817858ae5e0d2
"""

from __future__ import annotations

import argparse
import sys
import time
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))
sys.path.insert(0, str(BACKEND_DIR / "scripts"))

from precompute_field_spectra import FIELD_NAMES, sesame_target  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.jobs.store import FieldStore  # noqa: E402
from app.lightcurve.lookup import lightcurves_dir  # noqa: E402
from app.lightcurve.saved import FILE_VERSION, field_curves_path  # noqa: E402
from app.lightcurve.service import LightcurveError, compute_lightcurve  # noqa: E402
from app.resolve.motion import field_center  # noqa: E402
from app.spectrum.cutouts import covering_cutouts, cutout_dirs, list_cutouts  # noqa: E402
from app.spectrum.lookup import CUTOUT_MARGIN_PX  # noqa: E402
from app.spectrum.precomputed import spectra_dir  # noqa: E402
from app.spectrum.saved import load_field_spectra, write_field_spectra  # noqa: E402
from app.spectrum.service import SpectrumTarget  # noqa: E402


def process_field(field_id: str) -> dict[str, Any]:
    """Mide y guarda las curvas de las fuentes guardadas de un campo. Devuelve un resumen para mostrar."""
    started = time.perf_counter()
    settings = get_settings()
    saved = load_field_spectra(spectra_dir(settings), field_id)
    if saved is None:
        return {"field": field_id, "error": "el campo no tiene espectros guardados"}
    store = FieldStore(settings.precomputed_fields_dir)
    meta = store.read_meta(field_id)
    center = (float(meta.request.ra), float(meta.request.dec))

    # El objeto con nombre se mide siguiendo su movimiento propio, igual que en el espectro.
    named: SpectrumTarget | None = None
    tracks = store.list_tracks(field_id)
    if tracks:
        resolved = sesame_target(tracks[0].name, settings)
        if resolved is not None:
            ra, dec = field_center(resolved, settings.field_epoch)
            named = SpectrumTarget(
                ra=ra,
                dec=dec,
                epoch=settings.field_epoch,
                name=FIELD_NAMES.get(field_id, tracks[0].name),
                motion=resolved,
            )

    cached = list_cutouts(cutout_dirs(settings))
    sources: list[dict[str, Any]] = []
    statuses: Counter[str] = Counter()
    for source in saved["sources"]:
        if source.get("kind") == "named" and named is not None:
            target = named
        else:
            target = SpectrumTarget(ra=float(source["ra"]), dec=float(source["dec"]), epoch=settings.field_epoch)
        cutouts = covering_cutouts(cached, target.ra, target.dec, margin_px=CUTOUT_MARGIN_PX, center=center)
        document: dict[str, Any] | None
        try:
            document = compute_lightcurve(cutouts, target, field_id=field_id)
            document["source"] = "precomputed"
        except LightcurveError as exc:
            document = None
            statuses[f"sin curva ({exc})"[:60]] += 1
        if document is not None:
            statuses[str(document.get("status"))] += 1
        sources.append(
            {
                "kind": source.get("kind"),
                "ra": source["ra"],
                "dec": source["dec"],
                "positions": source.get("positions"),
                "status": None if document is None else document.get("status"),
                "document": document,
            }
        )
    if not any(item["document"] is not None for item in sources):
        return {
            "field": field_id,
            "error": "no se pudo medir ninguna curva (faltan los recortes del campo en la cache)",
        }

    path = field_curves_path(lightcurves_dir(settings), field_id)
    size = write_field_spectra(
        path,
        {
            "version": FILE_VERSION,
            "field": field_id,
            "name": saved.get("name"),
            "computed_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "sources": sources,
        },
    )
    return {
        "field": field_id,
        "name": saved.get("name"),
        "sources": len(sources),
        "statuses": dict(statuses),
        "bytes": size,
        "seconds": round(time.perf_counter() - started, 1),
    }


def report(summary: dict[str, Any]) -> None:
    if "error" in summary:
        print(f"{summary['field']}: {summary['error']}", flush=True)
        return
    print(
        f"{summary['field']} {summary['name'] or ''}: {summary['sources']} fuentes ({summary['statuses']}), "
        f"{summary['bytes'] / 1024:.0f} KB en {summary['seconds']} s",
        flush=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--only", nargs="*", default=None, help="ids de campo a calcular; por defecto, todos")
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
            for summary in pool.map(process_field, ids):
                summaries.append(summary)
                report(summary)
    else:
        for field_id in ids:
            summaries.append(process_field(field_id))
            report(summaries[-1])

    total = sum(summary.get("bytes", 0) for summary in summaries)
    failed = [summary["field"] for summary in summaries if "error" in summary]
    print(f"Total: {total / 1e6:.2f} MB en {len(summaries) - len(failed)} archivos; sin curvas: {failed or 'ninguno'}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
