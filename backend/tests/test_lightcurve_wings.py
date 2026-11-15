"""Curva de luz (app/lightcurve): fotometria sobre las alas y normalizacion por canal.

- Alas, con imagenes sinteticas: una estrella con el nucleo enmascarado y alas
  anchas. La medida tiene que ser proporcional al flujo y no depender de lo que
  haya en el hueco, de un tramo enmascarado del anillo ni del fondo.
- Normalizacion, con medidas sinteticas: un espectro con forma y una variacion
  conocida entre pasadas. La curva tiene que devolver la variacion y no la
  forma del espectro.
- Con los 12 recortes reales de Barnard (tests/fixtures/cutouts), de punta a
  punta: la estrella satura, se miden las alas y, con tan pocas exposiciones,
  el documento dice que no alcanza en vez de dar una curva.

Ningun test usa la red.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest

from app.lightcurve.calibration import EMPTY, calibration_from_document, load_calibration
from app.lightcurve.normalize import channel_index, relative_curve, robust_scatter, time_bins
from app.lightcurve.service import compute_lightcurve
from app.lightcurve.wings import (
    WingAnnulus,
    WingConfig,
    choose_annulus,
    edge_room,
    hole_radius,
    measure_wings,
)
from app.spectrum.cutouts import covering_cutouts, list_cutouts
from app.spectrum.service import SpectrumTarget

CUTOUTS = Path(__file__).parent / "fixtures" / "cutouts"
BARNARD = (269.446287, 4.768255)

SHAPE = (59, 59)
CENTRE = (29.3, 28.8)
ANNULUS = WingAnnulus(inner_px=6.0, outer_px=10.0, sky_inner_px=20.0, sky_outer_px=26.0)


def distance(x: float = CENTRE[0], y: float = CENTRE[1], shape: tuple[int, int] = SHAPE) -> np.ndarray:
    yy, xx = np.indices(shape)
    return np.hypot(xx - x, yy - y)


def star(flux: float, x: float = CENTRE[0], y: float = CENTRE[1], sky: float = 0.0) -> np.ndarray:
    """Estrella con alas anchas (perfil de Moffat), de flujo total `flux`, sobre un fondo plano."""
    alpha, beta = 1.2, 2.5
    profile = (beta - 1.0) / (math.pi * alpha**2) * (1.0 + (distance(x, y) / alpha) ** 2) ** (-beta)
    return flux * profile + sky


def saturated(image: np.ndarray, radius: float = 4.2, x: float = CENTRE[0], y: float = CENTRE[1]) -> np.ndarray:
    """Mascara del nucleo saturado: un disco alrededor de la estrella."""
    return distance(x, y) <= radius


def variance_of(image: np.ndarray, sigma: float = 0.01) -> np.ndarray:
    return np.full(image.shape, sigma**2)


# ----------------------------------------------------------------------- hueco


def test_hole_radius_is_where_the_first_clean_ring_starts() -> None:
    bad = distance() <= 3.6
    assert hole_radius(bad, *CENTRE) == 4.0
    assert hole_radius(np.zeros(SHAPE, dtype=bool), *CENTRE) == 0.0


def test_hole_radius_of_a_fully_masked_cutout_is_unknown() -> None:
    assert math.isnan(hole_radius(np.ones(SHAPE, dtype=bool), *CENTRE))


def test_annulus_starts_one_pixel_beyond_the_usual_hole() -> None:
    annulus = choose_annulus([4.0] * 9 + [5.0, math.nan])
    assert (annulus.inner_px, annulus.outer_px) == (6.0, 10.0)
    assert annulus.sky_inner_px == 12.0 and annulus.sky_outer_px == 17.0
    # Sin hueco (fuente sin saturar) el anillo igual deja fuera el nucleo.
    assert choose_annulus([0.0, 0.0]).inner_px == WingConfig().min_inner_px
    assert choose_annulus([]).inner_px == WingConfig().min_inner_px


def test_annulus_rejects_impossible_geometry() -> None:
    with pytest.raises(ValueError):
        WingAnnulus(inner_px=8.0, outer_px=6.0, sky_inner_px=10.0, sky_outer_px=12.0)


# ------------------------------------------------------------------------ alas


def test_wings_are_proportional_to_the_flux_of_the_star() -> None:
    faint, bright = star(1000.0), star(2500.0)
    bad = saturated(faint)
    low = measure_wings(faint, variance_of(faint), bad, *CENTRE, ANNULUS)
    high = measure_wings(bright, variance_of(bright), bad, *CENTRE, ANNULUS)
    assert low.ok and high.ok
    assert high.flux / low.flux == pytest.approx(2.5, rel=1e-6)
    # Es una fraccion del flujo, no el flujo: sirve para comparar, no como valor absoluto.
    assert 0.0 < low.flux < 1000.0


def test_wings_do_not_depend_on_what_is_inside_the_hole() -> None:
    image = star(1000.0)
    bad = saturated(image)
    reference = measure_wings(image, variance_of(image), bad, *CENTRE, ANNULUS)
    garbage = image.copy()
    garbage[bad] = np.nan
    garbage[28, 29] = 1.0e9
    assert measure_wings(garbage, variance_of(image), bad, *CENTRE, ANNULUS).flux == pytest.approx(reference.flux)
    # Un hueco mas chico, mientras no llegue al anillo, tampoco cambia nada.
    smaller = saturated(image, radius=2.0)
    assert measure_wings(image, variance_of(image), smaller, *CENTRE, ANNULUS).flux == pytest.approx(reference.flux)


def test_wings_do_not_depend_on_the_background_level() -> None:
    bad = saturated(star(1.0))
    dark = measure_wings(star(1000.0), variance_of(bad), bad, *CENTRE, ANNULUS)
    bright_sky = measure_wings(star(1000.0, sky=7.5), variance_of(bad), bad, *CENTRE, ANNULUS)
    assert bright_sky.flux == pytest.approx(dark.flux, rel=1e-6)
    assert bright_sky.sky == pytest.approx(dark.sky + 7.5, rel=1e-6)


def test_a_masked_stretch_of_the_annulus_changes_the_measurement_by_a_few_percent() -> None:
    image = star(1000.0)
    bad = saturated(image)
    reference = measure_wings(image, variance_of(image), bad, *CENTRE, ANNULUS)
    yy, xx = np.indices(SHAPE)
    angle = np.arctan2(yy - CENTRE[1], xx - CENTRE[0])
    wedge = bad | ((np.abs(angle) < 0.45) & (distance() > 5.0))  # 14 % del anillo, como una columna defectuosa
    partial = measure_wings(image, variance_of(image), wedge, *CENTRE, ANNULUS)
    assert partial.ok
    assert 0.8 <= partial.valid_fraction < 0.9
    # Sumando los pixeles validos faltaria el 14 %. Con la mediana de cada corona por su area completa
    # el cambio es de un 3 %: las alas caen rapido con el radio y la mediana depende un poco de que
    # pixeles quedan. Es parte del error real que se mide sobre la estrella de control.
    assert partial.flux == pytest.approx(reference.flux, rel=0.05)
    assert abs(partial.flux / reference.flux - 1.0) < 0.14 / 2


def test_a_field_star_inside_the_annulus_is_mostly_rejected() -> None:
    image = star(1000.0)
    bad = saturated(image)
    reference = measure_wings(image, variance_of(image), bad, *CENTRE, ANNULUS)
    # Una estrella de campo con la cuarta parte del flujo de las alas, en medio del anillo.
    neighbour = 0.25 * reference.flux
    crowded = measure_wings(
        image + star(neighbour, x=CENTRE[0] + 8.0, y=CENTRE[1]), variance_of(image), bad, *CENTRE, ANNULUS
    )
    change = crowded.flux / reference.flux - 1.0
    # Sumando pixeles entraria entera (25 %). La mediana de cada corona deja pasar menos de la tercera parte.
    assert 0.0 <= change < 0.25 / 3


def test_wing_error_matches_the_scatter_of_repeated_measurements() -> None:
    rng = np.random.default_rng(5)
    sigma = 0.02
    image = star(1000.0, sky=1.0)
    bad = saturated(image)
    variance = variance_of(image, sigma)
    fluxes, errors = [], []
    for _ in range(200):
        result = measure_wings(image + rng.normal(0.0, sigma, SHAPE), variance, bad, *CENTRE, ANNULUS)
        assert result.flux is not None and result.error is not None
        fluxes.append(result.flux)
        errors.append(result.error)
    assert float(np.median(errors)) == pytest.approx(float(np.std(fluxes)), rel=0.25)


def test_wings_that_cannot_be_measured_say_why() -> None:
    image = star(1000.0)
    variance = variance_of(image)
    bad = saturated(image)
    # El anillo no entra en el recorte.
    assert measure_wings(image, variance, bad, 5.0, 28.0, ANNULUS).status == "edge"
    assert measure_wings(image, variance, bad, math.nan, 28.0, ANNULUS).status == "edge"
    # El hueco llega al anillo: quedan pocos pixeles validos.
    assert measure_wings(image, variance, saturated(image, radius=8.5), *CENTRE, ANNULUS).status == "masked"
    # Una corona entera sin pixeles validos, aunque el anillo en conjunto tenga muchos.
    ring = bad | ((distance() >= 6.0) & (distance() < 7.0))
    wide = WingAnnulus(inner_px=6.0, outer_px=14.0, sky_inner_px=20.0, sky_outer_px=26.0)
    assert measure_wings(image, variance, ring, *CENTRE, wide).status == "masked"
    # Sin anillo de fondo.
    no_sky = bad | (distance() >= 19.0)
    assert measure_wings(image, variance, no_sky, *CENTRE, ANNULUS).status == "no_sky"
    # Sin alas que medir: solo ruido.
    rng = np.random.default_rng(2)
    noise = rng.normal(0.0, 0.01, SHAPE)
    assert measure_wings(noise, variance, bad, *CENTRE, ANNULUS).status == "faint"


def test_edge_room_is_the_distance_to_the_nearest_border() -> None:
    assert edge_room((59, 59), 29.0, 29.0) == 29.5
    assert edge_room((59, 59), 3.0, 29.0) == 3.5
    assert edge_room((34, 58), 30.0, 40.0) < 0  # fuera del recorte


# --------------------------------------------------------------- normalizacion

# Un espectro con mucha forma: el nivel cambia 20 veces entre canales.
LEVELS = {0: 5.0, 1: 40.0, 2: 12.0, 3: 100.0, 4: 60.0, 5: 8.0}
FACTORS = (1.4, 1.0, 0.7)  # brillo de cada pasada


def table(
    factors: tuple[float, ...] = FACTORS,
    noise: float = 0.0,
    seed: int = 1,
    skip: frozenset[tuple[int, int]] = frozenset(),
) -> tuple[list[float], list[float], list[int], list[int]]:
    """Una medida por canal y pasada: nivel del canal x brillo de la pasada x ruido."""
    rng = np.random.default_rng(seed)
    values, errors, channels, bins = [], [], [], []
    for channel, level in LEVELS.items():
        for index, factor in enumerate(factors):
            if (channel, index) in skip:
                continue
            values.append(level * factor * (1.0 + rng.normal(0.0, noise) if noise else 1.0))
            errors.append(level * 0.01)
            channels.append(channel)
            bins.append(index)
    return values, errors, channels, bins


def test_channel_index_uses_the_channel_edges() -> None:
    edges = np.geomspace(1.0, 2.0, 5)
    assert channel_index(1.0, edges) == 0
    assert channel_index(1.95, edges) == 3
    assert channel_index(0.5, edges) == 0 and channel_index(9.0, edges) == 3
    assert channel_index(float(edges[2]) * 1.0001, edges) == 2


def test_time_bins_split_on_gaps_and_on_length() -> None:
    assert time_bins([10.0, 10.5, 11.0, 200.0, 201.0, 11.5], gap_days=4.0, max_days=12.0) == [0, 0, 0, 1, 1, 0]
    # Sin huecos, una tanda no dura mas de `max_days`.
    assert time_bins([0.0, 3.0, 6.0, 9.0, 12.0, 15.0], gap_days=4.0, max_days=10.0) == [0, 0, 0, 0, 1, 1]
    assert time_bins([]) == []


def test_curve_returns_the_variation_and_not_the_shape_of_the_spectrum() -> None:
    values, errors, channels, bins = table()
    curve = relative_curve(values, errors, channels, bins)
    assert curve.used.all()
    # El brillo de las pasadas, relativo a la del medio.
    assert curve.bin_value == pytest.approx(FACTORS, rel=1e-6)
    # Cada medida vale el brillo de su pasada, sea el canal brillante o debil.
    assert curve.relative == pytest.approx([FACTORS[index] for index in bins], rel=1e-6)
    assert curve.channel_level == pytest.approx(LEVELS, rel=1e-6)
    assert curve.residual_scatter == pytest.approx(0.0, abs=1e-9)


def test_a_constant_source_gives_a_flat_curve_with_its_real_scatter() -> None:
    values, errors, channels, bins = table(factors=(1.0, 1.0, 1.0, 1.0, 1.0), noise=0.04, seed=4)
    curve = relative_curve(values, errors, channels, bins)
    assert curve.bin_value == pytest.approx(1.0, abs=0.06)
    # La dispersion sale de las medidas, no del error formal (1 %): por eso el error de la pasada es realista.
    assert 0.015 < curve.residual_scatter < 0.08
    assert float(np.median(curve.bin_error)) > 0.01
    assert robust_scatter(curve.relative[curve.used]) == pytest.approx(0.04, rel=0.6)


def test_iterating_corrects_channels_seen_in_only_some_passes() -> None:
    # El canal 5 no se observo en la primera pasada, la mas brillante: su mediana queda baja y,
    # dividiendo una sola vez, sus medidas saldrian altas. Las iteraciones lo corrigen.
    values, errors, channels, bins = table(skip=frozenset({(5, 0)}))
    curve = relative_curve(values, errors, channels, bins)
    assert curve.iterations > 1
    assert curve.bin_value == pytest.approx(FACTORS, rel=1e-4)
    assert curve.relative == pytest.approx([FACTORS[index] for index in bins], rel=1e-4)
    naive = np.array(values)[np.array(channels) == 5] / np.median(np.array(values)[np.array(channels) == 5])
    assert naive != pytest.approx([FACTORS[1], FACTORS[2]], rel=0.05)


def test_one_bad_measurement_does_not_drag_the_curve() -> None:
    values, errors, channels, bins = table(noise=0.01, seed=8)
    clean = relative_curve(values, errors, channels, bins)
    values[4] *= 6.0  # un rayo cosmico sin marcar
    dirty = relative_curve(values, errors, channels, bins)
    assert dirty.bin_value == pytest.approx(clean.bin_value, rel=0.03)


def test_measures_that_say_nothing_are_left_out() -> None:
    values, errors, channels, bins = table()
    # Un canal con una sola medida: su nivel seria esa medida.
    values.append(33.0), errors.append(0.3), channels.append(9), bins.append(1)
    # Una medida negativa y otra sin error.
    values.append(-2.0), errors.append(0.1), channels.append(0), bins.append(2)
    values.append(5.0), errors.append(0.0), channels.append(0), bins.append(2)
    curve = relative_curve(values, errors, channels, bins)
    assert list(curve.used[-3:]) == [False, False, False]
    assert np.isnan(curve.relative[-3:]).all()
    assert 9 not in curve.channel_level
    assert curve.bin_value == pytest.approx(FACTORS, rel=1e-6)


def test_bin_error_shrinks_with_the_number_of_measures() -> None:
    few = relative_curve(*table(noise=0.05, seed=3))
    levels = {index: 10.0 + index for index in range(40)}
    rng = np.random.default_rng(3)
    values, errors, channels, bins = [], [], [], []
    for channel, level in levels.items():
        for index, factor in enumerate(FACTORS):
            values.append(level * factor * (1.0 + rng.normal(0.0, 0.05)))
            errors.append(level * 0.01)
            channels.append(channel)
            bins.append(index)
    many = relative_curve(values, errors, channels, bins)
    assert float(np.median(many.bin_error)) < float(np.median(few.bin_error))
    assert many.bin_count.tolist() == [40, 40, 40]


def test_lengths_must_match() -> None:
    with pytest.raises(ValueError):
        relative_curve([1.0, 2.0], [0.1], [0, 0], [0, 1])


# ---------------------------------------------------------------- calibracion


def test_stored_calibration_validates_wings_only_where_the_control_star_is_flat() -> None:
    calibration = load_calibration()
    assert calibration is not EMPTY
    wings = calibration.for_method("wings")
    aperture = calibration.for_method("aperture")
    assert wings is not None and aperture is not None
    # Barnard sale plana en los detectores 1, 4, 5 y 6; en 2 y 3 las alas no se sostienen.
    assert [detector for detector in range(1, 7) if wings.validated(detector)] == [1, 4, 5, 6]
    assert all(aperture.validated(detector) for detector in range(1, 7))
    assert 0.0 < wings.epoch_floor < 0.05 and 0.0 < aperture.epoch_floor < 0.05


def test_calibration_document_round_trip() -> None:
    document = {
        "methods": {
            "wings": {
                "control": "Estrella",
                "epoch_floor": 0.02,
                "point_floor": 0.05,
                "detectors": {"4": {"n_points": 50, "epoch_deviation": 0.01, "point_scatter": 0.03, "valid": True}},
            }
        }
    }
    calibration = calibration_from_document(document)
    wings = calibration.for_method("wings")
    assert wings is not None and wings.validated(4) and not wings.validated(2)
    assert calibration.for_method("aperture") is None


# ------------------------------------------------------------ recortes reales


def test_barnard_fixtures_measure_wings_and_admit_there_is_no_curve() -> None:
    cutouts = covering_cutouts(list_cutouts([CUTOUTS]), *BARNARD)
    document = compute_lightcurve(cutouts, SpectrumTarget(ra=BARNARD[0], dec=BARNARD[1]))
    assert document["provenance"]["n_exposures"] == 12
    assert {"code": "saturated_source", "detectors": [3, 6]} in document["warnings"]
    wings = {series["detector"]: series for series in document["series"] if series["method"] == "wings"}
    assert set(wings) == {3, 6}
    for series in wings.values():
        # Las alas se midieron de verdad, fuera del nucleo saturado...
        assert series["relative_only"] is True
        assert series["annulus"]["inner_px"] >= 3.0
        assert series["n_measured"] >= 4
        # ...pero seis exposiciones por detector no alcanzan para una curva: lo dice en vez de inventarla.
        assert series["status"] == "insufficient"
        assert series["points"] == [] and series["epochs"] == []
    assert document["status"] == "empty"
    assert document["variability"]["verdict"] == "undetermined"
