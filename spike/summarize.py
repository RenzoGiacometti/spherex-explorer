"""Resume las corridas de field.py en tablas Markdown para RESULTADOS.md (Etapa 0).

Uso: uv run python summarize.py barnard wise0855
"""

from __future__ import annotations

import json
import math
import statistics
import sys
from pathlib import Path

from astropy.io import fits
from astropy.wcs import WCS

OUT = Path(__file__).parent / "out"


def load(label: str) -> tuple[dict, list[dict]]:
    summary = json.loads((OUT / label / "resumen.json").read_text(encoding="utf-8"))
    runs = [json.loads(line) for line in (OUT / label / "tiempos.jsonl").read_text(encoding="utf-8").splitlines() if line]
    return summary, runs


def general(label: str) -> None:
    summary, runs = load(label)
    scale = summary["grid"]["pixel_scale_arcsec"]
    print(f"\n## {summary['target']['name']} ({label})")
    print(f"objetivo: {summary['target']}")
    print(f"centro: {summary['center']}, grilla {summary['grid']}")
    print(f"consulta: {summary['query']}")
    print(f"exposiciones: {summary['exposures']}")
    print("\n| epoca | fechas | exposiciones | D1 | D2 | D3 | D4 | D5 | D6 | DR1 | QR3 | dias con datos |")
    print("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for e in summary["epochs"]:
        d = e["by_detector"]
        c = e["by_collection"]
        print(
            f"| {e['index']} | {e['start']} a {e['end']} | {e['n_exposures']} | "
            + " | ".join(str(d[f"D{i}"]) for i in range(1, 7))
            + f" | {c.get('spherex_dr1', 0)} | {c.get('spherex_qr3', 0)} | {len(e['dates'])} |"
        )
    for e in summary["epochs"]:
        print(f"  epoca {e['index']} fechas: {e['dates']}")
    print("\ncorridas (la primera es en frio):")
    for run in runs:
        d = run["download"]
        print(
            f"  {run['run_at']}: consulta {run['query_seconds']:.1f} s (cache={run['query_from_cache']}), "
            f"descarga {d['wall_seconds']} s, bajados {d['downloaded']}, cache {d['from_cache']}, fallidos {d['failed_count']}, "
            f"con reintento {d['retried']}, MB {d['bytes_received'] / 1e6:.1f}, por recorte {d['seconds_per_cutout']}, "
            f"proceso {run['processing_seconds']} s, total {run['total_seconds']} s"
        )
    p = summary["processing"]
    print(f"fraccion enmascarada: {p['masked_fraction']}; flags: {p['flag_pixel_counts']}")
    print(f"fondo residual mediana: {p['residual_background_median']}; desvio entre recortes: {p['residual_background_std']}")

    print("\n| epoca | det | N | S/R forzada | flujo forzado mJy | S/R pico | centroide-esperado [arcsec] | ajuste-esperado [arcsec] | nucleo valido |")
    print("|---|---|---|---|---|---|---|---|---|")
    def arcsec(row: dict, key: str) -> str:
        return f"{row[key] * scale:.1f}" if row.get(key) is not None else "-"

    for m in summary["target_measurements"]:
        print(
            f"| {m['epoch']} | D{m['detector']} | {m['n_exposures']} | {m.get('forced_snr')} | {m.get('forced_flux_mjy')} | "
            f"{m.get('peak_snr')} | {arcsec(m, 'centroid_offset_px')} | {arcsec(m, 'fit_offset_px')} | {m.get('core_valid_fraction')} |"
        )

    motion = summary["target_motion_first_to_last"]
    if motion:
        print("\n| det | epocas | dias | medido E [arcsec] | medido N | esperado E | esperado N |")
        print("|---|---|---|---|---|---|---|")
        for r in motion:
            print(f"| D{r['detector']} | {r['epoch_a']} a {r['epoch_b']} | {r['days']} | {r['measured_east_arcsec']} | {r['measured_north_arcsec']} | {r['expected_east_arcsec']} | {r['expected_north_arcsec']} |")
        full = [r for r in motion if r["epoch_a"] == 1 and r["epoch_b"] == len(summary["epochs"])]
        if len(full) >= 2:
            for axis in ("east", "north"):
                measured = [r[f"measured_{axis}_arcsec"] for r in full]
                expected = [r[f"expected_{axis}_arcsec"] for r in full]
                print(
                    f"  {axis}: medido {statistics.mean(measured):.2f} +/- {statistics.stdev(measured):.2f} (desvio entre {len(full)} detectores, "
                    f"error de la media {statistics.stdev(measured) / math.sqrt(len(full)):.2f}); esperado {statistics.mean(expected):.2f}"
                )
            total = math.hypot(statistics.mean(r["measured_east_arcsec"] for r in full), statistics.mean(r["measured_north_arcsec"] for r in full))
            print(f"  modulo medido: {total:.2f} arcsec = {total / 6.15:.2f} px nativos")

    # Ajuste menos esperado por epoca: donde cae la fuente brillante respecto de la marca.
    header = fits.getheader(OUT / label / "cubo.fits")
    wcs = WCS(header).celestial
    print("\nposicion ajustada por epoca y detector (RA, Dec) y desvio respecto de lo esperado (E, N) en arcsec:")
    for m in summary["target_measurements"]:
        if m.get("fit_x") is None:
            continue
        ra, dec = (float(v) for v in wcs.pixel_to_world_values(m["fit_x"], m["fit_y"]))
        east = -(m["fit_x"] - m["expected_x"]) * scale
        north = (m["fit_y"] - m["expected_y"]) * scale
        print(f"  epoca {m['epoch']} D{m['detector']}: {ra:.5f} {dec:+.5f}  dE={east:+.1f} dN={north:+.1f}  limite={m.get('fit_at_limit')}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    for name in sys.argv[1:]:
        general(name)
