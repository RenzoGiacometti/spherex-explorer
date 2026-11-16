"""Que colecciones de SPHEREx se listan por SIA2, sin editar el codigo cuando sale un release nuevo.

El bucket publico `nasa-irsa-spherex` de AWS tiene una carpeta por release
(`dr1/`, `qr2/`, `qr3/` el 15 de noviembre de 2026). Su listado es un XML de
S3 (`ListObjectsV2` con `delimiter=/`), con un `<Prefix>` por carpeta:

    https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/?list-type=2&delimiter=/

De ahi salen las colecciones, con la regla de SPEC.md, seccion 2 ("usar DR1 y
QR3, no QR2"): todos los Data Release y solo el Quick Release mas nuevo, porque
cada uno reemplaza al anterior. La coleccion de SIA2 de un release se llama
`spherex_<release>` (y `spherex_<release>_deep` la de los campos profundos).

SIA2 no sirve para descubrirlas: a una coleccion que no existe responde igual
que a una sin exposiciones en ese punto.

El listado se guarda 12 horas en `cache/releases.json`. Si el bucket no
responde vale la copia guardada, aunque este vencida, y si no hay ninguna, la
lista fija de `settings.collections`. Nada de esto lanza excepciones.
"""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path

from app.config import DEFAULT_COLLECTIONS, Settings
from app.irsa import transport

_PREFIX = re.compile(rb"<Prefix>(dr|qr)(\d+)/</Prefix>")
_MAX_LISTING_BYTES = 1024 * 1024
# Tras un fallo no se vuelve a preguntar al bucket hasta que pase este tiempo.
_RETRY_AFTER_FAILURE_S = 600.0

_lock = threading.Lock()
# Por carpeta de cache: (hasta cuando vale, colecciones).
_memory: dict[str, tuple[float, tuple[str, ...]]] = {}


def collections_from_listing(payload: bytes, deep: bool = False) -> tuple[str, ...]:
    """Colecciones del listado del bucket: los Data Release, del mas nuevo al mas viejo, y el ultimo Quick Release.

    Los Data Release van primero porque el orden decide cual gana cuando una
    exposicion aparece en dos colecciones (`app.irsa.sia.deduplicate`).
    Devuelve una tupla vacia si el listado no trae ninguna carpeta de release.
    """
    found = {(kind.decode("ascii"), int(number)) for kind, number in _PREFIX.findall(payload)}
    data = sorted((number for kind, number in found if kind == "dr"), reverse=True)
    quick = sorted((number for kind, number in found if kind == "qr"), reverse=True)
    releases = [f"dr{number}" for number in data] + [f"qr{number}" for number in quick[:1]]
    names: list[str] = []
    for release in releases:
        names.append(f"spherex_{release}")
        if deep:
            names.append(f"spherex_{release}_deep")
    return tuple(names)


def _cache_path(settings: Settings) -> Path:
    return settings.cache_dir / "releases.json"


def _saved(path: Path, deep: bool) -> tuple[float, tuple[str, ...]] | None:
    """`(cuando se guardo, colecciones)` de la copia en disco, o `None` si no hay o no sirve."""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
        names = tuple(str(name) for name in document["collections"])
        if not names or bool(document.get("deep", False)) != deep:
            return None
        return float(document["checked_at"]), names
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _fetch(settings: Settings) -> tuple[str, ...]:
    """Pide el listado al bucket. Lanza lo que sea si no responde o no trae ningun release."""
    deadline = transport.Deadline(settings.release_list_timeout_s)
    response = transport.session().get(
        settings.release_list_url,
        headers=transport.request_headers(settings),
        stream=True,
        timeout=transport.timeouts(settings, deadline),
    )
    try:
        if response.status_code != 200:
            raise ValueError(f"HTTP {response.status_code}")
        payload = transport.read_body(response.raw, deadline, limit=_MAX_LISTING_BYTES)
    finally:
        response.close()
    names = collections_from_listing(payload, settings.deep_collections)
    if not names:
        raise ValueError("el listado no trae ninguna carpeta de release")
    return names


def active_collections(settings: Settings) -> tuple[str, ...]:
    """Las colecciones que hay que listar ahora.

    - Con `settings.discover_releases` apagado, o con `settings.collections`
      distinto del valor por defecto (alguien eligio las colecciones a mano
      con `SPHEREX_COLLECTIONS`), devuelve `settings.collections` sin tocar la red.
    - Si no, las que salen del listado del bucket, guardado
      `settings.release_list_cache_hours` horas en disco.
    - Si el bucket no responde: la copia guardada, aunque este vencida; si no
      hay, `settings.collections`. El fallo se recuerda 10 minutos.
    """
    if not settings.discover_releases or settings.collections != DEFAULT_COLLECTIONS:
        return settings.collections
    path = _cache_path(settings)
    key = str(path)
    now = time.time()
    with _lock:
        remembered = _memory.get(key)
        if remembered is not None and now < remembered[0]:
            return remembered[1]
        max_age_s = settings.release_list_cache_hours * 3600.0
        saved = _saved(path, settings.deep_collections)
        if saved is not None and 0.0 <= now - saved[0] <= max_age_s:
            _memory[key] = (saved[0] + max_age_s, saved[1])
            return saved[1]
        try:
            names = _fetch(settings)
        except Exception:  # red, plazo, respuesta que no es el listado: vale lo ultimo que se supo
            names = saved[1] if saved is not None else settings.collections
            _memory[key] = (now + _RETRY_AFTER_FAILURE_S, names)
            return names
        _memory[key] = (now + max_age_s, names)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            document = {"collections": list(names), "deep": settings.deep_collections, "checked_at": now}
            path.write_text(json.dumps(document), encoding="utf-8")
        except OSError:
            pass  # sin copia en disco se vuelve a preguntar al reiniciar
        return names


def reset() -> None:
    """Olvida lo recordado en memoria. Para los tests."""
    with _lock:
        _memory.clear()
