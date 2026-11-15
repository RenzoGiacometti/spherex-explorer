"""Deteccion de fuentes sobre planos sinteticos: picos conocidos, saturacion, NaN y borde."""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.spectrum.detect import DetectConfig, detect_sources, detection_image

SHAPE = (120, 120)


def gaussian(x: float, y: float, amplitude: float, sigma: float = 1.6) -> np.ndarray:
    ys, xs = np.mgrid[0 : SHAPE[0], 0 : SHAPE[1]]
    return amplitude * np.exp(-((xs - x) ** 2 + (ys - y) ** 2) / (2.0 * sigma**2))


def stack(sources: list[tuple[float, float, float]], n_planes: int = 6, seed: int = 7) -> np.ndarray:
    """Planos con ruido de sigma 1 y fondo distinto en cada uno, con las fuentes `(x, y, amplitud)`."""
    rng = np.random.default_rng(seed)
    signal = sum((gaussian(x, y, amplitude) for x, y, amplitude in sources), np.zeros(SHAPE))
    return np.stack([rng.normal(10.0 * plane, 1.0, SHAPE) + signal for plane in range(n_planes)]).astype(np.float32)


def nearest(found: list, x: float, y: float) -> float:
    return min(math.hypot(source.x - x, source.y - y) for source in found)


def test_finds_known_peaks_from_brightest_to_faintest() -> None:
    sources = [(30.3, 40.6, 80.0), (80.0, 25.0, 300.0), (60.5, 90.2, 40.0), (100.0, 100.0, 150.0)]
    found = detect_sources(stack(sources))

    assert len(found) == len(sources)
    assert not any(source.saturated for source in found)
    # De la mas brillante a la mas debil, y cada una a menos de un tercio de pixel de donde se puso.
    by_brightness = sorted(sources, key=lambda source: -source[2])
    for source, (x, y, _amplitude) in zip(found, by_brightness, strict=True):
        assert math.hypot(source.x - x, source.y - y) < 0.35
    assert [source.peak for source in found] == sorted((source.peak for source in found), reverse=True)


def test_noise_alone_gives_no_sources() -> None:
    assert detect_sources(stack([])) == []


def test_max_sources_keeps_the_brightest() -> None:
    sources = [(20.0 + 20.0 * index, 60.0, 50.0 + 50.0 * index) for index in range(5)]
    found = detect_sources(stack(sources), DetectConfig(max_sources=2))

    assert len(found) == 2
    assert nearest(found[:1], 100.0, 60.0) < 0.5
    assert nearest(found[1:], 80.0, 60.0) < 0.5


def test_saturated_blob_is_one_source_and_goes_first() -> None:
    planes = stack([(40.0, 40.0, 500.0), (90.0, 80.0, 2000.0)])
    ys, xs = np.mgrid[0 : SHAPE[0], 0 : SHAPE[1]]
    core = np.hypot(xs - 90.0, ys - 80.0) <= 4.0
    planes[:, core] = np.inf

    found = detect_sources(planes)

    assert found[0].saturated
    assert math.isinf(found[0].peak)
    assert found[0].n_saturated_px == int(core.sum())
    assert math.hypot(found[0].x - 90.0, found[0].y - 80.0) < 0.1
    # Las alas de la saturada no salen como fuentes aparte: solo queda la otra estrella.
    assert len(found) == 2
    assert not found[1].saturated
    assert nearest(found[1:], 40.0, 40.0) < 0.35


def test_pixel_saturated_in_a_single_plane_is_not_a_source() -> None:
    planes = stack([(40.0, 40.0, 200.0)])
    planes[2, 100, 100] = np.inf  # un rayo cosmico marcado en un solo plano

    image, saturated = detection_image(planes)
    found = detect_sources(planes)

    assert not saturated.any()
    assert np.isfinite(image[100, 100])
    assert len(found) == 1
    assert nearest(found, 40.0, 40.0) < 0.35


def test_nan_regions_are_ignored() -> None:
    planes = stack([(40.0, 40.0, 200.0), (90.0, 90.0, 200.0)])
    planes[:, 70:, 70:] = np.nan  # una esquina sin cobertura, con una fuente adentro
    planes[0] = np.nan  # y un plano entero sin datos

    image, saturated = detection_image(planes)
    found = detect_sources(planes)

    assert np.isnan(image[90, 90])
    assert not saturated.any()
    assert len(found) == 1
    assert nearest(found, 40.0, 40.0) < 0.35


def test_pixel_with_little_coverage_is_left_out() -> None:
    planes = stack([])
    planes[1:, 60, 60] = np.nan  # un solo plano con valor: su promedio no es confiable
    planes[0, 60, 60] = 500.0

    image, _saturated = detection_image(planes)

    assert np.isnan(image[60, 60])
    assert detect_sources(planes) == []


def test_sources_near_the_edge_are_dropped() -> None:
    config = DetectConfig(edge_px=8.0)
    found = detect_sources(stack([(3.0, 60.0, 300.0), (60.0, 116.0, 300.0), (60.0, 60.0, 100.0)]), config)

    assert len(found) == 1
    assert nearest(found, 60.0, 60.0) < 0.35


def test_minimum_separation_keeps_the_brighter_of_two_close_sources() -> None:
    config = DetectConfig(min_separation_px=7.0)
    found = detect_sources(stack([(50.0, 50.0, 300.0), (55.0, 50.0, 150.0), (50.0, 62.0, 150.0)]), config)

    assert len(found) == 2
    assert nearest(found[:1], 50.0, 50.0) < 0.5
    assert nearest(found[1:], 50.0, 62.0) < 0.5
    for first in found:
        for second in found:
            assert first is second or math.hypot(first.x - second.x, first.y - second.y) >= config.min_separation_px


def test_excluded_positions_are_not_detected_again() -> None:
    sources = [(40.0, 40.0, 300.0), (90.0, 90.0, 100.0)]
    found = detect_sources(stack(sources), exclude=[(41.0, 40.5)])

    assert len(found) == 1
    assert nearest(found, 90.0, 90.0) < 0.35


def test_detection_image_is_in_units_of_its_own_noise() -> None:
    image, _saturated = detection_image(stack([(60.0, 60.0, 100.0)]))
    background = image[:30, :30]

    assert abs(float(np.median(background))) < 0.2
    assert float(np.std(background)) == pytest.approx(1.0, abs=0.2)
    # Amplitud 100 sobre ruido 1 por plano, seis planos promediados: unas 100 x raiz(6) sigmas.
    assert float(image[60, 60]) == pytest.approx(100.0 * math.sqrt(6.0), rel=0.15)


def test_single_plane_is_accepted() -> None:
    planes = stack([(60.0, 60.0, 200.0)], n_planes=1)

    found = detect_sources(planes[0])

    assert len(found) == 1
    assert nearest(found, 60.0, 60.0) < 0.35


def test_rejects_wrong_dimensions_and_bad_config() -> None:
    with pytest.raises(ValueError):
        detection_image(np.zeros((2, 3, 4, 5)))
    with pytest.raises(ValueError):
        DetectConfig(min_saturated_planes=0)
