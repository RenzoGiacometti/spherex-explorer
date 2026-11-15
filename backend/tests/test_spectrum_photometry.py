"""Fotometria de apertura del espectro (app/spectrum).

- Con imagenes sinteticas: pesos de la apertura, flujo recuperado, fondo en
  anillo, error, y los casos que no dan un numero (saturacion, mascara, borde).
- Con los 12 recortes reales de Barnard (tests/fixtures/cutouts): la estrella
  sale saturada en todos, y una estrella de campo da un punto con la longitud de
  onda dentro del rango de su detector.

Ningun test usa la red.
"""

from __future__ import annotations

import itertools
import math
from pathlib import Path

import numpy as np
import pytest

from app.spectrum.cutouts import covering_cutouts, list_cutouts, parse_cutout_name
from app.spectrum.photometry import (
    ApertureConfig,
    aperture_weights,
    gaussian_enclosed_fraction,
    measure_aperture,
    sky_level,
)
from app.spectrum.service import SpectrumTarget, assign_epochs, bin_points, compute_spectrum
from app.spectrum.wavelength import WaveTable, detector_pixel, load_wave_tables

CUTOUTS = Path(__file__).parent / "fixtures" / "cutouts"
BARNARD = (269.446287, 4.768255)  # centro de los recortes guardados

OVERFLOW = 1 << 1
HOT = 1 << 6
SOURCE = 1 << 21
SHAPE = (41, 41)


def gaussian_scene(
    x: float,
    y: float,
    total: float,
    fwhm: float = 1.3,
    sky: float = 0.0,
    shape: tuple[int, int] = SHAPE,
    subsample: int = 9,
) -> np.ndarray:
    """Fuente gaussiana de flujo `total`, integrada sobre cada pixel, mas un fondo plano."""
    sigma = fwhm / (2.0 * math.sqrt(2.0 * math.log(2.0)))
    offsets = (np.arange(subsample) + 0.5) / subsample - 0.5
    ys = (np.arange(shape[0])[:, None] + offsets[None, :]).reshape(-1)
    xs = (np.arange(shape[1])[:, None] + offsets[None, :]).reshape(-1)
    profile = np.exp(-((ys[:, None] - y) ** 2 + (xs[None, :] - x) ** 2) / (2.0 * sigma**2))
    profile = profile.reshape(shape[0], subsample, shape[1], subsample).mean(axis=(1, 3))
    return total * profile / (2.0 * math.pi * sigma**2) + sky


def clean(shape: tuple[int, int] = SHAPE) -> tuple[np.ndarray, np.ndarray]:
    return np.full(shape, 0.01), np.zeros(shape, dtype=np.uint32)


# ------------------------------------------------------------------- apertura


@pytest.mark.parametrize(("x", "y", "radius"), [(20.0, 20.0, 1.5), (20.3, 19.6, 2.0), (17.5, 22.5, 3.0)])
def test_aperture_weights_add_up_to_the_circle_area(x: float, y: float, radius: float) -> None:
    weights = aperture_weights(SHAPE, x, y, radius, subsample=20)
    assert weights.min() >= 0.0 and weights.max() <= 1.0
    assert weights.sum() == pytest.approx(math.pi * radius**2, rel=0.01)
    # Fuera del circulo no hay peso.
    yy, xx = np.indices(SHAPE)
    assert not weights[np.hypot(xx - x, yy - y) > radius + 0.75].any()


def test_aperture_weights_outside_the_array_are_empty() -> None:
    assert aperture_weights(SHAPE, -10.0, 5.0, 1.5).sum() == 0.0


def test_recovers_the_flux_of_a_source_on_a_flat_background() -> None:
    variance, flags = clean()
    config = ApertureConfig(radius_px=2.0)
    for x, y in [(20.0, 20.0), (20.4, 19.7), (19.5, 20.5)]:
        image = gaussian_scene(x, y, total=100.0, sky=3.0)
        result = measure_aperture(image, variance, flags, x, y, config=config)
        assert result.status == "ok"
        expected = 100.0 * gaussian_enclosed_fraction(2.0, 1.3)
        # Con la PSF submuestreada (1,3 px de ancho) repartir cada pixel del borde por su
        # fraccion de area es una aproximacion: acierta al 2 %.
        assert result.flux == pytest.approx(expected, rel=0.02)
        assert result.sky == pytest.approx(3.0, abs=1e-3)


def test_background_level_does_not_change_the_flux() -> None:
    variance, flags = clean()
    low = measure_aperture(gaussian_scene(20.2, 20.1, 50.0, sky=0.0), variance, flags, 20.2, 20.1)
    high = measure_aperture(gaussian_scene(20.2, 20.1, 50.0, sky=250.0), variance, flags, 20.2, 20.1)
    assert low.flux == pytest.approx(high.flux, rel=1e-6)


def test_a_star_in_the_annulus_does_not_raise_the_background() -> None:
    variance, flags = clean()
    rng = np.random.default_rng(7)
    image = gaussian_scene(20.0, 20.0, 80.0, sky=5.0) + rng.normal(0.0, 0.05, SHAPE)
    alone = measure_aperture(image, variance, flags, 20.0, 20.0)
    crowded = measure_aperture(image + gaussian_scene(26.0, 20.0, 400.0), variance, flags, 20.0, 20.0)
    assert crowded.sky == pytest.approx(alone.sky, abs=0.05)
    assert crowded.flux == pytest.approx(alone.flux, rel=0.02)


def test_source_pixels_are_left_out_of_the_annulus_when_enough_remain() -> None:
    variance, flags = clean()
    image = gaussian_scene(20.0, 20.0, 80.0, sky=5.0)
    yy, xx = np.indices(SHAPE)
    neighbour = np.hypot(xx - 26.0, yy - 20.0) <= 3.0
    image[neighbour] += 2.0  # meseta que el recorte por sigma no alcanza a sacar del todo
    flags[neighbour] |= SOURCE
    result = measure_aperture(image, variance, flags, 20.0, 20.0, source_bits=SOURCE)
    assert result.sky == pytest.approx(5.0, abs=1e-3)


def test_error_matches_the_scatter_of_repeated_measurements() -> None:
    rng = np.random.default_rng(11)
    sigma = 0.2
    variance = np.full(SHAPE, sigma**2)
    flags = np.zeros(SHAPE, dtype=np.uint32)
    scene = gaussian_scene(20.3, 20.2, 30.0, sky=1.0)
    fluxes, errors = [], []
    for _ in range(300):
        result = measure_aperture(scene + rng.normal(0.0, sigma, SHAPE), variance, flags, 20.3, 20.2)
        assert result.flux is not None and result.error is not None
        fluxes.append(result.flux)
        errors.append(result.error)
    assert float(np.median(errors)) == pytest.approx(float(np.std(fluxes)), rel=0.15)


def test_sky_level_clips_outliers() -> None:
    rng = np.random.default_rng(3)
    values = np.concatenate([rng.normal(10.0, 0.5, 500), np.full(30, 90.0)])
    median, sigma, used = sky_level(values)
    assert median == pytest.approx(10.0, abs=0.1)
    assert sigma == pytest.approx(0.5, rel=0.2)
    assert used <= 500


# --------------------------------------------------- mediciones que no dan numero


def test_saturated_core_gives_a_notice_and_no_flux() -> None:
    variance, flags = clean()
    image = gaussian_scene(20.0, 20.0, 1.0e6)
    flags[20, 20] |= OVERFLOW
    result = measure_aperture(image, variance, flags, 20.0, 20.0, masked_bits=OVERFLOW, saturation_bits=OVERFLOW)
    assert result.status == "saturated"
    assert result.flux is None and result.error is None
    assert result.saturated_pixels == 1
    assert result.flag_bits & OVERFLOW


def test_saturation_next_to_the_aperture_also_invalidates() -> None:
    variance, flags = clean()
    image = gaussian_scene(20.0, 20.0, 100.0)
    config = ApertureConfig(radius_px=1.5, saturation_margin_px=1.0)
    near = flags.copy()
    near[20, 22] |= OVERFLOW  # a 2 px del centro: fuera de la apertura, dentro del margen
    assert measure_aperture(image, variance, near, 20.0, 20.0, saturation_bits=OVERFLOW, config=config).status == (
        "saturated"
    )
    far = flags.copy()
    far[20, 24] |= OVERFLOW
    assert measure_aperture(image, variance, far, 20.0, 20.0, saturation_bits=OVERFLOW, config=config).ok


def test_masked_pixel_in_the_core_rejects_the_exposure() -> None:
    variance, flags = clean()
    image = gaussian_scene(20.0, 20.0, 100.0)
    flags[20, 21] |= HOT
    result = measure_aperture(image, variance, flags, 20.0, 20.0, masked_bits=HOT)
    assert result.status == "masked"
    assert result.flux is None
    assert result.masked_fraction > 0.0


def test_non_finite_pixel_in_the_aperture_rejects_the_exposure() -> None:
    variance, flags = clean()
    image = gaussian_scene(20.0, 20.0, 100.0)
    image[20, 20] = np.nan
    assert measure_aperture(image, variance, flags, 20.0, 20.0).status == "masked"


def test_a_sliver_of_masked_edge_is_tolerated() -> None:
    variance, flags = clean()
    # Con el objeto en x = 20,1 la apertura de 1,5 px entra 0,1 px en la columna 22: una astilla.
    x, y = 20.1, 20.0
    image = gaussian_scene(x, y, 100.0)
    reference = measure_aperture(image, variance, flags, x, y, masked_bits=HOT)
    flags[20, 22] |= HOT
    tolerant = measure_aperture(image, variance, flags, x, y, masked_bits=HOT)
    assert tolerant.ok
    assert 0.0 < tolerant.masked_fraction <= 0.02
    assert tolerant.flux == pytest.approx(reference.flux, rel=0.02)
    strict = ApertureConfig(max_masked_fraction=0.0)
    assert measure_aperture(image, variance, flags, x, y, masked_bits=HOT, config=strict).status == "masked"


@pytest.mark.parametrize(("x", "y"), [(0.5, 20.0), (20.0, 39.8), (-3.0, 5.0), (math.nan, 20.0)])
def test_aperture_off_the_cutout_is_an_edge(x: float, y: float) -> None:
    variance, flags = clean()
    result = measure_aperture(gaussian_scene(20.0, 20.0, 10.0), variance, flags, x, y)
    assert result.status == "edge"
    assert result.flux is None


def test_annulus_without_valid_pixels_has_no_sky() -> None:
    variance, flags = clean()
    image = gaussian_scene(20.0, 20.0, 100.0)
    yy, xx = np.indices(SHAPE)
    flags[np.hypot(xx - 20.0, yy - 20.0) >= 3.0] |= HOT
    result = measure_aperture(image, variance, flags, 20.0, 20.0, masked_bits=HOT)
    assert result.status == "no_sky"


def test_centroid_reveals_light_that_is_not_centred_on_the_target() -> None:
    variance, flags = clean()
    image = gaussian_scene(21.0, 20.0, 100.0)  # la fuente esta un pixel al costado de donde se mide
    result = measure_aperture(image, variance, flags, 20.0, 20.0, config=ApertureConfig(radius_px=2.0))
    assert result.centroid is not None
    assert result.centroid[0] - 20.0 > 0.4
    assert abs(result.centroid[1] - 20.0) < 0.05
    centred = measure_aperture(gaussian_scene(20.0, 20.0, 100.0), variance, flags, 20.0, 20.0)
    assert centred.centroid == pytest.approx((20.0, 20.0), abs=0.02)


def test_config_rejects_impossible_geometry() -> None:
    with pytest.raises(ValueError):
        ApertureConfig(radius_px=5.0, annulus_in_px=4.0)


# --------------------------------------------------------- longitud de onda


def test_wave_table_interpolates_between_control_points() -> None:
    table = WaveTable(
        detector=1,
        x=np.array([1.0, 11.0]),
        y=np.array([1.0, 5.0, 6.0, 21.0]),
        wavelength=np.array([[1.0, 2.0], [1.4, 2.4], [3.0, 4.0], [4.5, 5.5]]),
        bandwidth=np.full((4, 2), 0.02),
    )
    assert table.lookup(1.0, 1.0) == pytest.approx((1.0, 0.02))
    assert table.lookup(6.0, 3.0)[0] == pytest.approx(1.7)
    # Entre dos puntos de control pegados (5 y 6) la tabla salta: asi marca SPHEREx un cambio de filtro.
    assert table.lookup(1.0, 5.5)[0] == pytest.approx(2.2)
    # Fuera de la malla, el borde.
    assert table.lookup(-50.0, 1.0)[0] == pytest.approx(1.0)
    assert table.wave_range == (1.0, 5.5)


def test_cutout_pixel_maps_to_detector_pixel() -> None:
    header = {"CRVAL1W": 1, "CDELT1W": 1, "CRPIX1W": -329.0, "CRVAL2W": 1, "CDELT2W": 1, "CRPIX2W": -119.0}
    # El primer pixel del recorte (0, 0) es el pixel FITS 1: 1 + (1 + 329) = 331.
    assert detector_pixel(header, 0.0, 0.0) == (331.0, 121.0)


def test_stored_wave_tables_cover_the_six_detectors_in_order() -> None:
    tables = load_wave_tables()
    ranges = [tables.for_detector(detector).wave_range for detector in range(1, 7)]
    assert ranges[0][0] == pytest.approx(0.735, abs=0.02)
    assert ranges[5][1] == pytest.approx(5.02, abs=0.02)
    for (_, high), (low, _) in itertools.pairwise(ranges):
        assert low < high  # detectores vecinos se solapan un poco
    assert all(low < high for low, high in ranges)


# ------------------------------------------------------------ recortes reales


def test_cutout_names_are_parsed() -> None:
    name = "level2_2025W33_2C_0321_1D3_spx_l2b-v27-2026-228__269.446287_+4.768255_0.1_img.fits"
    cutout = parse_cutout_name(Path(name))
    assert cutout is not None
    assert (cutout.ra, cutout.dec, cutout.side_deg, cutout.mode) == (269.446287, 4.768255, 0.1, "img")
    assert cutout.exposure == "level2_2025W33_2C_0321_1D3_spx_l2b-v27-2026-228"
    assert parse_cutout_name(Path("index.json")) is None


def test_barnard_is_reported_as_saturated_instead_of_a_spectrum() -> None:
    cutouts = covering_cutouts(list_cutouts([CUTOUTS]), *BARNARD)
    assert len(cutouts) == 12
    document = compute_spectrum(cutouts, SpectrumTarget(ra=BARNARD[0], dec=BARNARD[1]))
    assert document["status"] == "saturated"
    assert document["points"] == [] and document["binned"] == []
    (warning,) = [item for item in document["warnings"] if item["code"] == "saturated_source"]
    assert warning["detectors"] == [3, 6]
    assert warning["n_exposures"] == 12
    # La forma del aviso `saturated_source` del documento del campo (contrato, seccion 5).
    assert {"ra", "dec", "radius_arcsec", "epochs", "detectors"} <= set(warning)
    assert warning["radius_arcsec"] == document["aperture"]["radius_arcsec"]
    assert {item["detector"]: item["n_saturated"] for item in document["detectors"]} == {3: 6, 6: 6}


def test_a_field_star_gives_points_inside_its_detector_range() -> None:
    # A unos 2 minutos de arco de Barnard, lejos del nucleo saturado: lo que haya ahi se mide en cada recorte.
    ra, dec = BARNARD[0] + 0.02, BARNARD[1] + 0.02
    cutouts = covering_cutouts(list_cutouts([CUTOUTS]), ra, dec)
    document = compute_spectrum(cutouts, SpectrumTarget(ra=ra, dec=dec))
    assert document["status"] in {"ok", "partial", "empty"}
    assert document["provenance"]["n_exposures"] == len(cutouts) > 0
    ranges = {item["detector"]: (item["wave_min_um"], item["wave_max_um"]) for item in document["detectors"]}
    for point in document["points"]:
        low, high = ranges[point["detector"]]
        assert low <= point["wavelength_um"] <= high
        assert point["error_mjy"] > 0
        assert math.isfinite(point["flux_mjy"])
        assert point["epoch"] in {1, 2, 3}
        assert point["date"].startswith("202")


# ---------------------------------------------------------------- documento


def test_epochs_split_on_gaps_longer_than_sixty_days() -> None:
    numbers, epochs = assign_epochs([60800.5, 60980.0, 60801.0, 61160.0, 61020.0])
    assert numbers == [1, 2, 1, 3, 2]
    assert [item["n_exposures"] for item in epochs] == [2, 2, 1]
    assert epochs[0]["start"] == "2025-05-05"


def test_binning_weights_by_inverse_variance() -> None:
    tables = load_wave_tables()
    low, _high = tables.for_detector(6).wave_range
    wave = low * 1.001
    points = [
        {"wavelength_um": wave, "flux_mjy": 1.0, "error_mjy": 0.1, "detector": 6},
        {"wavelength_um": wave, "flux_mjy": 3.0, "error_mjy": 0.3, "detector": 6},
    ]
    (binned,) = bin_points(points, tables)
    assert binned["n"] == 2 and binned["detector"] == 6
    assert binned["flux_mjy"] == pytest.approx(1.2, rel=1e-3)  # (1/0.01 + 3/0.09) / (1/0.01 + 1/0.09)
    assert binned["error_mjy"] == pytest.approx(math.sqrt(1.0 / (100.0 + 100.0 / 9.0)), rel=1e-3)
    assert binned["wave_min_um"] <= wave <= binned["wave_max_um"]
