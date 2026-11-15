"""El gestor de trabajos con varios pedidos a la vez: cola, limite compartido, suscriptores, campos ya
terminados, `refresh`, reinicio y detencion."""

from __future__ import annotations

import asyncio
import gc
import itertools
import shutil
import threading
from collections.abc import AsyncIterator, Callable, Iterator
from pathlib import Path

import pytest
from test_jobs_support import (
    SHAPE,
    HarnessFactory,
    expected_plane,
    harness_factory,
    make_exposures,
    manager_threads,
    planes_of,
    replay,
    validate_events,
    wait_until,
)

from app.api.errors import ApiError
from app.contract import FieldMeta
from app.irsa.cutouts import IrsaPermanent
from app.jobs.events import FieldEvent


@pytest.fixture
def build(tmp_path: Path) -> Iterator[HarnessFactory]:
    with harness_factory(tmp_path) as factory:
        yield factory


def assert_followed(delivered: list[FieldEvent], recorded: list[FieldEvent], state: FieldEvent) -> None:
    """Lo que recibio un suscriptor despues de `state` es lo publicado desde entonces, en orden.

    `state` es el documento armado al conectar y lleva el id del ultimo evento
    previo. Lo unico que puede faltar es un `progress` al que le siguio otro
    antes de que el suscriptor lo leyera: el bus se queda con el mas nuevo.
    """
    expected = [event for event in recorded if event.id > state.id]
    received = {event.id for event in delivered}
    assert delivered == [event for event in expected if event.id in received]
    for position, event in enumerate(expected):
        if event.id not in received:
            assert event.event == "progress" and expected[position + 1].event == "progress", event
    assert [event for event in delivered if event.event != "progress"] == [
        event for event in expected if event.event != "progress"
    ]


async def collect(stream: AsyncIterator[FieldEvent], timeout: float = 20.0) -> list[FieldEvent]:
    """Todo lo que entrega el flujo hasta que el servidor lo cierra."""
    events: list[FieldEvent] = []
    async with asyncio.timeout(timeout):
        async for event in stream:
            events.append(event)
    return events


async def until(condition: Callable[[], bool], timeout: float = 20.0) -> None:
    """`wait_until` sin frenar el bucle de asyncio."""
    await asyncio.to_thread(wait_until, condition, timeout)


# ------------------------------------------------------------ limite y turnos


def test_two_active_jobs_never_exceed_ten_downloads(build: HarnessFactory) -> None:
    harness = build({(1, 3): 30, (2, 3): 30})
    harness.irsa.gate = threading.Event()  # las descargas quedan retenidas: se ve cuantas hay a la vez
    first, second = harness.request(10.0, 20.0), harness.request(50.0, -30.0)
    harness.manager.submit(first)
    harness.manager.submit(second)
    # Los dos trabajos activos, con todos sus recortes en la cola, y las diez conexiones ocupadas.
    wait_until(lambda: sum(harness.manager.queue_state().pending_cutouts.values()) == 110)
    state = harness.manager.queue_state()
    assert set(state.active) == {first.field_id, second.field_id} and state.waiting == ()
    assert harness.irsa.active == 10 and len(harness.irsa.calls) == 10
    wait_until(lambda: len(manager_threads()) == 10 + 2)  # diez de descarga y uno por trabajo
    harness.irsa.crowd = 10  # desde aca cada descarga espera a que haya diez a la vez: si se pudiera pasar, se veria
    harness.irsa.gate.set()
    assert harness.manager.wait_idle(60.0)
    assert harness.irsa.max_active == 10  # ni una mas, sumando los dos trabajos
    assert len(harness.irsa.calls) == 120
    assert harness.manager.get_meta(first.field_id).status == "ready"
    assert harness.manager.get_meta(second.field_id).status == "ready"
    # Con los dos esperando recortes, las conexiones se reparten: ninguno espera a que termine el otro.
    window = harness.irsa.centers[10:70]
    share = window.count((first.ra, first.dec))
    assert 20 <= share <= 40, share


def test_two_active_jobs_take_turns(build: HarnessFactory) -> None:
    harness = build({(1, 3): 12}, max_cutout_downloads=1)
    harness.irsa.gate = threading.Event()
    first, second = harness.request(10.0, 20.0), harness.request(50.0, -30.0)
    harness.manager.submit(first)
    harness.manager.submit(second)
    # La unica conexion esta ocupada con un recorte y los otros 23 esperan, de los dos trabajos.
    wait_until(lambda: sum(harness.manager.queue_state().pending_cutouts.values()) == 23)
    harness.irsa.gate.set()
    assert harness.manager.wait_idle(30.0)
    centers = harness.irsa.centers
    assert len(centers) == 24 and centers.count((first.ra, first.dec)) == 12
    # La conexion va una vez a cada uno, hasta el final.
    assert all(one != two for one, two in itertools.pairwise(centers))


def test_only_the_ready_tasks_of_each_job_take_a_turn(build: HarnessFactory) -> None:
    """Un trabajo con todo en espera de `Retry-After` no le saca turnos al otro ni lo frena."""
    from app.irsa.cutouts import IrsaBusy

    harness = build({(1, 3): 4}, auto_clock=False, max_cutout_downloads=1)
    harness.irsa.list_gate = threading.Event()
    first, second = harness.request(10.0, 20.0), harness.request(50.0, -30.0)
    busy = {"count": 0}

    def on_call(exposure: object) -> None:
        # Los cuatro recortes del primer campo que llegue reciben un 503 la primera vez.
        if busy["count"] < 4 and harness.irsa.centers[-1] == (first.ra, first.dec):
            busy["count"] += 1
            raise IrsaBusy("HTTP 503", retry_after=5.0, requested=5.0)

    harness.irsa.on_call = on_call
    harness.manager.submit(first)
    harness.manager.submit(second)
    wait_until(lambda: len(harness.irsa.list_calls) == 2)
    harness.irsa.list_gate.set()
    wait_until(lambda: harness.manager.get_meta(second.field_id).status == "ready")
    assert harness.manager.get_meta(first.field_id).progress.cutouts_done == 0
    harness.clock.advance(5.1)
    assert harness.manager.wait_idle(30.0)
    assert harness.manager.get_meta(first.field_id).status == "ready"


# ------------------------------------------------------------------------ cola


def test_jobs_wait_in_line_and_a_full_queue_is_refused(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2}, max_active_jobs=1, max_queued_jobs=2)
    harness.irsa.list_gate = threading.Event()
    requests = [harness.request(10.0 * (index + 1), 5.0) for index in range(4)]
    a, b, c, d = requests
    metas = [harness.manager.submit(request) for request in (a, b, c)]
    assert [meta.status for meta in metas] == ["queued", "queued", "queued"]
    assert [meta.progress.queue_position for meta in metas] == [1, 1, 2]
    wait_until(lambda: harness.manager.get_meta(a.field_id).status == "listing")
    assert harness.manager.get_meta(a.field_id).progress.queue_position == 0
    assert harness.manager.get_meta(c.field_id).progress.queue_position == 2

    with pytest.raises(ApiError) as full:
        harness.manager.submit(d)
    assert (full.value.code, full.value.http_status, full.value.retryable) == ("queue_full", 429, True)
    assert full.value.headers() == {"Retry-After": "30"}
    with pytest.raises(ApiError):
        harness.manager.get_meta(d.field_id)  # no se creo nada
    # Un pedido de un campo que ya esta en la cola no ocupa otro lugar.
    assert harness.manager.submit(c).progress.queue_position == 2

    harness.irsa.list_gate.set()
    assert harness.manager.wait_idle(30.0)
    assert [harness.manager.get_meta(request.field_id).status for request in (a, b, c)] == ["ready"] * 3
    for request in (a, b, c):
        validate_events(harness.bus.of(request.field_id))
    # Posiciones: el evento `queued` sale al entrar y cada vez que cambia.
    assert [event.data for event in harness.bus.all_of(a.field_id, "queued")] == [{"position": 1}]
    assert [event.data for event in harness.bus.all_of(b.field_id, "queued")] == [{"position": 1}]
    assert [event.data for event in harness.bus.all_of(c.field_id, "queued")] == [{"position": 2}, {"position": 1}]
    assert harness.bus.names(c.field_id)[:4] == ["state", "queued", "queued", "progress"]
    assert harness.bus.of(c.field_id)[0].data["progress"]["queue_position"] == 2
    # Por orden de llegada, y de a uno: cada trabajo empieza cuando termino el anterior.
    log = harness.bus.log
    finished = {request.field_id: log.index((request.field_id, "done")) for request in (a, b, c)}
    started = {request.field_id: log.index((request.field_id, "progress")) for request in (a, b, c)}
    assert finished[a.field_id] < started[b.field_id] < finished[b.field_id] < started[c.field_id]
    # Con lugar otra vez, el pedido rechazado entra.
    assert harness.manager.submit(d).status == "queued"
    assert harness.manager.wait_idle(30.0)


def test_the_same_field_requested_twice_shares_one_job(build: HarnessFactory) -> None:
    harness = build({(1, 3): 3}, max_active_jobs=1)
    harness.irsa.list_gate = threading.Event()
    blocker, request = harness.request(80.0, 10.0), harness.request()
    harness.manager.submit(blocker)
    first = harness.manager.submit(request)
    again = harness.manager.submit(request)  # todavia en la cola
    assert (first.id, first.status) == (again.id, "queued") and again.progress.queue_position == 1
    wait_until(lambda: len(harness.irsa.list_calls) == 1)
    harness.irsa.list_gate.set()
    wait_until(lambda: harness.manager.get_meta(request.field_id).status in ("downloading", "ready"))
    harness.manager.submit(request)  # ya en curso, o recien terminado
    assert harness.manager.wait_idle(30.0)
    assert len(harness.irsa.list_calls) == 2  # uno por campo
    names = harness.bus.names(request.field_id)
    assert names.count("done") == 1 and names.count("listed") == 1
    assert [event.id for event in harness.bus.of(request.field_id)] == list(range(1, len(names) + 1))


def test_zero_queue_places_still_allow_the_active_jobs(build: HarnessFactory) -> None:
    harness = build({(1, 3): 1}, max_active_jobs=2, max_queued_jobs=0)
    harness.irsa.list_gate = threading.Event()
    harness.manager.submit(harness.request(10.0, 0.0))
    harness.manager.submit(harness.request(20.0, 0.0))
    with pytest.raises(ApiError) as full:
        harness.manager.submit(harness.request(30.0, 0.0))
    assert full.value.code == "queue_full"
    harness.irsa.list_gate.set()
    assert harness.manager.wait_idle(30.0)


# ---------------------------------------------------------------- suscriptores


async def test_a_subscriber_from_the_start_follows_the_whole_job(build: HarnessFactory) -> None:
    harness = build({(1, 3): 3, (2, 3): 2})
    harness.irsa.list_gate = threading.Event()
    request = harness.request()
    harness.manager.submit(request)
    await until(lambda: len(harness.irsa.list_calls) == 1 and "preview" in harness.bus.names(request.field_id))
    stream = harness.manager.subscribe(request.field_id)
    harness.irsa.list_gate.set()
    events = await collect(stream)
    validate_events(events)
    recorded = harness.bus.of(request.field_id)
    # Primero `state`, con el documento de ese momento; despues, lo mismo que se publico.
    assert events[0].event == "state" and events[0].id == 4  # state, queued, progress y preview ya habian salido
    first = FieldMeta.model_validate(events[0].data)
    assert (first.status, first.progress.phase, first.preview.status) == ("listing", "listing", "ready")
    assert_followed(events[1:], recorded, events[0])
    assert len(events) > 8
    assert [event.event for event in events[-2:]] == ["state", "done"]
    assert replay(events) == recorded[-2].data
    assert harness.bus.subscriber_count(request.field_id) == 0


async def test_a_late_subscriber_gets_state_and_then_only_what_is_new(build: HarnessFactory) -> None:
    harness = build({(1, 3): 4, (2, 3): 4}, max_cutout_downloads=1)
    harness.irsa.hold_after = 3
    request = harness.request()
    harness.manager.submit(request)

    def halfway() -> bool:
        plane = harness.manager.get_meta(request.field_id).plane(1, 3)
        return plane is not None and plane.status == "building" and len(harness.irsa.calls) == 4

    await until(halfway)
    stream = harness.manager.subscribe(request.field_id)
    harness.irsa.resume.set()
    events = await collect(stream)
    recorded = harness.bus.of(request.field_id)
    state = FieldMeta.model_validate(events[0].data)
    assert events[0].event == "state" and events[0].id >= 8
    assert state.status == "downloading" and state.progress.cutouts_done == 3
    plane = state.plane(1, 3)
    assert plane is not None and (plane.status, plane.rev, plane.n_used) == ("building", 1, 2)
    assert state.flags and state.detectors is not None and state.detectors[2].display is not None
    # Sin repeticion de lo anterior: solo lo publicado despues de conectar.
    assert_followed(events[1:], recorded, events[0])
    assert len(events) > 5
    assert "listed" not in [event.event for event in events]
    assert [event.id for event in events] == sorted(event.id for event in events)
    assert replay(events) == recorded[-2].data


async def test_a_subscriber_of_a_finished_field_gets_state_and_done(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2})
    request = harness.request()
    final = await asyncio.to_thread(harness.run, request)
    events = await collect(harness.manager.subscribe(request.field_id))
    validate_events(events)
    assert [(event.id, event.event) for event in events] == [(1, "state"), (2, "done")]
    assert FieldMeta.model_validate(events[0].data) == final
    assert events[1].data == {"status": "ready", "rev": 1, "elapsed_s": final.progress.elapsed_s}


async def test_a_subscriber_of_a_failed_job_gets_state_and_error(build: HarnessFactory) -> None:
    harness = build({})
    request = harness.request()
    await asyncio.to_thread(harness.run, request)
    published = harness.bus.last(request.field_id, "error")
    events = await collect(harness.manager.subscribe(request.field_id))
    validate_events(events)
    assert [event.event for event in events] == ["state", "error"]
    assert events[0].data["status"] == "failed" and events[1].data == published.data
    assert events[0].id < events[1].id


def test_subscribing_to_an_unknown_field_fails_at_once(build: HarnessFactory) -> None:
    harness = build({(1, 3): 1})
    # La ruta tiene que poder responder 404 antes de abrir el flujo: el error sale al llamar.
    with pytest.raises(ApiError) as missing:
        harness.manager.subscribe("0000000000000000")
    assert missing.value.code == "not_found"
    with pytest.raises(ApiError):
        harness.manager.get_meta("0000000000000000")


async def test_a_subscriber_that_leaves_does_not_stop_the_job(build: HarnessFactory) -> None:
    harness = build({(1, 3): 4}, max_cutout_downloads=1)
    harness.irsa.gate = threading.Event()
    request = harness.request()
    harness.manager.submit(request)
    await until(lambda: len(harness.irsa.calls) == 1)
    gone = harness.manager.subscribe(request.field_id)
    assert (await anext(gone)).event == "state"

    async def like_a_route(stream: AsyncIterator[FieldEvent]) -> None:
        try:
            async for _ in stream:
                pass
        finally:
            await stream.aclose()  # type: ignore[attr-defined]

    waiting = asyncio.ensure_future(like_a_route(harness.manager.subscribe(request.field_id)))
    never_read = harness.manager.subscribe(request.field_id)
    await asyncio.sleep(0.01)
    assert harness.bus.subscriber_count(request.field_id) == 3
    await gone.aclose()  # type: ignore[attr-defined]  # cerro la pestania
    with pytest.raises(StopAsyncIteration):
        await anext(gone)
    waiting.cancel()  # se corto la conexion mientras esperaba el proximo evento
    with pytest.raises(asyncio.CancelledError):
        await waiting
    assert harness.bus.subscriber_count(request.field_id) == 1
    del never_read  # ni se llego a leer ni se cerro: al soltarlo deja de estar anotado
    gc.collect()
    assert harness.bus.subscriber_count(request.field_id) == 0
    harness.irsa.gate.set()
    assert await asyncio.to_thread(harness.manager.wait_idle, 20.0)
    # El trabajo no depende de ninguna conexion: termino y quedo en el almacen.
    assert harness.manager.get_meta(request.field_id).status == "ready"


async def test_waiting_for_each_event_with_a_timeout_loses_nothing(build: HarnessFactory) -> None:
    """Lo que hace la ruta para intercalar el `: ping`: esperar cada evento con un tope y volver a pedir."""
    harness = build({(1, 3): 3, (2, 3): 3}, max_cutout_downloads=1)
    harness.irsa.gate = threading.Event()
    request = harness.request()
    harness.manager.submit(request)
    await until(lambda: len(harness.irsa.calls) == 1)
    stream = harness.manager.subscribe(request.field_id)
    received: list[FieldEvent] = []
    pings = 0
    while True:
        try:
            received.append(await asyncio.wait_for(anext(stream), 0.02))
        except TimeoutError:
            pings += 1  # aca la ruta manda `: ping`
            if pings == 3:
                harness.irsa.gate.set()
        except StopAsyncIteration:
            break
    assert pings >= 3
    recorded = harness.bus.of(request.field_id)
    assert received[0].event == "state" and received[0].data["status"] == "downloading"
    assert_followed(received[1:], recorded, received[0])
    assert [event.event for event in received[-2:]] == ["state", "done"]
    assert replay(received) == recorded[-2].data
    assert harness.bus.subscriber_count(request.field_id) == 0


async def test_a_slow_subscriber_is_brought_up_to_date_with_a_new_state(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2, (2, 3): 2, (3, 3): 2, (1, 4): 4}, max_cutout_downloads=1, max_pending=3)
    harness.irsa.list_gate = threading.Event()
    harness.irsa.hold_after = 6
    request = harness.request()
    harness.manager.submit(request)
    await until(lambda: "preview" in harness.bus.names(request.field_id))
    stream = harness.manager.subscribe(request.field_id)
    harness.irsa.list_gate.set()

    def six_processed() -> bool:
        meta = harness.manager.get_meta(request.field_id)
        plane = meta.plane(3, 3)
        return plane is not None and plane.status == "ready" and len(harness.irsa.calls) == 7

    # Mientras tanto nadie lee: `listed`, seis eventos `plane`... mas de los tres que se le guardan.
    await until(six_processed)
    assert harness.bus.subscriber_count(request.field_id) == 0  # el bus ya lo solto
    reader = asyncio.ensure_future(collect(stream))
    await until(lambda: harness.bus.subscriber_count(request.field_id) == 1)  # volvio a suscribirse
    harness.irsa.resume.set()
    events = await reader
    validate_events(events)
    recorded = harness.bus.of(request.field_id)
    assert [event.event for event in events[:2]] == ["state", "state"]
    stale, fresh = FieldMeta.model_validate(events[0].data), FieldMeta.model_validate(events[1].data)
    assert stale.status == "listing" and stale.planes is None
    # El segundo `state` trae todo lo que se perdio: reemplaza el documento a mitad del flujo.
    assert fresh.status == "downloading" and fresh.progress.cutouts_done == 6
    assert [plane.status for plane in fresh.planes or () if plane.detector == 3] == ["ready"] * 3
    assert events[1].id > events[0].id
    assert_followed(events[2:], recorded, events[1])
    assert len(events) > 6
    assert [event.event for event in events[-2:]] == ["state", "done"]
    assert replay(events) == recorded[-2].data


async def test_a_subscriber_that_reads_after_the_end_still_gets_the_final_state(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2, (2, 3): 2, (3, 3): 2}, max_pending=2)
    harness.irsa.list_gate = threading.Event()
    request = harness.request()
    harness.manager.submit(request)
    await until(lambda: "preview" in harness.bus.names(request.field_id))
    stream = harness.manager.subscribe(request.field_id)
    harness.irsa.list_gate.set()
    assert await asyncio.to_thread(harness.manager.wait_idle, 20.0)
    events = await collect(stream)
    final = harness.manager.get_meta(request.field_id)
    assert [event.event for event in events] == ["state", "state", "done"]
    assert FieldMeta.model_validate(events[1].data) == final
    assert events[2].data["status"] == "ready"


# ----------------------------------------------------------- campos terminados


def test_a_finished_field_is_served_from_the_store_without_irsa(build: HarnessFactory, tmp_path: Path) -> None:
    first = build({(1, 3): 3, (2, 3): 2})
    request = first.request()
    final = first.run(request)
    first.close()

    second = build({(1, 3): 3, (2, 3): 2})  # otro gestor, como al reiniciar el backend
    served = second.manager.submit(request)
    assert served == final and served.status == "ready"
    assert second.manager.get_meta(request.field_id) == final
    assert second.manager.submit(second.request(band=6)) == final  # la banda no cambia nada
    assert second.irsa.list_calls == [] and second.irsa.calls == [] and second.preview.calls == []
    assert second.bus.of(request.field_id) == []  # ni trabajo ni eventos
    second.manager.set_priority(request.field_id, 5)  # terminado: no hace nada
    assert second.manager.wait_idle(1.0)
    # Lo que devuelve es una copia: tocarla no cambia lo que se sirve despues.
    served.status = "failed"
    assert second.manager.get_meta(request.field_id).status == "ready"


def test_refresh_is_ignored_on_a_precomputed_field(build: HarnessFactory, tmp_path: Path) -> None:
    first = build({(1, 3): 2})
    request = first.request()
    final = first.run(request)
    first.close()
    # El campo pasa a vivir con los precalculados (data/fields), como los cinco objetos de prueba.
    precomputed = first.settings.precomputed_fields_dir
    precomputed.mkdir(parents=True)
    shutil.move(str(first.store.write_root / request.field_id), str(precomputed / request.field_id))

    second = build({(1, 3): 5})
    assert second.manager.submit(second.request(refresh=True)) == final
    assert second.manager.wait_idle(1.0)
    assert second.irsa.list_calls == [] and second.irsa.calls == []
    assert second.manager.get_meta(request.field_id) == final
    assert not (second.store.write_root / request.field_id).exists()


# --------------------------------------------------------------------- refresh


def test_refresh_rebuilds_what_changed_while_the_old_revision_is_served(build: HarnessFactory) -> None:
    harness = build({(1, 3): 3, (2, 3): 2}, max_cutout_downloads=1)
    request = harness.request()
    old = harness.run(request)
    folder = harness.store.write_root / request.field_id
    old_bytes = {name: (folder / name).read_bytes() for name in ("plane_e1_d3.f32", "plane_e2_d3.f32")}
    untouched = (folder / "plane_e1_d3.f32").stat().st_mtime_ns
    events_before = len(harness.bus.of(request.field_id))

    # Aparecio una exposicion nueva en la segunda epoca.
    harness.irsa.exposures = make_exposures({(1, 3): 3, (2, 3): 3})
    harness.irsa.listed_at = "2026-12-01T00:00:00Z"
    harness.irsa.gate = threading.Event()
    served = harness.manager.submit(harness.request(refresh=True))
    assert served == old  # 200 con la revision anterior
    wait_until(lambda: len(harness.irsa.calls) == 5 + 1)  # el trabajo aparte ya esta bajando
    assert harness.irsa.list_calls == [False, True]
    # Mientras tanto se sigue sirviendo la revision anterior, sin eventos nuevos.
    assert harness.manager.get_meta(request.field_id) == old
    assert harness.manager.submit(harness.request(refresh=True)) == old  # no arranca otro
    assert (folder / "plane_e2_d3.f32").read_bytes() == old_bytes["plane_e2_d3.f32"]
    assert harness.store.read_meta(request.field_id) == old
    harness.manager.set_priority(request.field_id, 6)

    harness.irsa.gate.set()
    assert harness.manager.wait_idle(30.0)
    new = harness.manager.get_meta(request.field_id)
    assert harness.irsa.list_calls == [False, True]
    assert (new.status, new.rev) == ("ready", old.rev + 1)
    assert harness.store.read_meta(request.field_id) == new
    changed, same = new.plane(2, 3), new.plane(1, 3)
    old_changed = old.plane(2, 3)
    assert changed is not None and same is not None and old_changed is not None
    # La `rev` del plano reemplazado sigue a la que tenia; el que no cambio conserva archivo y `rev`.
    assert (changed.rev, changed.n_exposures, changed.n_used) == (old_changed.rev + 1, 3, 3)
    assert same == old.plane(1, 3)
    assert (folder / "plane_e1_d3.f32").stat().st_mtime_ns == untouched
    assert (folder / "plane_e2_d3.f32").read_bytes() == expected_plane(
        harness, ["E2D3N0", "E2D3N1", "E2D3N2"]
    ).image.tobytes()
    _flags, coverage = harness.store.read_aux(request.field_id, 2, 3, shape=SHAPE)
    assert int(coverage.max()) == 3
    assert [plane.cube_offset for plane in new.planes or () if plane.cube_offset is not None] == [0, 4 * 195 * 195]
    assert new.epochs is not None and [epoch.n_exposures for epoch in new.epochs] == [3, 3]
    assert (new.progress.cutouts_total, new.progress.cutouts_done, new.progress.phase) == (6, 6, "done")
    assert new.provenance is not None and old.provenance is not None
    assert new.provenance.listed_at == "2026-12-01T00:00:00Z"
    assert new.preview == old.preview and harness.store.has_preview(request.field_id)
    assert {"code": "few_exposures", "epoch": 2, "detector": 3, "n": 3} in [
        warning.model_dump() for warning in new.warnings
    ]
    assert len(harness.bus.of(request.field_id)) == events_before  # el refresh no publica nada
    assert harness.preview.calls == [3]  # la vista provisoria no se vuelve a pedir


async def test_subscribers_during_a_refresh_see_the_finished_field(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2})
    request = harness.request()
    old = await asyncio.to_thread(harness.run, request)
    harness.irsa.gate = threading.Event()
    harness.manager.submit(harness.request(refresh=True))
    await until(lambda: len(harness.irsa.calls) == 2 + 2)  # el trabajo aparte ya esta bajando
    events = await collect(harness.manager.subscribe(request.field_id))
    assert [(event.id, event.event) for event in events] == [(1, "state"), (2, "done")]
    assert FieldMeta.model_validate(events[0].data) == old
    harness.irsa.gate.set()
    assert await asyncio.to_thread(harness.manager.wait_idle, 20.0)


def test_refresh_without_news_keeps_every_revision(build: HarnessFactory) -> None:
    harness = build({(1, 3): 3, (2, 3): 2}, max_cutout_downloads=1)
    request = harness.request()
    old = harness.run(request)
    folder = harness.store.write_root / request.field_id
    stamps = {path.name: path.stat().st_mtime_ns for path in folder.glob("*.f32")}
    harness.irsa.listed_at = "2026-12-01T00:00:00Z"
    harness.manager.submit(harness.request(refresh=True))
    assert harness.manager.wait_idle(30.0)
    new = harness.manager.get_meta(request.field_id)
    assert len(harness.irsa.calls) == 10  # se volvio a armar (los recortes estan en la cache)...
    assert new.rev == old.rev and new.planes == old.planes  # ...y no cambio nada
    assert {path.name: path.stat().st_mtime_ns for path in folder.glob("*.f32")} == stamps
    assert new.provenance is not None and new.provenance.listed_at == "2026-12-01T00:00:00Z"
    assert new.model_copy(update={"provenance": old.provenance}) == old


def test_refresh_completes_a_partial_field(build: HarnessFactory) -> None:
    harness = build({(1, 3): 3, (1, 4): 1}, max_cutout_downloads=1)
    harness.irsa.script["E1D3N0"] = [IrsaPermanent("HTTP 500 que no se arreglo")]
    harness.irsa.script["E1D4N0"] = [IrsaPermanent("HTTP 500 que no se arreglo")]
    request = harness.request()
    old = harness.run(request)
    assert old.status == "partial" and [warning.code for warning in old.warnings].count("cutouts_failed") == 1
    harness.manager.submit(harness.request(refresh=True))
    assert harness.manager.wait_idle(30.0)
    new = harness.manager.get_meta(request.field_id)
    assert (new.status, new.rev) == ("ready", 2)
    recovered, was_empty = new.plane(1, 3), new.plane(1, 4)
    assert recovered is not None and (recovered.status, recovered.rev, recovered.n_failed) == ("ready", 3, 0)
    assert was_empty is not None and (was_empty.status, was_empty.rev, was_empty.n_used) == ("ready", 2, 1)
    assert harness.store.read_plane(request.field_id, 1, 4, shape=SHAPE).shape == SHAPE
    assert "cutouts_failed" not in [warning.code for warning in new.warnings]
    assert (new.progress.cutouts_done, new.progress.cutouts_failed) == (4, 0)
    assert [plane.cube_offset for plane in new.planes or () if plane.cube_offset is not None] == [0, 4 * 195 * 195]


def test_refresh_never_makes_a_field_worse(build: HarnessFactory) -> None:
    harness = build({(1, 3): 3, (2, 3): 2}, max_cutout_downloads=1)
    request = harness.request()
    old = harness.run(request)
    # Esta vez un recorte no se puede bajar, y despues IRSA ni siquiera lista.
    harness.irsa.script["E1D3N1"] = [IrsaPermanent("HTTP 404")]
    harness.manager.submit(harness.request(refresh=True))
    assert harness.manager.wait_idle(30.0)
    assert harness.manager.get_meta(request.field_id).planes == old.planes
    assert harness.manager.get_meta(request.field_id).rev == old.rev

    harness.irsa.stale = True
    harness.irsa.exposures = make_exposures({(1, 3): 4})
    harness.manager.submit(harness.request(refresh=True))
    assert harness.manager.wait_idle(30.0)
    kept = harness.manager.get_meta(request.field_id)
    assert kept.planes == old.planes and kept.provenance is not None and kept.provenance.list_stale is False
    assert harness.irsa.list_calls == [False, True, True]
    assert harness.store.read_plane(request.field_id, 1, 3, shape=SHAPE).shape == SHAPE


def test_refresh_of_a_field_that_does_not_exist_is_a_normal_job(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2})
    request = harness.request(refresh=True)
    assert harness.manager.submit(request).status == "queued"
    assert harness.manager.wait_idle(30.0)
    assert harness.irsa.list_calls == [True]
    assert harness.bus.names(request.field_id)[-1] == "done"


# -------------------------------------------------------- reinicio y detencion


def test_a_half_built_field_from_a_previous_run_is_built_again(build: HarnessFactory) -> None:
    first = build({(1, 3): 4, (2, 3): 4}, max_cutout_downloads=1)
    first.irsa.hold_after = 3
    request = first.request()
    first.manager.submit(request)

    def halfway() -> bool:
        plane = first.manager.get_meta(request.field_id).plane(1, 3)
        return plane is not None and plane.status == "building" and len(first.irsa.calls) == 4

    wait_until(halfway)
    first.manager.shutdown(timeout=0.2)  # el backend se apaga con el campo a medio armar
    first.release()
    folder = first.store.write_root / request.field_id
    assert first.store.read_meta(request.field_id).status == "downloading"
    assert (folder / "plane_e1_d3.f32").exists()
    (folder / "plane_e3_d1.f32").write_bytes(b"resto de otra corrida")

    second = build({(1, 3): 4, (2, 3): 4}, max_cutout_downloads=1)
    # Lo que quedo a medias no cuenta como existente.
    for call in (second.manager.get_meta, second.manager.subscribe):
        with pytest.raises(ApiError) as missing:
            call(request.field_id)
        assert missing.value.code == "not_found"
    with pytest.raises(ApiError):
        second.manager.set_priority(request.field_id, 3)
    assert second.manager.submit(request).status == "queued"
    assert second.manager.wait_idle(30.0)
    final = second.manager.get_meta(request.field_id)
    assert (final.status, final.rev) == ("ready", 1)
    assert len(second.irsa.calls) == 8  # se pide todo de nuevo: en el backend real sale de la cache de recortes
    # El plano que ya habia publicado su revision 1 sigue numerando desde ahi: `?rev=1` ya se sirvio
    # como `immutable` y no puede pasar a devolver otros bytes.
    assert [(e, d, status, rev) for e, d, status, rev, _ in planes_of(second.bus.of(request.field_id))] == [
        (1, 3, "building", 2),
        (2, 3, "building", 1),
        (1, 3, "ready", 3),
        (2, 3, "ready", 2),
    ]
    assert [plane.rev for plane in final.planes or () if plane.status == "ready"] == [3, 2]
    assert not (folder / "plane_e3_d1.f32").exists()
    assert second.store.read_meta(request.field_id) == final


def test_shutdown_with_jobs_in_flight_leaves_nothing_running(build: HarnessFactory) -> None:
    harness = build({(1, 3): 8, (2, 3): 8}, max_active_jobs=2, max_queued_jobs=5)
    harness.irsa.gate = threading.Event()
    requests = [harness.request(10.0 * (index + 1), 5.0) for index in range(3)]
    for request in requests:
        harness.manager.submit(request)
    wait_until(lambda: harness.irsa.active == 10)  # dos trabajos bajando, el tercero en la cola
    assert harness.manager.get_meta(requests[2].field_id).status == "queued"
    assert len(manager_threads()) >= 12

    harness.manager.shutdown(timeout=0.3)  # las descargas en curso todavia no volvieron
    published = len(harness.bus.log)
    with pytest.raises(ApiError) as stopped:
        harness.manager.submit(requests[0])
    assert stopped.value.code == "upstream_unavailable"
    harness.irsa.gate.set()  # las descargas que estaban en vuelo vuelven
    wait_until(lambda: not manager_threads(), 10.0)
    assert harness.manager.wait_idle(1.0)
    assert len(harness.bus.log) == published  # despues de detenerse no publica nada mas
    assert harness.irsa.max_active == 10 and len(harness.irsa.calls) == 10  # ni pide nada mas
    assert "done" not in [name for _, name in harness.bus.log]
    assert "error" not in [name for _, name in harness.bus.log]
    # Lo que quedo en el almacen esta sin terminar: se rehace cuando se vuelva a pedir.
    assert harness.store.read_meta(requests[0].field_id).status == "downloading"
    harness.manager.shutdown()  # detenerlo dos veces no hace nada


async def test_shutdown_ends_the_open_streams(build: HarnessFactory) -> None:
    harness = build({(1, 3): 4}, max_cutout_downloads=2)
    harness.irsa.gate = threading.Event()
    request = harness.request()
    harness.manager.submit(request)
    await until(lambda: harness.irsa.active == 2)
    reader = asyncio.ensure_future(collect(harness.manager.subscribe(request.field_id)))
    await asyncio.sleep(0.01)
    await asyncio.to_thread(harness.manager.shutdown, 0.2)
    events = await reader
    # El flujo termina sin `done` ni `error`: el cliente va a reconectar.
    assert [event.event for event in events] == ["state"]
    assert harness.bus.subscriber_count(request.field_id) == 0
    harness.irsa.gate.set()


def test_shutdown_of_an_idle_manager(build: HarnessFactory) -> None:
    harness = build({(1, 3): 2})
    assert manager_threads() == []  # crear el gestor no arranca ningun hilo
    assert harness.irsa.pruned == 1  # pero si aplica el tope de disco de la cache
    harness.manager.shutdown()
    assert manager_threads() == []
    harness = build({(1, 3): 2})
    harness.run()
    # Los hilos de descarga quedan para el proximo trabajo; el del trabajo ya termino.
    wait_until(lambda: len(manager_threads()) == 10)
    harness.manager.shutdown()
    assert manager_threads() == []
