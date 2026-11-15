"""Etapa 0: cubo del campo de SPHEREx para un punto del cielo.

Dado un nombre o RA/Dec y un campo de vision:
1. lista las exposiciones de DR1 y QR3 que cubren el punto (fecha y detector);
2. baja los recortes en paralelo, con reintentos y cache en disco;
3. resta ZODI, enmascara segun FLAGS y reproyecta a una grilla comun;
4. agrupa por epoca (huecos de mas de 60 dias) y detector, y hace el coadd
   ponderado por inversa de la varianza;
5. guarda un PNG por (epoca, detector), un mosaico, el cubo en FITS y un JSON
   con cantidades, fechas, tiempos y recortes fallidos.

Uso:
    uv run python field.py --name "Barnard's Star" --fov 0.1
    uv run python field.py --ra 210.80227 --dec 54.34895 --fov 0.1

Descartable: sirve para medir y decidir, no es el backend.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import re
import sys
import time
import warnings
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import quote

import astropy.units as u
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from astropy.coordinates import Distance, SkyCoord, get_body_barycentric
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from matplotlib.colors import AsinhNorm
from reproject import reproject_interp
from scipy.optimize import least_squares

import irsa

HERE = Path(__file__).resolve().parent
CACHE_DIR = HERE / "cache"
OUT_DIR = HERE / "out"

# SPEC.md: usar DR1 y QR3 (QR2 quedo reemplazado).
COLLECTIONS = ("spherex_dr1", "spherex_qr3")

# Escala nativa: `s_pixel_scale` de SIA2 (6.150); el WCS de un archivo real da 6.13 x 6.15.
NATIVE_SCALE_ARCSEC = 6.15
EPOCH_GAP_DAYS = 60.0

# El centro de la grilla es la posicion del objeto en esta fecha fija, para que
# la cache de recortes no cambie cuando aparecen exposiciones nuevas.
CENTER_EPOCH = 2026.0

# Flags que activan el aviso conservador CONTAINS_BAD_PIXEL del SPHEREx
# Explanatory Supplement (tabla 16), tal como los usa el tutorial oficial:
# https://caltech-ipac.github.io/irsa-tutorials/spherex-source-discovery-tool-demo/
# SOURCE queda afuera a proposito: marca pixeles de fuentes conocidas.
BAD_FLAGS = (
    "TRANSIENT", "OVERFLOW", "SUR_ERROR", "NONFUNC", "DICHROIC", "MISSING_DATA", "HOT", "COLD",
    "NONLINEAR", "CROSSTALK", "GHOST", "GHOST_FPA", "GHOST_EXT", "STREAK", "PERSIST",
    "BLOOM", "SNOWBALL", "HALO", "SATELLITE_HALO",
)  # fmt: skip

# Resolucion de nombres: Sesame (CDS) y su espejo en CfA, salida XML.
SESAME_URLS = (
    "https://cds.unistra.fr/cgi-bin/nph-sesame/-ox/S?",
    "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-ox/S?",
)

# Fotometria sobre el coadd, en pixeles nativos.
APERTURE_RADIUS = 1.5
ANNULUS_INNER = 4.0
ANNULUS_OUTER = 8.0
SEARCH_RADIUS = 2.0
FIT_RADIUS = 6.0
FIT_CENTER_LIMIT = 3.0
FIT_WIDTH = 1.0

MARK_COLOR = "#ff9d00"


# ----------------------------------------------------------------------- objetivo


@dataclass(frozen=True)
class Target:
    """Posicion ICRS en `ref_epoch` y movimiento del objeto."""

    name: str
    ra: float
    dec: float
    pm_ra: float = 0.0  # mas/anio, incluye cos(dec)
    pm_dec: float = 0.0  # mas/anio
    parallax: float = 0.0  # mas
    radial_velocity: float = 0.0  # km/s
    ref_epoch: float = 2000.0  # anio juliano
    source: str = "manual"

    @property
    def moves(self) -> bool:
        return bool(self.pm_ra or self.pm_dec or self.parallax)

    def position_at(self, mjd: float) -> tuple[float, float]:
        """RA/Dec ICRS aparentes en la fecha: movimiento propio mas paralaje."""
        if not self.moves:
            return self.ra, self.dec
        when = Time(mjd, format="mjd")
        kwargs: dict[str, object] = {
            "ra": self.ra * u.deg,
            "dec": self.dec * u.deg,
            "pm_ra_cosdec": self.pm_ra * u.mas / u.yr,
            "pm_dec": self.pm_dec * u.mas / u.yr,
            "obstime": Time(self.ref_epoch, format="jyear"),
            "frame": "icrs",
        }
        if self.parallax > 0:
            kwargs["distance"] = Distance(parallax=self.parallax * u.mas)
            kwargs["radial_velocity"] = self.radial_velocity * u.km / u.s
        moved = SkyCoord(**kwargs).apply_space_motion(new_obstime=when)
        ra, dec = float(moved.ra.deg), float(moved.dec.deg)
        if self.parallax > 0:
            # Desplazamiento paralactico = -paralaje * (posicion baricentrica del
            # observador proyectada sobre el plano del cielo). SPHEREx esta en
            # orbita baja: se usa la Tierra.
            x, y, z = get_body_barycentric("earth", when).xyz.to_value(u.au)
            a, d = math.radians(ra), math.radians(dec)
            east = self.parallax * (x * math.sin(a) - y * math.cos(a))
            north = self.parallax * (x * math.cos(a) * math.sin(d) + y * math.sin(a) * math.sin(d) - z * math.cos(d))
            ra += east / 3.6e6 / math.cos(d)
            dec += north / 3.6e6
        return ra, dec


def resolve_name(name: str) -> Target:
    """Resuelve un nombre con Sesame; trae movimiento propio, paralaje y velocidad radial.

    SIMBAD da la posicion ICRS en la epoca J2000.0 (comprobado con WISE 0855:
    su RA de SIMBAD es la de la epoca WISE llevada hacia atras a 2000.0).
    """
    cache_file = CACHE_DIR / "sesame" / (re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_").lower() + ".xml")
    if cache_file.exists():
        text = cache_file.read_text(encoding="utf-8")
    else:
        text = ""
        errors: list[str] = []
        for base in SESAME_URLS:
            try:
                resp = irsa.http("GET", base + quote(name), tries=3, timeout=(15.0, 40.0))
            except irsa.IrsaError as exc:
                errors.append(str(exc))
                continue
            if resp.status_code == 200 and "<jradeg>" in resp.text:
                text = resp.text
                break
            errors.append(f"{base}: HTTP {resp.status_code}, sin posicion")
        if not text:
            raise SystemExit(f"No se pudo resolver '{name}' con Sesame: {errors}")
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(text, encoding="utf-8")

    resolver = ET.fromstring(text.split("<!---")[0]).find("./Target/Resolver")
    if resolver is None:
        raise SystemExit(f"Sesame no devolvio datos para '{name}'")

    def number(path: str) -> float:
        node = resolver.find(path)
        return float(node.text) if node is not None and node.text else 0.0

    return Target(
        name=name,
        ra=number("jradeg"),
        dec=number("jdedeg"),
        pm_ra=number("pm/pmRA"),
        pm_dec=number("pm/pmDE"),
        parallax=number("plx/v"),
        radial_velocity=number("Vel/v"),
        ref_epoch=2000.0,
        source=f"Sesame/SIMBAD ({resolver.findtext('oname', default=name)})",
    )


# -------------------------------------------------------------------- exposiciones


@dataclass(frozen=True)
class Exposure:
    obs_id: str
    collection: str
    detector: int
    mjd_start: float
    mjd_end: float
    url: str
    wave_min_um: float
    wave_max_um: float


def list_exposures_sia(ra: float, dec: float, refresh: bool) -> tuple[list[Exposure], dict[str, object]]:
    """Exposiciones que cubren el punto, via SIA2 (una consulta por coleccion).

    Columnas ObsCore de `spherex.obscore` (TAP_SCHEMA): obs_id, obs_collection,
    energy_bandpassname, t_min, t_max, access_url, em_min, em_max, calib_level,
    dataproduct_type, dataproduct_subtype, s_pixel_scale.
    """
    exposures: list[Exposure] = []
    info: dict[str, object] = {"source": "sia", "seconds": 0.0, "from_cache": True, "collections": {}}
    skipped: Counter[str] = Counter()
    pixel_scales: Counter[str] = Counter()
    for collection in COLLECTIONS:
        rows, meta = irsa.sia_query(ra, dec, collection, CACHE_DIR, refresh=refresh)
        info["seconds"] = float(info["seconds"]) + float(meta["seconds"])  # type: ignore[arg-type]
        info["from_cache"] = bool(info["from_cache"]) and bool(meta["from_cache"])
        info["collections"][collection] = {  # type: ignore[index]
            "rows": len(rows), "seconds": meta["seconds"], "queried_at": meta["queried_at"],
            "from_cache": meta["from_cache"], "refresh_error": meta.get("refresh_error"),
        }  # fmt: skip
        for row in rows:
            kind = f"{row['dataproduct_type']}/{row['dataproduct_subtype']}/nivel {row['calib_level']}"
            if kind != "image/science/nivel 2":
                skipped[kind] += 1
                continue
            pixel_scales[row["s_pixel_scale"]] += 1
            exposures.append(
                Exposure(
                    obs_id=row["obs_id"],
                    collection=row["obs_collection"],
                    detector=int(row["energy_bandpassname"].rsplit("D", 1)[-1]),
                    mjd_start=float(row["t_min"]),
                    mjd_end=float(row["t_max"]),
                    url=row["access_url"],
                    wave_min_um=float(row["em_min"]) * 1e6,
                    wave_max_um=float(row["em_max"]) * 1e6,
                )
            )
    info["skipped_products"] = dict(skipped)
    info["s_pixel_scale"] = dict(pixel_scales)
    return exposures, info


def list_exposures_tap(ra: float, dec: float, refresh: bool) -> tuple[list[Exposure], dict[str, object]]:
    """Lo mismo via TAP. Consulta del tutorial de cutouts mas `spherex.observation`
    para la coleccion. Columnas tomadas de TAP_SCHEMA (resultados/tap_schema.txt).

    No probado de punta a punta: el 2026-11-15 las consultas espaciales de
    SPHEREx en TAP agotaban el tiempo de espera (ver check_tap.py)."""
    collections = ", ".join(f"'{c}'" for c in COLLECTIONS)
    adql = f"""
        SELECT o.collection, o.observationid, a.uri, p.energy_bandpassname,
               p.time_bounds_lower, p.time_bounds_upper,
               p.energy_bounds_lower, p.energy_bounds_upper
        FROM spherex.artifact a
        JOIN spherex.plane p ON a.planeid = p.planeid
        JOIN spherex.observation o ON p.obsid = o.obsid
        WHERE 1 = CONTAINS(POINT('ICRS', {ra:.6f}, {dec:.6f}), p.poly)
          AND o.collection IN ({collections})
        ORDER BY p.time_bounds_lower
    """
    rows, meta = irsa.tap_query(adql, CACHE_DIR, refresh=refresh)
    exposures = [
        Exposure(
            obs_id=row["observationid"],
            collection=row["collection"],
            detector=int(row["energy_bandpassname"].rsplit("D", 1)[-1]),
            mjd_start=float(row["time_bounds_lower"]),
            mjd_end=float(row["time_bounds_upper"]),
            url=irsa.IRSA_BASE + row["uri"],
            wave_min_um=float(row["energy_bounds_lower"]) * 1e6,
            wave_max_um=float(row["energy_bounds_upper"]) * 1e6,
        )
        for row in rows
    ]
    return exposures, {"source": "tap", "seconds": meta["seconds"], "from_cache": meta["from_cache"]}


def deduplicate(exposures: list[Exposure]) -> tuple[list[Exposure], int]:
    """Si una exposicion esta en DR1 y en QR3, se queda la de DR1."""
    best: dict[tuple[str, int], Exposure] = {}
    for exp in exposures:
        key = (exp.obs_id, exp.detector)
        current = best.get(key)
        if current is None or (exp.collection == "spherex_dr1" and current.collection != "spherex_dr1"):
            best[key] = exp
    unique = sorted(best.values(), key=lambda e: (e.mjd_start, e.detector))
    return unique, len(exposures) - len(unique)


def assign_epochs(exposures: list[Exposure]) -> list[int]:
    """Indice de epoca de cada exposicion (ordenadas por fecha): corta en huecos > 60 dias."""
    epochs: list[int] = []
    current = 0
    for i, exp in enumerate(exposures):
        if i > 0 and exp.mjd_start - exposures[i - 1].mjd_start > EPOCH_GAP_DAYS:
            current += 1
        epochs.append(current)
    return epochs


# ------------------------------------------------------------------ procesamiento


def output_grid(ra: float, dec: float, fov_deg: float, scale_arcsec: float) -> tuple[WCS, tuple[int, int]]:
    """Grilla comun: proyeccion TAN centrada en (ra, dec), norte arriba, este a la izquierda."""
    n = 2 * int(fov_deg * 3600.0 / scale_arcsec / 2.0) + 1  # impar: el centro cae en un pixel
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [ra, dec]
    wcs.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]
    wcs.wcs.cdelt = [-scale_arcsec / 3600.0, scale_arcsec / 3600.0]
    wcs.wcs.cunit = ["deg", "deg"]
    return wcs, (n, n)


def load_and_reproject(
    path: Path,
    out_wcs: WCS,
    shape: tuple[int, int],
    subtract_background: bool,
) -> tuple[np.ndarray, np.ndarray, dict[str, int], float]:
    """Devuelve (imagen, varianza) en la grilla comun, el conteo de flags y el fondo residual."""
    with fits.open(path, memmap=False) as hdul:
        header = hdul["IMAGE"].header
        image = hdul["IMAGE"].data.astype(np.float64)
        zodi = hdul["ZODI"].data.astype(np.float64)
        variance = hdul["VARIANCE"].data.astype(np.float64)
        flags = hdul["FLAGS"].data.astype(np.int64)
        flag_header = hdul["FLAGS"].header
        # MSKNnnnn da el nombre del bit nnnn (tutorial spherex-intro, seccion 9).
        bits = {str(flag_header[key]): int(key[4:]) for key in flag_header["MSKN*"]}

    flag_counts = {name: int(((flags >> bit) & 1).sum()) for name, bit in bits.items()}
    bad_bits = 0
    for name in BAD_FLAGS:
        if name in bits:
            bad_bits |= 1 << bits[name]

    data = image - zodi
    bad = ((flags & bad_bits) != 0) | ~np.isfinite(data) | ~np.isfinite(variance) | (variance <= 0)
    flag_counts["_masked"] = int(bad.sum())
    flag_counts["_pixels"] = int(bad.size)

    background = 0.0
    if subtract_background:
        # Fondo residual tras restar ZODI: mediana de los pixeles validos que no
        # pertenecen a fuentes conocidas (flag SOURCE), si quedan suficientes.
        sky = ~bad
        if "SOURCE" in bits:
            no_source = sky & (((flags >> bits["SOURCE"]) & 1) == 0)
            if no_source.sum() >= 50:
                sky = no_source
        if sky.any():
            background = float(np.median(data[sky]))
            data = data - background

    data[bad] = np.nan
    variance[bad] = np.nan
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        wcs = WCS(header)
        stacked = reproject_interp(
            (np.stack([data, variance]), wcs), out_wcs, shape_out=shape, order="bilinear", return_footprint=False
        )
    return stacked[0], stacked[1], flag_counts, background


def coadd(images: list[np.ndarray], variances: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Media ponderada por inversa de la varianza. Devuelve (coadd, varianza, cobertura)."""
    data = np.stack(images)
    var = np.stack(variances)
    valid = np.isfinite(data) & np.isfinite(var) & (var > 0)
    weight = np.where(valid, 1.0 / np.where(valid, var, 1.0), 0.0)
    total = weight.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(total > 0, (weight * np.where(valid, data, 0.0)).sum(axis=0) / total, np.nan)
        mean_var = np.where(total > 0, 1.0 / total, np.nan)
    return mean, mean_var, valid.sum(axis=0)


# ------------------------------------------------------------------------ medicion


def _mad_sigma(values: np.ndarray) -> float:
    median = np.median(values)
    return float(1.4826 * np.median(np.abs(values - median)))


def fit_profile(
    image: np.ndarray, x0: float, y0: float, oversample: int, background: float, sigma: float
) -> dict[str, float | int | None]:
    """Centro por ajuste de un perfil de Moffat a los pixeles validos cerca de (x0, y0).

    Sirve aunque el nucleo este enmascarado por saturacion (Barnard): las alas
    alcanzan para fijar el centro. La perdida robusta le quita peso a las
    estrellas vecinas.
    """
    yy, xx = np.indices(image.shape)
    selected = (np.hypot(xx - x0, yy - y0) <= FIT_RADIUS * oversample) & np.isfinite(image)
    if selected.sum() < 30:
        return {}
    xs, ys, values = xx[selected].astype(float), yy[selected].astype(float), image[selected].astype(float)
    amplitude = max(float(values.max() - background), sigma, 1e-9)
    limit = FIT_CENTER_LIMIT * oversample
    # Ancho fijo: con el nucleo enmascarado, amplitud y ancho son degenerados
    # (en las alas solo importa su producto) y el ajuste no converge.
    width2 = (FIT_WIDTH * oversample) ** 2

    def residual(p: np.ndarray) -> np.ndarray:
        r2 = (xs - p[0]) ** 2 + (ys - p[1]) ** 2
        return p[4] + p[2] * (1.0 + r2 / width2) ** (-p[3]) - values

    try:
        fit = least_squares(
            residual,
            x0=[x0, y0, amplitude, 2.0, background],
            bounds=(
                [x0 - limit, y0 - limit, 0.0, 0.3, -np.inf],
                [x0 + limit, y0 + limit, np.inf, 8.0, np.inf],
            ),
            loss="soft_l1",
            f_scale=max(3.0 * sigma, 1e-9),
            x_scale="jac",
            max_nfev=2000,
        )
    except ValueError:
        return {}
    if not fit.success:
        return {}
    return {
        "fit_x": round(float(fit.x[0]), 3),
        "fit_y": round(float(fit.x[1]), 3),
        "fit_offset_px": round(math.hypot(fit.x[0] - x0, fit.x[1] - y0), 3),
        "fit_amplitude": round(float(fit.x[2]), 5),
        "fit_beta": round(float(fit.x[3]), 3),
        "fit_points": int(selected.sum()),
        "fit_at_limit": bool(abs(fit.x[0] - x0) > 0.98 * limit or abs(fit.x[1] - y0) > 0.98 * limit),
    }


def measure(image: np.ndarray, x0: float, y0: float, oversample: int) -> dict[str, float | bool | None]:
    """Centroide y relacion senal/ruido cerca de la posicion esperada (x0, y0).

    El ruido se estima de forma empirica: dispersion de sumas de apertura
    iguales repartidas por el campo. Asi absorbe el ruido correlacionado que
    introduce el remuestreo, que una estimacion pixel a pixel subestima.
    """
    r_ap = APERTURE_RADIUS * oversample
    yy, xx = np.indices(image.shape)
    finite = np.isfinite(image)
    dist = np.hypot(xx - x0, yy - y0)
    result: dict[str, float | bool | None] = {
        "expected_x": round(float(x0), 3),
        "expected_y": round(float(y0), 3),
        "in_field": bool(0 <= x0 < image.shape[1] and 0 <= y0 < image.shape[0]),
    }
    annulus = image[(dist >= ANNULUS_INNER * oversample) & (dist < ANNULUS_OUTER * oversample) & finite]
    if annulus.size < 20:
        return result | {"measured": False}
    background = float(np.median(annulus))
    sigma_pix = _mad_sigma(annulus)

    def aperture_sum(cx: float, cy: float) -> tuple[float, float]:
        inside = np.hypot(xx - cx, yy - cy) <= r_ap
        good = inside & finite
        if inside.sum() == 0 or good.sum() < 0.6 * inside.sum():
            return math.nan, 0.0
        return float((image[good] - background).sum() * inside.sum() / good.sum()), float(good.sum() / inside.sum())

    # Sumas de control lejos del objetivo, con el mismo fondo local restado por posicion.
    control: list[float] = []
    step = 2.0 * r_ap
    margin = ANNULUS_OUTER * oversample
    for cy in np.arange(margin, image.shape[0] - margin, step):
        for cx in np.arange(margin, image.shape[1] - margin, step):
            if math.hypot(cx - x0, cy - y0) < 3.0 * r_ap:
                continue
            d = np.hypot(xx - cx, yy - cy)
            ring = image[(d >= ANNULUS_INNER * oversample) & (d < ANNULUS_OUTER * oversample) & finite]
            inside = d <= r_ap
            good = inside & finite
            if ring.size < 20 or good.sum() < inside.sum():
                continue
            control.append(float((image[good] - np.median(ring)).sum()))
    sigma_ap = _mad_sigma(np.array(control)) if len(control) >= 10 else math.nan

    forced_flux, forced_coverage = aperture_sum(x0, y0)

    # Centroide ponderado por flujo, partiendo del pixel mas brillante cerca de lo esperado.
    search = (dist <= SEARCH_RADIUS * oversample) & finite
    centroid_x = centroid_y = math.nan
    peak = math.nan
    if search.any():
        flat = np.where(search, image, -np.inf)
        iy, ix = np.unravel_index(int(np.argmax(flat)), image.shape)
        peak = float(image[iy, ix] - background)
        cx, cy = float(ix), float(iy)
        for _ in range(10):
            inside = (np.hypot(xx - cx, yy - cy) <= r_ap) & finite
            weights = np.clip(image[inside] - background, 0.0, None)
            if weights.sum() <= 0:
                break
            nx, ny = float((weights * xx[inside]).sum() / weights.sum()), float((weights * yy[inside]).sum() / weights.sum())
            moved = math.hypot(nx - cx, ny - cy)
            cx, cy = nx, ny
            if moved < 0.01:
                break
        centroid_x, centroid_y = cx, cy
    centroid_flux, _ = aperture_sum(centroid_x, centroid_y) if math.isfinite(centroid_x) else (math.nan, 0.0)

    def clean(value: float, digits: int = 4) -> float | None:
        return round(value, digits) if math.isfinite(value) else None

    return result | {
        "measured": True,
        "background": clean(background, 5),
        "sigma_pixel": clean(sigma_pix, 5),
        "sigma_aperture": clean(sigma_ap, 5),
        "control_apertures": len(control),
        "forced_flux": clean(forced_flux, 5),
        "forced_coverage": clean(forced_coverage, 3),
        "forced_snr": clean(forced_flux / sigma_ap, 2) if sigma_ap and math.isfinite(sigma_ap) else None,
        "peak": clean(peak, 5),
        "peak_snr": clean(peak / sigma_pix, 2) if sigma_pix > 0 else None,
        "centroid_x": clean(centroid_x, 3),
        "centroid_y": clean(centroid_y, 3),
        "centroid_flux": clean(centroid_flux, 5),
        "centroid_snr": clean(centroid_flux / sigma_ap, 2) if sigma_ap and math.isfinite(sigma_ap) else None,
        "centroid_offset_px": clean(math.hypot(centroid_x - x0, centroid_y - y0), 3),
        "core_valid_fraction": round(float(finite[dist <= r_ap].mean()), 3) if (dist <= r_ap).any() else None,
    } | fit_profile(image, x0, y0, oversample, background, sigma_pix)


def motion_between(
    measurements: list[dict[str, object]], target: Target, scale_arcsec: float
) -> list[dict[str, object]]:
    """Desplazamiento medido y esperado entre la primera y la ultima epoca, por detector.

    La grilla es TAN con norte arriba y x creciente hacia el oeste.
    """
    rows: list[dict[str, object]] = []
    for detector in range(1, 7):
        fitted = [m for m in measurements if m["detector"] == detector and m.get("fit_x") is not None and not m.get("fit_at_limit")]
        if len(fitted) < 2:
            continue
        first, last = fitted[0], fitted[-1]
        if first["epoch"] == last["epoch"]:
            continue
        ra_a, dec_a = target.position_at(float(first["mjd_mean"]))  # type: ignore[arg-type]
        ra_b, dec_b = target.position_at(float(last["mjd_mean"]))  # type: ignore[arg-type]
        rows.append(
            {
                "detector": detector,
                "epoch_a": first["epoch"],
                "epoch_b": last["epoch"],
                "days": round(float(last["mjd_mean"]) - float(first["mjd_mean"]), 1),  # type: ignore[arg-type]
                "measured_east_arcsec": round(-(float(last["fit_x"]) - float(first["fit_x"])) * scale_arcsec, 2),  # type: ignore[arg-type]
                "measured_north_arcsec": round((float(last["fit_y"]) - float(first["fit_y"])) * scale_arcsec, 2),  # type: ignore[arg-type]
                "expected_east_arcsec": round((ra_b - ra_a) * math.cos(math.radians(dec_a)) * 3600.0, 2),
                "expected_north_arcsec": round((dec_b - dec_a) * 3600.0, 2),
            }
        )
    return rows


# ------------------------------------------------------------------------ graficos


def stretch(planes: list[np.ndarray]) -> AsinhNorm | None:
    """Misma escala para todas las epocas de un detector, para poder compararlas."""
    values = np.concatenate([p[np.isfinite(p)].ravel() for p in planes]) if planes else np.array([])
    if values.size < 10:
        return None
    median = float(np.median(values))
    sigma = max(_mad_sigma(values), 1e-6)
    high = max(float(np.percentile(values, 99.7)), median + 10 * sigma)
    return AsinhNorm(linear_width=3 * sigma, vmin=median - 2 * sigma, vmax=high)


def draw_panel(ax: plt.Axes, image: np.ndarray, norm: AsinhNorm | None, mark: tuple[float, float] | None, gap: float) -> None:
    ax.set_facecolor("#3a3a3a")  # los pixeles sin datos (NaN) quedan en gris medio
    ax.imshow(image, origin="lower", cmap="gray", norm=norm, interpolation="nearest")
    if mark is not None:
        x, y = mark
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ax.plot([x + dx * gap, x + dx * 2.2 * gap], [y + dy * gap, y + dy * 2.2 * gap], color=MARK_COLOR, lw=1.0)
    ax.set_xlim(-0.5, image.shape[1] - 0.5)
    ax.set_ylim(-0.5, image.shape[0] - 0.5)
    ax.set_xticks([])
    ax.set_yticks([])


# ----------------------------------------------------------------------- principal


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def iso_date(mjd: float) -> str:
    return str(Time(mjd, format="mjd").iso)[:10]


def run(args: argparse.Namespace) -> None:
    t_total = time.perf_counter()
    logging.getLogger("astropy").setLevel(logging.ERROR)
    warnings.filterwarnings("ignore", module="erfa")

    if args.name:
        target = resolve_name(args.name)
    else:
        target = Target(
            name=args.label or f"{args.ra:.5f} {args.dec:+.5f}",
            ra=args.ra, dec=args.dec, pm_ra=args.pm_ra, pm_dec=args.pm_dec,
            parallax=args.plx, ref_epoch=args.epoch,
        )  # fmt: skip
    center_mjd = float(Time(CENTER_EPOCH, format="jyear").mjd)
    center_ra, center_dec = (round(v, 6) for v in target.position_at(center_mjd))
    slug = slugify(args.label or target.name)
    out_dir = OUT_DIR / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Objetivo: {target.name} ({target.source})")
    print(f"Centro de la grilla (epoca {CENTER_EPOCH}): RA {center_ra:.6f}, Dec {center_dec:+.6f}; campo {args.fov} grados")

    # 1. Exposiciones
    lister = list_exposures_tap if args.source == "tap" else list_exposures_sia
    raw_exposures, query_info = lister(center_ra, center_dec, args.refresh_query)
    exposures, duplicates = deduplicate(raw_exposures)
    if args.limit:
        exposures = exposures[:: max(1, len(exposures) // args.limit)][: args.limit]
    if not exposures:
        raise SystemExit("Ninguna exposicion de DR1 o QR3 cubre el punto.")
    epochs = assign_epochs(exposures)
    n_epochs = epochs[-1] + 1
    print(
        f"Consulta ({query_info['source']}): {len(raw_exposures)} filas en {float(query_info['seconds']):.1f} s"
        f"{' (cache)' if query_info['from_cache'] else ''}; {len(exposures)} exposiciones, {n_epochs} epocas"
    )
    if args.query_only:
        # Solo dimensionar el campo: cuantas exposiciones, de que coleccion y como se reparten.
        print(f"  por coleccion: {dict(Counter(e.collection for e in exposures))}")
        print(f"  por detector: { {f'D{d}': sum(e.detector == d for e in exposures) for d in range(1, 7)} }")
        gaps = np.diff([e.mjd_start for e in exposures]) if len(exposures) > 1 else np.array([0.0])
        print(f"  mayor hueco entre exposiciones consecutivas: {float(gaps.max()):.1f} dias")
        for epoch in range(n_epochs):
            mjds = [e.mjd_start for e, k in zip(exposures, epochs, strict=True) if k == epoch]
            months = Counter(iso_date(m)[:7] for m in mjds)
            print(f"  epoca {epoch + 1}: {iso_date(min(mjds))} a {iso_date(max(mjds))}, {len(mjds)} exposiciones, por mes {dict(sorted(months.items()))}")
        return

    # 2. Recortes
    # El recorte viene en la orientacion del detector. Con --cutout-scale 1.4142
    # (raiz de 2) mas 4 px de margen cubre la grilla con cualquier giro.
    cutout_size = args.fov
    if args.cutout_scale != 1.0:
        cutout_size = round(args.fov * args.cutout_scale + 4 * NATIVE_SCALE_ARCSEC / 3600.0, 5)
        print(f"Lado del recorte pedido: {cutout_size} grados")
    t_download = time.perf_counter()

    def progress(done: int, total: int, result: irsa.CutoutResult) -> None:
        if done % 50 == 0 or done == total or not result.ok:
            state = "ok" if result.ok else f"FALLO ({result.error})"
            print(f"  recorte {done}/{total}: {state}", flush=True)

    results = irsa.fetch_cutouts(
        [e.url for e in exposures], center_ra, center_dec, cutout_size, CACHE_DIR,
        workers=args.workers, full=args.full, progress=progress,
    )  # fmt: skip
    download_seconds = time.perf_counter() - t_download
    fresh = [r for r in results if r.ok and not r.from_cache]
    failed = [r for r in results if not r.ok]
    print(
        f"Descarga: {len(fresh)} bajados, {sum(r.from_cache for r in results)} de cache, "
        f"{len(failed)} fallidos en {download_seconds:.1f} s"
    )

    # 3. Resta de ZODI, mascara y reproyeccion
    t_process = time.perf_counter()
    scale = NATIVE_SCALE_ARCSEC / args.oversample
    out_wcs, shape = output_grid(center_ra, center_dec, args.fov, scale)
    groups: dict[tuple[int, int], list[int]] = {}
    planes: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    flag_totals: Counter[str] = Counter()
    backgrounds: dict[int, list[float]] = {d: [] for d in range(1, 7)}
    unreadable: list[dict[str, str]] = []
    for i, (exp, result) in enumerate(zip(exposures, results, strict=True)):
        if not result.ok or result.path is None:
            continue
        try:
            image, variance, flag_counts, background = load_and_reproject(result.path, out_wcs, shape, not args.no_background)
        except (OSError, KeyError, ValueError) as exc:
            unreadable.append({"url": result.url, "error": f"{type(exc).__name__}: {exc}"[:200]})
            continue
        planes[i] = (image, variance)
        flag_totals.update(flag_counts)
        backgrounds[exp.detector].append(background)
        groups.setdefault((epochs[i], exp.detector), []).append(i)

    # 4. Coadd por (epoca, detector)
    cube = np.full((n_epochs, 6, *shape), np.nan, dtype=np.float32)
    cube_var = np.full((n_epochs, 6, *shape), np.nan, dtype=np.float32)
    coverage = np.zeros((n_epochs, 6, *shape), dtype=np.int16)
    for (epoch, detector), members in groups.items():
        mean, mean_var, count = coadd([planes[i][0] for i in members], [planes[i][1] for i in members])
        cube[epoch, detector - 1] = mean
        cube_var[epoch, detector - 1] = mean_var
        coverage[epoch, detector - 1] = count
    process_seconds = time.perf_counter() - t_process

    # 5. Salidas
    epoch_info: list[dict[str, object]] = []
    for epoch in range(n_epochs):
        members = [i for i, e in enumerate(epochs) if e == epoch]
        mjds = [exposures[i].mjd_start for i in members]
        used = [i for i in members if i in planes]
        epoch_info.append(
            {
                "index": epoch + 1,
                "start": iso_date(min(mjds)),
                "end": iso_date(max(mjds)),
                "mjd_start": round(min(mjds), 5),
                "mjd_end": round(max(mjds), 5),
                "mjd_mean": round(float(np.mean(mjds)), 5),
                "n_exposures": len(members),
                "n_used": len(used),
                "dates": dict(sorted(Counter(iso_date(m) for m in mjds).items())),
                "by_detector": {f"D{d}": sum(exposures[i].detector == d for i in members) for d in range(1, 7)},
                "by_collection": dict(Counter(exposures[i].collection for i in members)),
            }
        )

    wave_range = {d: (min(e.wave_min_um for e in exposures if e.detector == d), max(e.wave_max_um for e in exposures if e.detector == d))
                  for d in range(1, 7) if any(e.detector == d for e in exposures)}  # fmt: skip

    measurements: list[dict[str, object]] = []
    marks: dict[tuple[int, int], tuple[float, float]] = {}
    for epoch in range(n_epochs):
        for detector in range(1, 7):
            members = groups.get((epoch, detector), [])
            if not members:
                continue
            mjd = float(np.mean([exposures[i].mjd_start for i in members]))
            ra, dec = target.position_at(mjd)
            x, y = (float(v) for v in out_wcs.world_to_pixel_values(ra, dec))
            marks[(epoch, detector)] = (x, y)
            row = {
                "epoch": epoch + 1, "detector": detector, "n_exposures": len(members), "mjd_mean": round(mjd, 4),
                "expected_ra": round(ra, 7), "expected_dec": round(dec, 7),
            } | measure(cube[epoch, detector - 1].astype(np.float64), x, y, args.oversample)  # fmt: skip
            # Suma de apertura [MJy/sr] x angulo solido del pixel de salida [sr] -> mJy.
            # Sin correccion de apertura: subestima el flujo total de una fuente puntual.
            pixel_sr = math.radians(scale / 3600.0) ** 2
            for key in ("forced_flux", "centroid_flux"):
                value = row.get(key)
                row[f"{key}_mjy"] = round(float(value) * pixel_sr * 1e9, 4) if isinstance(value, float) else None
            measurements.append(row)

    norms = {d: stretch([cube[e, d - 1] for e in range(n_epochs) if (e, d) in groups]) for d in range(1, 7)}
    gap = 2.0 * args.oversample
    for (epoch, detector), members in sorted(groups.items()):
        fig, ax = plt.subplots(figsize=(5, 5.3), dpi=110)
        draw_panel(ax, cube[epoch, detector - 1], norms[detector], marks.get((epoch, detector)), gap)
        info = epoch_info[epoch]
        low, high = wave_range[detector]
        ax.set_title(
            f"{target.name}\nepoca {epoch + 1}: {info['start']} a {info['end']} | D{detector} "
            f"({low:.2f}-{high:.2f} um) | N={len(members)}",
            fontsize=8,
        )
        fig.tight_layout()
        fig.savefig(out_dir / f"epoca{epoch + 1}_d{detector}.png")
        plt.close(fig)

    fig, axes = plt.subplots(n_epochs, 6, figsize=(15, 2.6 * n_epochs + 0.6), dpi=100, squeeze=False)
    for epoch in range(n_epochs):
        for detector in range(1, 7):
            ax = axes[epoch][detector - 1]
            draw_panel(ax, cube[epoch, detector - 1], norms[detector], marks.get((epoch, detector)), gap)
            n = len(groups.get((epoch, detector), []))
            if epoch == 0 and detector in wave_range:
                ax.set_title(f"D{detector} ({wave_range[detector][0]:.2f}-{wave_range[detector][1]:.2f} um)", fontsize=9)
            ax.text(0.03, 0.03, f"N={n}", transform=ax.transAxes, color="white", fontsize=7)
            if detector == 1:
                ax.set_ylabel(f"epoca {epoch + 1}\n{epoch_info[epoch]['start']}\na {epoch_info[epoch]['end']}", fontsize=8)
    fig.suptitle(f"{target.name}: coadd por epoca y detector, campo {args.fov} grados, norte arriba, este a la izquierda", fontsize=10)
    fig.tight_layout()
    fig.savefig(out_dir / "mosaico.png")
    plt.close(fig)

    # Acercamiento alrededor del objetivo, para ver el desplazamiento entre epocas.
    half = int(8 * args.oversample)
    cx, cy = (round(float(v)) for v in out_wcs.world_to_pixel_values(*target.position_at(center_mjd)))
    fig, axes = plt.subplots(n_epochs, 6, figsize=(15, 2.6 * n_epochs + 0.6), dpi=100, squeeze=False)
    for epoch in range(n_epochs):
        for detector in range(1, 7):
            ax = axes[epoch][detector - 1]
            draw_panel(ax, cube[epoch, detector - 1], norms[detector], marks.get((epoch, detector)), gap)
            ax.set_xlim(cx - half - 0.5, cx + half + 0.5)
            ax.set_ylim(cy - half - 0.5, cy + half + 0.5)
            if epoch == 0:
                ax.set_title(f"D{detector}", fontsize=9)
            if detector == 1:
                ax.set_ylabel(f"epoca {epoch + 1}\n{epoch_info[epoch]['start']}", fontsize=8)
    fig.suptitle(f"{target.name}: acercamiento de {2 * half * scale:.0f} arcsec; la marca es la posicion esperada en cada epoca", fontsize=10)
    fig.tight_layout()
    fig.savefig(out_dir / "acercamiento.png")
    plt.close(fig)

    # Diferencia entre epocas: lo fijo se cancela y lo que se mueve deja un dipolo.
    pairs = [(n_epochs - 1, 0)] + ([(n_epochs - 1, n_epochs - 2)] if n_epochs >= 3 else [])
    if n_epochs >= 2:
        fig, axes = plt.subplots(len(pairs), 6, figsize=(15, 2.6 * len(pairs) + 0.6), dpi=100, squeeze=False)
        for row, (later, earlier) in enumerate(pairs):
            for detector in range(1, 7):
                ax = axes[row][detector - 1]
                ax.set_facecolor("#3a3a3a")
                difference = cube[later, detector - 1] - cube[earlier, detector - 1]
                window = difference[cy - half : cy + half + 1, cx - half : cx + half + 1]
                finite = window[np.isfinite(window)]
                if finite.size >= 10:
                    limit = max(6.0 * _mad_sigma(finite), 1e-6)
                    ax.imshow(difference, origin="lower", cmap="gray", vmin=-limit, vmax=limit, interpolation="nearest")
                for epoch, style in ((earlier, ":"), (later, "-")):
                    mark = marks.get((epoch, detector))
                    if mark is not None:
                        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                            ax.plot([mark[0] + dx * gap, mark[0] + dx * 2.2 * gap], [mark[1] + dy * gap, mark[1] + dy * 2.2 * gap],
                                    color=MARK_COLOR, lw=1.0, ls=style)  # fmt: skip
                ax.set_xlim(cx - half - 0.5, cx + half + 0.5)
                ax.set_ylim(cy - half - 0.5, cy + half + 0.5)
                ax.set_xticks([])
                ax.set_yticks([])
                if row == 0:
                    ax.set_title(f"D{detector}", fontsize=9)
                if detector == 1:
                    ax.set_ylabel(f"epoca {later + 1} menos\nepoca {earlier + 1}", fontsize=8)
        fig.suptitle(
            f"{target.name}: diferencia entre epocas (blanco = mas brillo en la epoca posterior); "
            "marca punteada = posicion esperada anterior, llena = posterior",
            fontsize=10,
        )
        fig.tight_layout()
        fig.savefig(out_dir / "diferencia.png")
        plt.close(fig)

    header = out_wcs.to_header()
    header["BUNIT"] = "MJy/sr"
    header["COMMENT"] = "Ejes: [epoca][detector 1..6][y][x]. IMAGE - ZODI - fondo residual."
    fits.HDUList(
        [
            fits.PrimaryHDU(cube, header=header),
            fits.ImageHDU(cube_var, header=header, name="VARIANCE"),
            fits.ImageHDU(coverage, header=header, name="COVERAGE"),
        ]
    ).writeto(out_dir / "cubo.fits", overwrite=True)

    seconds = sorted(r.seconds for r in fresh)
    summary = {
        "target": asdict(target),
        "center": {"ra": center_ra, "dec": center_dec, "epoch": CENTER_EPOCH},
        "fov_deg": args.fov,
        "grid": {"pixel_scale_arcsec": scale, "oversample": args.oversample, "shape": list(shape)},
        "query": query_info,
        "exposures": {
            "rows_returned": len(raw_exposures),
            "duplicates_dropped": duplicates,
            "total": len(exposures),
            "by_collection": dict(Counter(e.collection for e in exposures)),
            "by_detector": {f"D{d}": sum(e.detector == d for e in exposures) for d in range(1, 7)},
            "first": iso_date(exposures[0].mjd_start),
            "last": iso_date(exposures[-1].mjd_start),
        },
        "epochs": epoch_info,
        "download": {
            "mode": "completo" if args.full else "cortado antes de EPSF",
            "workers": min(args.workers, irsa.MAX_WORKERS),
            "wall_seconds": round(download_seconds, 2),
            "downloaded": len(fresh),
            "from_cache": sum(r.from_cache for r in results),
            "failed_count": len(failed),
            "failure_rate": round(len(failed) / len(results), 4),
            "retried": sum(1 for r in results if r.attempts > 1),
            "bytes_received": sum(r.nbytes for r in fresh),
            "seconds_per_cutout": (
                {"median": round(seconds[len(seconds) // 2], 2), "p90": round(seconds[int(len(seconds) * 0.9)], 2), "max": round(seconds[-1], 2)}
                if seconds else None
            ),
            "failed": [{"url": r.url, "error": r.error, "attempts": r.attempts} for r in failed],
            "unreadable": unreadable,
        },
        "processing": {
            "seconds": round(process_seconds, 2),
            "subtract_residual_background": not args.no_background,
            "bad_flags": list(BAD_FLAGS),
            "masked_fraction": round(flag_totals["_masked"] / max(flag_totals["_pixels"], 1), 4),
            "flag_pixel_counts": {k: v for k, v in sorted(flag_totals.items()) if not k.startswith("_") and v},
            "residual_background_median": {f"D{d}": round(float(np.median(v)), 5) for d, v in backgrounds.items() if v},
            "residual_background_std": {f"D{d}": round(float(np.std(v)), 5) for d, v in backgrounds.items() if v},
        },
        "target_measurements": measurements,
        "target_motion_first_to_last": motion_between(measurements, target, scale),
        "total_seconds": round(time.perf_counter() - t_total, 2),
        "run_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }  # fmt: skip
    (out_dir / "resumen.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    # Historial de tiempos: la primera corrida (sin cache) es la que vale como medicion.
    with (out_dir / "tiempos.jsonl").open("a", encoding="utf-8") as fh:
        timing = {k: summary[k] for k in ("run_at", "total_seconds")} | {
            "query_seconds": query_info["seconds"], "query_from_cache": query_info["from_cache"],
            "download": {k: v for k, v in summary["download"].items() if k not in ("failed", "unreadable")},  # type: ignore[union-attr]
            "processing_seconds": round(process_seconds, 2), "exposures": len(exposures),
        }  # fmt: skip
        fh.write(json.dumps(timing, ensure_ascii=False) + "\n")

    print(f"Proceso: {process_seconds:.1f} s. Salida en {out_dir}")
    for info in epoch_info:
        print(f"  epoca {info['index']}: {info['start']} a {info['end']}, {info['n_exposures']} exposiciones {info['by_detector']}")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--name", help="nombre del objeto (se resuelve con Sesame)")
    parser.add_argument("--ra", type=float, help="ascension recta ICRS en grados")
    parser.add_argument("--dec", type=float, help="declinacion ICRS en grados")
    parser.add_argument("--pm-ra", type=float, default=0.0, help="movimiento propio en RA*cos(dec), mas/anio")
    parser.add_argument("--pm-dec", type=float, default=0.0, help="movimiento propio en Dec, mas/anio")
    parser.add_argument("--plx", type=float, default=0.0, help="paralaje en mas")
    parser.add_argument("--epoch", type=float, default=2000.0, help="epoca de --ra/--dec, anio juliano")
    parser.add_argument("--fov", type=float, default=0.1, help="lado del campo en grados")
    parser.add_argument("--cutout-scale", type=float, default=1.0, help="lado del recorte pedido, en multiplos del campo (1.4142 cubre las esquinas)")
    parser.add_argument("--oversample", type=int, default=2, help="pixeles de salida por pixel nativo (6,15 arcsec)")
    parser.add_argument("--workers", type=int, default=irsa.MAX_WORKERS, help="descargas en paralelo (maximo 10)")
    parser.add_argument("--source", choices=("sia", "tap"), default="sia", help="servicio para listar exposiciones")
    parser.add_argument("--full", action="store_true", help="bajar el recorte completo (incluye WCS-WAVE)")
    parser.add_argument("--refresh-query", action="store_true", help="ignorar la cache de la consulta")
    parser.add_argument("--no-background", action="store_true", help="no restar el fondo residual por recorte")
    parser.add_argument("--limit", type=int, default=0, help="usar solo N exposiciones (pruebas)")
    parser.add_argument("--query-only", action="store_true", help="listar exposiciones y epocas, sin bajar recortes")
    parser.add_argument("--label", help="nombre de la carpeta de salida")
    args = parser.parse_args(argv)
    if not args.name and (args.ra is None or args.dec is None):
        parser.error("hace falta --name o --ra y --dec")
    return args


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    run(parse_args())
