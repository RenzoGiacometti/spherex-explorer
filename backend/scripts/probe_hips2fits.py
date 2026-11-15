"""Sondeo a mano de hips2fits (CDS) para la vista provisoria de WISE (contrato, seccion 4.10).

Hace UN pedido real, el mismo que `app.preview.hips2fits.fetch_preview`, y dice
que volvio: codigo HTTP, tiempo, tipo de contenido y, si es un FITS, forma,
unidades, WCS devuelto contra la grilla, orientacion y valores. Sirve para
verificar los parametros y los identificadores HiPS, que el 2026-11-15 no se
pudieron probar porque el servicio estaba caido (ver el encabezado de
`app/preview/hips2fits.py`, donde estan las fuentes de cada parametro).

Desde backend/:

    uv run python scripts/probe_hips2fits.py                 # W1, campo base de WISE 0855, WCS de la grilla
    uv run python scripts/probe_hips2fits.py --band 6        # W2
    uv run python scripts/probe_hips2fits.py --ra 269.4463 --dec 4.7683 --fov 0.5
    uv run python scripts/probe_hips2fits.py --mode params   # sin WCS: width, height, projection, fov, ra, dec
    uv run python scripts/probe_hips2fits.py --url https://alaskybis.cds.unistra.fr/hips-image-services/hips2fits
    uv run python scripts/probe_hips2fits.py --save tests/fixtures/preview

`--save` guarda la respuesta tal como llego (`.fits`, o `.txt` si no es un FITS)
y un `.json` con el pedido y el resumen, para usarla como fixture de los tests.

Respeta al servicio: un pedido por corrida, con timeout, sin reintentos y con
el User-Agent generico del backend. Termina con codigo 0 si la respuesta sirve
como vista provisoria y 1 si no.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import numpy as np

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    # El backend no es un paquete instalable: se importa desde backend/.
    sys.path.insert(0, str(BACKEND_DIR))

from app import geometry  # noqa: E402
from app.config import Settings  # noqa: E402
from app.domain import Grid, PreviewImage  # noqa: E402
from app.preview import hips2fits  # noqa: E402

# WISE 0855 en la epoca 2026.0 (SPEC.md, seccion 1): el ejemplo del contrato.
DEFAULT_RA, DEFAULT_DEC = 133.7598, -7.2422


def params_without_wcs(grid: Grid, hips: str) -> dict[str, str]:
    """Pedido sin WCS, con los parametros de `hips2fitsClass.query` de astroquery.

    `fov` es, segun su documentacion, "the size of the largest dimension of the
    image": para que la escala sea la de la grilla va el lado en pixeles por la
    escala, no el `fov` nominal del escalon (con 0.1667 y 195 px la escala
    quedaria en 3.0775"/px en vez de 3.075).
    """
    ny, nx = grid.shape
    return {
        "hips": hips,
        "format": "fits",
        "width": str(nx),
        "height": str(ny),
        "projection": "TAN",
        "coordsys": "icrs",
        "rotation_angle": "0.0",
        "ra": repr(grid.ra),
        "dec": repr(grid.dec),
        "fov": repr(max(nx, ny) * grid.pixel_scale_arcsec / 3600.0),
    }


def describe_fits(content: bytes, grid: Grid) -> dict[str, Any]:
    """Lo que hay que mirar de una respuesta FITS para darla por buena."""
    from astropy.wcs import WCS

    data, header = hips2fits.read_image(content)
    summary: dict[str, Any] = {
        "shape": list(data.shape),
        "grid_shape": list(grid.shape),
        "bitpix": header.get("BITPIX"),
        "bunit": header.get("BUNIT"),
        "nan_fraction": round(float(np.isnan(data).mean()), 4),
        "wcs_cards": {
            key: header[key]
            for key in ("CTYPE1", "CTYPE2", "CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2", "CDELT1", "CDELT2", "CD1_1",
                        "CD1_2", "CD2_1", "CD2_2", "PC1_1", "PC1_2", "PC2_1", "PC2_2", "RADESYS", "EQUINOX")
            if key in header
        },
    }  # fmt: skip
    finite = data[np.isfinite(data)]
    if finite.size:
        summary["values"] = {
            "min": float(finite.min()),
            "median": float(np.median(finite)),
            "p99": float(np.percentile(finite, 99.0)),
            "max": float(finite.max()),
        }
    wcs = WCS(header).celestial
    summary["has_celestial_wcs"] = bool(wcs.has_celestial)
    if wcs.has_celestial:
        summary["wcs_offset_px"] = hips2fits.wcs_offset_px(wcs, grid)
        ny, nx = data.shape
        # Orientacion de la imagen recibida: norte arriba es dec creciente con la fila;
        # este a la izquierda, RA decreciente con la columna.
        south = wcs.pixel_to_world((nx - 1) / 2.0, 0.0)
        north = wcs.pixel_to_world((nx - 1) / 2.0, ny - 1.0)
        east = wcs.pixel_to_world(0.0, (ny - 1) / 2.0)
        west = wcs.pixel_to_world(nx - 1.0, (ny - 1) / 2.0)
        summary["orientation"] = {
            "dec_row_first": float(south.icrs.dec.deg),
            "dec_row_last": float(north.icrs.dec.deg),
            "ra_column_first": float(east.icrs.ra.deg),
            "ra_column_last": float(west.icrs.ra.deg),
            "north_up": bool(north.icrs.dec.deg > south.icrs.dec.deg),
            "east_left": bool(((east.icrs.ra.deg - west.icrs.ra.deg + 180.0) % 360.0 - 180.0) > 0),
            "pixel_scale_arcsec": [
                round(float(v) * 3600.0, 5) for v in np.sqrt((wcs.pixel_scale_matrix**2).sum(axis=0))
            ],
        }
    return summary


def describe_preview(preview: PreviewImage, grid: Grid) -> dict[str, Any]:
    """La imagen ya en la grilla, como la guardaria el backend."""
    image = preview.image
    info = hips2fits.ready_preview_info(preview)
    y, x = np.unravel_index(int(np.nanargmax(image)), image.shape)
    ra, dec = geometry.pixel_to_sky(grid, float(x), float(y))
    return {
        "shape": list(image.shape),
        "dtype": str(image.dtype),
        "valid_fraction": round(float(np.isfinite(image).mean()), 4),
        "display": info.display.model_dump() if info.display is not None else None,
        "brightest_pixel": {"x": int(x), "y": int(y), "ra": round(ra, 6), "dec": round(dec, 6)},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Un pedido real a hips2fits con la grilla de un campo.")
    parser.add_argument("--ra", type=float, default=DEFAULT_RA, help="centro del campo, grados (por defecto WISE 0855)")
    parser.add_argument("--dec", type=float, default=DEFAULT_DEC)
    parser.add_argument("--fov", type=float, default=0.1667, help="lado del campo, grados: 0.1667 o 0.5")
    parser.add_argument("--band", type=int, default=3, help="detector de SPHEREx, 1 a 6: decide W1 o W2")
    parser.add_argument("--hips", help="identificador HiPS, en vez del de la banda")
    parser.add_argument("--url", help="URL del servicio, en vez de settings.hips2fits_url")
    parser.add_argument("--mode", choices=("wcs", "params"), default="wcs", help="como se describe la grilla")
    parser.add_argument("--timeout", type=float, help="segundos, en vez de settings.preview_timeout_s")
    parser.add_argument("--save", type=Path, help="carpeta donde guardar la respuesta y el resumen")
    parser.add_argument("--label", help="nombre de los archivos guardados (sin extension)")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    settings = Settings.from_env()
    if args.url:
        settings = replace(settings, hips2fits_url=args.url)
    if args.timeout:
        settings = replace(settings, preview_timeout_s=args.timeout)

    request = geometry.normalize_request(args.ra, args.dec, args.fov, args.band)
    grid = geometry.build_grid(request)
    band_name, wave_um = hips2fits.preview_band(request.band)
    hips = args.hips or hips2fits.preview_hips(request.band, settings)
    params = hips2fits.request_params(grid, hips) if args.mode == "wcs" else params_without_wcs(grid, hips)

    print(f"Servicio: {settings.hips2fits_url}")
    print(f"Campo:    RA {request.ra:.4f}, Dec {request.dec:+.4f}, {grid.shape[1]} x {grid.shape[0]} px de "
          f"{grid.pixel_scale_arcsec}\"; banda {band_name} ({wave_um} um), HiPS {hips}")  # fmt: skip
    for key, value in params.items():
        print(f"  {key} = {value}")
    print(f"URL completa: {settings.hips2fits_url}?{urlencode(params)}")

    report: dict[str, Any] = {
        "probed_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "url": settings.hips2fits_url,
        "mode": args.mode,
        "params": params,
        "grid": geometry.grid_info(grid).model_dump(),
        "band": band_name,
        "hips": hips,
    }
    started = time.perf_counter()
    reply: hips2fits.Reply | None = None
    try:
        reply = hips2fits.request_once(settings.hips2fits_url, params, settings)
    except hips2fits.PreviewUnavailable as exc:
        report["error"] = str(exc)
        print(f"\nSin respuesta en {time.perf_counter() - started:.1f} s: {exc}")
    report["seconds"] = round(time.perf_counter() - started, 2)

    usable = False
    is_fits = False
    if reply is not None:
        is_fits = reply.status == 200 and reply.body.startswith(b"SIMPLE  =")
        report.update(status=reply.status, content_type=reply.content_type, nbytes=len(reply.body))
        print(f"\nHTTP {reply.status} en {report['seconds']} s, {len(reply.body)} bytes, {reply.content_type!r}")
        if not is_fits:
            report["error"] = hips2fits.describe_error(reply)
            print(f"No es una imagen: {report['error']}")
        else:
            try:
                report["fits"] = describe_fits(reply.body, grid)
                print("FITS recibido:")
                print(json.dumps(report["fits"], indent=2, ensure_ascii=False))
                image = hips2fits.decode_preview(reply.body, grid)
                preview = PreviewImage(image=image, band=band_name, wave_um=wave_um, hips=hips)
                report["preview"] = describe_preview(preview, grid)
                print("Imagen en la grilla del campo:")
                print(json.dumps(report["preview"], indent=2, ensure_ascii=False))
                usable = True
            except hips2fits.PreviewUnavailable as exc:
                report["error"] = str(exc)
                print(f"El FITS no sirve como vista provisoria: {exc}")

    if args.save is not None:
        args.save.mkdir(parents=True, exist_ok=True)
        label = args.label or f"hips2fits_{band_name.lower()}_{request.ra:.4f}_{request.dec:+.4f}_{args.mode}"
        (args.save / f"{label}.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        if reply is not None:
            (args.save / f"{label}.{'fits' if is_fits else 'txt'}").write_bytes(reply.body)
        print(f"\nGuardado en {args.save} con el nombre {label}")

    print("\nResultado:", "sirve como vista provisoria" if usable else "NO sirve como vista provisoria")
    return 0 if usable else 1


if __name__ == "__main__":
    raise SystemExit(main())
