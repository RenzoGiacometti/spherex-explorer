"""Contexto de cualquier campo: el precalculado si existe y, si no, uno armado en vivo y guardado en la cache.

Junta el almacen versionado (`data/context`) con el proveedor en vivo
(`app.context.live`). Para un centro cualquiera:

1. Si el campo tiene contexto precalculado, se sirve ese.
2. Si no, cada parte (la capa de WISE, las fuentes de Gaia) se arma la primera
   vez que se pide, con el plazo corto del proveedor, y queda en
   `cache/context/live/<campo>/` con el mismo formato que el precalculado. La
   siguiente vez sale del disco.
3. Si IRSA no responde, esa parte queda "no disponible" y no se vuelve a pedir
   durante `RETRY_AFTER_S` segundos: un visor que insiste no le suma pedidos a
   un IRSA que ya esta lento.

Dos pedidos simultaneos de la misma parte del mismo campo esperan al mismo
trabajo en vez de duplicarlo. Las partes de un campo se arman de a una.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from app import geometry
from app.config import Settings
from app.context import live
from app.context.gaia import CATALOG
from app.context.store import (
    GAIA_FILENAME,
    ContextDocument,
    ContextNotFoundError,
    ContextStore,
    GaiaInfo,
    context_key,
)
from app.context.surveys import BANDS, context_cache_dir
from app.contract import FieldRequestInfo
from app.domain import NormalizedRequest

# Segundos durante los que no se reintenta una parte que IRSA no entrego.
RETRY_AFTER_S = 60.0

GAIA_PART = "gaia"

# Capas que se pueden armar en vivo: las de WISE, que salen de un solo mosaico.
LIVE_LAYERS: frozenset[str] = frozenset(band.key for band in BANDS if band.survey == "WISE")


class PartUnavailable(Exception):
    """Esa parte del contexto no esta disponible.

    Con `permanent` en falso es pasajero (IRSA no respondio) y `retry_after`
    dice en cuantos segundos tiene sentido reintentar. Con `permanent` en
    verdadero no va a estar nunca: una capa que no existe o que no se arma en vivo.
    """

    def __init__(self, message: str, retry_after: float = RETRY_AFTER_S, *, permanent: bool = False) -> None:
        super().__init__(message)
        self.retry_after = 0.0 if permanent else retry_after
        self.permanent = permanent


@dataclass(frozen=True)
class _Failure:
    at: float
    message: str


class LiveContextService:
    """Sirve el contexto de un campo, precalculado o en vivo. Se puede usar desde varios hilos."""

    def __init__(self, settings: Settings, *, clock: Callable[[], float] = time.monotonic) -> None:
        self.settings = settings
        self.precomputed = ContextStore.from_settings(settings)
        self.cache = ContextStore(context_cache_dir(settings) / "live")
        self._clock = clock
        self._guard = threading.Lock()
        self._locks: dict[str, threading.Lock] = {}
        self._failures: dict[tuple[str, str], _Failure] = {}

    # --------------------------------------------------------------- consulta

    @staticmethod
    def key(request: NormalizedRequest) -> str:
        return context_key(request.ra, request.dec, request.fov)

    def _store_with(self, key: str) -> ContextStore | None:
        """El almacen que tiene ese campo: el precalculado manda sobre la cache."""
        if self.precomputed.exists(key):
            return self.precomputed
        return self.cache if self.cache.exists(key) else None

    def is_precomputed(self, request: NormalizedRequest) -> bool:
        return self.precomputed.exists(self.key(request))

    def _field_lock(self, key: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(key, threading.Lock())

    def _check_recent_failure(self, key: str, part: str) -> None:
        with self._guard:
            failure = self._failures.get((key, part))
            if failure is None:
                return
            waited = self._clock() - failure.at
            if waited >= RETRY_AFTER_S:
                del self._failures[(key, part)]
                return
        raise PartUnavailable(failure.message, retry_after=RETRY_AFTER_S - waited)

    def _remember_failure(self, key: str, part: str, message: str) -> None:
        with self._guard:
            self._failures[(key, part)] = _Failure(self._clock(), message)

    # ----------------------------------------------------------------- partes

    def _document(self, request: NormalizedRequest) -> ContextDocument:
        """El documento del campo en la cache, o uno vacio si todavia no hay nada."""
        key = self.key(request)
        if self.cache.exists(key):
            return self.cache.read_document(key)
        return ContextDocument(
            key=key,
            field_id=request.field_id,
            pipeline=request.pipeline,
            object=None,
            request=FieldRequestInfo(ra=request.ra, dec=request.dec, fov=request.fov),
            grid=geometry.grid_info(geometry.build_grid(request)),
            surveys=[],
            gaia=None,
            generated_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        )

    def ensure_layer(self, request: NormalizedRequest, layer: str = live.DEFAULT_LAYER) -> ContextStore:
        """Deja la capa disponible y devuelve el almacen que la tiene. Lanza `PartUnavailable`."""
        key = self.key(request)
        with self._field_lock(key):
            store = self._store_with(key)
            if store is not None and any(item.key == layer for item in store.read_document(key).surveys):
                return store
            if store is self.precomputed:
                # Un campo precalculado sin esa capa: no se mezcla con la cache.
                raise PartUnavailable(f"el campo precalculado no tiene la capa {layer!r}", permanent=True)
            if layer not in LIVE_LAYERS:
                raise PartUnavailable(
                    f"la capa {layer!r} no se arma en vivo: solo {sorted(LIVE_LAYERS)}", permanent=True
                )
            self._check_recent_failure(key, layer)
            try:
                built = live.fetch_layer(geometry.build_grid(request), self.settings, layer=layer)
            except live.LiveUnavailable as exc:
                self._remember_failure(key, layer, str(exc))
                raise PartUnavailable(str(exc)) from exc
            document = self._document(request)
            self.cache.write_layer(key, built.info.file, built.image, document.grid.shape)
            layers = sorted([*document.surveys, built.info], key=lambda item: item.mjd)
            self.cache.write_document(document.model_copy(update={"surveys": layers}))
            return self.cache

    def ensure_gaia(self, request: NormalizedRequest) -> ContextStore:
        """Deja las fuentes de Gaia disponibles y devuelve el almacen que las tiene. Lanza `PartUnavailable`."""
        key = self.key(request)
        with self._field_lock(key):
            store = self._store_with(key)
            if store is not None and store.read_document(key).gaia is not None:
                return store
            if store is self.precomputed:
                raise PartUnavailable("el campo precalculado no tiene fuentes de Gaia", permanent=True)
            self._check_recent_failure(key, GAIA_PART)
            try:
                sources, radius = live.fetch_gaia(geometry.build_grid(request), self.settings)
            except live.LiveUnavailable as exc:
                self._remember_failure(key, GAIA_PART, str(exc))
                raise PartUnavailable(str(exc)) from exc
            document = self._document(request)
            self.cache.write_gaia(key, sources)
            magnitudes = sources.g_mag[np.isfinite(sources.g_mag)]
            info = GaiaInfo(
                file=GAIA_FILENAME,
                catalog=CATALOG,
                ref_epoch=sources.ref_epoch,
                n_sources=len(sources),
                radius_arcsec=round(radius, 1),
                g_mag_min=round(float(magnitudes.min()), 2) if magnitudes.size else None,
                g_mag_max=round(float(magnitudes.max()), 2) if magnitudes.size else None,
            )
            self.cache.write_document(document.model_copy(update={"gaia": info}))
            return self.cache

    # -------------------------------------------------------------- respuestas

    def document(self, request: NormalizedRequest) -> ContextDocument:
        """El documento de contexto del campo, armando en vivo lo que falte.

        Primero la capa de WISE, que es lo que el visor muestra mientras carga,
        y despues Gaia. Una parte que no se pudo armar falta en el documento
        (`surveys` vacio, `gaia` en `null`). Lanza `PartUnavailable` solo si no
        hay ninguna de las dos.
        """
        key = self.key(request)
        if self.precomputed.exists(key):
            return self.precomputed.read_document(key)
        errors: list[PartUnavailable] = []
        for ensure in (self.ensure_layer, self.ensure_gaia):
            try:
                ensure(request)
            except PartUnavailable as exc:
                errors.append(exc)
        if not self.cache.exists(key):
            raise PartUnavailable(
                "; ".join(str(error) for error in errors), retry_after=min(error.retry_after for error in errors)
            )
        return self.cache.read_document(key)

    def layer_bytes(self, request: NormalizedRequest, layer: str = live.DEFAULT_LAYER) -> bytes:
        """Bytes de una capa (Float32, formato de un plano). Lanza `PartUnavailable`."""
        store = self.ensure_layer(request, layer)
        try:
            return store.read_layer_bytes(self.key(request), layer)
        except ContextNotFoundError as exc:
            raise PartUnavailable(str(exc), permanent=True) from exc

    def gaia_bytes(self, request: NormalizedRequest) -> bytes:
        """`gaia.json` del campo. Lanza `PartUnavailable`."""
        store = self.ensure_gaia(request)
        try:
            return store.read_gaia_bytes(self.key(request))
        except ContextNotFoundError as exc:
            raise PartUnavailable(str(exc), permanent=True) from exc


@lru_cache(maxsize=4)
def get_service(settings: Settings) -> LiveContextService:
    """El servicio del proceso para esa configuracion: uno solo, para que la memoria de fallas sea compartida."""
    return LiveContextService(settings)
