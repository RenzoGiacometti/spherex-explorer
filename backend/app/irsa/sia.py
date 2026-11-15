"""Lista de exposiciones que cubren un punto, por SIA2 de IRSA.

Referencia probada contra el servicio: `sia_query` en spike/irsa.py y
`list_exposures_sia` y `deduplicate` en spike/field.py. Los nombres de columnas
(ObsCore) y los parametros estan citados ahi; no inventar otros.

- Parametros `COLLECTION` y `POS=circle <ra> <dec> <radio>`: estandar IVOA SIA
  2.0, usados con SPHEREx segun
  https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/
- Columnas ObsCore de `spherex.obscore` (TAP_SCHEMA, volcado en
  spike/resultados/tap_schema.txt), tal como llegan en las respuestas guardadas
  en tests/fixtures/sia: `dataproduct_type`, `dataproduct_subtype`,
  `calib_level`, `obs_id`, `obs_collection`, `energy_bandpassname`, `t_min`,
  `t_max`, `access_url`, `em_min`, `em_max`.

La cache guarda la respuesta de IRSA tal cual, una por coleccion y centro, con
el mismo nombre que usaba el spike:

    <coleccion>__<ra>_<dec>.xml     VOTable de IRSA
    <coleccion>__<ra>_<dec>.json    {"queried_at": ..., "url": ..., "rows": ...}

Si falta el `.json` (por ejemplo, un `.xml` de tests/fixtures/sia copiado a
mano), la fecha de la consulta es la de modificacion del `.xml`.
"""

from __future__ import annotations

import calendar
import contextlib
import io
import json
import math
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests
import urllib3
from astropy.io.votable import parse as parse_votable

from app.api.errors import upstream_unavailable
from app.config import Settings
from app.domain import Exposure, ExposureList
from app.irsa import transport
from app.irsa.limits import get_limiter

# Radio del circulo de busqueda: 1 segundo de arco, como en el spike. SIA2 devuelve
# las imagenes cuya huella toca el circulo; con un radio tan chico, las que cubren el punto.
SEARCH_RADIUS_DEG = 1.0 / 3600.0

# Columnas que se leen de la respuesta (ver el encabezado del modulo).
_COLUMNS = (
    "dataproduct_type", "dataproduct_subtype", "calib_level", "obs_id", "obs_collection", "energy_bandpassname",
    "t_min", "t_max", "access_url", "em_min", "em_max",
)  # fmt: skip

# `energy_bandpassname` vale de `SPHEREx-D1` a `SPHEREx-D6` (SPEC.md, seccion "Acceso").
_DETECTOR_RE = re.compile(r"D([1-6])$")

# Respuestas que conviene reintentar. El 502 es el habitual de SIA2 (spike/RESULTADOS.md, seccion 3).
_RETRY_STATUS = frozenset({429, 500, 502, 503, 504})
# Si IRSA pide esperar mas que esto, no se espera: se usa la copia guardada o se informa el error.
_MAX_RETRY_AFTER_S = 30.0

_TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"


class _SiaFailure(Exception):
    """La consulta de una coleccion no se pudo completar. `retry_after` es lo ultimo que pidio esperar IRSA."""

    def __init__(self, message: str, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class _BadResponse(Exception):
    """La respuesta no es el VOTable esperado. Puede ser pasajero: se reintenta."""


class _QueryError(Exception):
    """IRSA contesto que la consulta fallo o que corto la lista (`QUERY_STATUS` distinto de OK)."""


@dataclass(frozen=True)
class _Listing:
    """Lo que devolvio una coleccion."""

    exposures: list[Exposure]
    queried_at: float  # segundos desde 1970, UTC
    stale: bool = False  # IRSA no respondio y esto es una copia guardada


# ----------------------------------------------------------------------- VOTable


def parse_exposures(payload: bytes, collection: str = "") -> list[Exposure]:
    """Exposiciones de nivel 2 (`image/science`) de una respuesta VOTable de SIA2, en el orden de la respuesta.

    `collection` se usa solo si una fila no trae `obs_collection`. Lanza
    `_BadResponse` si no es un VOTable de SIA2 con `QUERY_STATUS` y `_QueryError`
    si el estado no es OK.
    """
    try:
        votable = parse_votable(io.BytesIO(payload), verify="ignore")
    except Exception as exc:  # astropy lanza varias clases segun donde falle el XML
        raise _BadResponse(f"la respuesta no es un VOTable: {type(exc).__name__}: {exc}") from exc

    statuses = [info for resource in votable.resources for info in resource.infos if info.name == "QUERY_STATUS"]
    for info in statuses:
        if info.value != "OK":
            # ERROR, u OVERFLOW si el servicio corto la lista de resultados.
            raise _QueryError(f"QUERY_STATUS={info.value}: {info.content or ''}".strip())
    if not statuses:
        # Sin QUERY_STATUS no se puede distinguir "ninguna exposicion" de una respuesta rota.
        raise _BadResponse("el VOTable no trae QUERY_STATUS")

    tables = list(votable.iter_tables())
    if not tables:
        return []
    try:
        # IRSA pone ID="col_N" en cada FIELD; los nombres ObsCore estan en `name`.
        table = tables[0].to_table(use_names_over_ids=True)
    except Exception as exc:
        raise _BadResponse(f"tabla ilegible: {type(exc).__name__}: {exc}") from exc
    if len(table) == 0:
        return []
    missing = [name for name in _COLUMNS if name not in table.colnames]
    if missing:
        raise _BadResponse(f"faltan las columnas {missing}")

    columns = {name: table[name].tolist() for name in _COLUMNS}
    exposures: list[Exposure] = []
    for i in range(len(table)):
        row = {name: values[i] for name, values in columns.items()}
        try:
            if str(row["dataproduct_type"]) != "image" or str(row["dataproduct_subtype"]) != "science":
                continue
            if int(row["calib_level"]) != 2:
                continue
            detector = _DETECTOR_RE.search(str(row["energy_bandpassname"]).strip())
            url = str(row["access_url"] or "").strip()
            obs_id = str(row["obs_id"] or "").strip()
            numbers = [float(row[name]) for name in ("t_min", "t_max", "em_min", "em_max")]
        except (TypeError, ValueError):
            continue  # una fila con un valor vacio en una columna que hace falta
        if detector is None or not url or not obs_id or not all(math.isfinite(value) for value in numbers):
            continue
        exposures.append(
            Exposure(
                obs_id=obs_id,
                collection=str(row["obs_collection"] or collection).strip() or collection,
                detector=int(detector.group(1)),
                mjd_start=numbers[0],
                mjd_end=numbers[1],
                url=url,
                wave_min_um=numbers[2] * 1e6,  # ObsCore da `em_min` y `em_max` en metros
                wave_max_um=numbers[3] * 1e6,
            )
        )
    return exposures


def deduplicate(exposures: list[Exposure], collections: tuple[str, ...]) -> list[Exposure]:
    """Una exposicion por observacion y detector, ordenadas por fecha y detector.

    Si esta en mas de una coleccion queda la de la que figura antes en
    `collections`: con el orden por defecto, la de DR1 antes que la de QR3.
    """
    rank = {name: position for position, name in enumerate(collections)}

    def priority(exposure: Exposure) -> int:
        return rank.get(exposure.collection, len(rank))

    best: dict[tuple[str, int], Exposure] = {}
    for exposure in exposures:
        key = (exposure.obs_id, exposure.detector)
        current = best.get(key)
        if current is None or priority(exposure) < priority(current):
            best[key] = exposure
    return sorted(best.values(), key=lambda item: (item.mjd_start, item.detector, item.obs_id))


# ------------------------------------------------------------------------- cache


def sia_cache_path(collection: str, ra: float, dec: float, settings: Settings) -> Path:
    """Archivo `.xml` de la cache para esa coleccion y ese centro. El `.json` va al lado, con el mismo nombre."""
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", collection)
    return settings.sia_cache_dir / f"{safe}__{ra:.6f}_{dec:+.6f}.xml"


def _write_atomic(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        tmp.write_bytes(payload)
        os.replace(tmp, path)
    finally:
        with contextlib.suppress(OSError):
            tmp.unlink()


def _store(path: Path, payload: bytes, url: str, rows: int, queried_at: float) -> None:
    """Guarda la respuesta. Si el disco falla, la lista igual sirve: la cache es solo un respaldo."""
    meta = {"queried_at": time.strftime(_TIME_FORMAT, time.gmtime(queried_at)), "url": url, "rows": rows}
    with contextlib.suppress(OSError):
        _write_atomic(path, payload)
        _write_atomic(path.with_suffix(".json"), json.dumps(meta, indent=2).encode("utf-8"))


def _saved_time(path: Path) -> float | None:
    """Fecha de la consulta guardada, en segundos desde 1970, o `None` si no hay copia."""
    try:
        queried_at = path.stat().st_mtime
    except OSError:
        return None
    try:
        meta = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
        queried_at = float(calendar.timegm(time.strptime(meta["queried_at"], _TIME_FORMAT)))
    except (OSError, ValueError, KeyError, TypeError):
        pass  # sin el `.json` vale la fecha del `.xml`
    return queried_at


def _load(path: Path, collection: str) -> _Listing | None:
    """La copia guardada de una coleccion, o `None` si no hay o no se puede leer."""
    queried_at = _saved_time(path)
    if queried_at is None:
        return None
    try:
        return _Listing(exposures=parse_exposures(path.read_bytes(), collection), queried_at=queried_at)
    except (OSError, _BadResponse, _QueryError):
        return None


# ---------------------------------------------------------------------- consulta


def _excerpt(payload: bytes) -> str:
    """Comienzo del cuerpo de una respuesta de error, en una linea y sin etiquetas HTML, para el mensaje.

    El 502 de IRSA trae una pagina "502 Proxy Error" de su propio proxy.
    """
    text = payload[:400].decode("utf-8", errors="replace")
    return " ".join(re.sub(r"<[^>]*>", " ", text).split())[:160]


def _query(collection: str, ra: float, dec: float, settings: Settings) -> tuple[bytes, list[Exposure], str]:
    """Consulta una coleccion con reintentos y devuelve (respuesta, exposiciones, URL pedida).

    Cada intento ocupa un lugar de `limiter.sia_slot()` solo mientras dura el
    pedido; la espera entre intentos no ocupa lugar. Cada intento tiene como
    tope `settings.irsa_total_timeout_s`, ademas de los timeouts de conexion y
    de lectura: una respuesta que llega de a poco no ocupa el lugar sin limite.
    Lanza `_SiaFailure`.
    """
    params = {"COLLECTION": collection, "POS": f"circle {ra:.6f} {dec:.6f} {SEARCH_RADIUS_DEG:.6f}"}
    attempts = max(1, settings.sia_attempts)
    limiter = get_limiter(settings)
    last = "sin intentos"
    retry_after: float | None = None
    for attempt in range(1, attempts + 1):
        retry_after = None
        try:
            with limiter.sia_slot():
                deadline = transport.total_deadline(settings)
                with transport.session().get(
                    settings.sia_url,
                    params=params,
                    stream=True,
                    timeout=transport.timeouts(settings, deadline),
                    headers=transport.request_headers(settings),
                ) as response:
                    # El cuerpo se lee aca, contra el plazo, y no con `response.content`, que solo
                    # tiene el timeout de cada lectura del socket.
                    payload = transport.read_body(response.raw, deadline)
        except (requests.RequestException, urllib3.exceptions.HTTPError) as exc:
            # De `requests` salen las fallas hasta recibir las cabeceras y el plazo vencido;
            # de urllib3, un corte o un silencio mientras se lee el cuerpo.
            last = f"{type(exc).__name__}: {exc}"
        else:
            if response.status_code == 200:
                try:
                    return payload, parse_exposures(payload, collection), response.url
                except _QueryError as exc:
                    raise _SiaFailure(f"SIA2 {collection}: {exc}") from exc
                except _BadResponse as exc:
                    last = str(exc)
            elif response.status_code in _RETRY_STATUS:
                last = f"HTTP {response.status_code}: {_excerpt(payload)}".rstrip(": ")
                retry_after = transport.parse_retry_after(response.headers.get("Retry-After"))
                if retry_after is not None and retry_after > _MAX_RETRY_AFTER_S:
                    break
            else:
                raise _SiaFailure(f"SIA2 {collection}: HTTP {response.status_code}: {_excerpt(payload)}".rstrip(": "))
        if attempt < attempts:
            time.sleep(max(settings.sia_retry_wait_s * attempt, retry_after or 0.0))
    raise _SiaFailure(f"SIA2 {collection}: {last} tras {attempt} intentos", retry_after)


def _list_collection(collection: str, ra: float, dec: float, settings: Settings, refresh: bool) -> _Listing:
    """Exposiciones de una coleccion: de la cache si esta vigente, de IRSA si no, o la copia vencida si IRSA falla."""
    path = sia_cache_path(collection, ra, dec, settings)
    saved_at = _saved_time(path)
    max_age_s = settings.exposure_list_cache_hours * 3600.0
    if saved_at is not None and not refresh and 0.0 <= time.time() - saved_at <= max_age_s:
        saved = _load(path, collection)
        if saved is not None:
            return saved
    try:
        payload, exposures, url = _query(collection, ra, dec, settings)
    except _SiaFailure as exc:
        saved = _load(path, collection)
        if saved is not None:
            return _Listing(exposures=saved.exposures, queried_at=saved.queried_at, stale=True)
        raise upstream_unavailable(f"{exc}; no hay una lista guardada", retry_after=exc.retry_after) from exc
    queried_at = float(int(time.time()))
    _store(path, payload, url, len(exposures), queried_at)
    return _Listing(exposures=exposures, queried_at=queried_at)


def _merge_listings(listings: list[Any], settings: Settings) -> ExposureList:
    """Une las listas de cada coleccion en la lista del campo."""
    exposures = deduplicate([item for listing in listings for item in listing.exposures], settings.collections)
    oldest = min((listing.queried_at for listing in listings), default=time.time())
    return ExposureList(
        exposures=exposures,
        listed_at=time.strftime(_TIME_FORMAT, time.gmtime(oldest)),
        stale=any(listing.stale for listing in listings),
    )


def list_exposures_parallel(ra: float, dec: float, settings: Settings, refresh: bool = False) -> ExposureList:
    """Como `list_exposures`, pero consulta las colecciones a la vez. Es la que usa el gestor de trabajos.

    Cada coleccion va en su hilo y dentro de `limiter.sia_slot()`. El 2026-11-15 SIA2
    tardaba 22 s por coleccion: una detras de la otra, la primera imagen de un campo
    nuevo esperaba 46 s solo por la lista. Si una coleccion falla, la otra igual
    termina su consulta (y queda en cache) antes de que salga el error.
    """
    collections = settings.collections
    if len(collections) < 2:
        return list_exposures(ra, dec, settings, refresh)
    # `map` conserva el orden de las colecciones y vuelve a lanzar la primera excepcion.
    with ThreadPoolExecutor(max_workers=len(collections), thread_name_prefix="spherex-sia") as pool:
        listings = list(pool.map(lambda name: _list_collection(name, ra, dec, settings, refresh), collections))
    return _merge_listings(listings, settings)


def list_exposures(ra: float, dec: float, settings: Settings, refresh: bool = False) -> ExposureList:
    """Exposiciones de nivel 2 de las colecciones de `settings.collections` que cubren el punto.

    - Una consulta SIA2 por coleccion, en VOTable (no CSV: la columna
      `cloud_access` trae comas sin entrecomillar), dentro de
      `limiter.sia_slot()`, con timeout y reintentos (IRSA devuelve 502 de forma
      intermitente).
    - Solo productos `image/science` de nivel 2. Si una exposicion esta en DR1 y
      en QR3, queda la de DR1. Ordenadas por fecha y detector.
    - Cache en `settings.sia_cache_dir`, por centro y coleccion, vigente
      `settings.exposure_list_cache_hours`. Con `refresh=True` se vuelve a
      consultar aunque este vigente.
    - Si IRSA no responde y hay una lista guardada, se devuelve esa con
      `stale=True` (aviso `stale_exposure_list`). Si no hay ninguna, lanza
      `ApiError` `upstream_unavailable`.
    - Si ninguna exposicion cubre el punto, devuelve la lista vacia; quien llama
      decide el `no_coverage`.

    Precisiones:

    - Las colecciones se consultan una detras de la otra (`list_exposures_parallel`
      las consulta a la vez). Cada una tiene su propia copia: puede salir una de
      IRSA y otra de la cache.
    - `listed_at` es la fecha de la consulta mas vieja de las que forman la lista.
    - `stale=True` vale tambien si se pidio `refresh`, IRSA no respondio y se uso
      una copia que todavia estaba vigente.
    - Bloqueante: hay que llamarla desde un hilo, no desde el bucle de asyncio.
    """
    listings = [_list_collection(collection, ra, dec, settings, refresh) for collection in settings.collections]
    return _merge_listings(listings, settings)
