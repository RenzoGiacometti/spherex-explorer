"""Eventos SSE: formato de `encode_sse` y reparto del `EventBus` entre hilos y asyncio."""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any

import pytest

from app.jobs.events import PING, EventBus, FieldEvent, Subscription, encode_sse

FIELD = "f3a91c0e52d47b18"
OTHER = "0123456789abcdef"


async def read_all(stream: Any, timeout: float = 5.0) -> list[FieldEvent]:
    """Todo lo que entrega el flujo hasta que termina."""
    events: list[FieldEvent] = []
    async with asyncio.timeout(timeout):
        async for event in stream:
            events.append(event)
    return events


# ------------------------------------------------------------------ encode_sse


def test_encode_sse_is_three_lines_and_a_blank_one() -> None:
    event = FieldEvent(id=7, event="queued", data={"position": 2})
    assert encode_sse(event) == b'event: queued\nid: 7\ndata: {"position":2}\n\n'


def test_encode_sse_keeps_the_json_on_one_line() -> None:
    message = "primera linea\nsegunda\r\ntercera con acento: campo vacío"
    event = FieldEvent(
        id=3, event="error", data={"error": {"code": "not_found", "message": message, "retryable": False}}
    )
    encoded = encode_sse(event)
    assert encoded.endswith(b"\n\n")
    lines = encoded[:-2].split(b"\n")
    assert len(lines) == 3 and b"\r" not in encoded
    assert lines[0] == b"event: error" and lines[1] == b"id: 3"
    assert lines[2].startswith(b"data: ")
    assert json.loads(lines[2][len(b"data: ") :].decode("utf-8")) == event.data


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_encode_sse_rejects_nan_and_infinity(value: float) -> None:
    event = FieldEvent(id=1, event="progress", data={"phase": "downloading", "elapsed_s": value})
    with pytest.raises(ValueError):
        encode_sse(event)


def test_encode_sse_accepts_any_mapping() -> None:
    from types import MappingProxyType

    event = FieldEvent(id=1, event="queued", data=MappingProxyType({"position": 1}))
    assert encode_sse(event) == b'event: queued\nid: 1\ndata: {"position":1}\n\n'


def test_ping_is_a_comment() -> None:
    assert PING == b": ping\n\n"


# ------------------------------------------------------------------ numeracion


def test_publish_numbers_the_events_of_each_field() -> None:
    bus = EventBus()
    assert bus.last_id(FIELD) == 0
    first = bus.publish(FIELD, "state", {"a": 1})
    second = bus.publish(FIELD, "queued", {"position": 1})
    other = bus.publish(OTHER, "state", {"b": 2})
    assert (first.id, second.id, other.id) == (1, 2, 1)
    assert (first.event, first.data) == ("state", {"a": 1})
    assert bus.last_id(FIELD) == 2 and bus.last_id(OTHER) == 1


def test_close_forgets_the_field() -> None:
    bus = EventBus()
    bus.publish(FIELD, "state", {})
    bus.publish(FIELD, "done", {})
    bus.close(FIELD)
    assert bus.last_id(FIELD) == 0
    assert bus.publish(FIELD, "state", {}).id == 1
    bus.close("no-existe")  # cerrar un campo sin eventos no es un error


# --------------------------------------------------------------------- entrega


async def test_a_subscriber_gets_only_what_is_published_afterwards() -> None:
    bus = EventBus()
    bus.publish(FIELD, "state", {"n": 1})
    stream = bus.subscribe(FIELD)
    bus.publish(FIELD, "progress", {"n": 2})
    bus.publish(OTHER, "progress", {"n": 99})
    bus.publish(FIELD, "done", {"n": 3})
    events = await read_all(stream)
    assert [(event.id, event.event) for event in events] == [(2, "progress"), (3, "done")]


async def test_subscription_starts_when_subscribe_returns_not_when_iterated() -> None:
    bus = EventBus()
    stream = bus.subscribe(FIELD)
    assert bus.subscriber_count(FIELD) == 1
    bus.publish(FIELD, "state", {})
    bus.publish(FIELD, "error", {})
    assert [event.event for event in await read_all(stream)] == ["state", "error"]


@pytest.mark.parametrize("closing", ["done", "error"])
async def test_the_stream_ends_after_done_or_error(closing: str) -> None:
    bus = EventBus()
    stream = bus.subscribe(FIELD)
    bus.publish(FIELD, "plane", {})
    bus.publish(FIELD, closing, {})  # type: ignore[arg-type]
    bus.publish(FIELD, "plane", {"tarde": True})
    events = await read_all(stream)
    assert [event.event for event in events] == ["plane", closing]
    assert bus.subscriber_count(FIELD) == 0


async def test_every_subscriber_gets_every_event() -> None:
    bus = EventBus()
    streams = [bus.subscribe(FIELD) for _ in range(5)]
    for number in range(20):
        bus.publish(FIELD, "plane", {"n": number})
    bus.publish(FIELD, "done", {})
    for stream in streams:
        events = await read_all(stream)
        assert [event.id for event in events] == list(range(1, 22))


async def test_events_published_from_threads_arrive_in_order() -> None:
    bus = EventBus(max_pending=10_000)
    stream = bus.subscribe(FIELD)
    per_thread = 200

    def work(name: int) -> None:
        for number in range(per_thread):
            bus.publish(FIELD, "plane", {"thread": name, "n": number})

    reader = asyncio.ensure_future(read_all(stream))
    await asyncio.sleep(0)  # el lector ya espera cuando empiezan a publicar
    threads = [threading.Thread(target=work, args=(name,)) for name in range(8)]
    for thread in threads:
        thread.start()
    await asyncio.to_thread(lambda: [thread.join() for thread in threads])
    bus.publish(FIELD, "done", {})
    events = await reader
    assert [event.id for event in events] == list(range(1, 8 * per_thread + 2))
    for name in range(8):
        own = [event.data["n"] for event in events if event.data.get("thread") == name]
        assert own == list(range(per_thread))


async def test_a_waiting_subscriber_wakes_up_with_an_event_from_a_thread() -> None:
    bus = EventBus()
    stream = bus.subscribe(FIELD)
    reader = asyncio.ensure_future(anext(stream))
    await asyncio.sleep(0.01)
    assert not reader.done()
    await asyncio.to_thread(bus.publish, FIELD, "queued", {"position": 1})
    event = await asyncio.wait_for(reader, 5.0)
    assert (event.id, event.event) == (1, "queued")


async def test_close_ends_the_open_streams_after_what_was_pending() -> None:
    bus = EventBus()
    stream = bus.subscribe(FIELD)
    waiting = bus.subscribe(FIELD)
    reader = asyncio.ensure_future(read_all(waiting))
    await asyncio.sleep(0)
    bus.publish(FIELD, "plane", {"n": 1})
    bus.close(FIELD)
    assert [event.data for event in await read_all(stream)] == [{"n": 1}]
    assert [event.data for event in await reader] == [{"n": 1}]
    assert bus.subscriber_count(FIELD) == 0


# ------------------------------------------------- suscriptores lentos o idos


def test_publishing_never_blocks_without_readers() -> None:
    bus = EventBus(max_pending=8)
    stream = bus.subscribe(FIELD)
    assert isinstance(stream, Subscription)
    for number in range(1000):
        bus.publish(FIELD, "plane", {"n": number})
    # Nadie leyo: al llenarse se le descarto todo y dejo de recibir.
    assert stream.lagged and stream.pending == 0
    assert bus.subscriber_count(FIELD) == 0
    assert bus.last_id(FIELD) == 1000


async def test_a_slow_subscriber_ends_as_lagged_and_loses_its_backlog() -> None:
    bus = EventBus(max_pending=3)
    slow = bus.subscribe(FIELD)
    fast = bus.subscribe(FIELD, max_pending=100)
    assert isinstance(slow, Subscription) and isinstance(fast, Subscription)
    for number in range(4):
        bus.publish(FIELD, "plane", {"n": number})
    assert slow.lagged and not fast.lagged
    assert await read_all(slow) == []
    bus.publish(FIELD, "done", {})
    assert [event.id for event in await read_all(fast)] == [1, 2, 3, 4, 5]


async def test_unread_progress_events_collapse_into_the_latest() -> None:
    bus = EventBus(max_pending=5)
    stream = bus.subscribe(FIELD)
    assert isinstance(stream, Subscription)
    bus.publish(FIELD, "plane", {"n": 0})
    for number in range(500):
        bus.publish(FIELD, "progress", {"cutouts_done": number})
    assert stream.pending == 2 and not stream.lagged
    bus.publish(FIELD, "plane", {"n": 1})
    bus.publish(FIELD, "progress", {"cutouts_done": 500})
    bus.publish(FIELD, "done", {})
    events = await read_all(stream)
    assert [event.event for event in events] == ["plane", "progress", "plane", "progress", "done"]
    assert events[1].data == {"cutouts_done": 499} and events[1].id == 501
    assert events[3].data == {"cutouts_done": 500}


async def test_a_subscriber_that_leaves_is_forgotten() -> None:
    bus = EventBus()
    stream = bus.subscribe(FIELD)
    assert isinstance(stream, Subscription)
    bus.publish(FIELD, "plane", {})
    assert (await anext(stream)).event == "plane"
    await stream.aclose()
    assert bus.subscriber_count(FIELD) == 0
    bus.publish(FIELD, "plane", {})
    assert stream.pending == 0
    with pytest.raises(StopAsyncIteration):
        await anext(stream)


async def test_cancelling_a_reader_does_not_break_the_stream() -> None:
    bus = EventBus()
    stream = bus.subscribe(FIELD)
    reader = asyncio.ensure_future(anext(stream))
    await asyncio.sleep(0)
    reader.cancel()
    with pytest.raises(asyncio.CancelledError):
        await reader
    bus.publish(FIELD, "done", {})
    assert [event.event for event in await read_all(stream)] == ["done"]


def test_a_subscriber_whose_loop_is_gone_does_not_break_publish() -> None:
    bus = EventBus()
    stream = bus.subscribe(FIELD)
    assert isinstance(stream, Subscription)
    loop = asyncio.new_event_loop()
    task = loop.create_task(anext(stream))  # type: ignore[arg-type]
    loop.run_until_complete(asyncio.sleep(0))  # el lector queda esperando
    assert not task.done()
    task._log_destroy_pending = False  # type: ignore[attr-defined]  # sin el aviso de asyncio al descartarla
    loop.close()  # el servidor se apago sin que el lector llegara a enterarse
    for number in range(3):
        bus.publish(FIELD, "plane", {"n": number})
    bus.publish(FIELD, "done", {})
    assert bus.subscriber_count(FIELD) == 0


def test_many_abandoned_subscribers_do_not_accumulate() -> None:
    bus = EventBus(max_pending=16)
    streams = [bus.subscribe(FIELD) for _ in range(50)]
    for number in range(100):
        bus.publish(FIELD, "plane", {"n": number})
    assert bus.subscriber_count(FIELD) == 0
    assert all(isinstance(stream, Subscription) and stream.pending == 0 for stream in streams)
