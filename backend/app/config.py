"""Configuracion del backend: rutas y limites.

Los valores por defecto son los del contrato (docs/contrato-cubo.md, secciones
10 y 11). Cada campo de `Settings` se puede sobreescribir con una variable de
entorno `SPHEREX_<NOMBRE_EN_MAYUSCULAS>`; por ejemplo `SPHEREX_CACHE_DIR` o
`SPHEREX_FAKE_SECONDS`.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, fields
from functools import lru_cache
from pathlib import Path
from typing import get_type_hints

ENV_PREFIX = "SPHEREX_"

# Carpeta backend/, sin depender del directorio desde el que se arranca.
BACKEND_DIR = Path(__file__).resolve().parent.parent

# Epoca fija a la que se propaga la posicion de un objeto para centrar su campo
# (contrato, seccion 4.8). Es fija para que el `id` del campo no cambie con la fecha.
FIELD_EPOCH = 2026.0

# Version del pipeline. Entra en el `id` del campo: cambiarla invalida la cache
# sin borrar nada (contrato, seccion 3).
PIPELINE_VERSION = "1"

# Version de pipeline de los campos de muestra que sirve el servidor falso
# (scripts/make_sample_fields.py). Es distinta de PIPELINE_VERSION a proposito:
# asi el `id` de una muestra nunca coincide con el del campo real del mismo
# centro, y un navegador que guardo planos del servidor falso (`immutable`, un
# anio) no los muestra en lugar de los del backend real, que comparte origen y
# rutas. Hay que subirla si cambian los pixeles de las muestras sin que cambie
# su `rev`: con el mismo `id` el navegador seguiria mostrando los anteriores.
SAMPLE_PIPELINE_VERSION = "muestra-1"

# CLAUDE.md: maximo 10 descargas en paralelo contra IRSA. Es un tope duro: una
# variable de entorno puede bajarlo, no subirlo.
IRSA_MAX_PARALLEL_DOWNLOADS = 10


@dataclass(frozen=True)
class Settings:
    """Rutas y limites del backend. Inmutable; se crea con `Settings.from_env()`."""

    # Rutas. `data_dir` se versiona (campos precalculados); `cache_dir` es la
    # cache de ejecucion y git la ignora.
    data_dir: Path = BACKEND_DIR / "data"
    cache_dir: Path = BACKEND_DIR / "cache"

    # Limites hacia IRSA y cola de trabajos (contrato, seccion 10).
    max_cutout_downloads: int = IRSA_MAX_PARALLEL_DOWNLOADS
    max_sia_queries: int = 2
    max_active_jobs: int = 2
    max_queued_jobs: int = 20
    cutout_attempts: int = 6

    # Acceso a IRSA (app/irsa). Servicio SIA2 (SPEC.md, seccion "Acceso") y tiempos de
    # espera en segundos: el de lectura es el silencio maximo entre dos tramos de una respuesta.
    sia_url: str = "https://irsa.ipac.caltech.edu/SIA"
    irsa_connect_timeout_s: float = 15.0
    irsa_read_timeout_s: float = 60.0
    # Tope de tiempo de un recorte entero (los dos pedidos del modo `full` incluidos) y de cada
    # intento de SIA2: una respuesta que llega de a poco no dispara el timeout de lectura.
    # 0 o menos lo desactiva.
    irsa_total_timeout_s: float = 180.0
    # SIA2 devuelve 502 de forma intermitente, a veces durante minutos: intentos por coleccion
    # y espera base entre ellos, que crece con cada intento (2, 4, 6, 8 y 10 s: 30 s en total).
    sia_attempts: int = 6
    sia_retry_wait_s: float = 2.0
    # Espera que se informa cuando un 503 o un 429 llega sin `Retry-After` legible (IRSA manda 5).
    irsa_retry_after_default_s: float = 5.0
    # Maximo de `IrsaBusy.retry_after`, pida lo que pida IRSA: un `Retry-After` de horas no
    # puede dejar parado un recorte. Lo que pidio de verdad queda en `IrsaBusy.requested`.
    irsa_retry_after_max_s: float = 60.0
    # Tope de disco de la cache de recortes (contrato, seccion 11); 0 o menos lo desactiva.
    cutout_cache_max_gb: float = 10.0

    # Con `SPHEREX_PRECOMPUTED_ONLY=1` el backend solo sirve campos ya armados (los de
    # `data/fields`): pedir cualquier otro responde 404 `not_found` y nunca se toca IRSA.
    # Es el modo del despliegue publico.
    precomputed_only: bool = False
    # Un pedido cuyo centro esta a menos de estos segundos de arco del de un campo ya armado
    # del mismo escalon abre ese campo en vez de armar otro casi igual (coordenadas tipeadas
    # a mano, con menos decimales): ahorra unas 350 descargas a IRSA. 0 lo desactiva. En modo
    # `precomputed_only` vale al menos 60.
    nearby_field_arcsec: float = 0.0
    # Carpeta con el frontend compilado (`frontend/dist`). Si se indica, el backend lo sirve
    # en `/` desde el mismo origen que la API; vacio, solo responde `/api`.
    static_dir: str = ""
    # Documentacion interactiva de la API (`/docs`, `/redoc` y `/openapi.json`). Prendida en
    # desarrollo; la imagen del despliegue publico la apaga con `SPHEREX_DOCS_ENABLED=0`.
    docs_enabled: bool = True

    # Identidad del campo.
    field_epoch: float = FIELD_EPOCH
    pipeline_version: str = PIPELINE_VERSION

    # Colecciones que se listan por SIA2 (SPEC.md, seccion 2: DR1 y QR3, no QR2).
    collections: tuple[str, ...] = ("spherex_dr1", "spherex_qr3")
    # Exposiciones separadas por mas de estos dias caen en epocas distintas.
    epoch_gap_days: float = 60.0

    # Vigencia de las caches (contrato, seccion 11).
    resolve_cache_days: float = 30.0
    exposure_list_cache_hours: float = 24.0

    # Vista provisoria de WISE. Desactivada por defecto: hips2fits de CDS estuvo caido todo el
    # 2026-11-15 y el pedido nunca se pudo verificar contra el servicio. Con
    # `SPHEREX_PREVIEW_ENABLED=1` el trabajo la vuelve a pedir; sin eso, el campo sale con
    # `preview.status = "unavailable"` desde el principio y no se toca la red.
    preview_enabled: bool = False
    # Si hips2fits no responde en este tiempo, se descarta.
    preview_timeout_s: float = 20.0
    # Servicio hips2fits de CDS y HiPS de WISE de cada banda (app/preview/hips2fits.py).
    # SIN VERIFICAR contra el servicio: el 2026-11-15 estaba caido. La URL sale de
    # astroquery.hips2fits y los identificadores de la lista del nodo HiPS de IRSA
    # (`creator_did = ivo://CDS/P/allWISE/W1` y `.../W2`); el detalle, en ese modulo.
    hips2fits_url: str = "https://alasky.cds.unistra.fr/hips-image-services/hips2fits"
    preview_hips_w1: str = "CDS/P/allWISE/W1"
    preview_hips_w2: str = "CDS/P/allWISE/W2"

    # Sesame (app/resolve/sesame.py): servidores en el orden en que se consultan, CDS y
    # su espejo en CfA (las URL del spike), y timeout de cada intento.
    sesame_urls: tuple[str, ...] = (
        "https://cds.unistra.fr/cgi-bin/nph-sesame/-ox/S?",
        "https://vizier.cfa.harvard.edu/viz-bin/nph-sesame/-ox/S?",
    )
    sesame_timeout_s: float = 10.0
    # Tope de toda la resolucion de un nombre, sumando servidores, reintentos y pausas;
    # se reparte entre los servidores que falten consultar. 0 o menos lo desactiva.
    sesame_total_timeout_s: float = 20.0

    # SSE: comentario `: ping` tras este silencio, y tope de eventos `progress`.
    sse_ping_s: float = 15.0
    progress_events_per_s: float = 4.0

    # Identificacion ante los servicios externos.
    user_agent: str = "spherex-explorer-backend/0.1 (python-requests)"

    # Servidor falso (app/fake.py).
    fake_fields_dir: Path = BACKEND_DIR / "tests" / "fixtures" / "fields"
    fake_sesame_dir: Path = BACKEND_DIR / "tests" / "fixtures" / "sesame"
    fake_seconds: float = 25.0

    def __post_init__(self) -> None:
        for name in ("max_cutout_downloads", "max_sia_queries", "max_active_jobs", "cutout_attempts"):
            if getattr(self, name) < 1:
                raise ValueError(f"{name} debe ser al menos 1")
        if self.max_queued_jobs < 0:
            raise ValueError("max_queued_jobs no puede ser negativo")
        if self.fake_seconds <= 0:
            raise ValueError("fake_seconds debe ser positivo")
        if self.max_cutout_downloads > IRSA_MAX_PARALLEL_DOWNLOADS:
            object.__setattr__(self, "max_cutout_downloads", IRSA_MAX_PARALLEL_DOWNLOADS)

    # ------------------------------------------------------------ rutas derivadas

    @property
    def precomputed_fields_dir(self) -> Path:
        """Campos precalculados, versionados en el repositorio. Se buscan primero."""
        return self.data_dir / "fields"

    @property
    def cached_fields_dir(self) -> Path:
        """Campos armados durante la ejecucion."""
        return self.cache_dir / "fields"

    @property
    def cutout_cache_dir(self) -> Path:
        """Recortes bajados de IRSA, por exposicion, centro y lado."""
        return self.cache_dir / "cutouts"

    @property
    def sia_cache_dir(self) -> Path:
        """Listas de exposiciones (respuestas de SIA2), por centro y coleccion."""
        return self.cache_dir / "sia"

    @property
    def sesame_cache_dir(self) -> Path:
        """Nombres resueltos con Sesame."""
        return self.cache_dir / "sesame"

    # ------------------------------------------------------------------- entorno

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Settings:
        """Crea la configuracion con los valores por defecto y las variables `SPHEREX_*` presentes."""
        env = os.environ if environ is None else environ
        hints = get_type_hints(cls)
        values: dict[str, object] = {}
        for item in fields(cls):
            raw = env.get(ENV_PREFIX + item.name.upper())
            if raw is None or raw.strip() == "":
                continue
            values[item.name] = _parse(item.name, hints[item.name], raw.strip())
        return cls(**values)  # type: ignore[arg-type]


def _parse(name: str, kind: object, raw: str) -> object:
    """Convierte el texto de una variable de entorno al tipo del campo."""
    try:
        if kind is Path:
            return Path(raw).expanduser()
        if kind is bool:
            if raw.lower() in ("1", "true", "yes", "on"):
                return True
            if raw.lower() in ("0", "false", "no", "off"):
                return False
            raise ValueError(raw)
        if kind is int:
            return int(raw)
        if kind is float:
            return float(raw)
        if kind == tuple[str, ...]:
            return tuple(part.strip() for part in raw.split(",") if part.strip())
    except ValueError as exc:
        raise ValueError(f"{ENV_PREFIX}{name.upper()}={raw!r} no es un valor valido") from exc
    return raw


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Configuracion del proceso, leida del entorno una sola vez."""
    return Settings.from_env()
