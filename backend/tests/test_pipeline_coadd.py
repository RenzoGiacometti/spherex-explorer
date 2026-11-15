"""`PlaneAccumulator`: las reglas de cada pixel del coadd (contrato, secciones 6 y 7).

Todo con exposiciones sinteticas armadas en memoria. Las reglas se prueban
sobre un plano de un solo pixel, donde cada caso se lee de un vistazo, y
despues sobre planos enteros contra una referencia calculada con las
exposiciones apiladas (como `coadd` en spike/field.py).
"""

from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import numpy as np
import pytest

from app import geometry
from app.domain import Grid, PlaneArrays, ReprojectedExposure
from app.pipeline import coadd
from app.pipeline.coadd import MAX_EXPOSURES, PlaneAccumulator
from app.pipeline.flag_table import FlagTableError

# Bits de los encabezados reales (tests/fixtures/cutouts), los que hacen falta aca.
BITS: dict[str, int] = {"TRANSIENT": 0, "OVERFLOW": 1, "HOT": 10, "SOURCE": 21, "BLOOM": 26, "SNOWBALL": 27}
WITHOUT_SNOWBALL = {name: bit for name, bit in BITS.items() if name != "SNOWBALL"}
WITH_SATELLITE_HALO = {**BITS, "SATELLITE_HALO": 29}

OVERFLOW, HOT, SOURCE, BLOOM, SNOWBALL = (
    1 << BITS[name] for name in ("OVERFLOW", "HOT", "SOURCE", "BLOOM", "SNOWBALL")
)
SATELLITE_HALO = 1 << 29

# Un plano de un solo pixel y uno chico, de 23 x 23.
PIXEL = geometry.make_grid(10.0, 20.0, 0.0005, 3.075)
SMALL = geometry.make_grid(10.0, 20.0, 0.02, 3.075)


def exposure(
    value: Any = 1.0,
    variance: Any = 1.0,
    flags: Any = 0,
    footprint: Any = True,
    *,
    bits: dict[str, int] = BITS,
    grid: Grid = PIXEL,
) -> ReprojectedExposure:
    """Exposicion sintetica: cada argumento es un numero para todo el plano o un arreglo con su forma."""
    shape = grid.shape
    return ReprojectedExposure(
        image=np.broadcast_to(np.asarray(value, dtype=np.float32), shape).copy(),
        variance=np.broadcast_to(np.asarray(variance, dtype=np.float32), shape).copy(),
        flags=np.broadcast_to(np.asarray(flags, dtype=np.uint32), shape).copy(),
        footprint=np.broadcast_to(np.asarray(footprint, dtype=bool), shape).copy(),
        flag_bits=dict(bits),
        background=0.0,
    )


def discarded(flags: int = 0, *, bits: dict[str, int] = BITS, grid: Grid = PIXEL) -> ReprojectedExposure:
    """Exposicion que cubre el plano pero no aporta valor (como la deja `load_exposure` al enmascarar)."""
    return exposure(np.nan, np.nan, flags, bits=bits, grid=grid)


def uncovered(*, grid: Grid = PIXEL) -> ReprojectedExposure:
    """Exposicion cuya huella no toca el plano."""
    return exposure(np.nan, np.nan, 0, False, grid=grid)


def accumulate(*exposures: ReprojectedExposure, grid: Grid = PIXEL) -> PlaneArrays:
    accumulator = PlaneAccumulator(grid, len(exposures))
    for item in exposures:
        accumulator.add(item)
    return accumulator.snapshot()


def pixel(*exposures: ReprojectedExposure) -> tuple[float, int, int]:
    """`(valor, flags, cobertura)` del coadd de un plano de un pixel."""
    plane = accumulate(*exposures)
    return float(plane.image[0, 0]), int(plane.flags[0, 0]), int(plane.coverage[0, 0])


def same_plane(a: PlaneArrays, b: PlaneArrays) -> bool:
    return (
        np.array_equal(a.image, b.image, equal_nan=True)
        and np.array_equal(a.flags, b.flags)
        and np.array_equal(a.coverage, b.coverage)
    )


# ----------------------------------------------------------------------- pesos


def test_mean_is_weighted_by_inverse_variance() -> None:
    # Pesos 1 y 1/3: (1 x 1 + 3 x 1/3) / (1 + 1/3) = 1.5.
    value, flags, coverage = pixel(exposure(1.0, 1.0), exposure(3.0, 3.0))
    assert value == pytest.approx(1.5, rel=1e-6)
    assert (flags, coverage) == (0, 2)

    # La exposicion con menos varianza manda.
    value, _, _ = pixel(exposure(10.0, 0.01), exposure(0.0, 100.0))
    assert value == pytest.approx(10.0 * 100.0 / (100.0 + 0.01), rel=1e-6)

    # Con la misma varianza es la media simple, y puede ser negativa.
    value, _, coverage = pixel(exposure(-1.0, 2.0), exposure(-2.0, 2.0), exposure(-6.0, 2.0))
    assert value == pytest.approx(-3.0, rel=1e-6) and coverage == 3


def test_a_single_exposure_gives_its_own_values() -> None:
    rng = np.random.default_rng(1)
    image = rng.normal(0.0, 1.0, SMALL.shape).astype(np.float32)
    plane = accumulate(exposure(image, 0.5, grid=SMALL), grid=SMALL)
    np.testing.assert_allclose(plane.image, image, rtol=1e-6)
    assert (plane.coverage == 1).all() and not plane.flags.any()


@pytest.mark.parametrize(
    ("value", "variance"),
    [(np.nan, 1.0), (np.inf, 1.0), (-np.inf, 1.0), (5.0, np.nan), (5.0, np.inf), (5.0, 0.0), (5.0, -1.0)],
)
def test_invalid_contributions_do_not_count(value: float, variance: float) -> None:
    result, _, coverage = pixel(exposure(2.0, 1.0), exposure(value, variance), exposure(4.0, 1.0))
    assert result == pytest.approx(3.0, rel=1e-6)
    assert coverage == 2
    # Sola, no da ningun valor: el pixel queda sin datos, nunca en infinito negativo.
    alone, _, coverage = pixel(exposure(value, variance))
    assert math.isnan(alone) and coverage == 0


def test_a_value_outside_the_footprint_does_not_count() -> None:
    """La huella manda: lo que una exposicion traiga fuera de ella no entra ni cuenta como cobertura."""
    value, flags, coverage = pixel(exposure(2.0, 1.0), exposure(100.0, 1.0, OVERFLOW, False))
    assert (value, flags, coverage) == (pytest.approx(2.0), 0, 1)


def test_matches_the_stacked_coadd_of_the_spike() -> None:
    """Sobre planos enteros con huecos al azar: el mismo resultado que apilar y promediar."""
    rng = np.random.default_rng(7)
    n = 9
    images = rng.normal(0.0, 1.0, (n, *SMALL.shape)).astype(np.float32)
    variances = rng.uniform(0.01, 2.0, (n, *SMALL.shape)).astype(np.float32)
    holes = rng.random((n, *SMALL.shape)) < 0.7
    images[holes] = np.nan
    variances[holes] = np.nan
    images[0, 3, 3], variances[0, 3, 3] = 1.0, 0.0  # varianza no positiva con imagen finita
    images[1, 4, 4], variances[1, 4, 4] = np.inf, 1.0

    plane = accumulate(*(exposure(images[i], variances[i], grid=SMALL) for i in range(n)), grid=SMALL)

    # `coadd` de spike/field.py.
    data, var = images.astype(np.float64), variances.astype(np.float64)
    valid = np.isfinite(data) & np.isfinite(var) & (var > 0)
    weight = np.where(valid, 1.0 / np.where(valid, var, 1.0), 0.0)
    total = weight.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(total > 0, (weight * np.where(valid, data, 0.0)).sum(axis=0) / total, np.nan)

    assert np.array_equal(plane.coverage, valid.sum(axis=0))
    assert np.array_equal(np.isnan(plane.image), np.isnan(mean))
    assert np.isnan(mean).any() and np.isfinite(mean).any()
    np.testing.assert_allclose(plane.image[total > 0], mean[total > 0], rtol=1e-6, atol=1e-7)


def test_extreme_values_stay_finite() -> None:
    """Infinito queda reservado para la saturacion: una media de valores Float32 no se desborda."""
    huge = float(np.finfo(np.float32).max)
    for sign in (1.0, -1.0):
        value, _, coverage = pixel(exposure(sign * huge, 1.0), exposure(sign * huge, 3.0), exposure(sign * huge, 7.0))
        assert math.isfinite(value) and value == pytest.approx(sign * huge, rel=1e-6) and coverage == 3
    tiny = float(np.finfo(np.float32).tiny)
    value, _, coverage = pixel(exposure(1.0, tiny), exposure(2.0, tiny))
    assert value == pytest.approx(1.5, rel=1e-6) and coverage == 2


# ----------------------------------------------------------- flags por mayoria


@pytest.mark.parametrize(
    ("with_flag", "total", "expected"),
    [
        (1, 1, True),
        (1, 2, True),  # la mitad justa alcanza
        (1, 3, False),
        (2, 3, True),
        (1, 4, False),
        (2, 4, True),  # par: 2 de 4
        (3, 4, True),
        (2, 5, False),  # impar: 2 de 5 no llega
        (3, 5, True),
        (9, 20, False),
        (10, 20, True),
        (0, 3, False),
    ],
)
def test_flag_is_on_if_at_least_half_of_the_exposures_have_it(with_flag: int, total: int, expected: bool) -> None:
    items = [exposure(1.0, 1.0, SOURCE) for _ in range(with_flag)]
    items += [exposure(1.0, 1.0, 0) for _ in range(total - with_flag)]
    _, flags, coverage = pixel(*items)
    assert flags == (SOURCE if expected else 0)
    assert coverage == total


def test_each_bit_has_its_own_majority() -> None:
    _, flags, _ = pixel(
        exposure(1.0, 1.0, SOURCE | HOT),
        exposure(1.0, 1.0, SOURCE),
        exposure(1.0, 1.0, SOURCE | SNOWBALL),
        exposure(1.0, 1.0, SNOWBALL),
    )
    # SOURCE en 3 de 4 y SNOWBALL en 2 de 4: encendidos. HOT en 1 de 4: apagado.
    assert flags == SOURCE | SNOWBALL


def test_majority_counts_only_the_exposures_that_cover_the_pixel() -> None:
    # Una de una: las dos que no cubren el pixel no votan.
    _, flags, coverage = pixel(exposure(1.0, 1.0, SOURCE), uncovered(), uncovered())
    assert (flags, coverage) == (SOURCE, 1)
    # Las que cubren sin aportar valor si votan: 1 de 3.
    _, flags, coverage = pixel(exposure(1.0, 1.0, SOURCE), discarded(), discarded())
    assert (flags, coverage) == (0, 1)
    # Y sus flags cuentan aunque no aporten: HOT en 2 de 3.
    value, flags, coverage = pixel(exposure(1.0, 1.0), discarded(HOT), discarded(HOT))
    assert (value, flags, coverage) == (pytest.approx(1.0), HOT, 1)


def test_a_cosmic_ray_in_one_exposure_of_twenty_does_not_mark_the_pixel() -> None:
    """Por eso es la mayoria y no la union (contrato, seccion 6)."""
    items = [exposure(1.0, 1.0) for _ in range(19)] + [discarded(1 << BITS["TRANSIENT"])]
    value, flags, coverage = pixel(*items)
    assert (value, flags, coverage) == (pytest.approx(1.0), 0, 19)


# -------------------------------------------------- saturacion contra sin datos


def test_saturated_if_nothing_is_valid_and_at_least_half_is_saturated() -> None:
    assert pixel(discarded(OVERFLOW)) == (math.inf, OVERFLOW, 0)
    assert pixel(discarded(BLOOM)) == (math.inf, BLOOM, 0)
    assert pixel(discarded(OVERFLOW | BLOOM), discarded(BLOOM), discarded(BLOOM)) == (math.inf, BLOOM, 0)
    # La mitad justa: 1 de 2 y 2 de 4.
    assert pixel(discarded(BLOOM), discarded(HOT)) == (math.inf, BLOOM | HOT, 0)
    assert pixel(discarded(BLOOM), discarded(BLOOM), discarded(HOT), discarded())[0] == math.inf


def test_no_data_if_nothing_is_valid_and_saturation_is_a_minority() -> None:
    value, flags, coverage = pixel(discarded(BLOOM), discarded(HOT), discarded(HOT))
    assert math.isnan(value) and (flags, coverage) == (HOT, 0)
    value, _, _ = pixel(discarded(OVERFLOW), discarded(BLOOM), discarded(), discarded(), discarded())
    assert math.isnan(value)


def test_no_data_if_the_pixels_were_discarded_for_other_reasons() -> None:
    value, flags, coverage = pixel(discarded(HOT), discarded(SNOWBALL), discarded())
    assert math.isnan(value) and (flags, coverage) == (0, 0)
    # Un borde del detector: la exposicion cubre el pixel, sin flags y sin valor.
    value, flags, coverage = pixel(discarded())
    assert math.isnan(value) and (flags, coverage) == (0, 0)


def test_no_data_where_no_exposure_covers_the_pixel() -> None:
    value, flags, coverage = pixel(uncovered(), uncovered())
    assert math.isnan(value) and (flags, coverage) == (0, 0)
    # Los flags de fuera de la huella no cuentan, aunque sean de saturacion.
    value, flags, coverage = pixel(exposure(np.nan, np.nan, OVERFLOW, False))
    assert math.isnan(value) and (flags, coverage) == (0, 0)


def test_a_valid_value_wins_over_saturation() -> None:
    """Saturado es solo si ninguna exposicion aporto: RW Aurigae satura a medias."""
    value, flags, coverage = pixel(exposure(7.0, 1.0), discarded(BLOOM), discarded(BLOOM), discarded(BLOOM))
    assert (value, flags, coverage) == (pytest.approx(7.0), BLOOM, 1)


def test_saturation_counts_only_the_exposures_that_cover_the_pixel() -> None:
    assert pixel(discarded(OVERFLOW), uncovered(), uncovered(), uncovered()) == (math.inf, OVERFLOW, 0)


def test_a_saturated_pixel_always_carries_a_saturation_flag() -> None:
    """Saturado por los dos flags juntos sin que ninguno llegue a la mitad: se enciende el mas frecuente.

    De cuatro exposiciones, una tiene OVERFLOW y otra BLOOM: la mitad tiene
    alguno de los dos (regla de la seccion 7), pero ninguno llega a la mitad
    por separado (regla de la seccion 6). A igual cantidad gana el bit mas bajo.
    """
    value, flags, coverage = pixel(discarded(OVERFLOW), discarded(BLOOM), discarded(HOT), discarded(HOT))
    assert (value, flags, coverage) == (math.inf, HOT | OVERFLOW, 0)
    # El mas frecuente de los dos: 2 de BLOOM contra 1 de OVERFLOW, sobre 6.
    items = [discarded(BLOOM), discarded(BLOOM), discarded(OVERFLOW), discarded(), discarded(), discarded()]
    assert pixel(*items) == (math.inf, BLOOM, 0)
    # RW Aurigae, plano (1, 2), pixel (98, 96): cubren 18, OVERFLOW 8, BLOOM 6, alguno de los dos 12.
    items = [discarded(OVERFLOW)] * 6 + [discarded(BLOOM)] * 4 + [discarded(OVERFLOW | BLOOM)] * 2 + [discarded()] * 6
    assert pixel(*items) == (math.inf, OVERFLOW, 0)


def test_the_added_saturation_flag_does_not_touch_other_pixels() -> None:
    """El flag agregado va solo a pixeles saturados sin ninguno: ni sin datos, ni con valor, ni ya explicados."""
    # Sin datos (la saturacion es minoria): los flags quedan por mayoria, sin agregados.
    value, flags, _ = pixel(discarded(OVERFLOW), discarded(BLOOM), discarded(), discarded(), discarded())
    assert math.isnan(value) and flags == 0
    # Con valor valido: tampoco.
    value, flags, _ = pixel(exposure(3.0, 1.0), discarded(OVERFLOW), discarded(BLOOM), discarded())
    assert (value, flags) == (pytest.approx(3.0), 0)
    # Saturado y ya explicado por mayoria con BLOOM: no se suma OVERFLOW aunque aparezca.
    assert pixel(discarded(BLOOM), discarded(BLOOM), discarded(OVERFLOW), discarded()) == (math.inf, BLOOM, 0)


def test_coverage_is_zero_exactly_where_the_image_is_not_finite() -> None:
    rng = np.random.default_rng(11)
    shape = SMALL.shape
    items = []
    for _ in range(6):
        image = rng.normal(0.0, 1.0, shape).astype(np.float32)
        lost = rng.random(shape) < 0.6
        flags = np.where(lost & (rng.random(shape) < 0.7), BLOOM, 0).astype(np.uint32)
        image[lost] = np.nan
        footprint = rng.random(shape) < 0.8
        items.append(exposure(image, np.where(lost, np.nan, 0.3), flags, footprint, grid=SMALL))
    plane = accumulate(*items, grid=SMALL)
    assert np.isnan(plane.image).any() and np.isposinf(plane.image).any() and np.isfinite(plane.image).any()
    assert not np.isneginf(plane.image).any()
    assert np.array_equal(plane.coverage == 0, ~np.isfinite(plane.image))
    assert int(plane.coverage.max()) <= 6
    # En estos datos el unico flag de saturacion es BLOOM: todo pixel saturado lo tiene encendido.
    assert ((plane.flags[np.isposinf(plane.image)] & np.uint32(BLOOM)) != 0).all()


def test_flags_and_saturation_match_a_reference_computed_from_the_stack() -> None:
    rng = np.random.default_rng(23)
    shape = SMALL.shape
    n = 8
    footprints = rng.random((n, *shape)) < 0.85
    choices = np.array([0, 0, 0, SOURCE, SOURCE | HOT, OVERFLOW, BLOOM, OVERFLOW | BLOOM, SNOWBALL], dtype=np.uint32)
    flags = choices[rng.integers(0, len(choices), (n, *shape))]
    masked = (flags & np.uint32(OVERFLOW | BLOOM | HOT | SNOWBALL)) != 0
    images = np.where(masked, np.nan, rng.normal(0.0, 1.0, (n, *shape))).astype(np.float32)
    # Como en `load_exposure`: fuera de la huella no hay imagen ni flags.
    images[~footprints] = np.nan
    flags[~footprints] = 0
    plane = accumulate(*(exposure(images[i], 1.0, flags[i], footprints[i], grid=SMALL) for i in range(n)), grid=SMALL)

    covering = footprints.sum(axis=0)
    n_valid = np.isfinite(images).sum(axis=0)
    n_saturated = ((flags & np.uint32(OVERFLOW | BLOOM)) != 0).sum(axis=0)
    expected_flags = np.zeros(shape, dtype=np.uint32)
    for number in range(32):
        count = ((flags >> np.uint32(number)) & np.uint32(1)).sum(axis=0)
        expected_flags |= ((count > 0) & (2 * count >= covering)).astype(np.uint32) << np.uint32(number)
    saturated = (n_valid == 0) & (covering > 0) & (2 * n_saturated >= covering)
    # Un pixel saturado sin ningun flag de saturacion por mayoria lleva el mas frecuente de los
    # dos (OVERFLOW a igual cantidad, por ser el bit mas bajo). Pixel por pixel, sin el codigo de la app.
    n_overflow = ((flags & np.uint32(OVERFLOW)) != 0).sum(axis=0)
    n_bloom = ((flags & np.uint32(BLOOM)) != 0).sum(axis=0)
    added = 0
    for y, x in zip(*np.nonzero(saturated), strict=True):
        if expected_flags[y, x] & np.uint32(OVERFLOW | BLOOM):
            continue
        expected_flags[y, x] |= np.uint32(OVERFLOW if n_overflow[y, x] >= n_bloom[y, x] else BLOOM)
        added += 1
    assert added > 0  # el caso existe en estos datos: si no, la regla no se estaria probando

    assert np.array_equal(plane.flags, expected_flags)
    assert ((plane.flags[saturated] & np.uint32(OVERFLOW | BLOOM)) != 0).all()
    assert np.array_equal(plane.coverage, n_valid)
    assert np.array_equal(np.isposinf(plane.image), saturated) and saturated.any()
    assert np.array_equal(np.isnan(plane.image), (n_valid == 0) & ~saturated)
    assert ((n_valid == 0) & ~saturated).any()


# ------------------------------------------------------------------- snapshot


def random_exposures(n: int, seed: int, grid: Grid = SMALL) -> list[ReprojectedExposure]:
    rng = np.random.default_rng(seed)
    shape = grid.shape
    items = []
    for _ in range(n):
        image = rng.normal(0.0, 1.0, shape).astype(np.float32)
        lost = rng.random(shape) < 0.3
        flags = np.where(lost, rng.choice([HOT, BLOOM, OVERFLOW], shape), 0).astype(np.uint32)
        flags |= np.where(rng.random(shape) < 0.5, SOURCE, 0).astype(np.uint32)
        image[lost] = np.nan
        variance = np.where(lost, np.nan, rng.uniform(0.1, 1.0, shape))
        items.append(exposure(image, variance, flags, rng.random(shape) < 0.9, grid=grid))
    return items


def test_snapshot_halfway_equals_a_new_accumulator_with_the_same_exposures() -> None:
    items = random_exposures(10, seed=5)
    accumulator = PlaneAccumulator(SMALL, len(items))
    for item in items[:5]:
        accumulator.add(item)
    halfway = accumulator.snapshot()
    assert accumulator.n_used == 5 and accumulator.n_exposures == 10
    assert same_plane(halfway, accumulate(*items[:5], grid=SMALL))

    for item in items[5:]:
        accumulator.add(item)
    final = accumulator.snapshot()
    assert accumulator.n_used == 10
    assert same_plane(final, accumulate(*items, grid=SMALL))
    assert not same_plane(final, halfway)
    assert int(final.coverage.max()) > int(halfway.coverage.max())


def test_snapshot_does_not_modify_the_accumulator() -> None:
    items = random_exposures(4, seed=9)
    accumulator = PlaneAccumulator(SMALL, len(items))
    for item in items[:2]:
        accumulator.add(item)
    first = accumulator.snapshot()
    second = accumulator.snapshot()
    assert same_plane(first, second) and accumulator.n_used == 2
    assert first.image is not second.image and first.coverage is not second.coverage

    # Lo que se haga con un snapshot no llega al acumulador, y los `add()` que siguen no lo cambian.
    kept = PlaneArrays(image=first.image.copy(), flags=first.flags.copy(), coverage=first.coverage.copy())
    second.image[:] = 99.0
    second.flags[:] = 0xFFFFFFFF
    second.coverage[:] = 77
    assert same_plane(accumulator.snapshot(), kept)
    for item in items[2:]:
        accumulator.add(item)
    assert same_plane(first, kept)
    assert same_plane(accumulator.snapshot(), accumulate(*items, grid=SMALL))


def test_add_does_not_modify_or_keep_the_exposure() -> None:
    item = random_exposures(1, seed=2)[0]
    copy = exposure(item.image, item.variance, item.flags, item.footprint, grid=SMALL)
    accumulator = PlaneAccumulator(SMALL, 1)
    accumulator.add(item)
    assert np.array_equal(item.image, copy.image, equal_nan=True) and np.array_equal(item.flags, copy.flags)
    before = accumulator.snapshot()
    item.image[:] = 50.0
    item.flags[:] = 0
    assert same_plane(accumulator.snapshot(), before)


def test_empty_accumulator() -> None:
    accumulator = PlaneAccumulator(SMALL, 0)
    plane = accumulator.snapshot()
    assert accumulator.n_used == 0 and accumulator.shape == SMALL.shape
    assert np.isnan(plane.image).all() and not plane.flags.any() and not plane.coverage.any()


def test_snapshot_types_and_shapes() -> None:
    plane = accumulate(*random_exposures(3, seed=4), grid=SMALL)
    assert plane.image.shape == plane.flags.shape == plane.coverage.shape == SMALL.shape
    assert (plane.image.dtype, plane.flags.dtype, plane.coverage.dtype) == (np.float32, np.uint32, np.uint16)


def test_order_of_the_exposures_does_not_matter() -> None:
    items = random_exposures(12, seed=31)
    forward = accumulate(*items, grid=SMALL)
    backward = accumulate(*reversed(items), grid=SMALL)
    assert np.array_equal(forward.flags, backward.flags) and np.array_equal(forward.coverage, backward.coverage)
    assert np.array_equal(np.isfinite(forward.image), np.isfinite(backward.image))
    assert np.array_equal(np.isposinf(forward.image), np.isposinf(backward.image))
    # Las sumas en coma flotante pueden diferir en el ultimo bit.
    finite = np.isfinite(forward.image)
    np.testing.assert_allclose(forward.image[finite], backward.image[finite], rtol=1e-6, atol=1e-7)


def test_add_from_many_threads() -> None:
    """`add()` es seguro entre hilos: no se pierde ninguna exposicion ni se rompe ninguna suma."""
    items = random_exposures(48, seed=17)
    serial = accumulate(*items, grid=SMALL)
    accumulator = PlaneAccumulator(SMALL, len(items))
    snapshots: list[PlaneArrays] = []

    def work(item: ReprojectedExposure) -> None:
        accumulator.add(item)
        snapshots.append(accumulator.snapshot())

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(work, items))
    plane = accumulator.snapshot()
    assert accumulator.n_used == len(items) and len(snapshots) == len(items)
    assert np.array_equal(plane.flags, serial.flags) and np.array_equal(plane.coverage, serial.coverage)
    assert np.array_equal(np.isposinf(plane.image), np.isposinf(serial.image))
    finite = np.isfinite(serial.image)
    assert np.array_equal(np.isfinite(plane.image), finite)
    np.testing.assert_allclose(plane.image[finite], serial.image[finite], rtol=1e-6, atol=1e-7)
    # Cada snapshot intermedio es un coadd coherente, con su invariante de cobertura.
    for snapshot in snapshots:
        assert np.array_equal(snapshot.coverage == 0, ~np.isfinite(snapshot.image))


# ------------------------------------------------------ tablas de bits distintas


def test_exposures_with_different_bit_tables() -> None:
    """Tres tablas, como en los datos: sin SNOWBALL, la completa y la que suma SATELLITE_HALO."""
    plain = exposure(1.0, 1.0, SOURCE, bits=WITHOUT_SNOWBALL)
    snowball = discarded(SNOWBALL | SOURCE, bits=BITS)
    halo = discarded(SATELLITE_HALO, bits=WITH_SATELLITE_HALO)

    # SOURCE en 2 de 3; SNOWBALL y SATELLITE_HALO en 1 de 3. La que no declara un flag cuenta como que no lo tiene.
    assert pixel(plain, snowball, halo) == (pytest.approx(1.0), SOURCE, 1)
    assert pixel(halo, snowball, plain) == (pytest.approx(1.0), SOURCE, 1)
    # De a dos, la mitad justa alcanza.
    assert pixel(plain, snowball) == (pytest.approx(1.0), SOURCE | SNOWBALL, 1)
    assert pixel(plain, halo) == (pytest.approx(1.0), SOURCE | SATELLITE_HALO, 1)
    # El bit 29 no se pierde ni se confunde con otro.
    assert pixel(halo, halo, snowball) == (pytest.approx(math.nan, nan_ok=True), SATELLITE_HALO, 0)


def test_saturation_is_found_by_name_in_each_table() -> None:
    # Una tabla que no declara OVERFLOW ni BLOOM no puede marcar saturacion, tenga los bits que tenga.
    other = {"TRANSIENT": 0, "HOT": 10}
    value, flags, _ = pixel(exposure(np.nan, np.nan, OVERFLOW | BLOOM | HOT, bits=other))
    assert math.isnan(value) and flags == HOT
    # Mezclada con una que si los declara, cuenta como una exposicion sin saturacion.
    assert pixel(discarded(BLOOM), exposure(np.nan, np.nan, BLOOM, bits=other))[0] == math.inf
    value, _, _ = pixel(discarded(BLOOM), exposure(np.nan, np.nan, BLOOM, bits=other), discarded(HOT))
    assert math.isnan(value)


def test_bits_that_the_exposure_does_not_declare_are_not_counted() -> None:
    """La capa de flags solo usa bits de `flags[]`: uno encendido sin declarar no aparece."""
    undeclared = 1 << 30
    value, flags, coverage = pixel(exposure(1.0, 1.0, SOURCE | undeclared), exposure(1.0, 1.0, undeclared))
    assert (value, flags, coverage) == (pytest.approx(1.0), SOURCE, 2)
    # El bit 27 en un archivo que no declara SNOWBALL tampoco.
    _, flags, _ = pixel(exposure(1.0, 1.0, SNOWBALL, bits=WITHOUT_SNOWBALL))
    assert flags == 0


@pytest.mark.parametrize(
    ("table", "message"),
    [
        ({**WITHOUT_SNOWBALL, "OTRO_NOMBRE": 27}, "el bit 27 aparece como SNOWBALL y como OTRO_NOMBRE"),
        ({**WITHOUT_SNOWBALL, "SNOWBALL": 30}, "el flag SNOWBALL aparece en el bit 27 y en el bit 30"),
        ({**BITS, "FUERA": 32}, "los bits van de 0 a 31"),
    ],
)
def test_incompatible_bit_table_is_rejected_and_leaves_the_accumulator_as_it_was(
    table: dict[str, int], message: str
) -> None:
    items = random_exposures(3, seed=13)
    accumulator = PlaneAccumulator(SMALL, 4)
    for item in items:
        accumulator.add(item)
    before = accumulator.snapshot()

    bad = exposure(1.0, 1.0, SOURCE, bits=table, grid=SMALL)
    with pytest.raises(FlagTableError, match=message):
        accumulator.add(bad)
    assert isinstance(FlagTableError("x"), ValueError)
    assert accumulator.n_used == 3 and same_plane(accumulator.snapshot(), before)

    # El acumulador sigue sirviendo.
    accumulator.add(exposure(1.0, 1.0, SOURCE, grid=SMALL))
    assert accumulator.n_used == 4 and not same_plane(accumulator.snapshot(), before)


# --------------------------------------------------------------- entradas malas


def test_exposure_of_another_shape_is_rejected() -> None:
    accumulator = PlaneAccumulator(SMALL, 2)
    accumulator.add(exposure(1.0, 1.0, grid=SMALL))
    before = accumulator.snapshot()
    with pytest.raises(ValueError, match="forma"):
        accumulator.add(exposure(1.0, 1.0, grid=PIXEL))
    wrong = exposure(1.0, 1.0, grid=SMALL)
    wrong.footprint = np.ones((23, 22), dtype=bool)
    with pytest.raises(ValueError, match="footprint"):
        accumulator.add(wrong)
    floating = exposure(1.0, 1.0, grid=SMALL)
    floating.flags = floating.flags.astype(np.float32)  # type: ignore[assignment]
    with pytest.raises(ValueError, match="enteros"):
        accumulator.add(floating)
    assert accumulator.n_used == 1 and same_plane(accumulator.snapshot(), before)


@pytest.mark.parametrize("n_exposures", [-1, MAX_EXPOSURES + 1, 2.5, "3", True, None])
def test_n_exposures_has_to_be_a_count(n_exposures: Any) -> None:
    with pytest.raises(ValueError, match="n_exposures"):
        PlaneAccumulator(PIXEL, n_exposures)


def test_n_exposures_is_what_the_plane_expects_not_a_limit() -> None:
    """Una segunda pasada puede traer recortes que se habian dado por perdidos."""
    assert MAX_EXPOSURES == 65535
    accumulator = PlaneAccumulator(PIXEL, np.int64(1))  # type: ignore[arg-type]
    accumulator.add(exposure(1.0, 1.0))
    accumulator.add(exposure(3.0, 1.0))
    assert (accumulator.n_exposures, accumulator.n_used) == (1, 2)
    assert float(accumulator.snapshot().image[0, 0]) == pytest.approx(2.0)


def test_coverage_cannot_overflow(monkeypatch: pytest.MonkeyPatch) -> None:
    """La cobertura es Uint16: el acumulador no acepta mas exposiciones de las que puede contar."""
    monkeypatch.setattr(coadd, "MAX_EXPOSURES", 2)
    accumulator = PlaneAccumulator(PIXEL, 2)
    accumulator.add(exposure(1.0, 1.0))
    accumulator.add(exposure(1.0, 1.0))
    with pytest.raises(ValueError, match="Uint16"):
        accumulator.add(exposure(1.0, 1.0))
    assert accumulator.n_used == 2 and int(accumulator.snapshot().coverage[0, 0]) == 2


def test_flags_stored_as_signed_integers_are_accepted() -> None:
    """Un arreglo int32 con el bit 31 encendido es negativo: se cuenta el bit, no el signo."""
    table = {**BITS, "PRUEBA_31": 31}
    item = exposure(1.0, 1.0, bits=table)
    item.flags = np.full(PIXEL.shape, -(2**31) | SOURCE, dtype=np.int32)  # type: ignore[assignment]
    _, flags, _ = pixel(item)
    assert flags == (1 << 31) | SOURCE


def test_weights_use_the_variance_of_each_pixel() -> None:
    """Dos exposiciones con ruido distinto por pixel: cada pixel pesa segun su propia varianza."""
    shape = SMALL.shape
    rows, columns = np.indices(shape)
    variance_a = 0.5 + 0.1 * rows
    variance_b = 2.0 + 0.3 * columns
    plane = accumulate(exposure(1.0, variance_a, grid=SMALL), exposure(5.0, variance_b, grid=SMALL), grid=SMALL)
    expected = (1.0 / variance_a + 5.0 / variance_b) / (1.0 / variance_a + 1.0 / variance_b)
    np.testing.assert_allclose(plane.image, expected, rtol=1e-5)
    assert (plane.coverage == 2).all()
