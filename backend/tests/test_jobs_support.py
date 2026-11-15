"""Apoyo de los tests del gestor de trabajos: IRSA, hips2fits, pipeline y reloj de mentira. No tiene tests propios.

Con estas piezas un trabajo corre entero sin red y sin esperas de verdad:

- `FakeClock`: reloj que avanza solo cuando el test lo dice, o por su cuenta
  cada vez que un hilo de descarga se queda esperando un reintento.
- `FakeIrsa`: la lista de exposiciones y las descargas. A cada exposicion se le
  puede dar un guion de respuestas (errores de IRSA) para sus intentos.
- `FakePipeline`: `load_exposure` que arma una exposicion sintetica a partir del
  nombre del archivo, sin leer nada.
- `FakePreview`: la vista provisoria, lista, caida o lenta.
- `RecordingBus`: un `EventBus` que ademas anota todo lo publicado, para mirar
  la secuencia completa de un trabajo sin depender de cuando se conecta nadie.
- `Harness`: todo lo anterior junto con un `JobManager` sobre un directorio temporal.
"""

from __future__ import annotations

import contextlib
import copy
import threading
import time
import zlib
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from app import geometry
from app.api.errors import ApiError
from app.config import Settings
from app.contract import EVENT_ADAPTERS, EventName, FieldMeta, utc_timestamp
from app.domain import (
    CutoutFile,
    Exposure,
    ExposureList,
    Grid,
    NormalizedRequest,
    PreviewImage,
    ReprojectedExposure,
)
from app.jobs.deps import JobDeps
from app.jobs.document import NOMINAL_WAVE_RANGE_UM
from app.jobs.events import EventBus, FieldEvent
from app.jobs.manager import JobManager
from app.jobs.store import FieldStore
from app.pipeline.coadd import PlaneAccumulator
from app.preview.hips2fits import PreviewUnavailable, preview_band

Key = tuple[int, int]

# Fecha de la primera exposicion de cada epoca sintetica: separadas por mas de 60 dias.
EPOCH_START_MJD = (60900.0, 61100.0, 61300.0, 61500.0)

# Tabla de bits de las exposiciones sinteticas: los nombres y numeros de los recortes reales
# (tests/fixtures/cutouts), solo los que hacen falta.
FLAG_BITS = {"TRANSIENT": 0, "OVERFLOW": 1, "SUR_ERROR": 2, "SOURCE": 21, "BLOOM": 26}
FLAG_DESCRIPTIONS = {"OVERFLOW": "Overflow detected during SUR", "BLOOM": "Pixel part of a bloom artifact"}

WAIT_S = 20.0  # tope de cualquier espera de un test
SHAPE = (195, 195)  # grilla del escalon base


def wait_until(condition: Callable[[], bool], timeout: float = WAIT_S, message: str = "") -> None:
    """Espera a que `condition()` sea verdadera mirando cada pocos milisegundos; falla si pasa `timeout`."""
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError(message or "la condicion no se cumplio a tiempo")
        time.sleep(0.002)


# ------------------------------------------------------------------------ reloj


class FakeClock:
    """Reloj del gestor en los tests.

    Con `auto` en verdadero, cada vez que un hilo de descarga no tiene nada
    listo y espera un reintento, el reloj salta lo que falta: las esperas de
    `Retry-After` se respetan en el orden pero no se esperan de verdad. Con
    `auto` en falso el reloj solo avanza con `advance`, para comprobar que
    algo NO pasa antes de tiempo.
    """

    # Lo que avanza con cada lectura: como un reloj de verdad, nunca da dos veces la misma hora.
    TICK_S = 1e-6

    def __init__(self, auto: bool = True, start: float = 1000.0) -> None:
        self.auto = auto
        self._now = start
        self._lock = threading.Lock()

    def __call__(self) -> float:
        with self._lock:
            self._now += self.TICK_S
            return self._now

    def advance(self, seconds: float) -> None:
        with self._lock:
            self._now += seconds

    def wait(self, condition: threading.Condition, timeout: float | None) -> None:
        if timeout is None:
            condition.wait(1.0)  # nada pendiente: hasta que avisen
            return
        if self.auto:
            self.advance(timeout)
        condition.wait(0.002)


# ----------------------------------------------------------------- exposiciones


def make_exposures(counts: Mapping[Key, int], spacing_days: float = 0.5) -> list[Exposure]:
    """Exposiciones sinteticas: `counts` dice cuantas tiene cada plano `(epoca, detector)`.

    El `obs_id` es `E<epoca>D<detector>N<orden>` y sirve de clave en los tests.
    """
    exposures: list[Exposure] = []
    for (epoch, detector), count in sorted(counts.items()):
        low, high = NOMINAL_WAVE_RANGE_UM[detector]
        for order in range(count):
            # Un corrimiento por detector para que dos exposiciones no compartan fecha.
            mjd = EPOCH_START_MJD[epoch - 1] + order * spacing_days + detector * 0.001
            obs_id = f"E{epoch}D{detector}N{order}"
            exposures.append(
                Exposure(
                    obs_id=obs_id,
                    collection="spherex_dr1",
                    detector=detector,
                    mjd_start=mjd,
                    mjd_end=mjd + 0.0013,
                    url=f"https://irsa.invalid/{obs_id}.fits",
                    wave_min_um=low + 0.0001,
                    wave_max_um=high + 0.0002,
                )
            )
    return exposures


def plane_of(obs_id: str) -> Key:
    """`(epoca, detector)` de un `obs_id` de `make_exposures`."""
    epoch, rest = obs_id[1:].split("D")
    return int(epoch), int(rest.split("N")[0])


class FakeIrsa:
    """La lista de exposiciones y el servicio de recortes, de mentira.

    `script[obs_id]` es la lista de respuestas de los proximos intentos de ese
    recorte: una excepcion se lanza, cualquier otra cosa es un intento que sale
    bien. Agotado el guion, todo sale bien.
    """

    def __init__(self, exposures: Iterable[Exposure], *, stale: bool = False, listed_at: str | None = None) -> None:
        self.exposures = list(exposures)
        self.stale = stale
        self.listed_at = listed_at
        self.list_error: BaseException | None = None
        self.list_gate: threading.Event | None = None  # si esta, la lista espera a que se lo abra
        self.before_list: Callable[[float, float], None] | None = None
        self.list_calls: list[bool] = []  # el `refresh` de cada llamada
        self.script: dict[str, list[Any]] = {}
        self.calls: list[str] = []  # obs_id de cada intento de descarga, en orden de llegada
        self.call_times: list[tuple[str, float]] = []
        self.clock: Callable[[], float] | None = None
        self.modes: dict[str, str] = {}
        self.from_cache: set[str] = set()
        self.reasons: dict[str, str] = {}
        self.delay_s = 0.0  # lo que tarda cada descarga, en segundos de verdad
        self.gate: threading.Event | None = None  # si esta, cada descarga espera a que se lo abra
        # Si esta, las descargas que lleguen despues de las primeras `hold_after` esperan a `resume`.
        self.hold_after: int | None = None
        self.resume = threading.Event()
        # Si esta, cada descarga espera hasta que haya esa cantidad a la vez (o pase un momento).
        self.crowd: int | None = None
        self._crowded = threading.Event()
        self.on_call: Callable[[Exposure], None] | None = None
        self.centers: list[tuple[float, float]] = []  # centro pedido en cada intento, en orden de llegada
        self.active = 0
        self.max_active = 0
        self.discarded: list[Path] = []
        self.pruned = 0
        self._lock = threading.Lock()

    # ------------------------------------------------------------- dependencias

    def list_exposures(self, ra: float, dec: float, settings: Settings, refresh: bool = False) -> ExposureList:
        with self._lock:
            self.list_calls.append(refresh)
        if self.before_list is not None:
            self.before_list(ra, dec)
        if self.list_gate is not None:
            assert self.list_gate.wait(WAIT_S), "nadie abrio la lista de exposiciones"
        if self.list_error is not None:
            raise self.list_error
        return ExposureList(
            exposures=list(self.exposures), listed_at=self.listed_at or utc_timestamp(), stale=self.stale
        )

    def fetch_cutout(
        self, exposure: Exposure, ra: float, dec: float, side_deg: float, settings: Settings
    ) -> CutoutFile:
        key = exposure.obs_id
        with self._lock:
            self.calls.append(key)
            self.centers.append((ra, dec))
            number = len(self.calls)
            if self.clock is not None:
                self.call_times.append((key, self.clock()))
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            if self.crowd is not None and self.active >= self.crowd:
                self._crowded.set()
            outcomes = self.script.get(key)
            outcome = outcomes.pop(0) if outcomes else None
        try:
            if self.on_call is not None:
                self.on_call(exposure)
            if self.crowd is not None:
                self._crowded.wait(2.0)
            if self.hold_after is not None and number > self.hold_after:
                assert self.resume.wait(WAIT_S), "nadie reanudo las descargas"
            if self.gate is not None:
                assert self.gate.wait(WAIT_S), "nadie abrio las descargas"
            if self.delay_s:
                time.sleep(self.delay_s)
            if isinstance(outcome, BaseException):
                raise outcome
            mode = self.modes.get(key, "truncated")
            return CutoutFile(
                path=settings.cutout_cache_dir / f"{key}.fits",
                mode=mode,  # type: ignore[arg-type]
                from_cache=key in self.from_cache,
                nbytes=0 if key in self.from_cache else 123840,
                reason=self.reasons.get(key),
            )
        finally:
            with self._lock:
                self.active -= 1

    def discard_cutout(self, path: Path, settings: Settings) -> bool:
        with self._lock:
            self.discarded.append(Path(path))
        return True

    def prune_cutout_cache(self, settings: Settings) -> None:
        with self._lock:
            self.pruned += 1

    # ----------------------------------------------------------------- consultas

    def attempts(self, obs_id: str) -> int:
        with self._lock:
            return self.calls.count(obs_id)

    def first_calls(self) -> list[str]:
        """Los recortes en el orden en que se pidieron por primera vez."""
        with self._lock:
            return list(dict.fromkeys(self.calls))


# --------------------------------------------------------------------- pipeline


class FakePipeline:
    """`load_exposure` sintetico: la imagen sale del nombre del archivo, siempre la misma.

    - `saturated`: planos cuyas exposiciones traen un nucleo saturado (sin
      valor y con OVERFLOW) en el centro.
    - `unreadable[obs_id]`: cuantas veces ese recorte lanza `ValueError` antes de leerse bien.
    - `fail_at`: numero de llamada (desde 1) en el que lanza `RuntimeError`, para simular una falla interna.
    - `bad_table`: recortes cuya tabla de bits contradice a las demas.
    """

    def __init__(self) -> None:
        self.saturated: set[Key] = set()
        self.unreadable: dict[str, int] = {}
        self.fail_at: int | None = None
        self.bad_table: set[str] = set()
        self.calls: list[str] = []
        self.gate: threading.Event | None = None
        self._lock = threading.Lock()

    def load_exposure(self, path: Path, grid: Grid) -> ReprojectedExposure:
        obs_id = Path(path).stem
        with self._lock:
            self.calls.append(obs_id)
            number = len(self.calls)
            pending = self.unreadable.get(obs_id, 0)
            if pending > 0:
                self.unreadable[obs_id] = pending - 1
        if self.gate is not None:
            assert self.gate.wait(WAIT_S), "nadie abrio el proceso"
        if self.fail_at is not None and number == self.fail_at:
            raise RuntimeError("falla interna simulada al procesar un recorte")
        if pending > 0:
            raise ValueError(f"{obs_id}: recorte ilegible (simulado)")
        return synthetic_exposure(
            obs_id, grid, saturated=plane_of(obs_id) in self.saturated, bad_table=obs_id in self.bad_table
        )


def synthetic_exposure(
    obs_id: str, grid: Grid, *, saturated: bool = False, bad_table: bool = False
) -> ReprojectedExposure:
    """Una exposicion ya reproyectada: ruido mas una estrella en el centro. Depende solo de `obs_id`."""
    ny, nx = grid.shape
    rng = np.random.default_rng(zlib.crc32(obs_id.encode()))
    yy, xx = np.indices((ny, nx))
    cy, cx = (ny - 1) / 2.0, (nx - 1) / 2.0
    image = (rng.normal(0.0, 0.05, (ny, nx)) + 5.0 * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / 8.0)).astype(
        np.float32
    )
    variance = np.full((ny, nx), 0.0025, dtype=np.float32)
    flags = np.zeros((ny, nx), dtype=np.uint32)
    if saturated:
        core = (xx - cx) ** 2 + (yy - cy) ** 2 <= 9.0
        image[core] = np.nan
        variance[core] = np.nan
        flags[core] = 1 << FLAG_BITS["OVERFLOW"]
    bits = dict(FLAG_BITS)
    if bad_table:
        bits = {"OTRO_NOMBRE": FLAG_BITS["OVERFLOW"]}
    return ReprojectedExposure(
        image=image,
        variance=variance,
        flags=flags,
        footprint=np.ones((ny, nx), dtype=bool),
        flag_bits=bits,
        background=0.0,
        flag_descriptions=dict(FLAG_DESCRIPTIONS),
    )


# ------------------------------------------------------------- vista provisoria


class FakePreview:
    """`fetch_preview` de mentira. `mode`: `ready`, `down` (lanza `PreviewUnavailable`) o `slow` (espera a `gate`)."""

    def __init__(self, mode: str = "ready") -> None:
        self.mode = mode
        self.gate = threading.Event()
        self.calls: list[int] = []
        self.started = threading.Event()

    def fetch_preview(self, grid: Grid, band: int, settings: Settings) -> PreviewImage:
        self.calls.append(band)
        self.started.set()
        if self.mode == "slow":
            assert self.gate.wait(WAIT_S), "nadie abrio la vista provisoria"
        if self.mode == "down":
            raise PreviewUnavailable("hips2fits no respondio (simulado)")
        name, wave_um = preview_band(band)
        image = preview_image(grid)
        return PreviewImage(image=image, band=name, wave_um=wave_um, hips=f"prueba/WISE/{name}")


def preview_image(grid: Grid) -> np.ndarray:
    ny, nx = grid.shape
    yy, xx = np.indices((ny, nx))
    image = (2.0 + 0.01 * xx + 0.02 * yy).astype(np.float32)
    image[0, 0] = np.nan
    return image


# ------------------------------------------------------------------------- bus


class RecordingBus(EventBus):
    """Un bus que ademas anota todo lo publicado, por campo."""

    def __init__(self, max_pending: int = 256) -> None:
        super().__init__(max_pending)
        self.events: dict[str, list[FieldEvent]] = {}
        self.log: list[tuple[str, str]] = []  # (campo, evento) de todo lo publicado, en orden
        # Se llama con cada evento, en el hilo que publica y antes de repartirlo. No tiene que llamar al gestor.
        self.hook: Callable[[str, str, Mapping[str, Any]], None] | None = None
        self._record_lock = threading.RLock()

    def publish(self, field_id: str, event: EventName, data: Mapping[str, Any]) -> FieldEvent:
        # Numerar y anotar van juntos: asi lo anotado queda en el orden de los ids aunque publiquen dos hilos.
        with self._record_lock:
            if self.hook is not None:
                self.hook(field_id, event, data)
            item = super().publish(field_id, event, data)
            self.events.setdefault(field_id, []).append(item)
            self.log.append((field_id, event))
        return item

    def of(self, field_id: str) -> list[FieldEvent]:
        with self._record_lock:
            return list(self.events.get(field_id, ()))

    def names(self, field_id: str) -> list[str]:
        return [event.event for event in self.of(field_id)]

    def last(self, field_id: str, name: str) -> FieldEvent:
        return next(event for event in reversed(self.of(field_id)) if event.event == name)

    def all_of(self, field_id: str, name: str) -> list[FieldEvent]:
        return [event for event in self.of(field_id) if event.event == name]


def validate_events(events: Iterable[FieldEvent]) -> None:
    """Cada evento cumple el modelo del contrato para su nombre."""
    for event in events:
        EVENT_ADAPTERS[event.event].validate_python(event.data)


# -------------------------------------------------------------------- conjunto


def make_settings(root: Path, **overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "data_dir": root / "data",
        "cache_dir": root / "cache",
        # Sin tope: en los tests los `progress` no dependen del reloj, salvo en el que lo prueba.
        "progress_events_per_s": 1e9,
        # La vista de WISE viene desactivada por defecto; estos tests la prueban con un doble.
        "preview_enabled": True,
    }
    values.update(overrides)
    return Settings(**values)


@dataclass
class Harness:
    """Un gestor de trabajos con todo lo externo reemplazado."""

    settings: Settings
    store: FieldStore
    bus: RecordingBus
    clock: FakeClock
    irsa: FakeIrsa
    pipeline: FakePipeline
    preview: FakePreview
    manager: JobManager
    extra: dict[str, Any] = field(default_factory=dict)

    def request(self, ra: float = 10.0, dec: float = 20.0, band: int = 3, refresh: bool = False) -> NormalizedRequest:
        return geometry.normalize_request(ra, dec, None, band, refresh)

    def run(self, request: NormalizedRequest | None = None, timeout: float = WAIT_S) -> FieldMeta:
        """Pide un campo, espera a que el gestor quede sin trabajo y devuelve el documento que quedo."""
        request = request or self.request()
        self.manager.submit(request)
        assert self.manager.wait_idle(timeout), "el trabajo no termino a tiempo"
        return self.manager.get_meta(request.field_id)

    def release(self) -> None:
        """Abre todo lo que un test pudo dejar retenido, para que ningun hilo quede esperando."""
        if self.irsa.gate is not None:
            self.irsa.gate.set()
        self.irsa.resume.set()
        if self.irsa.list_gate is not None:
            self.irsa.list_gate.set()
        self.preview.gate.set()
        if self.pipeline.gate is not None:
            self.pipeline.gate.set()

    def close(self) -> None:
        self.manager.shutdown(timeout=5.0)


def make_harness(
    root: Path,
    counts: Mapping[Key, int] | None = None,
    *,
    auto_clock: bool = True,
    preview: str = "ready",
    max_pending: int = 256,
    deps: Mapping[str, Any] | None = None,
    **settings: Any,
) -> Harness:
    """Arma un gestor sobre `root` con exposiciones sinteticas (`counts`: cuantas por plano)."""
    config = make_settings(root, **settings)
    store = FieldStore.from_settings(config)
    bus = RecordingBus(max_pending)
    clock = FakeClock(auto=auto_clock)
    irsa = FakeIrsa(make_exposures(counts if counts is not None else {(1, 3): 4, (2, 3): 4}))
    irsa.clock = clock
    pipeline = FakePipeline()
    wise = FakePreview(preview)
    functions: dict[str, Any] = {
        "list_exposures": irsa.list_exposures,
        "fetch_cutout": irsa.fetch_cutout,
        "discard_cutout": irsa.discard_cutout,
        "prune_cutout_cache": irsa.prune_cutout_cache,
        "fetch_preview": wise.fetch_preview,
        "load_exposure": pipeline.load_exposure,
        "clock": clock,
        "wait": clock.wait,
    }
    functions.update(deps or {})
    manager = JobManager(config, store, bus, JobDeps(**functions))

    def settle_preview(ra: float, dec: float) -> None:
        """La lista no vuelve hasta que la vista provisoria quedo resuelta.

        La vista se pide en otro hilo: sin esto, el evento `preview` podria caer
        en cualquier lugar de la secuencia (o despues del final de un trabajo
        muy corto) y los tests no podrian fijar el orden. Asi sale siempre entre
        el `progress` de `listing` y `listed`, salvo en el modo `slow`.
        """
        if wise.mode == "slow":
            return
        field_id = geometry.normalize_request(ra, dec).field_id

        def settled() -> bool:
            try:
                return manager.get_meta(field_id).preview.status != "pending"
            except ApiError:
                return True

        wait_until(settled, 5.0, "la vista provisoria no se resolvio")

    irsa.before_list = settle_preview
    return Harness(
        settings=config, store=store, bus=bus, clock=clock, irsa=irsa, pipeline=pipeline, preview=wise, manager=manager
    )


def manager_threads() -> list[str]:
    """Nombres de los hilos del gestor (trabajos, descargas y vistas provisorias) que siguen vivos."""
    return sorted(thread.name for thread in threading.enumerate() if thread.name.startswith("spherex-"))


# ----------------------------------------------------------- para cada modulo


HarnessFactory = Callable[..., Harness]


@contextlib.contextmanager
def harness_factory(tmp_path: Path) -> Iterator[HarnessFactory]:
    """Fabrica de gestores para un test: los que arma se detienen al salir, pase o falle el test.

    Cada modulo de tests la envuelve en su fixture `build`. La fabrica recibe lo
    mismo que `make_harness`; con `root` se elige otra carpeta que `tmp_path`.
    """
    created: list[Harness] = []

    def factory(counts: Mapping[Key, int] | None = None, **options: Any) -> Harness:
        root = options.pop("root", tmp_path)
        harness = make_harness(root, counts, **options)
        created.append(harness)
        return harness

    try:
        yield factory
    finally:
        for item in created:
            item.release()
            item.close()
        # Ningun test deja hilos del gestor corriendo.
        wait_until(lambda: not manager_threads(), 10.0, f"quedaron hilos del gestor: {manager_threads()}")


def replay(events: list[FieldEvent]) -> dict[str, Any] | None:
    """Aplica los eventos como lo hace el frontend (frontend/src/data/fieldEvents.ts) y devuelve el documento."""
    meta: dict[str, Any] | None = None
    for event in events:
        data = copy.deepcopy(dict(event.data))
        if event.event in ("state", "listed"):
            meta = data
        elif meta is None:
            continue
        elif event.event == "queued":
            meta["progress"]["queue_position"] = data["position"]
        elif event.event == "preview":
            meta["preview"] = data
        elif event.event == "progress":
            meta["progress"] = data
            if meta["status"] in ("queued", "listing", "downloading"):
                meta["status"] = {"queued": "queued", "listing": "listing"}.get(data["phase"], "downloading")
        elif event.event == "plane":
            plane = data["plane"]
            for index, current in enumerate(meta["planes"]):
                if (current["epoch"], current["detector"]) == (plane["epoch"], plane["detector"]):
                    if plane["rev"] >= current["rev"]:
                        meta["planes"][index] = plane
            display = data["detector_display"]
            if display is not None:
                for detector in meta["detectors"]:
                    if detector["detector"] == display["detector"]:
                        detector["display"] = {key: value for key, value in display.items() if key != "detector"}
        elif event.event == "warning":
            if data not in meta["warnings"]:
                meta["warnings"].append(data)
        elif event.event == "done":
            meta["status"] = data["status"]
            meta["rev"] = data["rev"]
        elif event.event == "error":
            meta["status"] = "failed"
    return meta


def planes_of(events: list[FieldEvent]) -> list[tuple[int, int, str, int, int]]:
    """(epoca, detector, estado, rev, n_used) de cada evento `plane`, en orden."""
    return [
        (item["epoch"], item["detector"], item["status"], item["rev"], item["n_used"])
        for item in (event.data["plane"] for event in events if event.event == "plane")
    ]


def expected_plane(harness: Harness, obs_ids: list[str], **options: Any) -> Any:
    """El coadd que da el pipeline con esas exposiciones sinteticas, en ese orden."""
    grid = geometry.build_grid(harness.request())
    accumulator = PlaneAccumulator(grid, len(obs_ids))
    for obs_id in obs_ids:
        accumulator.add(synthetic_exposure(obs_id, grid, **options))
    return accumulator.snapshot()
