"""Gestor de trabajos: cola, planificacion de descargas y entrega progresiva (contrato, secciones 8 a 11).

Un trabajo arma un campo: lista exposiciones, pide la vista provisoria, baja
los recortes en el orden de la seccion 8, acumula cada plano, emite revisiones
provisorias y definitivas y deja todo en el `FieldStore`. El trabajo en si esta
en `app.jobs.job.FieldJob`; aca estan la cola, los hilos de descarga y lo que
usan las rutas.

Hilos:

- Uno por trabajo activo (`FieldJob.run`), mas uno corto para su vista
  provisoria. Hasta `settings.max_active_jobs` trabajos a la vez.
- `settings.max_cutout_downloads` hilos de descarga para todo el gestor,
  compartidos por los trabajos activos. Cada uno toma el proximo recorte
  listo, alternando de trabajo: con dos activos las conexiones se reparten por
  turnos y uno grande no frena al otro. Arrancan con el primer trabajo.

Limite hacia IRSA: nunca hay mas descargas que hilos de descarga, y ademas
`fetch_cutout` toma por su cuenta el cupo global del proceso
(`get_limiter(settings).cutout_slot()`) mientras baja. Por eso aca no se lo
vuelve a tomar alrededor de la llamada: el semaforo no es reentrante, cada
descarga ocuparia dos lugares y diez hilos con uno cada uno se trabarian
esperando el segundo. Lo mismo vale para `list_exposures` y el cupo de SIA2.

Reintentos (`app.jobs.plan.after_failure`): `fetch_cutout` hace un intento.
Ante `IrsaBusy` el recorte vuelve a la cola con la hora antes de la cual no se
lo puede pedir, y el hilo sigue con otro: la espera no ocupa conexion.

Para las rutas: `submit`, `get_meta`, `subscribe` (devuelve un `FieldStream`),
`set_priority` y `shutdown` son la interfaz acordada. `read_plane` y `read_aux`
entregan los bytes de un plano junto con la entrada de `planes[]` de esa misma
revision; conviene usarlas en vez de leer el almacen despues de `get_meta`.

Lo que el servidor falso (`app.fake`) ya hace y este gestor hace igual, porque
el frontend se desarrollo contra el:

- `listed`: los planos sin exposiciones ya van `empty` (no tienen evento
  `plane`) y los demas `pending`. `flags` va como lista vacia hasta leer el
  encabezado del primer recorte; `provenance.download_mode`, `null`.
- Revisiones de un plano: la provisoria es la 1 y la definitiva la 2 o una
  posterior. Un plano que se emite una sola vez queda en la 1. Un plano sin
  exposiciones queda en la 0. (Si el campo ya tuvo un intento que no termino,
  o es un `refresh`, la numeracion sigue desde la revision que tenia cada
  plano: el binario de una revision ya servida no cambia nunca.)
- `progress`: `planes_total` y `planes_ready` cuentan tambien los planos
  `empty`; `cutouts_done` no incluye los fallidos (ver `contract.Progress`).
- Al terminar, antes de `done`, se emite un `state` con el documento final: es
  el unico evento que lleva `cube_offset`, `flags` completo y
  `provenance.built_at`.
- Si el trabajo falla: evento `error` con el cuerpo `{"error": {...}}`,
  `status: "failed"` y `progress.phase` en la fase en la que estaba. Lo que no
  se construyo responde `409 not_ready` con `retryable: false`.
- La vista provisoria queda con la banda del pedido que creo el trabajo
  (`preview.hips2fits.preview_band`), aunque despues cambie la prioridad.
- `?rev=N` es `immutable` solo si N es la revision vigente; si no, se devuelve
  la vigente con `no-cache`.
"""

from __future__ import annotations

import contextlib
import logging
import threading
import time
from collections import OrderedDict, deque
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.api.errors import ApiError, invalid_request, no_coverage, not_found, queue_full, upstream_unavailable
from app.config import Settings
from app.contract import FINISHED_FIELD_STATUSES, DoneEvent, FieldMeta, PlaneInfo
from app.domain import NormalizedRequest
from app.irsa.cutouts import IrsaError
from app.jobs.deps import JobDeps
from app.jobs.document import parse_timestamp
from app.jobs.events import CLOSING_EVENTS, EventBus, FieldEvent, Subscription
from app.jobs.job import CutoutArrived, CutoutLost, FieldJob
from app.jobs.plan import CutoutTask, GiveUp, after_failure
from app.jobs.store import META_FILENAME, FieldStore, StoreError

logger = logging.getLogger(__name__)

# `Retry-After` de `queue_full`, en segundos.
QUEUE_FULL_RETRY_S = 30.0
# Trabajos fallidos que se recuerdan para responder `state` y `error` a quien llegue despues.
MAX_FAILED_KEPT = 64
# Documentos de campos terminados que se guardan ya leidos.
MAX_STORED_CACHED = 64
# Puntos sin cobertura que se recuerdan.
MAX_NO_COVERAGE_KEPT = 1024

# Lo que hace falta para abrir un flujo: el `state` inicial, el evento de cierre si el campo ya
# termino o fallo, y la suscripcion al bus si el trabajo sigue.
_Opening = tuple[FieldEvent, FieldEvent | None, Subscription | None]
# `FieldStore.read_plane_bytes`, `read_aux_bytes` o `read_aux_gzip`.
_BinaryReader = Callable[..., bytes]


@dataclass(frozen=True)
class QueueState:
    """Foto de la cola del gestor, para diagnostico y tests."""

    active: tuple[str, ...]  # `id` de los campos con un trabajo en curso, en el orden en que arrancaron
    waiting: tuple[str, ...]  # los que esperan turno, por orden de llegada
    refreshing: tuple[str, ...]  # campos terminados que se estan armando de nuevo
    pending_cutouts: dict[str, int]  # por campo activo, recortes que todavia no se pidieron o esperan un reintento


class FieldStream:
    """Flujo de eventos de un campo para una conexion: `state`, lo que publique el trabajo y fin.

    Es un iterador asincrono que no es un generador, a proposito: cancelar una
    espera de `anext()` no lo termina ni le hace perder eventos, asi que la ruta
    puede esperar cada evento con un tope de tiempo para intercalar el `: ping`.
    Termina despues de `done` o `error`, o cuando el gestor se detiene.
    """

    def __init__(self, manager: JobManager, field_id: str, opening: _Opening) -> None:
        self._manager = manager
        self._field_id = field_id
        self._ready: deque[FieldEvent] = deque()
        self._subscription: Subscription | None = None
        self._finished = False
        self._load(opening)

    def _load(self, opening: _Opening) -> None:
        state, closing, subscription = opening
        self._ready.append(state)
        if closing is not None:
            self._ready.append(closing)
        self._subscription = subscription
        self._finished = subscription is None

    def __aiter__(self) -> FieldStream:
        return self

    async def __anext__(self) -> FieldEvent:
        while True:
            if self._ready:
                return self._ready.popleft()
            subscription = self._subscription
            if self._finished or subscription is None:
                raise StopAsyncIteration
            try:
                event = await subscription.__anext__()
            except StopAsyncIteration:
                self._subscription = None
                self._finished = True
                if subscription.lagged:
                    # Quien lee se atraso y el bus le descarto eventos: documento nuevo y sigue desde ahi.
                    with contextlib.suppress(ApiError):
                        self._load(self._manager._open_stream(self._field_id))
                continue  # si no se atraso, el gestor se detuvo y cerro el flujo
            if event.event in CLOSING_EVENTS:
                self.close()
            return event

    def close(self) -> None:
        """Deja de recibir eventos. Lo que ya estaba por entregarse todavia se entrega."""
        subscription, self._subscription = self._subscription, None
        self._finished = True
        if subscription is not None:
            subscription.close()

    async def aclose(self) -> None:
        self._ready.clear()
        self.close()

    def __del__(self) -> None:
        # Un flujo que se abandona sin cerrar no queda anotado en el bus.
        with contextlib.suppress(Exception):
            self.close()


class JobManager:
    """Cola de trabajos con limite global hacia IRSA.

    - Hasta `settings.max_active_jobs` trabajos a la vez; los demas esperan por
      orden de llegada, hasta `settings.max_queued_jobs`.
    - Dos pedidos del mismo campo comparten un unico trabajo.
    - Con dos trabajos activos, las conexiones se reparten por turnos.
    - El trabajo no depende de ninguna conexion: si el navegador se va, sigue y
      queda en cache.
    """

    def __init__(
        self, settings: Settings, store: FieldStore, bus: EventBus | None = None, deps: JobDeps | None = None
    ) -> None:
        """Crea el gestor sin arrancar ningun hilo.

        `deps` reemplaza las funciones externas (IRSA, hips2fits, pipeline,
        reloj y espera); por defecto, las reales. Al crearlo se aplica el tope
        de disco de la cache de recortes.
        """
        self._settings = settings
        self._store = store
        self._bus = bus if bus is not None else EventBus()
        self._deps = deps if deps is not None else JobDeps()

        # Un solo candado para la cola y para lo que reparten los hilos de descarga.
        self._lock = threading.RLock()
        self._cond = threading.Condition(self._lock)
        self._jobs: dict[str, FieldJob] = {}  # trabajos en la cola, en curso o fallidos
        self._refreshing: dict[str, FieldJob] = {}  # `refresh` en curso de campos terminados
        self._waiting: deque[FieldJob] = deque()
        self._active: list[FieldJob] = []
        self._failed: deque[str] = deque()
        self._workers: list[threading.Thread] = []
        self._turn = 0
        self._stopping = False
        self._no_coverage: OrderedDict[tuple[float, float], datetime] = OrderedDict()
        self._stored_lock = threading.Lock()
        self.swap_lock = threading.Lock()  # ver `JobHost.swap_lock`
        self._stored_cache: OrderedDict[str, tuple[tuple[str, int, int], FieldMeta]] = OrderedDict()
        self._prune()

    @property
    def settings(self) -> Settings:
        return self._settings

    @property
    def store(self) -> FieldStore:
        return self._store

    @property
    def bus(self) -> EventBus:
        return self._bus

    # ------------------------------------------------------------------ pedidos

    def submit(self, request: NormalizedRequest) -> FieldMeta:
        """Pide un campo y devuelve su documento de metadatos actual. Es idempotente.

        - Si el campo esta en el almacen y terminado, devuelve sus metadatos sin
          tocar IRSA (salvo `request.refresh`, que vuelve a listar exposiciones
          mientras se sigue sirviendo la revision anterior).
        - Si ya hay un trabajo para ese `field_id`, se suma a el y, si
          `request.band` cambio, adelanta esa banda.
        - Si no, crea el trabajo en estado `queued` con `request.band` como
          banda prioritaria.

        Lanza `ApiError` `queue_full` (con `Retry-After`) si la cola esta llena.
        Quien llama responde 200 si `status` es `ready` o `partial`, y 202 si no.

        Tambien lanza `no_coverage` si un trabajo anterior ya encontro, con una
        lista de exposiciones todavia vigente, que ninguna cubre el punto (salvo
        `request.refresh`), y `upstream_unavailable` si el gestor se esta
        deteniendo. Un campo que quedo a medio armar o fallido no cuenta como
        existente: se arma de nuevo. Sobre un campo precalculado `refresh` se
        ignora.
        """
        field_id = request.field_id
        with self._lock:
            if self._stopping:
                raise upstream_unavailable("el backend se esta deteniendo")
            job = self._jobs.get(field_id)
            if job is not None and job.in_flight:
                if request.band != job.band:
                    self._reprioritize(job, request.band)
                return job.snapshot()
            stored = self._stored(field_id)
            if stored is not None:
                if request.refresh and not self._settings.precomputed_only:
                    self._start_refresh(request, stored)
                return stored
            if self._settings.precomputed_only:
                # Despliegue publico: solo lo que ya esta armado, sin trabajos ni pedidos a IRSA.
                raise not_found("este servidor solo sirve los campos precalculados")
            if not request.refresh:
                self._check_no_coverage(request)
            self._check_capacity()
            # Un intento anterior que no termino (fallido, o de otra corrida del backend) deja la
            # revision de cada plano: este trabajo sigue numerando desde ahi.
            previous = job.snapshot() if job is not None else self._leftover(field_id)
            job = FieldJob(
                self,
                request,
                self._settings,
                self._store,
                self._bus,
                self._deps,
                position=len(self._waiting) + 1,
                list_refresh=request.refresh,
                previous=previous,
            )
            # Si habia un trabajo fallido de este campo, este lo reemplaza: es el reintento.
            self._jobs[field_id] = job
            job.announce()
            self._waiting.append(job)
            snapshot = job.snapshot()
            self._pump()
            return snapshot

    def get_meta(self, field_id: str) -> FieldMeta:
        """Documento de metadatos del campo en su estado actual, este en curso o terminado.

        Lanza `ApiError` `not_found` si no existe ni como trabajo ni en el almacen.
        Durante un `refresh` devuelve el de la revision anterior. Un campo a
        medio armar de una corrida anterior del backend no existe hasta que otro
        `POST` lo vuelva a pedir.
        """
        with self._lock:
            job = self._jobs.get(field_id)
            if job is not None:
                return job.snapshot()
        # Fuera del candado: un trabajo que termina escribe el documento final antes de soltarse.
        stored = self._stored(field_id)
        if stored is None:
            raise not_found(f"no existe el campo {field_id!r}")
        return stored

    def subscribe(self, field_id: str) -> AsyncIterator[FieldEvent]:
        """Flujo de eventos de un campo para una conexion SSE.

        El primer evento es siempre `state`, con el documento completo. Si el
        campo ya estaba terminado, siguen `done` y el fin del flujo. Si no,
        siguen los eventos del trabajo hasta `done` o `error`; justo antes de
        `done` va otro `state`, con el documento terminado. El comentario
        `: ping` lo agrega la ruta.

        Lanza `ApiError` `not_found` si el campo no existe.

        La comprobacion y la suscripcion se hacen al llamar, no al empezar a
        recorrer el iterador. Lo que devuelve es un `FieldStream`: se puede
        cancelar una espera de `anext()` (por ejemplo con `asyncio.wait_for`,
        para mandar el `: ping`) y volver a pedir sin perder eventos. Si quien
        lee se atrasa tanto que el bus le descarta eventos, recibe otro `state`,
        que reemplaza todo lo anterior, y sigue desde ahi. Al dejar de leer
        antes del final conviene cerrarlo (`aclose()`).
        """
        return FieldStream(self, field_id, self._open_stream(field_id))

    def set_priority(self, field_id: str, band: int) -> None:
        """Reordena los planos pendientes para que los de `band` se construyan antes.

        No hace nada si el trabajo ya termino. Lanza `ApiError` `not_found` si
        el campo no existe.
        """
        if isinstance(band, bool) or not isinstance(band, int) or not 1 <= band <= 6:
            raise invalid_request(f"band={band!r} fuera de rango: se admite de 1 a 6")
        with self._lock:
            job = self._jobs.get(field_id)
            if job is not None:
                if job.in_flight:
                    self._reprioritize(job, band)
                return
        if self._stored(field_id) is None:
            raise not_found(f"no existe el campo {field_id!r}")

    def read_plane(self, field_id: str, epoch: int, detector: int) -> tuple[bytes, PlaneInfo]:
        """Bytes de `/plane/{e}/{d}` en su revision vigente y la entrada de `planes[]` que les corresponde.

        Las dos cosas se leen juntas: con un trabajo en curso, pedir primero los
        metadatos y despues el archivo puede cruzarse con una revision nueva y
        rotular los bytes con la `rev` anterior, que despues queda en la cache
        del navegador como `immutable`. Lanza `not_ready` si el plano esta en
        `pending` (con `retryable` en falso si el trabajo fallo) y `not_found`
        si el campo o el plano no existen o el plano esta `empty`.
        """
        return self._read_binary(field_id, epoch, detector, self._store.read_plane_bytes)

    def read_aux(self, field_id: str, epoch: int, detector: int, *, gzipped: bool = False) -> tuple[bytes, PlaneInfo]:
        """Bytes de `/aux/{e}/{d}` (o su gzip, con `gzipped`) y la entrada de `planes[]` de esa misma revision.

        Mismos errores que `read_plane`.
        """
        reader = self._store.read_aux_gzip if gzipped else self._store.read_aux_bytes
        return self._read_binary(field_id, epoch, detector, reader)

    def _read_binary(self, field_id: str, epoch: int, detector: int, reader: _BinaryReader) -> tuple[bytes, PlaneInfo]:
        with self._lock:
            job = self._jobs.get(field_id)
        if job is not None:
            # Con el candado del trabajo: una revision nueva cambia el archivo y el documento sin soltarlo.
            with job.lock:
                return self._read_checked(job.meta, epoch, detector, reader)
        # Campo terminado: solo un `refresh` lo reescribe, y lo hace con este candado tomado.
        with self.swap_lock:
            stored = self._stored(field_id)
            if stored is None:
                raise not_found(f"no existe el campo {field_id!r}")
            return self._read_checked(stored, epoch, detector, reader)

    def _read_checked(
        self, meta: FieldMeta, epoch: int, detector: int, reader: _BinaryReader
    ) -> tuple[bytes, PlaneInfo]:
        where = f"el plano de la epoca {epoch} y el detector {detector}"
        failed = meta.status == "failed"
        plane = meta.plane(epoch, detector)
        listed = meta.planes is not None and meta.grid is not None
        if listed and plane is None:
            raise not_found(f"el campo {meta.id!r} no tiene {where}")
        if plane is None or meta.grid is None or plane.status == "pending":
            # Si el trabajo fallo no va a estar: repetir el pedido no sirve hasta que otro `POST` lo reintente.
            raise ApiError(
                "not_ready",
                message=f"{where} todavia no esta construido" + ("; el trabajo fallo" if failed else ""),
                retryable=False if failed else None,
            )
        if plane.status == "empty":
            raise not_found(f"{where} esta vacio: no tiene binario")
        try:
            data = reader(meta.id, epoch, detector, shape=meta.grid.shape)
        except StoreError as exc:
            raise not_found(str(exc)) from exc
        return data, plane.model_copy(deep=True)

    def queue_state(self) -> QueueState:
        """Que trabajos hay en curso y en la cola, y cuantos recortes le falta pedir a cada uno."""
        with self._lock:
            return QueueState(
                active=tuple(job.field_id for job in self._active),
                waiting=tuple(job.field_id for job in self._waiting),
                refreshing=tuple(self._refreshing),
                pending_cutouts={job.field_id: len(job.queue) for job in self._active},
            )

    def wait_idle(self, timeout: float | None = None) -> bool:
        """Espera a que no quede ningun trabajo en curso ni en la cola. Devuelve False si paso `timeout`.

        Es para los scripts que arman campos (el de precalculo) y para los tests.
        """
        with self._cond:
            return self._cond.wait_for(lambda: not self._active and not self._waiting, timeout)

    def shutdown(self, timeout: float = 10.0) -> None:
        """Detiene los trabajos en curso y espera a que terminen sus hilos.

        Los trabajos cortan donde estan, sin publicar `error`: lo que dejaron en
        el almacen queda a medio armar y se rehace cuando se vuelva a pedir (los
        recortes ya bajados estan en la cache). Los flujos abiertos terminan.
        Espera a los hilos hasta `timeout` segundos en total; uno que este en
        medio de un pedido a IRSA termina solo cuando ese pedido vuelve.
        """
        with self._cond:
            self._stopping = True
            jobs = [*self._active, *self._waiting, *self._refreshing.values()]
            self._waiting.clear()
            for job in jobs:
                job.stop()
                job.queue.clear()
                with job.lock:
                    if job.state == "queued":
                        job.state = "stopped"
            threads = list(self._workers)
            for job in jobs:
                threads.extend(thread for thread in (job.thread, job.preview_thread) if thread is not None)
            self._cond.notify_all()
        deadline = time.monotonic() + max(0.0, timeout)
        current = threading.current_thread()
        for thread in threads:
            if thread is not current:
                thread.join(max(0.0, deadline - time.monotonic()))
        with self._cond:
            for job in jobs:
                self._bus.close(job.field_id)
            self._jobs.clear()
            self._refreshing.clear()
            self._cond.notify_all()

    # --------------------------------------------------- lo que usa `FieldJob`

    def enqueue_cutouts(self, job: FieldJob, tasks: Sequence[CutoutTask]) -> None:
        """Pone recortes de `job` a disposicion de los hilos de descarga."""
        with self._cond:
            if not job.accepting:
                return
            job.queue.add(tasks)
            self._cond.notify_all()

    def job_finished(self, job: FieldJob, final: FieldMeta) -> None:
        """El trabajo dejo el campo terminado en el almacen: publica `state` y `done` y lo suelta."""
        with self._lock:
            with job.lock:
                job.meta = final
                job.state = "done"
                job.publish("state", final)
                done = DoneEvent(status=final.status, rev=final.rev, elapsed_s=final.progress.elapsed_s)  # type: ignore[arg-type]
                job.publish("done", done)
            # Desde aca el campo se sirve del almacen.
            if self._jobs.get(job.field_id) is job:
                del self._jobs[job.field_id]
            self._bus.close(job.field_id)
        self._forget_stored(job.field_id)

    def job_failed(self, job: FieldJob, error: ApiError) -> None:
        """El trabajo no puede continuar: publica `error` y lo deja a la vista hasta que se reintente."""
        with self._lock:
            with job.lock:
                job.state = "failed"
                job.closing = job.publish("error", error.body())
            self._bus.close(job.field_id)
            if error.code == "no_coverage":
                self._remember_no_coverage(job)
            if self._jobs.get(job.field_id) is job:
                self._failed.append(job.field_id)
                while len(self._failed) > MAX_FAILED_KEPT:
                    old = self._jobs.get(self._failed.popleft())
                    if old is not None and old is not job and old.state == "failed":
                        del self._jobs[old.field_id]

    def refresh_finished(self, job: FieldJob, changed: bool) -> None:
        """Termino un `refresh`. Si reemplazo planos, el documento guardado ya es el nuevo."""
        with self._lock:
            with job.lock:
                job.state = "done"
        self._forget_stored(job.field_id)
        if changed:
            logger.info("refresh del campo %s: hay una revision nueva", job.field_id)

    # ---------------------------------------------------------------------- cola

    def _check_capacity(self) -> None:
        if len(self._active) < self._settings.max_active_jobs:
            return
        if len(self._waiting) >= self._settings.max_queued_jobs:
            raise queue_full(
                f"cola de trabajos llena: {len(self._active)} en curso y {len(self._waiting)} esperando",
                retry_after=QUEUE_FULL_RETRY_S,
            )

    def _start_refresh(self, request: NormalizedRequest, stored: FieldMeta) -> None:
        """Arma de nuevo un campo terminado en un trabajo aparte, mientras se sigue sirviendo el guardado."""
        field_id = request.field_id
        if field_id in self._refreshing:
            return
        if self._is_precomputed(field_id):
            return  # los campos precalculados se regeneran con su script
        self._check_capacity()
        job = FieldJob(self, request, self._settings, self._store, self._bus, self._deps, position=0, base=stored)
        self._refreshing[field_id] = job
        self._waiting.append(job)
        self._pump()

    def _is_precomputed(self, field_id: str) -> bool:
        folder = self._store.locate(field_id)
        return folder is not None and _resolved(folder.parent) != _resolved(self._store.write_root)

    def _pump(self) -> None:
        """Arranca los trabajos que entran en los lugares libres y avisa a los demas su posicion. Con el candado."""
        if self._stopping:
            return
        while self._waiting and len(self._active) < self._settings.max_active_jobs:
            job = self._waiting.popleft()
            self._active.append(job)
            job.promote()
            thread = threading.Thread(
                target=self._run_job, args=(job,), name=f"spherex-job-{job.field_id}", daemon=True
            )
            job.thread = thread
            self._ensure_workers()
            thread.start()
        for position, job in enumerate(self._waiting, start=1):
            job.set_queue_position(position)

    def _run_job(self, job: FieldJob) -> None:
        try:
            job.run()
        except BaseException:
            logger.exception("el hilo del campo %s termino con una excepcion", job.field_id)
        finally:
            if not self._stopping:
                self._prune()
            with self._cond:
                if job in self._active:
                    self._active.remove(job)
                job.queue.clear()
                if self._refreshing.get(job.field_id) is job:
                    del self._refreshing[job.field_id]
                self._pump()
                self._cond.notify_all()

    def _reprioritize(self, job: FieldJob, band: int) -> None:
        """Cambia la banda prioritaria de un trabajo y reordena lo que le falta pedir. Con el candado."""
        with self._cond:
            if job.band == band:
                return
            job.band = band
            job.queue.reprioritize(band)
            self._cond.notify_all()

    def _prune(self) -> None:
        """Aplica el tope de disco de la cache de recortes (contrato, seccion 11)."""
        try:
            self._deps.prune_cutout_cache(self._settings)
        except Exception:
            logger.exception("no se pudo aplicar el tope de disco de la cache de recortes")

    # ---------------------------------------------------------------- descargas

    def _ensure_workers(self) -> None:
        if self._workers:
            return
        for number in range(1, self._settings.max_cutout_downloads + 1):
            thread = threading.Thread(target=self._worker, name=f"spherex-download-{number}", daemon=True)
            self._workers.append(thread)
            thread.start()

    def _worker(self) -> None:
        """Hilo de descarga: toma el proximo recorte listo, de un trabajo por vez, y lo baja."""
        while True:
            with self._cond:
                while True:
                    if self._stopping:
                        return
                    task, delay = self._next_task(self._deps.clock())
                    if task is not None:
                        break
                    self._deps.wait(self._cond, delay)
            try:
                self._fetch(task)
            except Exception as exc:
                # Un hilo de descarga no puede morir ni dejar un recorte sin resolver: el trabajo lo esperaria siempre.
                logger.exception("fallo inesperado al repartir un recorte del campo %s", task.job.field_id)
                with self._cond:
                    if task.job.accepting:
                        reason = f"falla interna: {type(exc).__name__}: {exc}"
                        task.job.inbox.put(CutoutLost(task=task, kind="permanent", reason=reason))

    def _next_task(self, now: float) -> tuple[CutoutTask | None, float | None]:
        """El proximo recorte a pedir, o cuanto falta para que haya uno listo. Con el candado.

        Los trabajos activos se recorren por turnos a partir del siguiente al
        ultimo atendido.
        """
        count = len(self._active)
        soonest: float | None = None
        for offset in range(count):
            position = (self._turn + offset) % count
            job = self._active[position]
            if not job.accepting:
                continue
            task = job.queue.pop_ready(now)
            if task is not None:
                self._turn = (position + 1) % count
                return task, None
            due = job.queue.next_due()
            if due is not None and (soonest is None or due < soonest):
                soonest = due
        return None, (None if soonest is None else max(soonest - now, 0.0))

    def _fetch(self, task: CutoutTask) -> None:
        """Un intento de bajar un recorte. El resultado va al trabajo o, si toca reintentar, de vuelta a la cola."""
        job: FieldJob = task.job
        request = job.request
        error: BaseException | None = None
        cutout = None
        try:
            cutout = self._deps.fetch_cutout(task.exposure, request.ra, request.dec, job.side_deg, self._settings)
        except IrsaError as exc:
            error = exc
        except Exception as exc:
            # `fetch_cutout` solo lanza `IrsaError`; cualquier otra cosa se trata como un corte.
            logger.exception("fallo inesperado al pedir un recorte del campo %s", job.field_id)
            error = exc
        with self._cond:
            task.attempts += 1
            if not job.accepting:
                return
            if cutout is not None:
                job.inbox.put(CutoutArrived(task=task, cutout=cutout))
                return
            assert error is not None
            reason = f"{type(error).__name__}: {error}"
            decision = after_failure(task, error, self._settings)
            if isinstance(decision, GiveUp):
                job.inbox.put(CutoutLost(task=task, kind=decision.kind, reason=reason))
                return
            # Vuelve a la cola con la hora antes de la cual no se lo pide: mientras tanto este hilo sigue con otro.
            task.error = reason
            task.not_before = self._deps.clock() + decision.wait_s
            job.queue.add([task])
            self._cond.notify_all()

    # ------------------------------------------------------------------- flujos

    def _open_stream(self, field_id: str) -> _Opening:
        with self._lock:
            job = self._jobs.get(field_id)
            if job is not None:
                with job.lock:
                    data = job.meta.model_dump(mode="json")
                    if job.closing is not None:
                        # Trabajo fallido: `state` y el mismo `error`.
                        closing = job.closing
                        return (
                            FieldEvent(closing.id, "state", data),
                            FieldEvent(closing.id + 1, closing.event, closing.data),
                            None,
                        )
                    if job.in_flight:
                        # Documento y suscripcion con el candado del trabajo: no se pierde ni se repite ningun evento.
                        subscription = self._bus.subscribe(field_id)
                        assert isinstance(subscription, Subscription)
                        return FieldEvent(max(self._bus.last_id(field_id), 1), "state", data), None, subscription
        stored = self._stored(field_id)
        if stored is None:
            raise not_found(f"no existe el campo {field_id!r}")
        done = DoneEvent(status=stored.status, rev=stored.rev, elapsed_s=stored.progress.elapsed_s)  # type: ignore[arg-type]
        return (
            FieldEvent(1, "state", stored.model_dump(mode="json")),
            FieldEvent(2, "done", done.model_dump(mode="json")),
            None,
        )

    # ------------------------------------------------------------------ almacen

    def _stored(self, field_id: str) -> FieldMeta | None:
        """Documento de un campo terminado del almacen, o `None` si no esta o no termino.

        Devuelve una copia. Lo leido se guarda mientras `meta.json` no cambie.
        """
        folder = self._store.locate(field_id)
        if folder is None:
            return None
        try:
            stat = (folder / META_FILENAME).stat()
        except OSError:
            return None
        stamp = (str(folder), stat.st_mtime_ns, stat.st_size)
        with self._stored_lock:
            cached = self._stored_cache.get(field_id)
            meta = cached[1] if cached is not None and cached[0] == stamp else None
        if meta is None:
            try:
                meta = self._store.read_meta(field_id)
            except StoreError as exc:
                logger.warning("campo %s ilegible en el almacen: %s", field_id, exc)
                return None
            with self._stored_lock:
                self._stored_cache[field_id] = (stamp, meta)
                self._stored_cache.move_to_end(field_id)
                while len(self._stored_cache) > MAX_STORED_CACHED:
                    self._stored_cache.popitem(last=False)
        # Lo que quedo a medio armar o fallido de otra corrida no cuenta: se arma de nuevo.
        if meta.status not in FINISHED_FIELD_STATUSES or meta.planes is None or meta.grid is None:
            return None
        return meta.model_copy(deep=True)

    def _leftover(self, field_id: str) -> FieldMeta | None:
        """Documento que dejo en el almacen un intento anterior del campo, este como este; `None` si no hay."""
        try:
            return self._store.read_meta(field_id)
        except StoreError:
            return None

    def _forget_stored(self, field_id: str) -> None:
        """Olvida el documento leido de un campo que este gestor acaba de reescribir.

        La fecha de `meta.json` avanza de a milisegundos: dos escrituras seguidas
        del mismo tamanio podrian parecer el mismo archivo.
        """
        with self._stored_lock:
            self._stored_cache.pop(field_id, None)

    # ------------------------------------------------------------ sin cobertura

    def _remember_no_coverage(self, job: FieldJob) -> None:
        """Anota que ninguna exposicion cubre ese punto, mientras siga vigente la lista que lo dijo."""
        listed = parse_timestamp(job.no_coverage_listed_at or "")
        if listed is None:
            return
        key = (job.request.ra, job.request.dec)
        self._no_coverage[key] = listed + timedelta(hours=self._settings.exposure_list_cache_hours)
        self._no_coverage.move_to_end(key)
        while len(self._no_coverage) > MAX_NO_COVERAGE_KEPT:
            self._no_coverage.popitem(last=False)

    def _check_no_coverage(self, request: NormalizedRequest) -> None:
        key = (request.ra, request.dec)
        expires = self._no_coverage.get(key)
        if expires is None:
            return
        now = parse_timestamp(self._deps.timestamp()) or datetime.now(UTC)
        if now < expires:
            raise no_coverage(
                f"ninguna exposicion cubre el punto ({request.ra:.4f}, {request.dec:+.4f}), "
                "segun la lista guardada y vigente"
            )
        del self._no_coverage[key]


def _resolved(path: Path) -> Path:
    try:
        return path.resolve()
    except OSError:
        return path.absolute()
