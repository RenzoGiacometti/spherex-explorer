"""Un trabajo: arma un campo de punta a punta (contrato, secciones 4.2, 5, 8 y 9).

`FieldJob` corre en un hilo propio, el unico que procesa recortes y arma el
documento de ese campo:

1. `listing`: lista las exposiciones y, a la par, en otro hilo, pide la vista
   provisoria de WISE.
2. `listed`: epocas, detectores, grilla y todos los planos.
3. `downloading`: le pasa los recortes al gestor (`JobHost.enqueue_cutouts`),
   que los baja con sus hilos de descarga y devuelve cada resultado por
   `inbox`. Aca se procesa de a uno (`load_exposure` y `PlaneAccumulator.add`
   retienen el GIL: mas hilos no lo aceleran) y se publican las revisiones de
   cada plano. Al final, una segunda pasada por los recortes que fallaron por
   causas pasajeras.
4. `finishing` y `done`: documento final, `state` y `done`.

Candados: `lock` protege el documento (`meta`) y la publicacion de eventos, que
van siempre juntos para que un `state` armado al conectar coincida con lo ya
publicado. Nunca se llama al gestor con `lock` tomado: el orden es candado del
gestor, despues el del trabajo, despues el del bus.

Un trabajo de `refresh` (`base` no es `None`) rehace el campo sin publicar
nada ni tocar el almacen, que sigue sirviendo la revision anterior; recien al
final reemplaza los planos que cambiaron.
"""

from __future__ import annotations

import contextlib
import json
import logging
import math
import queue
import threading
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol

import numpy as np
from numpy.typing import NDArray
from pydantic import BaseModel

from app import geometry
from app.api.errors import ApiError, no_coverage, upstream_unavailable
from app.config import Settings
from app.contract import (
    CUBE_PLANE_STATUSES,
    CutoutsFailedWarning,
    DetectorDisplay,
    DownloadMode,
    EventName,
    FewExposuresWarning,
    FieldMeta,
    FieldRequestInfo,
    FieldWarning,
    FullDownloadWarning,
    LowCoverageWarning,
    PlaneEmptyWarning,
    PlaneEvent,
    PlaneInfo,
    PlaneRef,
    PlaneStatus,
    Progress,
    Provenance,
    QueuedEvent,
    SaturatedSourceWarning,
    StaleExposureListWarning,
)
from app.domain import CutoutFile, Exposure, ExposureList, NormalizedRequest, PlaneArrays
from app.jobs.deps import JobDeps
from app.jobs.document import (
    DETECTORS,
    FEW_EXPOSURES_BELOW,
    LOW_COVERAGE_BELOW,
    detector_infos,
    epoch_infos,
    same_source,
    saturated_sources,
)
from app.jobs.events import EventBus, FieldEvent
from app.jobs.plan import SECOND_PASS_ATTEMPTS, CutoutTask, FailureKind, Key, TaskQueue
from app.jobs.store import FieldStore, aux_filename, plane_filename, with_cube_offsets
from app.pipeline.coadd import PlaneAccumulator
from app.pipeline.epochs import assign_epochs
from app.pipeline.flag_table import FlagTable
from app.pipeline.stats import detector_display, plane_stats, saturated_regions
from app.preview.hips2fits import PreviewUnavailable, preview_info, ready_preview_info

logger = logging.getLogger(__name__)

JobState = Literal["queued", "active", "done", "failed", "stopped"]

# Revision del campo y de cada plano que ya numero un intento anterior (`FieldJob.revision_floor`).
RevisionFloor = tuple[int, dict[Key, int]]

# Estados de un plano que ya no va a cambiar en esta pasada.
_SETTLED_PLANE_STATUSES: frozenset[str] = CUBE_PLANE_STATUSES | {"empty"}

# Si los primeros recortes se dan por perdidos por causas pasajeras (cada uno ya agoto sus intentos) sin
# que haya llegado ninguno, IRSA no esta entregando recortes: el trabajo falla ahi en vez de insistir con
# los cientos que faltan, que con el servicio caido serian decenas de minutos ocupando un lugar de la cola.
GIVE_UP_AFTER_LOST = 10
# Detector con el que se describe la vista provisoria mientras esta pendiente: W2, la banda que se pide siempre.
PREVIEW_DETECTOR = 6

# Motivo del aviso `full_download` cuando el recorte completo ya estaba en la cache
# (`CutoutFile.reason` solo viene en uno recien bajado).
_CACHED_FULL_REASON = "el recorte guardado en la cache es una respuesta completa"


class JobStopped(Exception):
    """El gestor se esta deteniendo: el trabajo corta donde esta, sin publicar nada mas."""


class JobHost(Protocol):
    """Lo que un trabajo le pide al gestor."""

    # Candado con el que el gestor lee los binarios de un campo terminado. Un `refresh` lo toma
    # mientras reemplaza planos y documento, para que nadie lea un plano nuevo con la `rev` anterior.
    swap_lock: threading.Lock

    def enqueue_cutouts(self, job: FieldJob, tasks: Sequence[CutoutTask]) -> None:
        """Pone recortes en la cola de descarga del trabajo."""

    def job_finished(self, job: FieldJob, final: FieldMeta) -> None:
        """El campo quedo en el almacen: publicar `state` y `done` y soltar el trabajo."""

    def job_failed(self, job: FieldJob, error: ApiError) -> None:
        """El trabajo no puede continuar: publicar `error`."""

    def refresh_finished(self, job: FieldJob, changed: bool) -> None:
        """Termino un trabajo de `refresh`, haya reemplazado algo o no."""


@dataclass(frozen=True)
class CutoutArrived:
    """Un recorte que ya esta en la cache de disco."""

    task: CutoutTask
    cutout: CutoutFile


@dataclass(frozen=True)
class CutoutLost:
    """Un recorte que se dio por perdido en esta pasada."""

    task: CutoutTask
    kind: FailureKind
    reason: str


_STOP = object()


@dataclass
class _PlaneState:
    """Lo que el trabajo lleva de un plano mientras lo arma."""

    key: Key
    index: int  # posicion en `meta.planes`
    n_exposures: int
    acc: PlaneAccumulator | None = None
    settled: int = 0  # recortes resueltos en la primera pasada, bien o mal
    retrying: int = 0  # recortes de la segunda pasada todavia sin resolver
    n_failed: int = 0
    mjds: list[float] = field(default_factory=list)  # fecha de cada exposicion que entro al coadd
    rev: int = 0
    provisional_sent: bool = False
    dirty: bool = False  # la segunda pasada le sumo exposiciones que todavia no se publicaron


def _same_plane(a: PlaneInfo, b: PlaneInfo) -> bool:
    """Si dos planos son el mismo salvo por la revision y el lugar en el cubo.

    Las estadisticas van redondeadas a 6 cifras, asi que dos coadds de las
    mismas exposiciones sumadas en otro orden (que difieren en el ultimo bit)
    cuentan como iguales.
    """
    skip = {"rev", "cube_offset"}
    return a.model_dump(exclude=skip) == b.model_dump(exclude=skip)


class FieldJob:
    """El trabajo de un campo. Lo crea y lo arranca `JobManager`."""

    def __init__(
        self,
        host: JobHost,
        request: NormalizedRequest,
        settings: Settings,
        store: FieldStore,
        bus: EventBus,
        deps: JobDeps,
        *,
        position: int = 1,
        base: FieldMeta | None = None,
        list_refresh: bool = False,
        previous: FieldMeta | None = None,
        floor: RevisionFloor | None = None,
    ) -> None:
        self.host = host
        self.request = request
        self.field_id = request.field_id
        self.settings = settings
        self.store = store
        self.bus = bus
        self.deps = deps
        # Documento de la revision anterior, si este trabajo es un `refresh` de un campo terminado.
        self.base = base
        self.silent = base is not None
        self.list_refresh = list_refresh or base is not None
        self.side_deg = geometry.cutout_side_deg(request.fov)
        self.grid = geometry.build_grid(request)

        self.lock = threading.RLock()
        self.state: JobState = "queued"
        # Evento `error` con el que termino, para quien se conecte despues.
        self.closing: FieldEvent | None = None
        # `listed_at` de la lista que dijo que ninguna exposicion cubre el punto.
        self.no_coverage_listed_at: str | None = None
        self.thread: threading.Thread | None = None
        self.preview_thread: threading.Thread | None = None

        # Estas dos las protege el candado del gestor, no `lock`.
        self.band = request.band
        self.queue = TaskQueue(request.band)

        self.inbox: queue.Queue[object] = queue.Queue()
        self.created_at = deps.clock()
        preview = (
            base.preview.model_copy(deep=True)
            if base is not None
            # La vista provisoria es siempre WISE W2 (`app.context.live.fetch_preview`), sea cual sea la banda pedida.
            else preview_info(PREVIEW_DETECTOR, settings, "pending" if settings.preview_enabled else "unavailable")
        )
        self.meta = FieldMeta(
            id=request.field_id,
            pipeline=request.pipeline,
            status="queued",
            rev=0,
            request=FieldRequestInfo(ra=request.ra, dec=request.dec, fov=request.fov),
            progress=Progress(phase="queued", queue_position=max(0, int(position))),
            preview=preview,
        )

        # Revision de cada plano en un intento anterior de este mismo campo que no termino (un trabajo
        # fallido, o lo que quedo en el almacen al apagarse el backend). Las revisiones de este trabajo
        # siguen desde ahi: esos binarios ya se sirvieron con `?rev=N` como `immutable`, y la misma URL
        # no puede pasar a devolver otros bytes (contrato, seccion 5: "el binario de una revision no cambia").
        # `previous` tambien puede ser un campo terminado en `partial` que este trabajo vuelve a armar
        # para completarlo (`JobManager.submit` con `complete_partial`): vale lo mismo, y ademas la
        # revision del campo sigue a la que tenia, porque `/cube?rev=N` ya se sirvio como `immutable`.
        self._base_revs: dict[Key, int] = (
            {(plane.epoch, plane.detector): plane.rev for plane in previous.planes or ()}
            if previous is not None
            else {}
        )
        self._base_field_rev = previous.rev if previous is not None else 0
        if floor is not None:
            # Lo que ya habia numerado el trabajo al que este reemplaza (ver `revision_floor`).
            self._base_field_rev = max(self._base_field_rev, floor[0])
            for key, rev in floor[1].items():
                self._base_revs[key] = max(self._base_revs.get(key, 0), rev)
        self._stop_requested = False
        # Con la vista de WISE desactivada (`Settings.preview_enabled`) no hay nada que esperar.
        self._preview_closed = self.silent or not settings.preview_enabled
        self._progress_interval = 1.0 / settings.progress_events_per_s if settings.progress_events_per_s > 0 else 0.0
        self._last_progress = -math.inf
        self._progress_dirty = False

        self._listing: ExposureList | None = None
        self._planes: dict[Key, _PlaneState] = {}
        self._tasks: list[CutoutTask] = []
        self._outstanding = 0
        self._lost: dict[int, CutoutLost] = {}
        self._flag_table = FlagTable()
        self._modes: set[str] = set()
        self._full_reason: str | None = None
        self._finishing = False
        # Imagen vigente de cada plano con datos, para la escala comun del detector.
        self._images: dict[Key, NDArray[np.float32]] = {}
        # Planos de un `refresh`, en memoria hasta saber cuales cambiaron.
        self._held: dict[Key, PlaneArrays] = {}
        self._sent_warnings: set[str] = set()
        self._announced_sources: list[SaturatedSourceWarning] = []

    # ------------------------------------------------------- lo que usa el gestor

    @property
    def in_flight(self) -> bool:
        """Si el trabajo espera turno o esta corriendo."""
        return self.state in ("queued", "active")

    @property
    def accepting(self) -> bool:
        """Si todavia le sirven los resultados de sus descargas."""
        return self.state == "active" and not self._stop_requested

    def snapshot(self) -> FieldMeta:
        """Copia del documento en su estado actual."""
        with self.lock:
            meta = self.meta.model_copy(deep=True)
            if self.in_flight:
                meta.progress.elapsed_s = self._elapsed()
        return meta

    def revision_floor(self) -> RevisionFloor:
        """Revision del campo y de cada plano desde las que sigue numerando quien reintente este trabajo.

        El documento de un trabajo que fallo no alcanza: un plano que no llego a
        tener binario en este intento figura con `rev` 0, y el campo tambien,
        aunque un intento anterior ya haya servido revisiones mas altas.
        """
        with self.lock:
            revs = dict(self._base_revs)
            for plane in self.meta.planes or ():
                key = (plane.epoch, plane.detector)
                revs[key] = max(revs.get(key, 0), plane.rev)
            return max(self._base_field_rev, self.meta.rev), revs

    def announce(self) -> None:
        """Primeros eventos del trabajo: `state` (con el id 1) y `queued` con la posicion inicial."""
        with self.lock:
            self._publish("state", self.meta)
            self._publish("queued", QueuedEvent(position=self.meta.progress.queue_position))

    def set_queue_position(self, position: int) -> None:
        """Nueva posicion en la cola; publica `queued` si cambio."""
        with self.lock:
            if self.state != "queued" or self.meta.progress.queue_position == position:
                return
            self.meta.progress.queue_position = position
            self._publish("queued", QueuedEvent(position=position))

    def promote(self) -> None:
        """Le toco el turno: deja de estar en la cola."""
        with self.lock:
            self.state = "active"
            self.meta.progress.queue_position = 0

    def stop(self) -> None:
        """Pide que el trabajo corte. No espera a que lo haga."""
        self._stop_requested = True
        self.inbox.put(_STOP)

    def publish(self, name: EventName, payload: BaseModel) -> FieldEvent | None:
        """Publica un evento del trabajo. Hay que llamarlo con `lock` tomado."""
        return self._publish(name, payload)

    # --------------------------------------------------------------- el trabajo

    def run(self) -> None:
        """Arma el campo. Corre entero en el hilo del trabajo y no deja escapar excepciones."""
        try:
            self._check_stop()
            self._begin()
            listing = self._list()
            self._plan(listing)
            self._download()
            self._conclude()
        except JobStopped:
            with self.lock:
                self.state = "stopped"
        except ApiError as exc:
            self._abort(exc)
        except Exception as exc:
            logger.exception("el trabajo del campo %s fallo", self.field_id)
            # El contrato no tiene un codigo para fallas internas: va como servicio no disponible,
            # que es el que invita a reintentar.
            self._abort(upstream_unavailable(f"falla interna al armar el campo: {type(exc).__name__}: {exc}"))
        finally:
            self._release()

    def _release(self) -> None:
        """Suelta lo pesado (acumuladores, imagenes) al terminar: un trabajo fallido queda en memoria solo con su
        documento."""
        self._planes.clear()
        self._tasks.clear()
        self._lost.clear()
        self._images.clear()
        self._held.clear()
        with contextlib.suppress(queue.Empty):
            while True:
                self.inbox.get_nowait()

    def _check_stop(self) -> None:
        if self._stop_requested:
            raise JobStopped

    def _begin(self) -> None:
        with self.lock:
            self.meta.status = "listing"
            self.meta.progress.phase = "listing"
            self.meta.progress.queue_position = 0
            self._publish_progress(force=True)
        if self.silent:
            return
        self._clear_leftovers()
        # El campo tiene que existir en el almacen antes de que alguien pida la vista provisoria.
        self._write_meta()
        if not self.settings.preview_enabled:
            return
        thread = threading.Thread(target=self._fetch_preview, name=f"spherex-preview-{self.field_id}", daemon=True)
        self.preview_thread = thread
        thread.start()

    def _clear_leftovers(self) -> None:
        """Borra los binarios de una corrida anterior del mismo campo que no termino."""
        folder = self.store.write_root / self.field_id
        for pattern in ("plane_e*_d*.f32", "aux_e*_d*.bin.gz", "preview.f32"):
            for path in folder.glob(pattern):
                with contextlib.suppress(OSError):
                    path.unlink()

    def _write_meta(self) -> None:
        with self.lock:
            document = self.meta.model_copy(deep=True)
        self.store.write_meta(document)

    # ---------------------------------------------------------- vista provisoria

    def _fetch_preview(self) -> None:
        """Hilo de la vista provisoria: la pide, la guarda con el campo y publica `preview`."""
        # Grilla propia: un WCS de astropy no se puede usar desde dos hilos a la vez.
        grid = geometry.build_grid(self.request)
        info = None
        image: NDArray[np.float32] | None = None
        try:
            preview = self.deps.fetch_preview(grid, self.request.band, self.settings)
            image = np.asarray(preview.image, dtype=np.float32)
            if image.shape != grid.shape:
                raise PreviewUnavailable(f"la vista provisoria mide {image.shape} y la grilla {grid.shape}")
            info = ready_preview_info(preview)
            if info.display is None:
                raise PreviewUnavailable("la vista provisoria no trae ningun pixel con datos")
        except PreviewUnavailable as exc:
            logger.info("campo %s sin vista provisoria: %s", self.field_id, exc)
            info = None
        except Exception:
            logger.exception("fallo inesperado al pedir la vista provisoria del campo %s", self.field_id)
            info = None
        with self.lock:
            if self._preview_closed or self._stop_requested:
                return  # el trabajo termino antes: la vista ya se dio por descartada
            self._preview_closed = True
            if info is not None and image is not None:
                try:
                    self.store.write_preview(self.field_id, image, shape=grid.shape)
                except Exception:
                    logger.exception("no se pudo guardar la vista provisoria del campo %s", self.field_id)
                    info = None
            if info is None:
                info = self.meta.preview.model_copy(update={"status": "unavailable", "display": None})
            self.meta.preview = info
            self._publish("preview", info)

    def _close_preview(self) -> None:
        """Si la vista provisoria todavia no llego, se descarta. Con `lock` tomado."""
        if self._preview_closed:
            return
        self._preview_closed = True
        self.meta.preview = self.meta.preview.model_copy(update={"status": "unavailable", "display": None})
        self._publish("preview", self.meta.preview)

    # ------------------------------------------------------------------ listado

    def _list(self) -> ExposureList:
        request = self.request
        try:
            listing = self.deps.list_exposures(request.ra, request.dec, self.settings, self.list_refresh)
        except ApiError:
            raise
        except Exception as exc:
            raise upstream_unavailable(f"no se pudo listar las exposiciones: {type(exc).__name__}: {exc}") from exc
        self._check_stop()
        if not listing.exposures:
            if not listing.stale:
                self.no_coverage_listed_at = listing.listed_at
            raise no_coverage(
                f"ninguna exposicion de {', '.join(self.settings.collections)} cubre el punto "
                f"({request.ra:.4f}, {request.dec:+.4f})"
            )
        return listing

    def _plan(self, listing: ExposureList) -> None:
        """Arma epocas, detectores y planos, publica `listed` y deja listos los recortes a pedir."""
        if self.silent and listing.stale:
            # IRSA no respondio: no hay nada nuevo que mirar.
            raise upstream_unavailable("refresh: IRSA no respondio y la lista de exposiciones es una copia guardada")
        exposures: list[Exposure] = sorted(
            listing.exposures, key=lambda item: (item.mjd_start, item.detector, item.obs_id)
        )
        assignment = assign_epochs(exposures, self.settings.epoch_gap_days)
        members: dict[Key, list[int]] = {}
        for index, (exposure, epoch) in enumerate(zip(exposures, assignment.indices, strict=True)):
            members.setdefault((epoch, exposure.detector), []).append(index)

        infos: list[PlaneInfo] = []
        tasks: list[CutoutTask] = []
        for summary in assignment.epochs:
            for detector in DETECTORS:
                key = (summary.epoch, detector)
                own = members.get(key, [])
                state = _PlaneState(key=key, index=len(infos), n_exposures=len(own), rev=self._base_revs.get(key, 0))
                self._planes[key] = state
                if not own:
                    # Sin exposiciones: se sabe vacio desde la lista y no tiene evento `plane`.
                    infos.append(PlaneInfo(epoch=summary.epoch, detector=detector, status="empty"))
                    continue
                state.acc = PlaneAccumulator(self.grid, len(own))
                infos.append(PlaneInfo(epoch=summary.epoch, detector=detector, status="pending", n_exposures=len(own)))
                tasks.extend(
                    CutoutTask(
                        job=self,
                        index=index,
                        exposure=exposures[index],
                        key=key,
                        order=order,
                        budget=self.settings.cutout_attempts,
                    )
                    for order, index in enumerate(own)
                )
        strays = set(members) - set(self._planes)
        if strays:
            raise ValueError(f"exposiciones con un detector fuera de 1 a 6: {sorted(strays)}")

        self._listing = listing
        self._tasks = tasks
        with self.lock:
            meta = self.meta
            meta.grid = geometry.grid_info(self.grid)
            meta.detectors = detector_infos(exposures)
            meta.epochs = epoch_infos(assignment.epochs)
            meta.planes = infos
            # Los bits de FLAGS salen del encabezado de los recortes: todavia no se leyo ninguno.
            meta.flags = []
            meta.provenance = Provenance(
                collections=list(self.settings.collections), listed_at=listing.listed_at, list_stale=listing.stale
            )
            meta.status = "downloading"
            progress = meta.progress
            progress.phase = "downloading"
            progress.queue_position = 0
            progress.cutouts_total = len(exposures)
            progress.planes_total = len(infos)
            progress.planes_ready = self._planes_ready()
            progress.elapsed_s = self._elapsed()
            # Lo que se sabe con solo listar (planos vacios, pocas exposiciones, lista vencida)
            # viaja dentro de `listed`: no hace falta un evento `warning` por cada uno.
            self._sync_warnings(publish=False)
            self._publish("listed", meta)
            self._publish_progress(force=True)
        if not self.silent:
            self._write_meta()

    # ----------------------------------------------------------------- descarga

    def _download(self) -> None:
        self._outstanding = len(self._tasks)
        self.host.enqueue_cutouts(self, self._tasks)
        self._drain()
        # Segunda pasada: solo lo que fallo por causas pasajeras (contrato, seccion 9).
        again = [lost.task for lost in self._lost.values() if lost.kind == "transient"]
        if not again:
            return
        budget = min(SECOND_PASS_ATTEMPTS, self.settings.cutout_attempts)
        for task in again:
            task.restart(budget, second_pass=True)
            self._planes[task.key].retrying += 1
        self._outstanding = len(again)
        self.host.enqueue_cutouts(self, again)
        self._drain()

    def _drain(self) -> None:
        """Procesa lo que devuelven las descargas hasta que no quede ningun recorte sin resolver."""
        while self._outstanding > 0:
            item = self._take()
            if isinstance(item, CutoutArrived):
                self._on_arrived(item.task, item.cutout)
            elif isinstance(item, CutoutLost):
                self._on_lost(item.task, item.kind, item.reason)

    def _take(self) -> object:
        """El proximo resultado. Mientras espera, manda el `progress` que haya quedado retenido por el tope."""
        while True:
            self._check_stop()
            timeout = max(self._progress_interval, 0.05) if self._progress_dirty else None
            try:
                item = self.inbox.get(timeout=timeout)
            except queue.Empty:
                with self.lock:
                    if self._progress_dirty:
                        self._publish_progress()
                continue
            if item is _STOP:
                raise JobStopped
            return item

    def _on_arrived(self, task: CutoutTask, cutout: CutoutFile) -> None:
        plane = self._planes[task.key]
        try:
            exposure = self.deps.load_exposure(cutout.path, self.grid)
        except (OSError, KeyError, ValueError) as exc:
            reason = f"recorte ilegible: {type(exc).__name__}: {exc}"
            # Un recorte guardado que no se puede leer se descarta, para que no quede en la cache,
            # y se vuelve a pedir una vez.
            logger.warning("campo %s: %s; se descarta %s", self.field_id, reason, cutout.path)
            try:
                self.deps.discard_cutout(cutout.path, self.settings)
            except Exception:
                logger.exception("no se pudo descartar %s", cutout.path)
            if task.refetched:
                self._on_lost(task, "permanent", reason)
                return
            task.refetched = True
            task.restart(task.budget)
            self.host.enqueue_cutouts(self, [task])
            return
        try:
            # Primero contra la tabla del campo: un bit con dos nombres es un error de este recorte.
            self._flag_table.check(exposure.flag_bits)
            assert plane.acc is not None
            plane.acc.add(exposure)
            new_flags = self._flag_table.add_exposure(exposure)
        except ValueError as exc:
            self._on_lost(task, "permanent", f"recorte inservible: {type(exc).__name__}: {exc}")
            return

        plane.mjds.append(task.exposure.mjd_start)
        self._modes.add(cutout.mode)
        with self.lock:
            progress = self.meta.progress
            progress.cutouts_done += 1
            if cutout.from_cache:
                progress.cutouts_cached += 1
            if task.second_pass:
                # Se habia dado por perdido en la primera pasada.
                plane.n_failed -= 1
                progress.cutouts_failed -= 1
                plane.dirty = True
                self._lost.pop(task.index, None)
            if new_flags:
                self.meta.flags = self._flag_table.infos()
            if self.meta.provenance is not None:
                self.meta.provenance.download_mode = self._download_mode()
            if cutout.mode == "full" and self._full_reason is None:
                self._full_reason = cutout.reason or _CACHED_FULL_REASON
                self._sync_warnings()
        self._settle(task, plane)

    def _on_lost(self, task: CutoutTask, kind: FailureKind, reason: str) -> None:
        plane = self._planes[task.key]
        task.error = reason
        logger.info("campo %s: recorte perdido (%s): %s: %s", self.field_id, kind, task.exposure.obs_id, reason)
        with self.lock:
            if not task.second_pass:
                plane.n_failed += 1
                self.meta.progress.cutouts_failed += 1
            self._lost[task.index] = CutoutLost(task=task, kind=kind, reason=reason)
            nothing_arrived = self.meta.progress.cutouts_done == 0
        if nothing_arrived and not task.second_pass:
            down = sum(1 for lost in self._lost.values() if lost.kind != "permanent")
            if down >= GIVE_UP_AFTER_LOST:
                raise upstream_unavailable(
                    f"IRSA no esta entregando recortes: {down} se dieron por perdidos sin que llegara ninguno "
                    f"(el ultimo: {reason})"
                )
        self._settle(task, plane)

    def _settle(self, task: CutoutTask, plane: _PlaneState) -> None:
        """Un recorte quedo resuelto en esta pasada: ve si al plano le toca una revision."""
        self._outstanding -= 1
        assert plane.acc is not None
        if task.second_pass:
            plane.retrying -= 1
            if plane.retrying <= 0 and plane.dirty:
                plane.dirty = False
                self._revise(plane, definitive=True)
        else:
            plane.settled += 1
            if plane.settled >= plane.n_exposures:
                self._revise(plane, definitive=True)
            elif (
                not self.silent
                and not plane.provisional_sent
                and plane.n_exposures >= 2
                and plane.acc.n_used >= max(1, plane.n_exposures // 2)
            ):
                # Provisoria: ya entro la mitad de sus exposiciones (contrato, seccion 8).
                self._revise(plane, definitive=False)
        with self.lock:
            self._publish_progress()

    # --------------------------------------------------------------- revisiones

    def _revise(self, plane: _PlaneState, *, definitive: bool) -> None:
        """Publica una revision del plano: lo escribe en el almacen y manda el evento `plane`."""
        assert plane.acc is not None and self.meta.planes is not None and self.meta.detectors is not None
        epoch, detector = plane.key
        arrays = plane.acc.snapshot()
        stats = plane_stats(arrays.image)
        previous = self.meta.planes[plane.index]
        status: PlaneStatus
        if stats is None:
            # Ninguna exposicion dejo un pixel con valor: el plano no tiene binario.
            if not definitive or previous.status == "empty":
                return
            status = "empty"
        elif not definitive:
            status = "building"
        else:
            status = "ready" if plane.n_failed == 0 else "partial"
        has_data = stats is not None
        info = PlaneInfo(
            epoch=epoch,
            detector=detector,
            status=status,
            rev=plane.rev + 1,
            n_exposures=plane.n_exposures,
            n_used=plane.acc.n_used,
            n_failed=plane.n_failed,
            mjd_mean=round(math.fsum(plane.mjds) / len(plane.mjds), 4) if has_data and plane.mjds else None,
            stats=stats,
            saturated=saturated_regions(arrays.image) if has_data else [],
        )
        if has_data:
            if self.silent:
                self._held[plane.key] = arrays
            self._images[plane.key] = arrays.image
        else:
            self._images.pop(plane.key, None)
            self._held.pop(plane.key, None)
        display = detector_display([self._images[key] for key in sorted(self._images) if key[1] == detector])

        with self.lock:
            # Los binarios y su entrada en el documento cambian juntos, con el candado: quien lee el
            # plano con `JobManager.read_plane` recibe siempre los bytes de la revision que se le dice.
            if has_data and not self.silent:
                shape = self.grid.shape
                self.store.write_plane(self.field_id, epoch, detector, arrays.image, shape=shape)
                self.store.write_aux(self.field_id, epoch, detector, arrays.flags, arrays.coverage, shape=shape)
            plane.rev = info.rev
            if not definitive:
                plane.provisional_sent = True
            self.meta.planes[plane.index] = info
            for item in self.meta.detectors:
                if item.detector == detector:
                    item.display = display
            self.meta.progress.planes_ready = self._planes_ready()
        if not self.silent:
            # La revision queda anotada en el almacen antes de anunciarla: si el backend se apaga, el
            # proximo intento sigue numerando desde aca.
            self._write_meta()
        with self.lock:
            event_display = None if display is None else DetectorDisplay(detector=detector, **display.model_dump())
            self._publish("plane", PlaneEvent(plane=info, detector_display=event_display))
            self._sync_warnings()

    def _planes_ready(self) -> int:
        return sum(1 for plane in self.meta.planes or () if plane.status in _SETTLED_PLANE_STATUSES)

    def _download_mode(self) -> DownloadMode | None:
        if not self._modes:
            return None
        if len(self._modes) > 1:
            return "mixed"
        return "full" if "full" in self._modes else "truncated"

    # ------------------------------------------------------------------- avisos

    def _warnings_for(self, planes: Sequence[PlaneInfo], *, final: bool) -> list[FieldWarning]:
        """Avisos que corresponden a esos planos, en un orden fijo. Usa el WCS de la grilla: solo desde el hilo
        del trabajo."""
        found: list[FieldWarning] = []
        if self._listing is not None and self._listing.stale:
            found.append(StaleExposureListWarning(listed_at=self._listing.listed_at))
        found.extend(
            PlaneEmptyWarning(epoch=plane.epoch, detector=plane.detector) for plane in planes if plane.status == "empty"
        )
        for plane in planes:
            if plane.status == "empty":
                continue
            # Con la revision definitiva se sabe cuantas entraron; antes, cuantas hay como mucho.
            n = plane.n_used if plane.status in CUBE_PLANE_STATUSES else plane.n_exposures
            if n < FEW_EXPOSURES_BELOW:
                found.append(FewExposuresWarning(epoch=plane.epoch, detector=plane.detector, n=n))
        found.extend(
            LowCoverageWarning(epoch=plane.epoch, detector=plane.detector, valid_fraction=plane.stats.valid_fraction)
            for plane in planes
            if plane.status in CUBE_PLANE_STATUSES
            and plane.stats is not None
            and plane.stats.valid_fraction < LOW_COVERAGE_BELOW
        )
        # Solo con planos definitivos: en uno provisorio, armado con pocas exposiciones, un rayo cosmico
        # o un pixel con OVERFLOW en una sola de ellas alcanza para dejar una region "saturada" que
        # desaparece al completarlo (visto con los recortes reales de Barnard: tres regiones de 4
        # pixeles en la provisoria de un plano, ninguna en la definitiva).
        found.extend(saturated_sources(self.grid, [plane for plane in planes if plane.status in CUBE_PLANE_STATUSES]))
        if self._full_reason is not None:
            found.append(FullDownloadWarning(reason=self._full_reason))
        if final:
            failed = [plane for plane in planes if plane.n_failed > 0]
            if failed:
                found.append(
                    CutoutsFailedWarning(
                        n=sum(plane.n_failed for plane in failed),
                        planes=[PlaneRef(epoch=plane.epoch, detector=plane.detector) for plane in failed],
                    )
                )
        return found

    def _sync_warnings(self, *, publish: bool = True) -> None:
        """Pone al dia `meta.warnings` y publica los avisos nuevos. Con `lock` tomado, desde el hilo del trabajo.

        El documento lleva siempre la lista vigente. Por el flujo sale cada
        aviso una vez; un `saturated_source` sale cuando la fuente aparece en
        un plano definitivo y no se repite cuando se le suman epocas o
        detectores (el cliente lo sumaria como otro aviso): la version completa
        llega con el `state` final.
        """
        current = self._warnings_for(self.meta.planes or (), final=self._finishing)
        self.meta.warnings = current
        for warning in current:
            if isinstance(warning, SaturatedSourceWarning):
                if any(same_source(warning, known) for known in self._announced_sources):
                    continue
                self._announced_sources.append(warning)
            else:
                fingerprint = json.dumps(warning.model_dump(mode="json"), sort_keys=True)
                if fingerprint in self._sent_warnings:
                    continue
                self._sent_warnings.add(fingerprint)
            if publish:
                self._publish("warning", warning)

    # -------------------------------------------------------------------- final

    def _conclude(self) -> None:
        progress = self.meta.progress
        if progress.cutouts_done == 0:
            kinds = {lost.kind for lost in self._lost.values()}
            if kinds & {"transient", "busy_too_long"}:
                # Un campo sin ningun recorte no sirve como `partial`: quedaria guardado vacio.
                raise upstream_unavailable(
                    f"IRSA no entrego ninguno de los {progress.cutouts_total} recortes del campo"
                )
        with self.lock:
            progress.phase = "finishing"
            self._finishing = True
            self._close_preview()
            self._sync_warnings()
            self._publish_progress(force=True)
            final = self._final_document()
        self._check_stop()
        if self.silent:
            self._conclude_refresh(final)
            return
        self.store.write_meta(final)
        self.host.job_finished(self, final)

    def _final_document(self) -> FieldMeta:
        """Documento terminado: `cube_offset`, `flags` completo, procedencia y estado final. Con `lock` tomado."""
        final = with_cube_offsets(self.meta)
        final.flags = self._flag_table.infos()
        if final.provenance is not None:
            final.provenance.download_mode = self._download_mode()
            final.provenance.built_at = self.deps.timestamp()
        final.status = "partial" if final.progress.cutouts_failed > 0 else "ready"
        # 1 en un campo nuevo; en uno que ya habia terminado y se volvio a armar, la siguiente.
        final.rev = self._base_field_rev + 1
        final.progress.phase = "done"
        final.progress.queue_position = 0
        final.progress.elapsed_s = self._elapsed()
        return final

    def _abort(self, error: ApiError) -> None:
        if self.silent:
            logger.warning("refresh del campo %s abandonado: %s", self.field_id, error.message)
            self.host.refresh_finished(self, False)
            return
        with self.lock:
            self._close_preview()
            # `progress.phase` queda en la fase en la que estaba (contrato, seccion 5).
            self.meta.status = "failed"
            self.meta.progress.elapsed_s = self._elapsed()
            document = self.meta.model_copy(deep=True)
        try:
            self.store.write_meta(document)
        except Exception:
            logger.exception("no se pudo guardar el estado del campo %s", self.field_id)
        self.host.job_failed(self, error)

    # ------------------------------------------------------------------ refresh

    def _conclude_refresh(self, final: FieldMeta) -> None:
        """Reemplaza en el almacen los planos que cambiaron respecto de la revision anterior.

        Un plano cambia si su entrada de `planes[]` es otra (mas exposiciones,
        recortes recuperados). Los que no cambiaron conservan su archivo y su
        `rev`, para que el navegador no vuelva a bajarlos. La `rev` de un plano
        reemplazado sigue a la que tenia: una URL con `?rev=N` ya servida como
        `immutable` no puede pasar a devolver otros bytes. Nunca se reemplaza un
        plano por otro armado con menos exposiciones (un recorte que esta vez no
        se pudo bajar).
        """
        base = self.base
        assert base is not None and final.planes is not None
        merged: list[PlaneInfo] = []
        changed: list[Key] = []
        for plane in final.planes:
            key = (plane.epoch, plane.detector)
            old = base.plane(*key)
            if old is not None and (_same_plane(old, plane) or plane.n_used < old.n_used):
                merged.append(old.model_copy(deep=True))
                continue
            plane.rev = (old.rev if old is not None else 0) + 1
            merged.append(plane)
            changed.append(key)
        kept = {(plane.epoch, plane.detector) for plane in merged}
        removed = [
            (plane.epoch, plane.detector) for plane in base.planes or () if (plane.epoch, plane.detector) not in kept
        ]

        if not changed and not removed:
            # Nada nuevo: solo se anota cuando se volvio a listar.
            document = base.model_copy(deep=True)
            if document.provenance is not None and final.provenance is not None:
                document.provenance.listed_at = final.provenance.listed_at
                document.provenance.list_stale = False
                document.warnings = [item for item in document.warnings if item.code != "stale_exposure_list"]
            self.store.write_meta(document)
            self.host.refresh_finished(self, False)
            return

        final.planes = merged
        final.rev = base.rev + 1
        final.preview = base.preview.model_copy(deep=True)
        total = sum(plane.n_exposures for plane in merged)
        failed = sum(plane.n_failed for plane in merged)
        final.status = "partial" if failed else "ready"
        final.progress.cutouts_total = total
        final.progress.cutouts_failed = failed
        final.progress.cutouts_done = total - failed
        final.progress.planes_total = final.progress.planes_ready = len(merged)
        final.warnings = self._warnings_for(merged, final=True)
        final = with_cube_offsets(final)

        shape = self.grid.shape
        folder = self.store.write_root / self.field_id
        with self.host.swap_lock:
            for key in changed:
                arrays = self._held.get(key)
                if arrays is not None:
                    self.store.write_plane(self.field_id, *key, arrays.image, shape=shape)
                    self.store.write_aux(self.field_id, *key, arrays.flags, arrays.coverage, shape=shape)
                else:
                    removed.append(key)  # paso a vacio: no tiene binario
            for key in removed:
                for name in (plane_filename(*key), aux_filename(*key)):
                    with contextlib.suppress(OSError):
                        (folder / name).unlink()
            self.store.write_meta(final)
        self.host.refresh_finished(self, True)

    # ------------------------------------------------------------------ eventos

    def _elapsed(self) -> float:
        return round(max(0.0, self.deps.clock() - self.created_at), 1)

    def _publish(self, name: EventName, payload: BaseModel) -> FieldEvent | None:
        if self.silent:
            return None
        return self.bus.publish(self.field_id, name, payload.model_dump(mode="json"))

    def _publish_progress(self, *, force: bool = False) -> None:
        """Evento `progress`: como maximo uno cada `_progress_interval`, salvo en los cambios de fase."""
        now = self.deps.clock()
        self.meta.progress.elapsed_s = round(max(0.0, now - self.created_at), 1)
        if not force and now - self._last_progress < self._progress_interval:
            self._progress_dirty = True
            return
        self._last_progress = now
        self._progress_dirty = False
        self._publish("progress", self.meta.progress)
