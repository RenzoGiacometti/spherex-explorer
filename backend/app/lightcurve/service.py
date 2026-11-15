"""De las medidas por exposicion al documento de la curva de luz.

Por cada detector hay hasta dos series, segun con que se midio:

- `aperture`: la apertura del espectro. Vale donde la fuente no satura.
- `wings`: el anillo sobre las alas (`wings.py`). Se mide donde la fuente
  satura; solo da variacion relativa.

Cada serie se normaliza por canal espectral (`normalize.py`) con una tanda por
pasada del relevamiento, y trae el brillo relativo de cada pasada con su error
(`epochs`), las medidas sueltas (`points`) y esas mismas medidas agrupadas en
tandas de pocos dias (`bins`), para ver el cambio dentro de una pasada larga.
La serie `preferred` de cada detector es la que hay que mostrar: alas si la
fuente satura ahi, apertura si no.

Una serie no trae curva cuando no significaria nada, y `status` dice por que:

- `unstable`: las alas no se sostienen. Medidas de dias vecinos y del mismo
  canal difieren mas de lo que explica el ruido (`MAX_EXCESS_SCATTER`). Les pasa
  a las estrellas muy saturadas en los detectores 1 a 3.
- `blended`: la luz dentro de la apertura no esta centrada en el objeto (otra
  fuente adentro), asi que el cambio de brillo seria el de la mezcla.
- `insufficient`: pocas medidas o una sola pasada.

El veredicto de cada serie (`variability.verdict`) compara la mayor diferencia
entre pasadas con su error, que incluye el piso medido sobre las estrellas de
control (`calibration.py`):

    variable   la diferencia supera 5 veces su error
    constant   no llega a 3 veces: sin variacion detectable, que no es lo mismo que constante
    marginal   en el medio

El veredicto del objeto junta los de sus series preferidas. Si en algun detector
hay otra fuente dentro de la apertura (`offset_source`), no afirma variacion en
los demas: queda `undetermined`.

Documento (snake_case, fechas en MJD y texto ISO, valores relativos sin unidad):

    status      "ok" si alguna serie tiene curva; si no, "empty"
    variability veredicto del objeto y en que detectores
    target, field, epochs
    series      una por detector y metodo
    warnings    `saturated_source`, `wings_unstable`, `wings_unvalidated`,
                `offset_source`
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np

from app.lightcurve.calibration import Calibration, Method, load_calibration
from app.lightcurve.exposures import ExposureMeasure, load_frames, measure_frames, saturating_detectors
from app.lightcurve.normalize import (
    MEDIAN_ERROR_FACTOR,
    channel_index,
    relative_curve,
    robust_scatter,
    time_bins,
)
from app.lightcurve.wings import WingAnnulus, WingConfig
from app.spectrum.cutouts import CachedCutout
from app.spectrum.photometry import ApertureConfig
from app.spectrum.service import (
    CHANNELS_PER_DETECTOR,
    EPOCH_GAP_DAYS,
    OFFSET_MIN_EXPOSURES,
    OFFSET_WARNING_ARCSEC,
    SpectrumTarget,
    assign_epochs,
)
from app.spectrum.wavelength import WaveTableError, WaveTables, load_wave_tables

DOCUMENT_VERSION = 1

# Una serie necesita al menos estas medidas, y dos pasadas con esta cantidad cada una.
MIN_SERIES_POINTS = 8
MIN_EPOCH_POINTS = 3
# Tandas cortas para medir la estabilidad: medidas de pocos dias, donde una variable lenta casi no cambia.
STABILITY_GAP_DAYS = 4.0
STABILITY_MAX_DAYS = 12.0
# Una tanda corta se muestra en la curva si junta al menos estas medidas.
MIN_BIN_POINTS = 6
# Dispersion de las alas, descontado el ruido formal, a partir de la cual no se confia en ellas.
MAX_EXCESS_SCATTER = 0.12
# Veredicto: diferencia entre pasadas sobre su error.
VARIABLE_SIGNIFICANCE = 5.0
CONSTANT_SIGNIFICANCE = 3.0

_MJD_UNIX_EPOCH = 40587.0


class LightcurveError(Exception):
    """No se pudo armar la curva (sin recortes, tablas ilegibles)."""


def _iso_date(mjd: float) -> str:
    moment = datetime(1970, 1, 1, tzinfo=UTC) + timedelta(days=mjd - _MJD_UNIX_EPOCH)
    return moment.strftime("%Y-%m-%d")


def _round(value: float, decimals: int) -> float:
    return round(float(value), decimals) + 0.0


def _optional(value: float | None, decimals: int) -> float | None:
    return None if value is None or not math.isfinite(value) else _round(value, decimals)


def _value_of(measure: ExposureMeasure, method: Method) -> tuple[float | None, float | None]:
    if method == "aperture":
        return (measure.aperture_mjy, measure.aperture_error_mjy) if measure.aperture.ok else (None, None)
    if measure.wings is None or not measure.wings.ok:
        return None, None
    return measure.wings_mjy, measure.wings_error_mjy


def _status_counts(measures: Sequence[ExposureMeasure], method: Method) -> dict[str, int]:
    counts: dict[str, int] = {}
    for measure in measures:
        status = measure.aperture.status if method == "aperture" else (measure.wings.status if measure.wings else "")
        if status:
            counts[status] = counts.get(status, 0) + 1
    return counts


def build_series(
    measures: Sequence[ExposureMeasure],
    epochs: Sequence[int],
    detector: int,
    method: Method,
    tables: WaveTables,
    calibration: Calibration,
    *,
    annulus: WingAnnulus | None = None,
    blended_offset: float | None = None,
    enforce_stability: bool = True,
) -> dict[str, Any] | None:
    """La serie de un detector con un metodo, o `None` si ese metodo no se midio ahi.

    `measures` y `epochs` son las exposiciones de ese detector y la pasada
    (desde 1) de cada una. Con `enforce_stability=False` una serie de alas
    inestable igual trae su curva: lo usa la calibracion, que necesita ver
    cuanto se aparta la estrella de control tambien donde el metodo falla.
    """
    counts = _status_counts(measures, method)
    if not counts:
        return None
    low, high = tables.for_detector(detector).wave_range
    edges = np.geomspace(low, high, CHANNELS_PER_DETECTOR + 1)

    chosen = []
    for measure, epoch in zip(measures, epochs, strict=True):
        value, error = _value_of(measure, method)
        if value is None or error is None or not math.isfinite(measure.wavelength_um):
            continue
        chosen.append((measure, epoch, value, error, channel_index(measure.wavelength_um, edges)))

    control = calibration.for_method(method)
    epoch_floor = 0.0 if control is None else control.epoch_floor
    point_floor = 0.0 if control is None else control.point_floor
    series: dict[str, Any] = {
        "detector": detector,
        "method": method,
        "preferred": False,
        "status": "insufficient",
        "relative_only": method == "wings",
        "wave_min_um": _round(low, 3),
        "wave_max_um": _round(high, 3),
        # Solo la apertura da un flujo de verdad; el de las alas es una fraccion desconocida.
        "reference_mjy": None,
        "annulus": None
        if annulus is None
        else {
            "inner_px": annulus.inner_px,
            "outer_px": annulus.outer_px,
            "sky_inner_px": annulus.sky_inner_px,
            "sky_outer_px": annulus.sky_outer_px,
        },
        "n_exposures": len(measures),
        "n_measured": len(chosen),
        "n_points": 0,
        "n_channels": 0,
        "rejected": {status: count for status, count in sorted(counts.items()) if status != "ok"},
        "scatter": None,
        "control": None
        if control is None
        else {
            "name": control.control,
            "validated": control.validated(detector),
            "epoch_floor": _round(epoch_floor, 4),
            "point_floor": _round(point_floor, 4),
        },
        "variability": None,
        "epochs": [],
        "bins": [],
        "points": [],
    }
    if method == "aperture" and chosen:
        series["reference_mjy"] = _round(float(np.median([item[2] for item in chosen])), 4)
    if method == "aperture" and blended_offset is not None:
        series["status"] = "blended"
        series["offset_arcsec"] = _round(blended_offset, 2)
        return series
    if len(chosen) < MIN_SERIES_POINTS:
        return series

    values = [item[2] for item in chosen]
    errors = [item[3] for item in chosen]
    channels = [item[4] for item in chosen]
    mjds = [item[0].mjd for item in chosen]
    epoch_bins = [item[1] - 1 for item in chosen]

    # Estabilidad: dispersion de las medidas alrededor de un modelo con tandas de pocos dias.
    fine = relative_curve(values, errors, channels, time_bins(mjds, STABILITY_GAP_DAYS, STABILITY_MAX_DAYS))
    curve = relative_curve(values, errors, channels, epoch_bins)
    used = curve.used
    if int(np.count_nonzero(used)) < MIN_SERIES_POINTS:
        return series
    formal = float(np.median(curve.relative_error[used] / curve.relative[used]))
    residual = fine.residual_scatter if math.isfinite(fine.residual_scatter) else curve.residual_scatter
    excess = math.sqrt(max(residual * residual - formal * formal, 0.0)) if math.isfinite(residual) else math.nan
    series["n_points"] = int(np.count_nonzero(used))
    series["n_channels"] = len(curve.channel_level)
    series["scatter"] = {
        # Todo en fraccion del brillo. `points` incluye la variacion real; `residual`, casi solo el ruido.
        "points": _optional(robust_scatter(curve.relative[used]), 4),
        "residual": _optional(residual, 4),
        "formal": _optional(formal, 4),
        "excess": _optional(excess, 4),
    }
    unstable = method == "wings" and math.isfinite(excess) and excess > MAX_EXCESS_SCATTER
    if unstable and enforce_stability:
        series["status"] = "unstable"
        return series

    epoch_rows = []
    for index in range(curve.bin_value.size):
        count = int(curve.bin_count[index])
        if count < MIN_EPOCH_POINTS:
            continue
        value = float(curve.bin_value[index])
        internal = float(curve.bin_error[index])
        own_mjds = [mjd for mjd, used_, bin_ in zip(mjds, used, epoch_bins, strict=True) if used_ and bin_ == index]
        mjd_mean = math.fsum(own_mjds) / len(own_mjds)
        epoch_rows.append(
            {
                "epoch": index + 1,
                "mjd": _round(mjd_mean, 3),
                "date": _iso_date(mjd_mean),
                "value": _round(value, 4),
                # Error de la mediana con la dispersion real, mas el piso de la estrella de control.
                "error": _round(math.hypot(internal, epoch_floor * value), 4),
                "n": count,
            }
        )
    if len(epoch_rows) < 2:
        return series

    series["status"] = "unstable" if unstable else "ok"
    series["epochs"] = epoch_rows
    series["points"] = [
        {
            "mjd": _round(measure.mjd, 5),
            "date": _iso_date(measure.mjd),
            "epoch": epoch,
            "value": _round(float(curve.relative[index]), 4),
            "error": _round(
                math.hypot(float(curve.relative_error[index]), point_floor * float(curve.relative[index])), 4
            ),
            "wavelength_um": _round(measure.wavelength_um, 4),
            "channel": channel,
        }
        for index, (measure, epoch, _value, _error, channel) in enumerate(chosen)
        if used[index]
    ]
    series["points"].sort(key=lambda point: point["mjd"])
    series["bins"] = _short_bins(series["points"], residual, epoch_floor)

    brightest = max(epoch_rows, key=lambda row: row["value"])
    faintest = min(epoch_rows, key=lambda row: row["value"])
    amplitude = brightest["value"] - faintest["value"]
    combined = math.hypot(brightest["error"], faintest["error"])
    significance = amplitude / combined if combined > 0 else 0.0
    if significance >= VARIABLE_SIGNIFICANCE:
        verdict = "variable"
    elif significance < CONSTANT_SIGNIFICANCE:
        verdict = "constant"
    else:
        verdict = "marginal"
    series["variability"] = {
        "verdict": verdict,
        # Diferencia entre la pasada mas brillante y la mas debil, en fraccion del brillo tipico.
        "amplitude": _round(amplitude, 4),
        "amplitude_error": _round(combined, 4),
        "significance": _round(significance, 1),
        "brightest_epoch": brightest["epoch"],
        "faintest_epoch": faintest["epoch"],
    }
    return series


def _short_bins(points: Sequence[dict[str, Any]], scatter: float, floor: float) -> list[dict[str, Any]]:
    """Mediana de las medidas relativas en tandas de pocos dias, para ver el cambio dentro de una pasada.

    Una pasada puede durar casi tres meses (R Draconis), y en ese tiempo una
    variable de periodo largo cambia. Son las mismas medidas de `points`
    agrupadas en el tiempo: no es otro ajuste. Cada tanda junta los canales que
    se observaron esos dias, no todos, asi que es mas ruidosa que una pasada;
    las que tienen menos de `MIN_BIN_POINTS` medidas no se informan.
    """
    if not points:
        return []
    groups = time_bins([point["mjd"] for point in points], STABILITY_GAP_DAYS, STABILITY_MAX_DAYS)
    rows: list[dict[str, Any]] = []
    for index in range(max(groups) + 1):
        members = [point for point, group in zip(points, groups, strict=True) if group == index]
        if len(members) < MIN_BIN_POINTS:
            continue
        value = float(np.median([point["value"] for point in members]))
        mjd = math.fsum(point["mjd"] for point in members) / len(members)
        spread = scatter if math.isfinite(scatter) and scatter > 0 else 0.0
        error = value * math.hypot(MEDIAN_ERROR_FACTOR * spread / math.sqrt(len(members)), floor)
        rows.append(
            {
                "mjd": _round(mjd, 3),
                "date": _iso_date(mjd),
                "epoch": members[0]["epoch"],
                "value": _round(value, 4),
                "error": _round(error, 4),
                "n": len(members),
            }
        )
    return rows


def _blended_offsets(measures: Sequence[ExposureMeasure]) -> dict[int, float]:
    """Detectores donde la luz de la apertura esta corrida del objeto, con la mediana del corrimiento."""
    shifted: dict[int, float] = {}
    for detector in sorted({measure.detector for measure in measures}):
        offsets = [m.offset_arcsec for m in measures if m.detector == detector and m.offset_arcsec is not None]
        if len(offsets) < OFFSET_MIN_EXPOSURES:
            continue
        total = math.hypot(float(np.median([o[0] for o in offsets])), float(np.median([o[1] for o in offsets])))
        if total > OFFSET_WARNING_ARCSEC:
            shifted[detector] = total
    return shifted


def _target_document(target: SpectrumTarget, epochs: Sequence[dict[str, Any]]) -> dict[str, Any]:
    motion = target.motion
    moving = motion is not None and motion.has_proper_motion
    return {
        "name": target.name,
        "ra": _round(target.ra, 6),
        "dec": _round(target.dec, 6),
        "epoch": target.epoch,
        "motion": None
        if motion is None or not moving
        else {"pm_ra": motion.pm_ra, "pm_dec": motion.pm_dec, "parallax": motion.parallax},
        # Posicion en la fecha media de cada pasada: sirve para reconocer un clic sobre el objeto.
        "track": [
            {
                "epoch": item["epoch"],
                "mjd": item["mjd_mean"],
                "ra": _round(target.position_at(item["mjd_mean"])[0], 6),
                "dec": _round(target.position_at(item["mjd_mean"])[1], 6),
            }
            for item in epochs
        ],
    }


def build_document(
    measures: Sequence[ExposureMeasure],
    annuli: dict[int, WingAnnulus],
    target: SpectrumTarget,
    tables: WaveTables,
    calibration: Calibration,
    *,
    field_id: str | None = None,
    n_unreadable: int = 0,
) -> dict[str, Any]:
    """Arma el documento de la curva de luz a partir de las medidas de cada exposicion."""
    usable = [measure for measure in measures if math.isfinite(measure.mjd)]
    numbers, epochs = assign_epochs([measure.mjd for measure in usable], EPOCH_GAP_DAYS)
    saturating = saturating_detectors([(measure.detector, measure.aperture) for measure in usable])
    blended = _blended_offsets(usable)

    series_list: list[dict[str, Any]] = []
    for detector in sorted({measure.detector for measure in usable}):
        own = [(m, e) for m, e in zip(usable, numbers, strict=True) if m.detector == detector]
        own_measures = [item[0] for item in own]
        own_epochs = [item[1] for item in own]
        built: dict[str, dict[str, Any]] = {}
        for method in ("aperture", "wings"):
            series = build_series(
                own_measures,
                own_epochs,
                detector,
                method,  # type: ignore[arg-type]
                tables,
                calibration,
                annulus=annuli.get(detector) if method == "wings" else None,
                blended_offset=blended.get(detector) if method == "aperture" else None,
            )
            if series is not None:
                built[method] = series
        # Donde la fuente satura, la apertura solo conserva las exposiciones en que salio mas debil.
        order = ("wings", "aperture") if detector in saturating else ("aperture", "wings")
        choice = next((name for name in order if name in built and built[name]["status"] == "ok"), None)
        if choice is None:
            choice = next((name for name in order if name in built), None)
        if choice is not None:
            built[choice]["preferred"] = True
        series_list.extend(built[name] for name in ("aperture", "wings") if name in built)

    preferred = [series for series in series_list if series["preferred"]]
    shown = [series for series in preferred if series["status"] == "ok"]
    variable = sorted(s["detector"] for s in shown if s["variability"]["verdict"] == "variable")
    marginal = sorted(s["detector"] for s in shown if s["variability"]["verdict"] == "marginal")
    if not shown:
        verdict = "undetermined"
    elif not variable and not marginal:
        verdict = "constant"
    elif blended:
        # Hay otra fuente dentro de la apertura en algun detector. Si el objeto se mueve respecto de
        # ella, la mezcla cambia de una pasada a otra tambien en los detectores vecinos, y eso se ve
        # como un cambio de brillo: no se puede afirmar que el objeto varia.
        verdict = "undetermined"
    elif variable:
        verdict = "variable"
    else:
        verdict = "marginal"

    warnings: list[dict[str, Any]] = []
    if saturating:
        warnings.append({"code": "saturated_source", "detectors": sorted(saturating)})
    unstable = [s for s in series_list if s["method"] == "wings" and s["status"] == "unstable"]
    if unstable:
        warnings.append(
            {
                "code": "wings_unstable",
                "detectors": sorted(s["detector"] for s in unstable),
                "scatter": max(s["scatter"]["excess"] for s in unstable),
            }
        )
    unvalidated = [
        s for s in shown if s["method"] == "wings" and s["control"] is not None and not s["control"]["validated"]
    ]
    if unvalidated:
        warnings.append({"code": "wings_unvalidated", "detectors": sorted(s["detector"] for s in unvalidated)})
    if blended:
        warnings.append(
            {"code": "offset_source", "detectors": sorted(blended), "offset_arcsec": _round(max(blended.values()), 2)}
        )

    versions = sorted({measure.processing for measure in usable if measure.processing})
    return {
        "version": DOCUMENT_VERSION,
        "status": "ok" if shown else "empty",
        "variability": {
            "verdict": verdict,
            "detectors": variable,
            "marginal_detectors": marginal,
            "amplitude": max((s["variability"]["amplitude"] for s in shown), default=None),
        },
        "target": _target_document(target, epochs),
        "field": field_id,
        "epochs": epochs,
        "series": series_list,
        "warnings": warnings,
        "provenance": {
            "source": "SPHEREx / IRSA",
            "n_exposures": len(usable),
            "n_unreadable": n_unreadable,
            "processing": versions,
            "channels_per_detector": CHANNELS_PER_DETECTOR,
            "error_factor_median": _round(MEDIAN_ERROR_FACTOR, 4),
        },
    }


def compute_lightcurve(
    cutouts: Sequence[CachedCutout],
    target: SpectrumTarget,
    *,
    aperture_config: ApertureConfig | None = None,
    wing_config: WingConfig | None = None,
    tables: WaveTables | None = None,
    calibration: Calibration | None = None,
    field_id: str | None = None,
) -> dict[str, Any]:
    """Curva de luz del objeto a partir de los recortes dados (uno por exposicion). No usa la red."""
    if not cutouts:
        raise LightcurveError("no hay recortes en la cache que cubran el punto")
    try:
        tables = load_wave_tables() if tables is None else tables
    except WaveTableError as exc:
        raise LightcurveError(str(exc)) from exc
    calibration = load_calibration() if calibration is None else calibration
    frames, unreadable = load_frames(cutouts, target, tables)
    if not frames:
        raise LightcurveError(f"ninguno de los {len(cutouts)} recortes se pudo leer")
    measures, annuli = measure_frames(frames, aperture_config=aperture_config, wing_config=wing_config)
    return build_document(measures, annuli, target, tables, calibration, field_id=field_id, n_unreadable=unreadable)
