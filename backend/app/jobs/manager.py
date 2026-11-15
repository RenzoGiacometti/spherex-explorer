"""Gestor de trabajos: cola, planificacion de descargas y entrega progresiva (contrato, secciones 8 a 11).

Un trabajo arma un campo: lista exposiciones, pide la vista provisoria, baja
los recortes en el orden de la seccion 8, acumula cada plano, emite revisiones
provisorias y definitivas y deja todo en el `FieldStore`.

Lo que el servidor falso (`app.fake`) ya hace y este gestor tiene que hacer
igual, porque el frontend se desarrolla contra el:

- `listed`: los planos sin exposiciones ya van `empty` (no tienen evento
  `plane`) y los demas `pending`. `flags` va como lista vacia hasta leer el
  encabezado del primer recorte; `provenance.download_mode`, `null`.
- Revisiones de un plano: la provisoria es la 1 y la definitiva la 2 o una
  posterior. Un plano que se emite una sola vez queda en la 1. Un plano sin
  exposiciones queda en la 0.
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

Pendiente de implementar: por ahora solo estan las firmas.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from app.config import Settings
from app.contract import FieldMeta
from app.domain import NormalizedRequest
from app.jobs.events import EventBus, FieldEvent
from app.jobs.store import FieldStore


class JobManager:
    """Cola de trabajos con limite global hacia IRSA.

    - Hasta `settings.max_active_jobs` trabajos a la vez; los demas esperan por
      orden de llegada, hasta `settings.max_queued_jobs`.
    - Dos pedidos del mismo campo comparten un unico trabajo.
    - Con dos trabajos activos, las conexiones se reparten por turnos.
    - El trabajo no depende de ninguna conexion: si el navegador se va, sigue y
      queda en cache.
    """

    def __init__(self, settings: Settings, store: FieldStore, bus: EventBus | None = None) -> None:
        """Crea el gestor sin arrancar ningun hilo."""
        raise NotImplementedError

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
        """
        raise NotImplementedError

    def get_meta(self, field_id: str) -> FieldMeta:
        """Documento de metadatos del campo en su estado actual, este en curso o terminado.

        Lanza `ApiError` `not_found` si no existe ni como trabajo ni en el almacen.
        """
        raise NotImplementedError

    def subscribe(self, field_id: str) -> AsyncIterator[FieldEvent]:
        """Flujo de eventos de un campo para una conexion SSE.

        El primer evento es siempre `state`, con el documento completo. Si el
        campo ya estaba terminado, siguen `done` y el fin del flujo. Si no,
        siguen los eventos del trabajo hasta `done` o `error`; justo antes de
        `done` va otro `state`, con el documento terminado. El comentario
        `: ping` lo agrega la ruta.

        Lanza `ApiError` `not_found` si el campo no existe.
        """
        raise NotImplementedError

    def set_priority(self, field_id: str, band: int) -> None:
        """Reordena los planos pendientes para que los de `band` se construyan antes.

        No hace nada si el trabajo ya termino. Lanza `ApiError` `not_found` si
        el campo no existe.
        """
        raise NotImplementedError

    def shutdown(self) -> None:
        """Detiene los trabajos en curso y espera a que terminen sus hilos."""
        raise NotImplementedError
