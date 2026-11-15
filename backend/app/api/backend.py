"""Lo que hacen las rutas de la aplicacion real, sin HTTP (contrato, seccion 4).

`ApiBackend` junta el gestor de trabajos, el almacen de campos y la resolucion
de nombres, y deja cada endpoint en una llamada. Todos sus metodos bloquean
(disco, candados del gestor, Sesame): las rutas, que son `async`, los llaman en
un hilo (`run_in_threadpool`) y solo arman la respuesta HTTP.

Que se lee junto, para no rotular unos bytes con la revision de otros:

- Plano y capas auxiliares: `JobManager.read_plane` y `read_aux` entregan los
  bytes con la entrada de `planes[]` de esa misma revision.
- Cubo: el documento y todos los planos se leen con `JobManager.swap_lock`
  tomado, que es el candado con el que un `refresh` reemplaza los planos de un
  campo terminado. El cubo entero queda en memoria (2,7 MB en el escalon base y
  6,2 MB en el amplio) y recien despues se envia por tramos: asi el candado se
  suelta enseguida y un cliente lento no frena a nadie.

Trayectorias (`/track`): la de un objeto se guarda con el campo la primera vez
que se calcula, y despues se sirve de ahi sin consultar Sesame. Vale mientras
sus fechas sean las de `epochs[].mjd_mean` del documento: si un `refresh` movio
las epocas se calcula de nuevo. Se guarda bajo el nombre principal del
catalogo, asi que se encuentra sin Sesame cuando `name` es ese nombre (es el
que el frontend lleva en el link); con cualquier otro texto se resuelve primero
el nombre, que tiene su propia cache. En un campo precalculado (data/fields) no
se escribe nada: sus trayectorias las deja el script de precalculo.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import AsyncIterator
from pathlib import Path

from app import geometry
from app.api.errors import invalid_request, not_built, not_found
from app.config import Settings
from app.contract import (
    FINISHED_FIELD_STATUSES,
    FieldMeta,
    FieldRequest,
    FieldResponse,
    PlaneInfo,
    ResolveResponse,
    TrackResponse,
)
from app.jobs.deps import JobDeps
from app.jobs.events import FieldEvent
from app.jobs.manager import JobManager
from app.jobs.store import FieldStore, StoreError, track_filename
from app.resolve import service as resolve_service
from app.resolve.sesame import normalize_query

logger = logging.getLogger(__name__)

# Nombre de archivo mas largo con el que se guarda una trayectoria. Un nombre principal de
# SIMBAD es corto; el tope evita rutas que Windows no admite.
MAX_TRACK_FILENAME = 120


def events_url(field_id: str) -> str:
    """Ruta del flujo de eventos de un campo, como va en la respuesta de `POST /api/field`."""
    return f"/api/field/{field_id}/events"


def track_is_current(track: TrackResponse, meta: FieldMeta) -> bool:
    """Si una trayectoria guardada corresponde a las epocas que el campo tiene ahora.

    Cada posicion lleva la fecha media de su epoca (`epochs[].mjd_mean`,
    contrato 4.9). Una trayectoria sin posiciones (objeto sin movimiento
    propio, o del otro lado del cielo) no depende de las epocas.
    """
    if not track.positions:
        return True
    expected = [
        (item.epoch, round(item.mjd_mean, resolve_service.TRACK_MJD_DECIMALS) + 0.0) for item in meta.epochs or ()
    ]
    return [(position.epoch, position.mjd) for position in track.positions] == expected


def _resolved(path: Path) -> Path:
    try:
        return path.resolve()
    except OSError:
        return path.absolute()


class ApiBackend:
    """Estado de la aplicacion real: la configuracion y el gestor de trabajos, que es uno por proceso.

    El gestor se crea con `start()` (o la primera vez que hace falta) sobre
    `FieldStore.from_settings(settings)`, y se detiene con `stop()`. Si se pasa
    un `manager` ya armado, se usa ese y no se lo detiene: es de quien lo creo.
    `deps` reemplaza las funciones externas del gestor (IRSA, hips2fits,
    pipeline), para los tests.
    """

    def __init__(self, settings: Settings, *, deps: JobDeps | None = None, manager: JobManager | None = None) -> None:
        self.settings = settings
        self._deps = deps
        self._manager = manager
        self._owns_manager = manager is None
        self._lock = threading.Lock()

    # ------------------------------------------------------------ ciclo de vida

    @property
    def manager(self) -> JobManager:
        """El gestor de trabajos. Crearlo aplica el tope de disco de la cache de recortes: toca el disco."""
        with self._lock:
            if self._manager is None:
                store = FieldStore.from_settings(self.settings)
                self._manager = JobManager(self.settings, store, deps=self._deps)
            return self._manager

    @property
    def store(self) -> FieldStore:
        return self.manager.store

    def start(self) -> None:
        """Deja el gestor creado. Se llama al arrancar la aplicacion."""
        _ = self.manager

    def stop(self, timeout: float = 10.0) -> None:
        """Detiene el gestor al cerrar la aplicacion: los trabajos cortan y los flujos abiertos terminan."""
        with self._lock:
            manager = self._manager
            if not self._owns_manager:
                return
            self._manager = None
        if manager is not None:
            manager.shutdown(timeout)

    # -------------------------------------------------------------------- campo

    def submit(self, body: FieldRequest) -> tuple[int, FieldResponse]:
        """`POST /api/field`: codigo HTTP (200 si el campo esta terminado, 202 si no) y cuerpo.

        Con `refresh` sobre un campo de la cache que quedo `partial`, el gestor
        lo vuelve a armar a la vista para completarlo y la respuesta es 202
        (`JobManager.submit` con `complete_partial`). Sobre un campo `ready`, uno
        precalculado o en modo `precomputed_only` sigue siendo 200 con el
        documento guardado.
        """
        request = geometry.normalize_request(
            body.ra, body.dec, body.fov, body.band, body.refresh, pipeline=self.settings.pipeline_version
        )
        meta = self.manager.submit(request, complete_partial=True)
        response = FieldResponse(id=meta.id, status=meta.status, events_url=events_url(meta.id), meta=meta)
        return (200 if meta.status in FINISHED_FIELD_STATUSES else 202), response

    def meta(self, field_id: str) -> FieldMeta:
        return self.manager.get_meta(field_id)

    def subscribe(self, field_id: str) -> AsyncIterator[FieldEvent]:
        """Flujo de eventos del campo (`JobManager.subscribe`). `not_found` sale aca, antes de abrir la respuesta."""
        return self.manager.subscribe(field_id)

    def set_priority(self, field_id: str, band: int) -> None:
        self.manager.set_priority(field_id, band)

    # ----------------------------------------------------------------- binarios

    @staticmethod
    def _check_plane_numbers(field_id: str, epoch: int, detector: int) -> None:
        """Un plano con esos numeros no puede existir en ningun campo: `not_found` tambien antes de `listed`."""
        if epoch < 1 or not 1 <= detector <= 6:
            raise not_found(f"el campo {field_id!r} no tiene el plano de la epoca {epoch} y el detector {detector}")

    def plane(self, field_id: str, epoch: int, detector: int) -> tuple[bytes, PlaneInfo]:
        """Bytes de `/plane/{e}/{d}` en su revision vigente y la entrada de `planes[]` de esa revision."""
        self._check_plane_numbers(field_id, epoch, detector)
        return self.manager.read_plane(field_id, epoch, detector)

    def aux(self, field_id: str, epoch: int, detector: int, *, gzipped: bool) -> tuple[bytes, PlaneInfo]:
        """Bytes de `/aux/{e}/{d}` (comprimidos como estan en disco si `gzipped`) y su entrada de `planes[]`."""
        self._check_plane_numbers(field_id, epoch, detector)
        return self.manager.read_aux(field_id, epoch, detector, gzipped=gzipped)

    def cube(self, field_id: str) -> tuple[FieldMeta, list[bytes]]:
        """El documento de un campo terminado y los bytes de `/cube`, un tramo por plano."""
        manager = self.manager
        with manager.swap_lock:
            meta = manager.get_meta(field_id)
            if meta.status not in FINISHED_FIELD_STATUSES:
                raise not_built(f"el campo {field_id!r} todavia no termino", job_failed=meta.status == "failed")
            try:
                return meta, list(manager.store.iter_cube(field_id, meta))
            except StoreError as exc:
                raise not_found(str(exc)) from exc

    def preview(self, field_id: str) -> bytes:
        """Bytes de `/preview`. `not_ready` mientras esta `pending` y `not_found` si quedo `unavailable`."""
        manager = self.manager
        problem: StoreError | None = None
        for _ in range(2):
            meta = manager.get_meta(field_id)
            status = meta.preview.status
            if status == "pending":
                raise not_built("la vista provisoria todavia no esta lista", job_failed=meta.status == "failed")
            if status == "unavailable":
                raise not_found(f"el campo {field_id!r} no tiene vista provisoria")
            # La vista puede estar antes que `grid`: su forma es la del escalon del pedido (contrato 4.10).
            side = geometry.select_step(meta.request.fov).size
            shape = meta.grid.shape if meta.grid is not None else (side, side)
            try:
                return manager.store.read_preview_bytes(field_id, shape=shape)
            except StoreError as exc:
                # Entre leer el documento y el archivo, otro `POST` pudo reintentar el campo, que
                # empieza borrando la vista del intento anterior: se mira el documento de nuevo.
                problem = exc
        raise not_found(str(problem))

    # --------------------------------------------------------- nombres y rastro

    def resolve(self, name: str) -> ResolveResponse:
        """`GET /api/resolve?name=`. Puede consultar Sesame: bloquea hasta `settings.sesame_total_timeout_s`."""
        return resolve_service.resolve(name, self.settings)

    def track(self, field_id: str, name: str) -> TrackResponse:
        """`GET /api/field/{id}/track?name=`: la trayectoria guardada con el campo o, si no hay, calculada."""
        meta = self.manager.get_meta(field_id)
        text = normalize_query(name)
        if not text:
            raise invalid_request("name no puede estar vacio")
        if meta.grid is None or meta.epochs is None:
            raise not_built(
                f"el campo {field_id!r} todavia no tiene grilla ni epocas: la trayectoria sale despues de `listed`",
                job_failed=meta.status == "failed",
            )
        saved = self._saved_track(field_id, text)
        if saved is not None and track_is_current(saved, meta):
            return saved
        target = resolve_service.resolve_target(text, self.settings)
        track = resolve_service.build_track_response(
            target, resolve_service.epoch_summaries(meta.epochs), geometry.grid_from_info(meta.grid)
        )
        if target.source == "sesame":
            self._save_track(field_id, track)
        return track

    def _saved_track(self, field_id: str, name: str) -> TrackResponse | None:
        """La trayectoria guardada con el campo para ese nombre exacto, o `None`."""
        if len(track_filename(name)) > MAX_TRACK_FILENAME:
            return None
        try:
            saved = self.store.read_track(field_id, name)
        except (StoreError, OSError) as exc:
            logger.warning("trayectoria ilegible en el campo %s: %s", field_id, exc)
            return None
        # El nombre de archivo no distingue mayusculas ni signos: dos objetos pueden compartirlo.
        return saved if saved is not None and saved.name == name else None

    def _save_track(self, field_id: str, track: TrackResponse) -> None:
        """Guarda la trayectoria con el campo. Si no se puede, se sigue sin ella: se calcula de nuevo la proxima vez."""
        store = self.store
        folder = store.locate(field_id)
        if folder is None or _resolved(folder.parent) != _resolved(store.write_root):
            return  # campo precalculado: no se escribe en data/fields mientras se sirve
        if len(track_filename(track.name)) > MAX_TRACK_FILENAME:
            return
        try:
            if store.read_track(field_id, track.name) != track:
                store.write_track(field_id, track)
        except (StoreError, OSError) as exc:
            logger.warning("no se pudo guardar la trayectoria de %r en el campo %s: %s", track.name, field_id, exc)
