"""Piezas puras del gestor de trabajos: orden de descarga, reintentos y partes del documento."""

from __future__ import annotations

import math

import pytest
from test_jobs_support import make_exposures

from app import geometry
from app.config import Settings
from app.contract import PlaneInfo, SaturatedRegion
from app.domain import EpochSummary, Exposure
from app.irsa.cutouts import IrsaBusy, IrsaError, IrsaPermanent, IrsaTransient
from app.jobs.document import (
    NOMINAL_WAVE_RANGE_UM,
    detector_infos,
    epoch_infos,
    iso_date,
    parse_timestamp,
    same_source,
    saturated_sources,
)
from app.jobs.plan import (
    SECOND_PASS_ATTEMPTS,
    TRANSIENT_WAIT_MAX_S,
    CutoutTask,
    GiveUp,
    Retry,
    TaskQueue,
    after_failure,
    band_order,
    task_order,
)

SETTINGS = Settings()


def tasks_for(counts: dict[tuple[int, int], int], budget: int = 6) -> list[CutoutTask]:
    tasks: list[CutoutTask] = []
    for index, exposure in enumerate(make_exposures(counts)):
        epoch, rest = exposure.obs_id[1:].split("D")
        order = int(rest.split("N")[1])
        tasks.append(
            CutoutTask(
                job=None,
                index=index,
                exposure=exposure,
                key=(int(epoch), exposure.detector),
                order=order,
                budget=budget,
            )
        )
    return tasks


def drain(queue: TaskQueue, now: float = 0.0) -> list[str]:
    names: list[str] = []
    while (task := queue.pop_ready(now)) is not None:
        names.append(task.exposure.obs_id)
    return names


# -------------------------------------------------------------------- orden


@pytest.mark.parametrize(
    ("band", "expected"),
    [
        (1, [1, 2, 3, 4, 5, 6]),
        (3, [3, 2, 4, 1, 5, 6]),
        (4, [4, 3, 5, 2, 6, 1]),
        (6, [6, 5, 4, 3, 2, 1]),
    ],
)
def test_band_order_goes_from_the_nearest_to_the_farthest(band: int, expected: list[int]) -> None:
    assert band_order(band) == expected


def test_the_requested_band_goes_first_with_its_epochs_taking_turns() -> None:
    queue = TaskQueue(band=3)
    queue.add(tasks_for({(1, 3): 3, (2, 3): 2, (3, 3): 3, (1, 2): 1, (2, 4): 2, (1, 6): 1, (2, 1): 1}))
    assert drain(queue) == [
        # Banda pedida: el primero de cada epoca, despues el segundo de cada una...
        "E1D3N0", "E2D3N0", "E3D3N0", "E1D3N1", "E2D3N1", "E3D3N1", "E1D3N2", "E3D3N2",
        # ...y las demas bandas, de la mas cercana a la mas lejana.
        "E1D2N0", "E2D4N0", "E2D4N1", "E2D1N0", "E1D6N0",
    ]  # fmt: skip
    assert len(queue) == 0


def test_every_band_shares_out_its_epochs() -> None:
    queue = TaskQueue(band=6)
    queue.add(tasks_for({(1, 5): 2, (2, 5): 2, (1, 6): 1}))
    assert drain(queue) == ["E1D6N0", "E1D5N0", "E2D5N0", "E1D5N1", "E2D5N1"]


def test_reprioritize_reorders_what_is_pending() -> None:
    queue = TaskQueue(band=3)
    queue.add(tasks_for({(1, 3): 2, (1, 5): 2, (1, 6): 1}))
    first = queue.pop_ready(0.0)
    assert first is not None and first.exposure.obs_id == "E1D3N0"
    queue.reprioritize(6)
    assert queue.band == 6
    assert drain(queue) == ["E1D6N0", "E1D5N0", "E1D5N1", "E1D3N1"]


def test_a_waiting_task_does_not_hold_back_the_ones_behind_it() -> None:
    queue = TaskQueue(band=3)
    tasks = tasks_for({(1, 3): 3})
    tasks[0].not_before = 105.0
    tasks[1].not_before = 101.0
    queue.add(tasks)
    assert queue.next_due() == 0.0
    assert drain(queue, now=100.0) == ["E1D3N2"]
    assert queue.pop_ready(100.0) is None and len(queue) == 2
    assert queue.next_due() == 101.0
    assert drain(queue, now=101.0) == ["E1D3N1"]
    assert drain(queue, now=105.0) == ["E1D3N0"]
    assert queue.next_due() is None


def test_a_task_that_comes_back_keeps_its_place_in_the_order() -> None:
    queue = TaskQueue(band=3)
    tasks = tasks_for({(1, 3): 2, (1, 4): 2})
    queue.add(tasks)
    first = queue.pop_ready(0.0)
    assert first is not None
    queue.add([first])  # vuelve para reintentar
    assert drain(queue) == ["E1D3N0", "E1D3N1", "E1D4N0", "E1D4N1"]


def test_task_order_key() -> None:
    task = tasks_for({(2, 5): 3})[2]
    assert task_order(3)(task) == (2, 5, 2, 2)
    assert task_order(5)(task) == (0, 5, 2, 2)


def test_clear_empties_the_queue() -> None:
    queue = TaskQueue(band=1)
    queue.add(tasks_for({(1, 1): 4}))
    queue.clear()
    assert len(queue) == 0 and queue.pop_ready(0.0) is None


# ---------------------------------------------------------------- reintentos


def failed(attempts: int, budget: int = 6) -> CutoutTask:
    task = tasks_for({(1, 3): 1}, budget=budget)[0]
    task.attempts = attempts
    return task


def test_busy_waits_what_irsa_asked() -> None:
    decision = after_failure(failed(1), IrsaBusy("503", retry_after=5.0, requested=5.0), SETTINGS)
    assert decision == Retry(5.0)
    # Sin cabecera `Retry-After` vale la espera que ya trae la excepcion.
    assert after_failure(failed(2), IrsaBusy("503", retry_after=5.0), SETTINGS) == Retry(5.0)
    # Justo el maximo todavia se respeta.
    assert after_failure(failed(1), IrsaBusy("503", retry_after=60.0, requested=60.0), SETTINGS) == Retry(60.0)


def test_busy_asking_for_more_than_the_maximum_gives_up_without_insisting() -> None:
    error = IrsaBusy("503", retry_after=60.0, requested=3600.0)
    assert after_failure(failed(1), error, SETTINGS) == GiveUp("busy_too_long")
    shorter = Settings(irsa_retry_after_max_s=10.0)
    assert after_failure(failed(1), IrsaBusy("503", retry_after=10.0, requested=11.0), shorter) == GiveUp(
        "busy_too_long"
    )


def test_transient_failures_retry_after_a_short_growing_wait() -> None:
    waits = [after_failure(failed(attempt), IrsaTransient("corte"), SETTINGS) for attempt in range(1, 6)]
    assert waits == [Retry(1.0), Retry(2.0), Retry(3.0), Retry(4.0), Retry(5.0)]
    long_budget = after_failure(failed(40, budget=100), IrsaTransient("corte"), SETTINGS)
    assert long_budget == Retry(TRANSIENT_WAIT_MAX_S)


@pytest.mark.parametrize("error", [IrsaTransient("corte"), IrsaBusy("503", retry_after=5.0), IrsaError("otra")])
def test_the_budget_ends_the_retries(error: Exception) -> None:
    assert isinstance(after_failure(failed(5), error, SETTINGS), Retry)
    assert after_failure(failed(6), error, SETTINGS) == GiveUp("transient")
    assert after_failure(failed(SECOND_PASS_ATTEMPTS, budget=SECOND_PASS_ATTEMPTS), error, SETTINGS) == GiveUp(
        "transient"
    )


def test_permanent_failures_are_not_retried() -> None:
    assert after_failure(failed(1), IrsaPermanent("HTTP 422: Arrays do not overlap."), SETTINGS) == GiveUp("permanent")


def test_an_unexpected_error_counts_as_transient() -> None:
    assert after_failure(failed(1), RuntimeError("inesperado"), SETTINGS) == Retry(1.0)


def test_restart_gives_a_fresh_budget() -> None:
    task = failed(6)
    task.not_before = 99.0
    task.restart(SECOND_PASS_ATTEMPTS, second_pass=True)
    assert (task.attempts, task.budget, task.not_before, task.second_pass) == (0, SECOND_PASS_ATTEMPTS, 0.0, True)
    task.attempts = 1
    task.restart(4)
    assert (task.attempts, task.budget, task.second_pass) == (0, 4, True)


# ----------------------------------------------------------------- documento


def test_iso_date_of_an_mjd() -> None:
    # Fechas de las muestras: la epoca 1 de Barnard va del 2025-08-15 al 2025-10-01.
    assert iso_date(60902.86) == "2025-08-15"
    assert iso_date(60949.31) == "2025-10-01"
    assert iso_date(51544.0) == "2000-01-01"
    assert iso_date(51544.99999) == "2000-01-01"


def test_parse_timestamp() -> None:
    moment = parse_timestamp("2026-11-15T06:21:10Z")
    assert moment is not None and moment.isoformat() == "2026-11-15T06:21:10+00:00"
    assert parse_timestamp("ayer") is None and parse_timestamp("") is None


def test_epoch_infos() -> None:
    summaries = [
        EpochSummary(epoch=1, mjd_start=60902.864715, mjd_end=60949.310001, mjd_mean=60914.9000049, n_exposures=118),
        EpochSummary(epoch=2, mjd_start=61110.2, mjd_end=61110.2, mjd_mean=61110.2, n_exposures=1),
    ]
    first, second = epoch_infos(summaries)
    assert first.model_dump() == {
        "epoch": 1,
        "start": "2025-08-15",
        "end": "2025-10-01",
        "mjd_start": 60902.86472,
        "mjd_end": 60949.31,
        "mjd_mean": 60914.9,
        "n_exposures": 118,
    }
    assert (second.start, second.end, second.n_exposures) == ("2026-03-11", "2026-03-11", 1)


def test_detector_infos_use_the_real_range_of_the_exposures() -> None:
    def exposure(detector: int, low: float, high: float) -> Exposure:
        return Exposure("obs", "spherex_dr1", detector, 60900.0, 60900.1, "http://x", low, high)

    infos = detector_infos([exposure(3, 1.63012, 2.4346), exposure(3, 1.6299, 2.43449), exposure(6, 4.4115, 5.0096)])
    assert [info.detector for info in infos] == [1, 2, 3, 4, 5, 6]
    assert (infos[2].wave_min_um, infos[2].wave_max_um) == (1.6299, 2.4346)
    assert (infos[5].wave_min_um, infos[5].wave_max_um) == (4.4115, 5.0096)
    # Un detector sin exposiciones en el campo lleva el rango de SPEC.md.
    assert (infos[0].wave_min_um, infos[0].wave_max_um) == NOMINAL_WAVE_RANGE_UM[1]
    assert all(info.display is None for info in infos)


def test_nominal_ranges_match_the_saved_sia_responses() -> None:
    """Los rangos de respaldo son los que informa IRSA: se comparan con una lista real guardada."""
    from test_irsa_support import SIA_DIR

    from app.irsa.sia import parse_exposures

    payload = (SIA_DIR / "spherex_dr1__269.446287_+4.768255.xml").read_bytes()
    infos = detector_infos(parse_exposures(payload, "spherex_dr1"))
    for info in infos:
        low, high = NOMINAL_WAVE_RANGE_UM[info.detector]
        assert math.isclose(info.wave_min_um, low, abs_tol=0.006), info
        assert math.isclose(info.wave_max_um, high, abs_tol=0.006), info


def plane(epoch: int, detector: int, *regions: tuple[float, float, float]) -> PlaneInfo:
    return PlaneInfo(
        epoch=epoch,
        detector=detector,
        status="ready",
        rev=2,
        saturated=[
            SaturatedRegion(x=x, y=y, radius_px=radius, n_pixels=round(math.pi * radius**2)) for x, y, radius in regions
        ],
    )


def test_saturated_regions_of_the_same_star_are_one_source() -> None:
    grid = geometry.make_grid(269.4463, 4.7683, 0.1667, 3.075)
    planes = [
        plane(1, 3, (97.0, 97.0, 4.6)),
        plane(1, 6, (97.4, 96.8, 3.0)),
        # La estrella se corre un par de pixeles entre epocas (movimiento propio).
        plane(2, 3, (97.2, 99.0, 4.0)),
        plane(2, 4),
    ]
    (warning,) = saturated_sources(grid, planes)
    assert warning.code == "saturated_source"
    assert warning.epochs == [1, 2] and warning.detectors == [3, 6]
    assert warning.radius_arcsec == round(4.6 * 3.075, 1)
    x, y = geometry.sky_to_pixel(grid, warning.ra, warning.dec)
    assert math.isclose(x, (97.0 + 97.4 + 97.2) / 3, abs_tol=0.02)
    assert math.isclose(y, (97.0 + 96.8 + 99.0) / 3, abs_tol=0.02)


def test_saturated_sources_far_apart_stay_separate() -> None:
    grid = geometry.make_grid(10.0, 20.0, 0.1667, 3.075)
    planes = [plane(1, 3, (97.0, 97.0, 4.0), (30.0, 150.0, 2.0)), plane(2, 3, (30.5, 150.2, 2.5))]
    first, second = saturated_sources(grid, planes)
    assert (first.epochs, first.detectors) == ([1], [3])
    assert (second.epochs, second.detectors) == ([1, 2], [3])
    assert not same_source(first, second)
    assert same_source(second, second)
    assert saturated_sources(grid, [plane(1, 1), plane(1, 2)]) == []


def test_saturated_sources_do_not_depend_on_the_order_of_the_planes() -> None:
    grid = geometry.make_grid(10.0, 20.0, 0.1667, 3.075)
    planes = [plane(2, 6, (97.0, 98.0, 3.0)), plane(1, 3, (97.5, 97.0, 4.0)), plane(1, 6, (96.5, 97.5, 2.0))]
    assert saturated_sources(grid, planes) == saturated_sources(grid, list(reversed(planes)))
