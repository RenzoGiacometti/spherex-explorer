"""Limite global hacia IRSA: nunca mas de 10 descargas de recortes ni de 2 consultas SIA2 a la vez."""

from __future__ import annotations

import threading
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import AbstractContextManager

import pytest

from app.config import Settings
from app.irsa import limits
from app.irsa.limits import IrsaLimiter, get_limiter, reset_limiter


@pytest.fixture(autouse=True)
def _fresh_limiter() -> Iterator[None]:
    reset_limiter()
    yield
    reset_limiter()


def run_in_slots(slot: Callable[[], AbstractContextManager[None]], threads: int, expected: int) -> int:
    """Corre `threads` hilos que ocupan un lugar cada uno y devuelve cuantos llegaron a estar adentro a la vez.

    Adentro, cada hilo espera en una barrera de `expected` lugares: si el
    limitador dejara pasar menos, la barrera no se completaria y el test
    fallaria por tiempo. `threads` tiene que ser multiplo de `expected`.
    """
    assert threads % expected == 0
    barrier = threading.Barrier(expected, timeout=10.0)
    lock = threading.Lock()
    inside = 0
    peak = 0

    def work() -> None:
        nonlocal inside, peak
        with slot():
            with lock:
                inside += 1
                peak = max(peak, inside)
            try:
                barrier.wait()
            finally:
                with lock:
                    inside -= 1

    with ThreadPoolExecutor(max_workers=threads) as pool:
        for future in [pool.submit(work) for _ in range(threads)]:
            future.result(timeout=30.0)
    return peak


def test_never_more_than_ten_cutouts_at_once() -> None:
    limiter = IrsaLimiter()
    assert (limiter.max_cutouts, limiter.max_sia) == (10, 2)
    assert run_in_slots(limiter.cutout_slot, threads=60, expected=10) == 10
    assert limiter.cutouts_in_flight == 0


def test_never_more_than_two_sia_queries_at_once() -> None:
    limiter = IrsaLimiter()
    assert run_in_slots(limiter.sia_slot, threads=24, expected=2) == 2
    assert limiter.sia_in_flight == 0


@pytest.mark.parametrize("asked", [11, 50, 10_000])
def test_cutout_quota_is_capped_at_ten(asked: int) -> None:
    limiter = IrsaLimiter(max_cutouts=asked, max_sia=2)
    assert limiter.max_cutouts == 10
    assert run_in_slots(limiter.cutout_slot, threads=40, expected=10) == 10


def test_smaller_quotas_are_respected() -> None:
    limiter = IrsaLimiter(max_cutouts=3, max_sia=1)
    assert run_in_slots(limiter.cutout_slot, threads=30, expected=3) == 3
    assert run_in_slots(limiter.sia_slot, threads=8, expected=1) == 1
    # Un cupo de cero o negativo dejaria todo bloqueado: queda en uno.
    assert IrsaLimiter(max_cutouts=0, max_sia=-2).max_cutouts == 1
    assert IrsaLimiter(max_cutouts=0, max_sia=-2).max_sia == 1


def test_in_flight_counts_what_is_inside() -> None:
    limiter = IrsaLimiter(max_cutouts=4)
    assert limiter.cutouts_in_flight == 0
    with limiter.cutout_slot():
        assert limiter.cutouts_in_flight == 1
        with limiter.cutout_slot(), limiter.sia_slot():
            assert (limiter.cutouts_in_flight, limiter.sia_in_flight) == (2, 1)
        assert (limiter.cutouts_in_flight, limiter.sia_in_flight) == (1, 0)
    assert limiter.cutouts_in_flight == 0


def test_a_slot_is_released_when_the_download_fails() -> None:
    limiter = IrsaLimiter(max_cutouts=1, max_sia=1)
    for slot in (limiter.cutout_slot, limiter.sia_slot):
        with pytest.raises(RuntimeError), slot():
            raise RuntimeError("corte de conexion")
        # Si el lugar no se hubiera devuelto, esto quedaria esperando para siempre.
        with slot():
            pass
    assert (limiter.cutouts_in_flight, limiter.sia_in_flight) == (0, 0)


def test_cutouts_and_sia_do_not_share_the_quota() -> None:
    limiter = IrsaLimiter(max_cutouts=2, max_sia=1)
    with limiter.cutout_slot(), limiter.cutout_slot():
        # Con los dos lugares de recortes ocupados, la consulta SIA2 entra igual.
        with limiter.sia_slot():
            assert (limiter.cutouts_in_flight, limiter.sia_in_flight) == (2, 1)


def test_a_full_quota_makes_the_next_one_wait() -> None:
    limiter = IrsaLimiter(max_cutouts=1)
    entered = threading.Event()

    def second() -> None:
        with limiter.cutout_slot():
            entered.set()

    with limiter.cutout_slot():
        thread = threading.Thread(target=second)
        thread.start()
        assert not entered.wait(0.2)  # sigue esperando su lugar
    assert entered.wait(5.0)
    thread.join(5.0)


def test_get_limiter_is_one_per_process() -> None:
    first = get_limiter(Settings())
    assert (first.max_cutouts, first.max_sia) == (10, 2)
    # Otra configuracion no crea otro limitador: el limite es del proceso.
    assert get_limiter(Settings(max_cutout_downloads=3, max_sia_queries=1)) is first

    with ThreadPoolExecutor(max_workers=16) as pool:
        seen = list(pool.map(lambda _: get_limiter(Settings()), range(64)))
    assert all(item is first for item in seen)


def test_get_limiter_takes_the_quotas_of_the_first_settings() -> None:
    limiter = get_limiter(Settings(max_cutout_downloads=4, max_sia_queries=1))
    assert (limiter.max_cutouts, limiter.max_sia) == (4, 1)
    reset_limiter()
    # La configuracion ya recorta el pedido a 10; el limitador tambien, por si alguien lo crea a mano.
    assert get_limiter(Settings(max_cutout_downloads=50)).max_cutouts == 10
    assert limits.IRSA_MAX_PARALLEL_DOWNLOADS == 10


def test_first_call_from_many_threads_creates_a_single_limiter() -> None:
    barrier = threading.Barrier(16, timeout=10.0)

    def first_call(_: int) -> IrsaLimiter:
        barrier.wait()
        return get_limiter(Settings())

    with ThreadPoolExecutor(max_workers=16) as pool:
        seen = list(pool.map(first_call, range(16)))
    assert len({id(item) for item in seen}) == 1
