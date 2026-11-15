"""Servidor falso para desarrollar el frontend sin IRSA ni CDS.

Implementa todos los endpoints del contrato (docs/contrato-cubo.md, secciones
4.1 a 4.10) sobre campos de muestra ya armados, guardados con `FieldStore` en
`SPHEREX_FAKE_FIELDS_DIR` (por defecto backend/tests/fixtures/fields). No
calcula nada: reproduce con demora lo que haria el backend real.

Se arranca con:

    uv run uvicorn app.fake:app --port 8000

Como se comporta:

- `POST /api/field` elige, entre las muestras del escalon de campo pedido, la
  que tiene el centro mas cerca. El `id` y los metadatos son los de la muestra,
  no los del pedido. Si no hay ninguna muestra de ese escalon (hoy no hay del
  amplio, de 30 minutos) responde `404 no_coverage` en vez de devolver un campo
  de otro tamano. `refresh` se acepta y no hace nada: equivale a volver a
  listar y no encontrar exposiciones nuevas.
- La primera vez que se pide un campo en una ejecucion, simula un campo nuevo.
  Despues responde `ready` con los metadatos completos. `?scenario=` fuerza el
  caso: `new` (campo nuevo), `cached` (ya terminado), `queued` (espera en la
  cola con la posicion bajando de 3 a 1 y despues sigue como nuevo), `error`
  (el trabajo falla despues de las primeras imagenes provisorias) y tres que
  responden el error sin crear nada: `queue_full` (429 con `Retry-After`),
  `no_coverage` (404) y `upstream_unavailable` (503).
- El campo nuevo dura `SPHEREX_FAKE_SECONDS` (por defecto 25) y emite por SSE
  la secuencia real: `state`, `queued`, `progress`, `preview`, `listed`,
  `progress`, y por cada plano una revision provisoria (`building`, con la
  mitad de las exposiciones) y despues la definitiva, en el orden de la seccion
  8 del contrato; al final, un `state` con el documento terminado y `done`.
- La revision provisoria es la imagen de la muestra con ruido gaussiano y
  algunos huecos sin datos, para que se note la diferencia con la definitiva.
- Revisiones: se sirve la `rev` que la muestra tiene en disco, sin ajustes. El
  plano definitivo lleva esa `rev` y el provisorio la anterior (1 y 2 en las
  muestras del repositorio). Un plano que en la muestra tiene `rev` 1 se emite
  una sola vez, ya definitivo. Asi una misma URL con `?rev=N` devuelve siempre
  los mismos bytes y la cache del navegador no mezcla una imagen provisoria con
  una definitiva.
- Cache: con `?rev=N` la respuesta es `immutable` solo si N es la revision
  vigente; si se pide otra, llega la vigente con `no-cache`. Las muestras usan
  un `pipeline` propio (`app.config.SAMPLE_PIPELINE_VERSION`), asi que su `id`
  no coincide con el del campo real del mismo centro y el navegador no confunde
  lo guardado del servidor falso con lo del backend real. Una muestra que
  tenga el `pipeline` real se sirve siempre con `no-cache`.
- Lo que el flujo SSE trae y lo que no:
  - En `listed` los planos sin exposiciones ya vienen `empty` y no tienen
    evento `plane`; los demas vienen `pending`.
  - `flags` llega vacio en `listed` y se completa con el primer archivo, porque
    el backend real lee los bits del encabezado de los recortes. Los eventos
    `plane` no lo llevan: hasta el final esta solo en `GET .../meta`.
  - `cube_offset`, `provenance.built_at` y `flags` completos llegan en el
    `state` que sale justo antes de `done`. `GET .../meta` trae lo mismo.
  - `progress`: `planes_total` y `planes_ready` cuentan tambien los planos
    vacios; `cutouts_done` no incluye los fallidos, asi que el avance es
    `(cutouts_done + cutouts_failed) / cutouts_total`.
- Vista provisoria: es siempre la imagen guardada con la muestra, rotulada W1 o
  W2 segun el `band` del pedido que creo el trabajo (W2 si es 5 o 6).
- Trabajo fallido (`scenario=error`): `status` queda en `failed` y
  `progress.phase` en la fase en la que estaba. Lo que no se llego a construir
  responde `409 not_ready` con `retryable: false`: no va a estar listo hasta
  que otro `POST` reintente el campo.
- `GET /api/resolve` interpreta coordenadas en grados o sexagesimales
  (`app.resolve.coords`) y, si el texto no lo es, busca el nombre en las
  respuestas de Sesame guardadas en backend/tests/fixtures/sesame. Solo conoce
  esos nombres: el texto buscado y el nombre principal de cada respuesta, sin
  distinguir mayusculas ni signos. `GET /api/health` los lista. Con
  `?scenario=upstream_unavailable` responde 503.

La simulacion no usa tareas de fondo: el estado de un trabajo es una funcion
del tiempo transcurrido y avanza cuando llega un pedido o cuando el flujo SSE
despierta. Por eso el trabajo "sigue" aunque nadie este conectado.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import re
import time
import warnings
import xml.etree.ElementTree as ET
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, Literal

import numpy as np
from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from numpy.typing import NDArray
from pydantic import BaseModel, ValidationError

from app import __version__
from app.api.errors import (
    ApiError,
    invalid_request,
    no_coverage,
    not_found,
    not_resolved,
    queue_full,
    register_error_handlers,
    upstream_unavailable,
)
from app.config import PIPELINE_VERSION, Settings, get_settings
from app.contract import (
    CUBE_PLANE_STATUSES,
    FINISHED_FIELD_STATUSES,
    DetectorDisplay,
    DetectorInfo,
    DoneEvent,
    ErrorBody,
    ErrorDetail,
    FieldCenter,
    FieldMeta,
    FieldRequest,
    FieldResponse,
    Motion,
    PlaneEvent,
    PlaneInfo,
    PriorityRequest,
    Progress,
    QueuedEvent,
    ResolveResponse,
    SkyPosition,
    TrackResponse,
)
from app.geometry import FOV_STEPS, angular_separation_deg, normalize_request
from app.jobs.store import (
    META_FILENAME,
    FieldStore,
    ResourceNotFoundError,
    StoreError,
    compress_aux,
    cube_nbytes,
    with_cube_offsets,
)
from app.pipeline.stats import detector_display, plane_stats, robust_stats, saturated_regions
from app.preview.hips2fits import preview_band
from app.resolve.coords import parse_coordinates

logger = logging.getLogger("spherex.fake")

# Casos que se pueden forzar con `?scenario=` en `POST /api/field`. Los cuatro
# primeros deciden como se simula el trabajo; los tres ultimos responden el
# error del contrato sin crear nada.
Scenario = Literal["new", "cached", "queued", "error", "queue_full", "no_coverage", "upstream_unavailable"]
RunScenario = Literal["new", "queued", "error"]
# Casos de `GET /api/resolve`.
ResolveScenario = Literal["upstream_unavailable"]

# `Retry-After` de `scenario=queue_full`, en segundos. Corto, para ver el reintento sin esperar.
_QUEUE_FULL_RETRY_S = 5.0

# Momento de cada paso del campo nuevo simulado, como fraccion de la duracion total.
_AT_QUEUED = 0.03
_AT_LISTING = 0.06
_AT_PREVIEW = 0.10
_AT_LISTED = 0.14
_AT_DOWNLOADING = 0.16
_AT_FIRST_PLANE = 0.20
_AT_LAST_PLANE = 0.94
_AT_FINISHING = 0.97
# En `scenario=queued`, espera adicional en la cola, tambien como fraccion de la duracion.
_QUEUE_WAIT = 0.4

# Ruido de la revision provisoria, en multiplos de la sigma del plano definitivo.
_NOISE_FACTOR = 1.5

_IMMUTABLE = "public, max-age=31536000, immutable"
_PING = b": ping\n\n"

Key = tuple[int, int]  # (epoca, detector)


# ---------------------------------------------------------------- simulacion


@dataclass(frozen=True)
class _Task:
    """Una revision de un plano: la provisoria o la definitiva."""

    epoch: int
    detector: int
    final: bool


@dataclass
class _Step:
    """Un paso del trabajo simulado, que ocurre `at` segundos despues del `POST`."""

    at: float
    kind: Literal["queued", "listing", "preview", "listed", "downloading", "plane", "finishing", "done", "error"]
    task: _Task | None = None
    position: int = 0


@dataclass(frozen=True)
class _Event:
    id: int
    name: str
    data: dict[str, Any]


def _task_order(band: int) -> Callable[[_Task], tuple[int, int, int, int]]:
    """Orden de la seccion 8 del contrato.

    Primero la banda pedida y despues las demas, de la mas cercana a la mas
    lejana. Dentro de una banda, todas las epocas avanzan a la vez: primero las
    revisiones provisorias de cada una y despues las definitivas.
    """
    return lambda task: (abs(task.detector - band), task.detector, int(task.final), task.epoch)


def provisional_image(field_id: str, epoch: int, detector: int, final: NDArray[np.float32]) -> NDArray[np.float32]:
    """Imagen de una revision provisoria: la definitiva con ruido gaussiano y algunos huecos sin datos.

    Es determinista (la semilla sale del campo y del plano), porque el binario
    de una revision no puede cambiar. Los pixeles saturados se conservan.
    """
    digest = hashlib.sha256(f"{field_id}|{epoch}|{detector}".encode()).digest()
    rng = np.random.default_rng(int.from_bytes(digest[:8], "little"))
    finite = np.isfinite(final)
    sigma = 0.0
    if finite.any():
        values = final[finite].astype(np.float64)
        _, sigma = robust_stats(values)
        if sigma <= 0.0:
            sigma = float(values.std())
    if sigma <= 0.0:
        sigma = 1e-3
    image = final + rng.normal(0.0, _NOISE_FACTOR * sigma, final.shape).astype(np.float32)

    ny, nx = final.shape
    holes = np.zeros(final.shape, dtype=bool)
    for _ in range(3):
        height = max(2, round(ny * rng.uniform(0.05, 0.12)))
        width = max(2, round(nx * rng.uniform(0.05, 0.12)))
        y0 = int(rng.integers(0, max(1, ny - height + 1)))
        x0 = int(rng.integers(0, max(1, nx - width + 1)))
        holes[y0 : y0 + height, x0 : x0 + width] = True
    # Una franja en un borde, como la de una exposicion que todavia no llego.
    strip = max(1, round(0.06 * min(ny, nx)))
    edge = int(rng.integers(0, 4))
    if edge == 0:
        holes[:, :strip] = True
    elif edge == 1:
        holes[:, -strip:] = True
    elif edge == 2:
        holes[:strip, :] = True
    else:
        holes[-strip:, :] = True
    image[holes & finite] = np.nan
    return image.astype(np.float32)


class _Run:
    """Trabajo simulado de un campo nuevo.

    Al crearlo se arma el plan completo (`steps`). `advance` aplica los pasos
    cuyo momento ya paso: cada uno modifica `meta` y agrega a `events` los
    eventos SSE que le corresponden.
    """

    def __init__(
        self,
        sample: FieldMeta,
        store: FieldStore,
        band: int,
        scenario: RunScenario,
        seconds: float,
        now: float,
        progress_interval: float,
    ) -> None:
        assert sample.grid is not None and sample.planes is not None
        self.sample = sample
        self.store = store
        self.band = band
        self.scenario = scenario
        self.seconds = seconds
        self.started = now
        self.shape = sample.grid.shape
        self.events: list[_Event] = []
        self.closing: _Event | None = None
        self.cursor = 0
        # Imagen vigente de cada plano que ya tiene datos, provisoria o definitiva.
        self.images: dict[Key, NDArray[np.float32]] = {}
        self._progress_interval = progress_interval
        self._last_progress_at = -math.inf
        self._emitted_warnings: set[int] = set()
        self._count_empty = sample.progress.planes_total == len(sample.planes)
        # Recortes de cada plano que ya conto su revision provisoria.
        self._counted: dict[Key, int] = {}
        # La vista provisoria se pide al crear el trabajo: queda con la banda de este
        # pedido (contrato, seccion 4.10), aunque despues cambie la prioridad. La
        # imagen es siempre la de la muestra; solo cambia el rotulo.
        preview_name, preview_wave_um = preview_band(band)
        self.preview = sample.preview.model_copy(deep=True, update={"band": preview_name, "wave_um": preview_wave_um})
        self.meta = FieldMeta(
            id=sample.id,
            pipeline=sample.pipeline,
            status="queued",
            rev=0,
            request=sample.request.model_copy(),
            progress=Progress(phase="queued", queue_position=3 if scenario == "queued" else 1),
            preview=self.preview.model_copy(update={"status": "pending", "display": None}),
        )
        self.steps = self._plan()

    # ------------------------------------------------------------------ plan

    def _tasks(self) -> list[_Task]:
        tasks: list[_Task] = []
        for plane in self.sample.planes or ():
            if plane.status in CUBE_PLANE_STATUSES:
                if plane.rev >= 2:
                    # Hay lugar para una revision anterior a la definitiva: la provisoria.
                    tasks.append(_Task(plane.epoch, plane.detector, final=False))
                tasks.append(_Task(plane.epoch, plane.detector, final=True))
            elif plane.n_exposures > 0:
                # Tenia exposiciones y ninguna sirvio: recien al procesarlas se sabe que queda vacio.
                tasks.append(_Task(plane.epoch, plane.detector, final=True))
        return sorted(tasks, key=_task_order(self.band))

    def _plan(self) -> list[_Step]:
        total = self.seconds
        steps: list[_Step] = []
        shift = 0.0
        if self.scenario == "queued":
            shift = _QUEUE_WAIT * total
            steps.append(_Step(_AT_QUEUED * total, "queued", position=3))
            steps.append(_Step(_AT_QUEUED * total + shift / 2.0, "queued", position=2))
            steps.append(_Step(_AT_QUEUED * total + shift, "queued", position=1))
        else:
            steps.append(_Step(_AT_QUEUED * total, "queued", position=1))
        steps.append(_Step(shift + _AT_LISTING * total, "listing"))
        steps.append(_Step(shift + _AT_PREVIEW * total, "preview"))
        steps.append(_Step(shift + _AT_LISTED * total, "listed"))
        steps.append(_Step(shift + _AT_DOWNLOADING * total, "downloading"))

        tasks = self._tasks()
        span = _AT_LAST_PLANE - _AT_FIRST_PLANE
        slots = [shift + total * (_AT_FIRST_PLANE + span * i / max(len(tasks) - 1, 1)) for i in range(len(tasks))]
        if self.scenario == "error":
            # Falla despues de las imagenes provisorias de la banda pedida.
            keep = sum(1 for task in tasks if task.detector == tasks[0].detector and not task.final) if tasks else 0
            keep = min(max(keep, 1), len(tasks))
            steps.extend(_Step(at, "plane", task) for task, at in zip(tasks[:keep], slots[:keep], strict=True))
            steps.append(_Step(slots[keep] if keep < len(slots) else shift + _AT_FINISHING * total, "error"))
        else:
            steps.extend(_Step(at, "plane", task) for task, at in zip(tasks, slots, strict=True))
            steps.append(_Step(shift + _AT_FINISHING * total, "finishing"))
            steps.append(_Step(shift + total, "done"))
        return steps

    def reprioritize(self, band: int) -> None:
        """Reordena las revisiones que faltan para que las de `band` salgan antes. Los horarios no cambian."""
        self.band = band
        pending = [i for i in range(self.cursor, len(self.steps)) if self.steps[i].task is not None]
        tasks = sorted((self.steps[i].task for i in pending), key=_task_order(band))  # type: ignore[arg-type, return-value]
        for index, task in zip(pending, tasks, strict=True):
            self.steps[index].task = task

    # ---------------------------------------------------------------- avance

    @property
    def finished(self) -> bool:
        return self.cursor >= len(self.steps)

    def next_at(self) -> float | None:
        """Momento (reloj monotono) del proximo paso, o `None` si el trabajo termino."""
        return None if self.finished else self.started + self.steps[self.cursor].at

    def advance(self, now: float) -> None:
        """Aplica todos los pasos cuyo momento ya paso."""
        elapsed = now - self.started
        while self.cursor < len(self.steps) and self.steps[self.cursor].at <= elapsed:
            step = self.steps[self.cursor]
            self.cursor += 1
            self._apply(step)

    def _emit(self, name: str, data: BaseModel) -> None:
        self.events.append(_Event(len(self.events) + 2, name, data.model_dump(mode="json")))

    def _emit_progress(self, step: _Step, *, force: bool = False) -> None:
        """Evento `progress`, como maximo uno cada `progress_interval` segundos salvo en los cambios de fase."""
        if force or step.at - self._last_progress_at >= self._progress_interval:
            self._last_progress_at = step.at
            self._emit("progress", self.meta.progress)

    def _emit_warnings(self, indices: list[int]) -> None:
        for index in indices:
            if index in self._emitted_warnings:
                continue
            self._emitted_warnings.add(index)
            warning = self.sample.warnings[index]
            self.meta.warnings.append(warning.model_copy(deep=True))
            self._emit("warning", warning)

    def _apply(self, step: _Step) -> None:
        progress = self.meta.progress
        progress.elapsed_s = round(step.at, 1)
        if step.kind == "queued":
            progress.queue_position = step.position
            self._emit("queued", QueuedEvent(position=step.position))
        elif step.kind == "listing":
            self.meta.status = "listing"
            progress.phase = "listing"
            progress.queue_position = 0
            self._emit_progress(step, force=True)
        elif step.kind == "preview":
            self.meta.preview = self.preview.model_copy(deep=True)
            self._emit("preview", self.meta.preview)
        elif step.kind == "listed":
            self._apply_listed()
        elif step.kind == "downloading":
            self._emit_progress(step, force=True)
        elif step.kind == "plane":
            assert step.task is not None
            self._apply_plane(step, step.task)
        elif step.kind == "finishing":
            progress.phase = "finishing"
            # Lo que no se aviso antes (recortes fallidos, descarga completa) sale al cerrar.
            self._emit_warnings(list(range(len(self.sample.warnings))))
            self._emit_progress(step, force=True)
        elif step.kind == "done":
            self._apply_done(step)
        elif step.kind == "error":
            # `progress.phase` no tiene un valor para la falla: queda en la fase en la que estaba.
            self.meta.status = "failed"
            detail = ErrorDetail(
                code="upstream_unavailable",
                message="falla simulada (scenario=error): IRSA dejo de responder",
                retryable=True,
            )
            self._emit("error", ErrorBody(error=detail))
            self.closing = self.events[-1]

    def _apply_listed(self) -> None:
        sample, meta = self.sample, self.meta
        assert sample.grid is not None and sample.planes is not None
        meta.grid = sample.grid.model_copy(deep=True)
        meta.detectors = [
            DetectorInfo(detector=d.detector, wave_min_um=d.wave_min_um, wave_max_um=d.wave_max_um)
            for d in sample.detectors or ()
        ]
        meta.epochs = [epoch.model_copy() for epoch in sample.epochs or ()]
        meta.planes = []
        for plane in sample.planes:
            if plane.status == "empty" and plane.n_exposures == 0:
                # Sin exposiciones: se sabe vacio desde la lista (contrato, seccion 9). No va a
                # tener evento `plane`, y cuenta como terminado en `planes_ready`.
                meta.planes.append(plane.model_copy(deep=True, update={"cube_offset": None}))
            else:
                meta.planes.append(
                    PlaneInfo(
                        epoch=plane.epoch, detector=plane.detector, status="pending", n_exposures=plane.n_exposures
                    )
                )
        # Los bits de FLAGS salen del encabezado de los archivos: todavia no se bajo ninguno.
        meta.flags = []
        if sample.provenance is not None:
            meta.provenance = sample.provenance.model_copy(deep=True, update={"download_mode": None, "built_at": None})

        # Avisos que se conocen con solo listar las exposiciones.
        for index, warning in enumerate(sample.warnings):
            known = warning.code in ("few_exposures", "stale_exposure_list")
            if warning.code == "plane_empty":
                plane = sample.plane(warning.epoch, warning.detector)
                known = plane is None or plane.n_exposures == 0
            if known:
                self._emitted_warnings.add(index)
                meta.warnings.append(warning.model_copy(deep=True))

        meta.status = "downloading"
        progress = meta.progress
        progress.phase = "downloading"
        progress.queue_position = 0
        progress.cutouts_total = sum(plane.n_exposures for plane in sample.planes)
        progress.planes_total = sample.progress.planes_total or sum(
            1 for plane in sample.planes if plane.status in CUBE_PLANE_STATUSES
        )
        progress.planes_ready = self._planes_ready()
        self._emit("listed", meta)

    def _planes_ready(self) -> int:
        final = CUBE_PLANE_STATUSES | {"empty"} if self._count_empty else CUBE_PLANE_STATUSES
        return sum(1 for plane in self.meta.planes or () if plane.status in final)

    def _apply_plane(self, step: _Step, task: _Task) -> None:
        sample, meta, progress = self.sample, self.meta, self.meta.progress
        assert meta.planes is not None and meta.detectors is not None
        key = (task.epoch, task.detector)
        source = sample.plane(*key)
        assert source is not None
        if not self.images:
            # Con el primer archivo se conocen los bits de FLAGS y el modo de descarga.
            meta.flags = [flag.model_copy() for flag in sample.flags or ()]
            if meta.provenance is not None and sample.provenance is not None:
                meta.provenance.download_mode = sample.provenance.download_mode

        # Recortes que llegaron (se hayan usado o no) y cuantos de ellos entran en la revision provisoria.
        downloaded = max(source.n_exposures - source.n_failed, 0)
        half = min(max(1, source.n_exposures // 2), max(source.n_used, 1))
        if source.status == "empty":
            plane = source.model_copy(deep=True, update={"cube_offset": None})
            progress.cutouts_done += downloaded
            progress.cutouts_failed += source.n_failed
        elif not task.final:
            final_image = self.store.read_plane(sample.id, task.epoch, task.detector, shape=self.shape)
            image = provisional_image(sample.id, task.epoch, task.detector, final_image)
            self.images[key] = image
            plane = PlaneInfo(
                epoch=task.epoch,
                detector=task.detector,
                status="building",
                rev=source.rev - 1,
                n_exposures=source.n_exposures,
                n_used=half,
                mjd_mean=source.mjd_mean,
                stats=plane_stats(image),
                saturated=saturated_regions(image),
            )
            progress.cutouts_done += half
            self._counted[key] = half
        else:
            self.images[key] = self.store.read_plane(sample.id, task.epoch, task.detector, shape=self.shape)
            plane = source.model_copy(deep=True, update={"cube_offset": None})
            progress.cutouts_done += max(downloaded - self._counted.pop(key, 0), 0)
            progress.cutouts_failed += source.n_failed

        index = next(i for i, item in enumerate(meta.planes) if (item.epoch, item.detector) == key)
        meta.planes[index] = plane
        progress.planes_ready = self._planes_ready()

        display = detector_display([image for (_, detector), image in self.images.items() if detector == task.detector])
        for item in meta.detectors:
            if item.detector == task.detector:
                item.display = display
        event_display = None if display is None else DetectorDisplay(detector=task.detector, **display.model_dump())

        self._emit_progress(step)
        self._emit("plane", PlaneEvent(plane=plane, detector_display=event_display))
        if task.final:
            self._emit_warnings(self._warnings_for(key))

    def _warnings_for(self, key: Key) -> list[int]:
        """Avisos de la muestra que se detectan al terminar ese plano."""
        epoch, detector = key
        found: list[int] = []
        for index, warning in enumerate(self.sample.warnings):
            if warning.code in ("low_coverage", "plane_empty"):
                if (warning.epoch, warning.detector) == key:
                    found.append(index)
            elif warning.code == "saturated_source":
                if epoch in warning.epochs and detector in warning.detectors:
                    found.append(index)
        return found

    def _apply_done(self, step: _Step) -> None:
        final = self.sample.model_copy(deep=True)
        final.progress.phase = "done"
        final.progress.queue_position = 0
        final.progress.elapsed_s = round(step.at, 1)
        final.preview = self.preview.model_copy(deep=True)
        self.meta = final
        self.images.clear()
        assert final.status in FINISHED_FIELD_STATUSES
        # Ningun evento anterior lleva `cube_offset`, `flags` ni `provenance` completos: el
        # documento terminado sale en un `state` justo antes de `done`, para que quien sigue
        # el flujo no tenga que volver a pedir los metadatos.
        self._emit("state", final)
        self._emit(
            "done",
            DoneEvent(status=final.status, rev=final.rev, elapsed_s=final.progress.elapsed_s),  # type: ignore[arg-type]
        )
        self.closing = self.events[-1]


# ------------------------------------------------------------------- muestras


def _step_name(fov: float) -> str:
    """Escalon de campo al que corresponde un `fov`: el menor que lo contiene (contrato, seccion 3)."""
    for step in FOV_STEPS:
        if fov <= step.fov + 1e-9:
            return step.name
    return FOV_STEPS[-1].name


def _revision_problem(meta: FieldMeta) -> str | None:
    """Por que las revisiones de una muestra no son las de un campo terminado, o `None` si estan bien.

    Un campo terminado tiene `rev` 1 o mas. Un plano con datos, o uno que quedo
    vacio despues de procesar sus exposiciones, cambio al menos una vez desde la
    lista: tambien tiene `rev` 1 o mas.
    """
    if meta.rev < 1:
        return f"el campo esta terminado y tiene rev={meta.rev}"
    for plane in meta.planes or ():
        changed = plane.status in CUBE_PLANE_STATUSES or plane.n_exposures > 0
        if changed and plane.rev < 1:
            return f"el plano de la epoca {plane.epoch} y el detector {plane.detector} tiene rev={plane.rev}"
    return None


def _load_sample(store: FieldStore, field_id: str) -> FieldMeta | None:
    """Lee una muestra y la prepara para servirla. Devuelve `None` si no sirve como campo terminado."""
    folder = store.locate(field_id)
    if folder is None:
        return None
    path = folder / META_FILENAME
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(document, dict) and "preview" not in document:
            # Tolerancia con muestras viejas: sin vista provisoria.
            document["preview"] = {"status": "unavailable", "band": "W1", "wave_um": 3.4, "hips": ""}
        meta = FieldMeta.model_validate(document)
    except (OSError, ValueError, ValidationError) as exc:
        logger.warning("muestra %s descartada: %s no cumple el contrato: %s", field_id, path, exc)
        return None

    planes = meta.planes or []
    complete = meta.grid is not None and meta.detectors is not None and meta.epochs is not None and bool(planes)
    statuses_ok = all(plane.status in CUBE_PLANE_STATUSES or plane.status == "empty" for plane in planes)
    if meta.status not in FINISHED_FIELD_STATUSES or not complete or not statuses_ok:
        logger.warning("muestra %s descartada: no es un campo terminado (status=%s)", field_id, meta.status)
        return None
    # Las revisiones se sirven como estan en disco, sin ajustes: lo guardado tiene que ser coherente.
    problem = _revision_problem(meta)
    if problem is not None:
        logger.warning("muestra %s descartada: %s", field_id, problem)
        return None
    if meta.id != field_id:
        logger.warning("muestra %s: meta.json dice id=%s; se usa el nombre de la carpeta", field_id, meta.id)
        meta.id = field_id

    meta = with_cube_offsets(meta)
    meta.flags = meta.flags or []
    if meta.preview.status == "pending" or (meta.preview.status == "ready" and not store.has_preview(field_id)):
        meta.preview.status = "unavailable"
    if meta.preview.status != "ready":
        meta.preview.display = None
    return meta


# --------------------------------------------------------------------- Sesame


@dataclass
class _SesameEntry:
    """Una respuesta de Sesame guardada, ya interpretada."""

    keys: set[str]
    query: str | None  # el texto con el que se hizo la consulta guardada
    name: str | None  # nombre principal segun el catalogo
    object_type: str | None
    ra: float
    dec: float
    pm_ra: float | None
    pm_dec: float | None
    parallax: float | None
    radial_velocity: float | None


def _name_key(text: str) -> str:
    """Clave para comparar nombres: solo letras y numeros, en minusculas."""
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def _parse_sesame(path: Path) -> _SesameEntry | None:
    """Interpreta una respuesta XML de Sesame guardada.

    Lee los mismos elementos que `resolve_name` en spike/field.py, que se probo
    contra el servicio (`jradeg`, `jdedeg`, `pm/pmRA`, `pm/pmDE`, `plx/v`,
    `Vel/v` y `oname` dentro de `Target/Resolver`), mas `Target/name` (el texto
    buscado) y `otype`, que se usan solo si estan.
    """
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        root = ET.fromstring(text.split("<!---")[0])
    except (OSError, ET.ParseError) as exc:
        logger.warning("respuesta de Sesame ilegible en %s: %s", path, exc)
        return None

    def number(node: ET.Element, tag: str) -> float | None:
        value = node.findtext(tag)
        try:
            return float(value) if value and value.strip() else None
        except ValueError:
            return None

    for resolver in root.findall("./Target/Resolver"):
        ra, dec = number(resolver, "jradeg"), number(resolver, "jdedeg")
        if ra is None or dec is None:
            continue
        name = (resolver.findtext("oname") or "").strip() or None
        query = (root.findtext("./Target/name") or "").strip() or None
        keys = {_name_key(path.stem)}
        for candidate in (name, query):
            if candidate:
                keys.add(_name_key(candidate))
                keys.add(_name_key(candidate.removeprefix("NAME ")))
        return _SesameEntry(
            keys={key for key in keys if key},
            query=query,
            name=name,
            object_type=(resolver.findtext("otype") or "").strip() or None,
            ra=ra,
            dec=dec,
            pm_ra=number(resolver, "pm/pmRA"),
            pm_dec=number(resolver, "pm/pmDE"),
            parallax=number(resolver, "plx/v"),
            radial_velocity=number(resolver, "Vel/v"),
        )
    return None


def _propagate(entry: _SesameEntry, year: float) -> tuple[float, float]:
    """Posicion del objeto en el anio juliano `year`: movimiento propio mas paralaje.

    Misma cuenta que `Target.position_at` en spike/field.py. La implementacion
    del backend real va en app/resolve/motion.py; esta copia es solo para que el
    servidor falso no dependa de ella.
    """
    import astropy.units as u
    from astropy.coordinates import Distance, SkyCoord, get_body_barycentric
    from astropy.time import Time
    from erfa import ErfaWarning

    when = Time(year, format="jyear")
    parallax = entry.parallax or 0.0
    kwargs: dict[str, Any] = {
        "ra": entry.ra * u.deg,
        "dec": entry.dec * u.deg,
        "pm_ra_cosdec": (entry.pm_ra or 0.0) * u.mas / u.yr,
        "pm_dec": (entry.pm_dec or 0.0) * u.mas / u.yr,
        "obstime": Time(2000.0, format="jyear"),
        "frame": "icrs",
    }
    if parallax > 0:
        kwargs["distance"] = Distance(parallax=parallax * u.mas)
        kwargs["radial_velocity"] = (entry.radial_velocity or 0.0) * u.km / u.s
    with warnings.catch_warnings():
        # Sin paralaje, ERFA propaga con una distancia muy grande y lo avisa ("distance
        # overridden"): es lo que se quiere, movimiento propio puro.
        warnings.simplefilter("ignore", ErfaWarning)
        moved = SkyCoord(**kwargs).apply_space_motion(new_obstime=when)
    ra, dec = float(moved.ra.deg), float(moved.dec.deg)
    if parallax > 0:
        x, y, z = get_body_barycentric("earth", when).xyz.to_value(u.au)
        a, d = math.radians(ra), math.radians(dec)
        east = parallax * (x * math.sin(a) - y * math.cos(a))
        north = parallax * (x * math.cos(a) * math.sin(d) + y * math.sin(a) * math.sin(d) - z * math.cos(d))
        ra += east / 3.6e6 / math.cos(d)
        dec += north / 3.6e6
    return ra % 360.0, dec


# -------------------------------------------------------------------- servidor


@dataclass
class FakeBackend:
    """Estado del servidor falso: muestras, trabajos simulados y respuestas de Sesame guardadas."""

    fields_dir: Path
    sesame_dir: Path
    seconds: float
    ping_seconds: float = 15.0
    progress_interval: float = 0.25
    field_epoch: float = 2026.0
    # Version del pipeline del backend real. Una muestra que la use comparte `id` y
    # rutas con el campo real: no se la sirve como `immutable`.
    real_pipeline: str = PIPELINE_VERSION
    # `perf_counter` y no `monotonic`, que en Windows avanza de a 16 ms.
    clock: Callable[[], float] = time.perf_counter
    runs: dict[str, _Run] = field(default_factory=dict)
    seen: set[str] = field(default_factory=set)
    _samples: dict[str, tuple[int, FieldMeta | None]] = field(default_factory=dict)
    _sesame: tuple[tuple[tuple[str, int], ...], list[_SesameEntry]] | None = None

    def __post_init__(self) -> None:
        self.store = FieldStore(self.fields_dir)
        self.ping_seconds = max(self.ping_seconds, 0.01)

    # ------------------------------------------------------------- muestras

    def samples(self) -> dict[str, FieldMeta]:
        """Muestras disponibles. Vuelve a leer las que cambiaron en disco."""
        found: dict[str, tuple[int, FieldMeta | None]] = {}
        for field_id in self.store.list_ids():
            folder = self.store.locate(field_id)
            try:
                stamp = (folder / META_FILENAME).stat().st_mtime_ns if folder is not None else -1
            except OSError:
                continue
            cached = self._samples.get(field_id)
            if cached is None or cached[0] != stamp:
                cached = (stamp, _load_sample(self.store, field_id))
            found[field_id] = cached
        self._samples = found
        return {field_id: meta for field_id, (_, meta) in found.items() if meta is not None}

    def state(self, field_id: str) -> tuple[FieldMeta, FieldMeta, _Run | None]:
        """Devuelve (muestra, metadatos actuales, trabajo simulado si lo hay), con el trabajo puesto al dia."""
        sample = self.samples().get(field_id)
        if sample is None:
            raise not_found(f"no existe el campo {field_id!r}")
        run = self.runs.get(field_id)
        if run is not None and run.sample is not sample:
            # La muestra cambio en disco: el trabajo simulado ya no vale.
            del self.runs[field_id]
            run = None
        if run is None:
            return sample, sample, None
        run.advance(self.clock())
        return sample, run.meta, run

    # ---------------------------------------------------------------- campo

    def submit(self, body: FieldRequest, scenario: Scenario | None) -> tuple[int, FieldResponse]:
        # Primero se valida el pedido: un pedido invalido es `invalid_request` con cualquier escenario.
        request = normalize_request(body.ra, body.dec, body.fov, body.band, body.refresh)
        if scenario == "queue_full":
            raise queue_full(
                "cola de trabajos llena (simulado con scenario=queue_full)", retry_after=_QUEUE_FULL_RETRY_S
            )
        if scenario == "no_coverage":
            raise no_coverage("ninguna exposicion cubre el punto (simulado con scenario=no_coverage)")
        if scenario == "upstream_unavailable":
            raise upstream_unavailable(
                "IRSA no responde y no hay copia en cache (simulado con scenario=upstream_unavailable)"
            )

        samples = self.samples()
        if not samples:
            raise no_coverage(f"el servidor falso no tiene campos de muestra en {self.fields_dir}")
        # Solo muestras del escalon pedido: devolver un campo de otro tamano no cumple la seccion 3.
        same_step = [meta for meta in samples.values() if _step_name(meta.request.fov) == request.step.name]
        if not same_step:
            raise no_coverage(
                f"el servidor falso no tiene campos de muestra del escalon {request.step.name!r} (fov {request.fov})"
            )
        chosen = min(
            same_step,
            key=lambda meta: (
                angular_separation_deg(request.ra, request.dec, meta.request.ra, meta.request.dec),
                meta.id,
            ),
        )
        sample, meta, run = self.state(chosen.id)
        in_progress = run is not None and not run.finished

        if scenario == "cached":
            self.runs.pop(sample.id, None)
            meta = sample
        elif run is not None and in_progress and scenario in (None, run.scenario):
            # Ya hay un trabajo para este campo: el pedido se suma a el.
            if request.band != run.band:
                run.reprioritize(request.band)
        elif scenario is None and sample.id in self.seen and meta.status in FINISHED_FIELD_STATUSES:
            pass  # ya se pidio antes en esta ejecucion: esta "en cache"
        else:
            run_scenario: RunScenario = "queued" if scenario == "queued" else "error" if scenario == "error" else "new"
            run = _Run(
                sample, self.store, request.band, run_scenario, self.seconds, self.clock(), self.progress_interval
            )
            self.runs[sample.id] = run
            meta = run.meta
        self.seen.add(sample.id)

        response = FieldResponse(
            id=sample.id, status=meta.status, events_url=f"/api/field/{sample.id}/events", meta=meta
        )
        return (200 if meta.status in FINISHED_FIELD_STATUSES else 202), response

    def set_priority(self, field_id: str, band: int) -> None:
        _, _, run = self.state(field_id)
        if run is not None and not run.finished:
            run.reprioritize(band)

    async def stream(self, sample: FieldMeta, run: _Run | None) -> AsyncIterator[bytes]:
        """Flujo SSE de un campo: `state`, lo que vaya pasando, y cierre despues de `done` o `error`."""
        if run is None:
            # Campo terminado: `state`, `done` y cierre.
            yield _sse("state", 1, sample.model_dump(mode="json"))
            done = DoneEvent(status=sample.status, rev=sample.rev, elapsed_s=sample.progress.elapsed_s)  # type: ignore[arg-type]
            yield _sse("done", 2, done.model_dump(mode="json"))
            return

        run.advance(self.clock())
        sent = len(run.events)
        state_id = run.events[-1].id if run.events else 1
        yield _sse("state", state_id, run.meta.model_dump(mode="json"))
        if run.finished:
            if run.closing is not None:
                yield _sse(run.closing.name, state_id + 1, run.closing.data)
            return

        last_write = self.clock()
        while True:
            run.advance(self.clock())
            while sent < len(run.events):
                event = run.events[sent]
                sent += 1
                yield _sse(event.name, event.id, event.data)
                last_write = self.clock()
                if event.name in ("done", "error"):
                    return
            next_at = run.next_at()
            if next_at is None:
                return
            now = self.clock()
            wait = next_at - now
            until_ping = self.ping_seconds - (now - last_write)
            if until_ping <= wait:
                await asyncio.sleep(max(until_ping, 0.0))
                yield _PING
                last_write = self.clock()
            else:
                await asyncio.sleep(max(wait, 0.0) + 0.001)

    # --------------------------------------------------------------- binarios

    def revision_headers(self, sample: FieldMeta, requested: int | None, current: int) -> dict[str, str]:
        """Cabecera de cache de un plano o del cubo pedido con `?rev=N` (contrato, secciones 4.4 y 4.5).

        `immutable` solo si N es la revision vigente: esa URL va a devolver
        siempre esos bytes. Si se pidio otra revision (ya reemplazada o que
        todavia no existe) se devuelve la vigente con `no-cache`, porque esa URL
        no corresponde a esos bytes. Tampoco es `immutable` una muestra con el
        `pipeline` del backend real: comparte `id` y rutas con el campo real, y
        el navegador mostraria la muestra en su lugar.
        """
        cacheable = requested is not None and requested == current and sample.pipeline != self.real_pipeline
        return {"Cache-Control": _IMMUTABLE if cacheable else "no-cache"}

    def _plane(self, field_id: str, epoch: int, detector: int) -> tuple[FieldMeta, PlaneInfo, _Run | None]:
        """El plano en su estado actual, o el error del contrato: 404 si no existe o esta vacio, 409 si falta."""
        sample, meta, run = self.state(field_id)
        if sample.plane(epoch, detector) is None:
            raise not_found(f"el campo {field_id!r} no tiene el plano de la epoca {epoch} y el detector {detector}")
        plane = meta.plane(epoch, detector)
        if plane is None or plane.status == "pending":
            raise _not_ready(meta, f"el plano de la epoca {epoch} y el detector {detector} todavia no esta construido")
        if plane.status == "empty":
            raise not_found(f"el plano de la epoca {epoch} y el detector {detector} esta vacio: no tiene binario")
        return sample, plane, run

    def plane_payload(
        self, field_id: str, epoch: int, detector: int, requested_rev: int | None = None
    ) -> tuple[bytes, dict[str, str]]:
        """Bytes del plano en su revision vigente y la cabecera de cache que le corresponde."""
        sample, plane, run = self._plane(field_id, epoch, detector)
        assert sample.grid is not None
        headers = self.revision_headers(sample, requested_rev, plane.rev)
        if plane.status == "building" and run is not None:
            return np.ascontiguousarray(run.images[(epoch, detector)], dtype="<f4").tobytes(), headers
        try:
            return self.store.read_plane_bytes(field_id, epoch, detector, shape=sample.grid.shape), headers
        except ResourceNotFoundError as exc:
            raise not_found(str(exc)) from exc

    def aux_payload(self, field_id: str, epoch: int, detector: int, accept_gzip: bool) -> tuple[bytes, bool]:
        """Capa auxiliar del plano. Devuelve los bytes y si van comprimidos con gzip."""
        sample, plane, run = self._plane(field_id, epoch, detector)
        assert sample.grid is not None
        shape = sample.grid.shape
        try:
            if plane.status == "building" and run is not None:
                # Media cobertura, y cero donde la imagen provisoria no tiene dato.
                flags, coverage = self.store.read_aux(field_id, epoch, detector, shape=shape)
                valid = np.isfinite(run.images[(epoch, detector)])
                coverage = np.where(valid, np.maximum((coverage + 1) // 2, 1), 0).astype(np.uint16)
                if accept_gzip:
                    return compress_aux(flags, coverage, shape), True
                return flags.astype("<u4").tobytes() + coverage.astype("<u2").tobytes(), False
            if accept_gzip:
                return self.store.read_aux_gzip(field_id, epoch, detector, shape=shape), True
            return self.store.read_aux_bytes(field_id, epoch, detector, shape=shape), False
        except ResourceNotFoundError as exc:
            raise not_found(str(exc)) from exc

    def cube(self, field_id: str, requested_rev: int | None = None) -> tuple[Iterator[bytes], dict[str, str]]:
        """Iterador con los bytes de `/cube` y sus cabeceras: la de cache y el tamano."""
        sample, meta, _ = self.state(field_id)
        if meta.status not in FINISHED_FIELD_STATUSES:
            raise _not_ready(meta, f"el campo {field_id!r} todavia no termino")
        headers = self.revision_headers(sample, requested_rev, meta.rev) | {"Content-Length": str(cube_nbytes(sample))}
        try:
            return self.store.iter_cube(field_id, sample), headers
        except ResourceNotFoundError as exc:
            raise not_found(str(exc)) from exc

    def preview_payload(self, field_id: str) -> bytes:
        sample, meta, _ = self.state(field_id)
        assert sample.grid is not None
        if meta.preview.status == "pending":
            raise _not_ready(meta, "la vista provisoria todavia no esta lista")
        if meta.preview.status == "unavailable":
            raise not_found("el campo no tiene vista provisoria")
        try:
            return self.store.read_preview_bytes(field_id, shape=sample.grid.shape)
        except ResourceNotFoundError as exc:
            raise not_found(str(exc)) from exc

    # ------------------------------------------------------- nombres y rastro

    def _sesame_entries(self) -> list[_SesameEntry]:
        """Respuestas de Sesame guardadas. Se releen si cambia el contenido de la carpeta."""
        paths = sorted(self.sesame_dir.rglob("*.xml")) if self.sesame_dir.is_dir() else []
        stamp = tuple((str(path), path.stat().st_mtime_ns) for path in paths)
        if self._sesame is None or self._sesame[0] != stamp:
            entries = [entry for entry in (_parse_sesame(path) for path in paths) if entry is not None]
            self._sesame = (stamp, entries)
        return self._sesame[1]

    def _sesame_lookup(self, text: str) -> _SesameEntry | None:
        key = _name_key(text)
        return next((entry for entry in self._sesame_entries() if key and key in entry.keys), None)

    def known_names(self) -> list[str]:
        """Textos que `resolve` reconoce como nombre: el buscado y el principal de cada respuesta guardada."""
        names = {text for entry in self._sesame_entries() for text in (entry.query, entry.name) if text}
        return sorted(names)

    def resolve(self, query: str, scenario: ResolveScenario | None = None) -> ResolveResponse:
        text = query.strip()
        if not text:
            raise invalid_request("name no puede estar vacio")
        if scenario == "upstream_unavailable":
            raise upstream_unavailable(
                "Sesame no responde y no hay copia en cache (simulado con scenario=upstream_unavailable)"
            )
        # Coordenadas, en grados o sexagesimales: no se consulta el catalogo (contrato, seccion 4.8).
        coordinates = parse_coordinates(text)
        if coordinates is not None:
            ra, dec = coordinates
            return ResolveResponse(
                query=text,
                source="coordinates",
                j2000=SkyPosition(ra=round(ra, 6) % 360.0, dec=round(dec, 6)),
                field_center=FieldCenter(ra=round(ra, 4) % 360.0, dec=round(dec, 4), epoch=self.field_epoch),
            )

        entry = self._sesame_lookup(text)
        if entry is None:
            raise not_resolved(f"el servidor falso no tiene guardada una respuesta de Sesame para {text!r}")
        motion = None
        center_ra, center_dec = entry.ra, entry.dec
        if entry.pm_ra is not None and entry.pm_dec is not None:
            # Paralaje y velocidad radial van como `null` si el catalogo no las trae.
            motion = Motion(
                pm_ra=entry.pm_ra,
                pm_dec=entry.pm_dec,
                parallax=entry.parallax,
                radial_velocity=entry.radial_velocity,
                per_year_arcsec=round(math.hypot(entry.pm_ra, entry.pm_dec) / 1000.0, 2),
            )
            center_ra, center_dec = _propagate(entry, self.field_epoch)
        moved = angular_separation_deg(entry.ra, entry.dec, center_ra, center_dec) * 3600.0
        return ResolveResponse(
            query=text,
            name=entry.name,
            source="sesame",
            object_type=entry.object_type,
            j2000=SkyPosition(ra=round(entry.ra, 6), dec=round(entry.dec, 6)),
            motion=motion,
            field_center=FieldCenter(ra=round(center_ra, 4) % 360.0, dec=round(center_dec, 4), epoch=self.field_epoch),
            moved_arcsec=round(moved, 1),
        )

    def track(self, field_id: str, name: str) -> TrackResponse:
        """Trayectoria guardada con la muestra para ese objeto; `positions` vacio si no hay ninguna."""
        self.state(field_id)
        text = name.strip()
        if not text:
            raise invalid_request("name no puede estar vacio")
        keys = {_name_key(text)}
        entry = self._sesame_lookup(text)
        if entry is not None:
            keys |= entry.keys
        try:
            tracks = self.store.list_tracks(field_id)
        except StoreError as exc:
            logger.warning("trayectorias ilegibles en el campo %s: %s", field_id, exc)
            tracks = []
        for track in tracks:
            if {_name_key(track.name), _name_key(track.name.removeprefix("NAME "))} & keys:
                return track
        return TrackResponse(name=entry.name if entry is not None and entry.name else text, positions=[])


def _sse(name: str, event_id: int, data: dict[str, Any]) -> bytes:
    """Un evento en formato `text/event-stream`, con el JSON en una sola linea."""
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return f"event: {name}\nid: {event_id}\ndata: {payload}\n\n".encode()


def _not_ready(meta: FieldMeta, message: str) -> ApiError:
    """`409 not_ready` para algo que todavia no esta construido.

    Si el trabajo fallo no va a estarlo: repetir el pedido no sirve hasta que
    otro `POST /api/field` reintente el campo, y por eso va con `retryable: false`.
    """
    failed = meta.status == "failed"
    return ApiError(
        "not_ready", message=f"{message}; el trabajo fallo" if failed else message, retryable=False if failed else None
    )


def create_fake_app(
    fields_dir: Path | None = None,
    *,
    sesame_dir: Path | None = None,
    seconds: float | None = None,
    ping_seconds: float | None = None,
    settings: Settings | None = None,
) -> FastAPI:
    """Crea el servidor falso. Lo que no se pasa sale de la configuracion (`SPHEREX_FAKE_*`)."""
    settings = get_settings() if settings is None else settings
    backend = FakeBackend(
        fields_dir=Path(fields_dir) if fields_dir is not None else settings.fake_fields_dir,
        sesame_dir=Path(sesame_dir) if sesame_dir is not None else settings.fake_sesame_dir,
        seconds=settings.fake_seconds if seconds is None else seconds,
        ping_seconds=settings.sse_ping_s if ping_seconds is None else ping_seconds,
        progress_interval=1.0 / settings.progress_events_per_s,
        field_epoch=settings.field_epoch,
        real_pipeline=settings.pipeline_version,
    )
    found = backend.samples()
    if not found:
        logger.warning("el servidor falso no encontro campos de muestra en %s", backend.fields_dir)
    for meta in found.values():
        if meta.pipeline == backend.real_pipeline:
            logger.warning(
                "la muestra %s usa el pipeline del backend real (%s): comparte id y rutas con el campo real, "
                "asi que se sirve sin `immutable`",
                meta.id,
                meta.pipeline,
            )

    app = FastAPI(title="SPHEREx Explorer API (servidor falso)", version=__version__)
    app.state.fake = backend
    register_error_handlers(app)
    # Es un servidor de desarrollo: el frontend puede estar en otro puerto.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["ETag", "Retry-After"],
    )

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        """No es parte del contrato: dice que hay para probar (muestras y nombres que se resuelven)."""
        fields = [
            {
                "id": meta.id,
                "pipeline": meta.pipeline,
                "ra": meta.request.ra,
                "dec": meta.request.dec,
                "fov": meta.request.fov,
                "status": meta.status,
            }
            for meta in backend.samples().values()
        ]
        return {
            "status": "ok",
            "fake": True,
            "pipeline": settings.pipeline_version,
            "fields": fields,
            "names": backend.known_names(),
        }

    @app.post("/api/field")
    async def post_field(body: FieldRequest, scenario: Annotated[Scenario | None, Query()] = None) -> JSONResponse:
        status_code, response = backend.submit(body, scenario)
        return JSONResponse(status_code=status_code, content=response.model_dump(mode="json"))

    @app.get("/api/field/{field_id}/events")
    async def get_events(field_id: str) -> StreamingResponse:
        sample, _, run = backend.state(field_id)
        return StreamingResponse(
            backend.stream(sample, run),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/api/field/{field_id}/meta")
    async def get_meta(field_id: str, request: Request) -> Response:
        _, meta, _ = backend.state(field_id)
        body = meta.model_dump_json().encode("utf-8")
        etag = f'"{hashlib.sha256(body).hexdigest()[:32]}"'
        headers = {"Cache-Control": "no-cache", "ETag": etag}
        known = {item.strip().removeprefix("W/") for item in request.headers.get("if-none-match", "").split(",")}
        if etag in known:
            return Response(status_code=304, headers=headers)
        return Response(content=body, media_type="application/json", headers=headers)

    @app.get("/api/field/{field_id}/plane/{epoch}/{detector}")
    async def get_plane(
        field_id: str, epoch: int, detector: int, rev: Annotated[int | None, Query(ge=0)] = None
    ) -> Response:
        data, headers = backend.plane_payload(field_id, epoch, detector, rev)
        return Response(content=data, media_type="application/octet-stream", headers=headers)

    @app.get("/api/field/{field_id}/cube")
    async def get_cube(field_id: str, rev: Annotated[int | None, Query(ge=0)] = None) -> StreamingResponse:
        chunks, headers = backend.cube(field_id, rev)
        return StreamingResponse(chunks, media_type="application/octet-stream", headers=headers)

    @app.get("/api/field/{field_id}/aux/{epoch}/{detector}")
    async def get_aux(field_id: str, epoch: int, detector: int, request: Request) -> Response:
        accept_gzip = "gzip" in request.headers.get("accept-encoding", "").lower()
        data, compressed = backend.aux_payload(field_id, epoch, detector, accept_gzip)
        headers = {"Cache-Control": "no-cache", "Vary": "Accept-Encoding"}
        if compressed:
            headers["Content-Encoding"] = "gzip"
        return Response(content=data, media_type="application/octet-stream", headers=headers)

    @app.get("/api/field/{field_id}/preview")
    async def get_preview(field_id: str) -> Response:
        data = backend.preview_payload(field_id)
        return Response(content=data, media_type="application/octet-stream", headers={"Cache-Control": "no-cache"})

    @app.get("/api/field/{field_id}/track")
    async def get_track(field_id: str, name: str) -> JSONResponse:
        return JSONResponse(content=backend.track(field_id, name).model_dump(mode="json"))

    @app.post("/api/field/{field_id}/priority", status_code=204)
    async def post_priority(field_id: str, body: PriorityRequest) -> Response:
        backend.set_priority(field_id, body.band)
        return Response(status_code=204)

    @app.get("/api/resolve")
    async def get_resolve(name: str, scenario: Annotated[ResolveScenario | None, Query()] = None) -> JSONResponse:
        return JSONResponse(content=backend.resolve(name, scenario).model_dump(mode="json"))

    return app


app = create_fake_app()
