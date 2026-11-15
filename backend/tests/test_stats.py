"""Estadisticas de un plano, escala de un detector y regiones saturadas."""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.pipeline.stats import (
    MAD_TO_SIGMA,
    detector_display,
    plane_stats,
    robust_stats,
    saturated_regions,
)


def _noise(shape: tuple[int, int] = (60, 80), sigma: float = 0.05, seed: int = 7) -> np.ndarray:
    return np.random.default_rng(seed).normal(0.0, sigma, shape).astype(np.float32)


# ----------------------------------------------------------------- plane_stats


def test_plane_stats_on_known_values() -> None:
    image = np.arange(1, 101, dtype=np.float32).reshape(10, 10)
    stats = plane_stats(image)
    assert stats is not None
    assert stats.min == 1.0
    assert stats.max == 100.0
    assert stats.median == 50.5
    # MAD de 1..100 respecto de 50.5 es 25.
    assert stats.sigma == pytest.approx(MAD_TO_SIGMA * 25.0, rel=1e-5)
    assert stats.p01 == pytest.approx(np.percentile(image, 1.0), rel=1e-5)
    assert stats.p99 == pytest.approx(np.percentile(image, 99.0), rel=1e-5)
    assert stats.p997 == pytest.approx(np.percentile(image, 99.7), rel=1e-5)
    assert stats.valid_fraction == 1.0
    assert stats.saturated_fraction == 0.0


def test_plane_stats_ignores_nan_and_infinity() -> None:
    image = np.arange(1, 101, dtype=np.float32).reshape(10, 10)
    clean = plane_stats(image[2:, :])
    image[0, :] = np.nan  # 10 pixeles sin datos
    image[1, :5] = np.inf  # 5 saturados
    image[1, 5:] = np.nan  # 5 mas sin datos
    stats = plane_stats(image)
    assert stats is not None and clean is not None
    # Las estadisticas salen solo de los 80 pixeles finitos.
    assert (stats.min, stats.max, stats.median, stats.sigma) == (clean.min, clean.max, clean.median, clean.sigma)
    assert (stats.p01, stats.p99, stats.p997) == (clean.p01, clean.p99, clean.p997)
    # Las fracciones son del total de pixeles.
    assert stats.valid_fraction == 0.8
    assert stats.saturated_fraction == 0.05


def test_plane_stats_sigma_is_robust_to_bright_sources() -> None:
    image = _noise(sigma=0.05)
    image[10:14, 10:14] = 500.0
    stats = plane_stats(image)
    assert stats is not None
    assert stats.sigma == pytest.approx(0.05, rel=0.1)
    assert abs(stats.median) < 0.01
    assert stats.max == 500.0


def test_plane_stats_without_finite_pixels() -> None:
    assert plane_stats(np.full((4, 4), np.nan, dtype=np.float32)) is None
    assert plane_stats(np.full((4, 4), np.inf, dtype=np.float32)) is None
    assert plane_stats(np.zeros((0, 0), dtype=np.float32)) is None


def test_plane_stats_values_are_finite_and_json_safe() -> None:
    image = _noise()
    image[0, 0] = np.nan
    image[5:8, 5:8] = np.inf
    stats = plane_stats(image)
    assert stats is not None
    assert all(math.isfinite(value) for value in stats.model_dump().values())


def test_robust_stats() -> None:
    median, sigma = robust_stats(np.array([1.0, 2.0, 3.0, 4.0, 100.0]))
    assert median == 3.0
    assert sigma == pytest.approx(MAD_TO_SIGMA * 1.0)


# ------------------------------------------------------------ detector_display


def test_detector_display_uses_the_contract_formula() -> None:
    planes = [_noise(seed=1), _noise(seed=2), _noise(seed=3)]
    display = detector_display(planes)
    assert display is not None
    values = np.concatenate([plane.ravel() for plane in planes]).astype(np.float64)
    median = float(np.median(values))
    sigma = float(MAD_TO_SIGMA * np.median(np.abs(values - median)))
    assert display.median == pytest.approx(median, rel=1e-4, abs=1e-9)
    assert display.sigma == pytest.approx(sigma, rel=1e-4)
    assert display.vmin == pytest.approx(median - 2.0 * sigma, rel=1e-4)
    assert display.vmax == pytest.approx(max(np.percentile(values, 99.7), median + 10.0 * sigma), rel=1e-4)


def test_detector_display_vmax_follows_bright_pixels() -> None:
    faint = _noise(seed=1)
    display_faint = detector_display([faint])
    bright = faint.copy()
    bright[:10, :10] = 40.0  # el 2 % del plano: queda por encima del percentil 99.7
    display_bright = detector_display([bright])
    assert display_faint is not None and display_bright is not None
    # Sin fuentes brillantes manda mediana + 10 sigma; con ellas, el percentil 99.7.
    assert display_faint.vmax == pytest.approx(display_faint.median + 10.0 * display_faint.sigma, rel=1e-3)
    assert display_bright.vmax == pytest.approx(40.0)


def test_detector_display_ignores_invalid_pixels_and_empty_planes() -> None:
    plane = _noise(seed=4)
    damaged = plane.copy()
    damaged[:5, :] = np.nan
    damaged[5:8, :8] = np.inf
    expected = detector_display([plane[8:, :], plane[5:8, 8:]])
    assert detector_display([damaged, np.full((3, 3), np.nan, dtype=np.float32)]) == expected


def test_detector_display_without_data() -> None:
    assert detector_display([]) is None
    assert detector_display([np.full((5, 5), np.nan, dtype=np.float32)]) is None


def test_detector_display_of_a_constant_plane_still_has_width() -> None:
    display = detector_display([np.full((5, 5), 2.0, dtype=np.float32)])
    assert display is not None
    assert display.sigma == 0.0
    assert display.vmin < 2.0 < display.vmax


# ----------------------------------------------------------- saturated_regions


def test_saturated_region_center_radius_and_count() -> None:
    image = _noise((40, 50))
    image[10:13, 20:25] = np.inf  # 3 filas x 5 columnas
    regions = saturated_regions(image)
    assert len(regions) == 1
    region = regions[0]
    assert region.n_pixels == 15
    assert region.x == 22.0  # columnas 20 a 24
    assert region.y == 11.0  # filas 10 a 12
    assert region.radius_px == pytest.approx(math.sqrt(15 / math.pi), abs=0.005)


def test_saturated_regions_need_at_least_four_pixels() -> None:
    image = _noise((30, 30))
    image[2, 2:5] = np.inf  # 3 pixeles: no se informa
    image[10, 10:14] = np.inf  # 4 pixeles: si
    regions = saturated_regions(image)
    assert [region.n_pixels for region in regions] == [4]
    assert (regions[0].x, regions[0].y) == (11.5, 10.0)
    assert [region.n_pixels for region in saturated_regions(image, min_pixels=1)] == [4, 3]


def test_saturated_regions_join_diagonal_neighbors() -> None:
    image = np.zeros((10, 10), dtype=np.float32)
    for i in range(4):
        image[2 + i, 3 + i] = np.inf  # cuatro pixeles que solo se tocan en diagonal
    regions = saturated_regions(image)
    assert len(regions) == 1
    assert regions[0].n_pixels == 4
    assert (regions[0].x, regions[0].y) == (4.5, 3.5)


def test_saturated_regions_are_separate_and_sorted_by_size() -> None:
    image = np.zeros((40, 40), dtype=np.float32)
    image[5:7, 5:7] = np.inf  # 4 pixeles
    image[20:25, 20:25] = np.inf  # 25 pixeles
    image[5:8, 30:33] = np.inf  # 9 pixeles
    regions = saturated_regions(image)
    assert [region.n_pixels for region in regions] == [25, 9, 4]
    assert [(region.x, region.y) for region in regions] == [(22.0, 22.0), (31.0, 6.0), (5.5, 5.5)]


def test_saturated_regions_ignore_nan_and_negative_infinity() -> None:
    image = np.zeros((12, 12), dtype=np.float32)
    image[0:4, 0:4] = np.nan
    image[6:8, 6:8] = -np.inf
    assert saturated_regions(image) == []


def test_saturated_regions_touching_the_border() -> None:
    image = np.zeros((8, 8), dtype=np.float32)
    image[0:2, 0:2] = np.inf
    image[6:8, 6:8] = np.inf
    regions = saturated_regions(image)
    assert sorted((region.x, region.y) for region in regions) == [(0.5, 0.5), (6.5, 6.5)]


def test_fully_saturated_plane_is_one_region() -> None:
    regions = saturated_regions(np.full((50, 60), np.inf, dtype=np.float32))
    assert len(regions) == 1
    assert regions[0].n_pixels == 3000
    assert (regions[0].x, regions[0].y) == (29.5, 24.5)
