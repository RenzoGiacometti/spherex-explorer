"""Resolucion de nombres con Sesame (CDS), con espejo en CfA.

Referencia probada contra el servicio: `resolve_name` en spike/field.py (salida
XML `-ox`, elementos `jradeg`, `jdedeg`, `pm/pmRA`, `pm/pmDE`, `plx/v`, `Vel/v`
y `oname` dentro de `Target/Resolver`). `otype` esta en las cinco respuestas
guardadas en tests/fixtures/sesame. No se lee ningun otro elemento.

Que devuelve Sesame en cada caso (respuestas reales guardadas en
tests/fixtures/sesame y tests/fixtures/sesame_extra, estas ultimas del espejo
de CfA el 2026-11-15):

- Nombre conocido: `<Sesame><Target><Resolver>` con `jradeg` y `jdedeg`.
  `pm`, `plx` y `Vel` aparecen solo si el catalogo los trae: Abell 2218 no
  tiene ninguno de los tres, y M 87 tiene `pm` sin `plx` ni `Vel`.
- Nombre desconocido: el mismo documento con un `<Target>` sin `<Resolver>`
  (`nombre_inexistente.xml`). Es una respuesta valida: `not_resolved`.
- Servicio caido: CDS contesta una pagina HTML ("Page unavailable", con 404 o
  despues de una redireccion). Eso no es "nombre desconocido": se pasa al otro
  servidor y, si ninguno responde, se usa la copia guardada o se informa
  `upstream_unavailable`.

Cache en disco: la respuesta XML tal como llego, un archivo por texto buscado
(`settings.sesame_cache_dir`), vigente `settings.resolve_cache_days`. Solo se
guardan los nombres resueltos; un "no lo conozco" no se guarda.
"""

from __future__ import annotations

import hashlib
import logging
import math
import os
import re
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote, urlsplit

import requests
import urllib3

from app.api.errors import invalid_request, not_resolved, upstream_unavailable
from app.config import Settings
from app.domain import ResolvedTarget
from app.irsa import transport

logger = logging.getLogger(__name__)

# Sesame en CDS y su espejo en CfA, salida XML (las mismas URL que usa el spike).
# Es el valor por defecto de `settings.sesame_urls`, que es lo que se consulta.
SESAME_URLS: tuple[str, ...] = Settings().sesame_urls

# Reintentos cortos: dos intentos por servidor, con una pausa breve entre ellos. El segundo
# es para un corte o un 5xx; despues de una demora no se reintenta (ver `_fetch`).
ATTEMPTS_PER_SERVER = 2
RETRY_PAUSE_S = 0.5
CONNECT_TIMEOUT_S = 5.0
# Respuestas que vale la pena repetir. Si el servidor pide esperar mas que
# `MAX_RETRY_AFTER_S`, no se lo espera ni se lo vuelve a consultar: se pasa al siguiente.
RETRY_STATUS = frozenset({429, 500, 502, 503, 504})
MAX_RETRY_AFTER_S = 5.0

# Un identificador de SIMBAD es corto; esto solo evita mandar un texto enorme en la URL.
MAX_NAME_LENGTH = 200

SECONDS_PER_DAY = 86400.0


class SesameResponseError(ValueError):
    """La respuesta no es un documento de Sesame (por ejemplo, la pagina HTML de un servicio caido)."""


class _ServerFailed(Exception):
    """Un servidor de Sesame no dio una respuesta util despues de los reintentos."""


# ------------------------------------------------------------------ respuesta


def _number(node: ET.Element, path: str) -> float | None:
    """El numero de un elemento, o `None` si falta, esta vacio o no es un numero finito."""
    value = node.findtext(path)
    if value is None or not value.strip():
        return None
    try:
        number = float(value)
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def _text(node: ET.Element, path: str) -> str | None:
    """El texto de un elemento con los espacios normalizados (`M  87` queda `M 87`), o `None` si falta."""
    value = " ".join((node.findtext(path) or "").split())
    return value or None


def parse_sesame(text: str, query: str) -> ResolvedTarget | None:
    """Interpreta la respuesta XML de Sesame.

    Devuelve la posicion ICRS en la epoca J2000.0, el nombre principal, el tipo
    de objeto y, si el catalogo los trae, movimiento propio, paralaje y
    velocidad radial (`None` los que falten). Devuelve `None` si la respuesta
    no trae posicion, es decir, si Sesame no conoce el nombre.

    Lanza `SesameResponseError` si el texto no es un documento de Sesame (una
    pagina HTML de error, un cuerpo vacio): eso no dice nada sobre el nombre.
    """
    # El documento termina con un comentario `<!--- ====Done ... -->` despues
    # del elemento raiz; se corta ahi, como en el spike.
    try:
        root = ET.fromstring(text.split("<!---")[0].strip())
    except ET.ParseError as exc:
        raise SesameResponseError(f"la respuesta no es XML ({exc})") from exc
    if root.tag != "Sesame":
        raise SesameResponseError(f"la respuesta no es de Sesame: el elemento raiz es <{root.tag}>")
    if root.find("./Target") is None:
        raise SesameResponseError("la respuesta de Sesame no trae ningun <Target>")

    for resolver in root.findall("./Target/Resolver"):
        ra, dec = _number(resolver, "jradeg"), _number(resolver, "jdedeg")
        if ra is None or dec is None or not (0.0 <= ra <= 360.0 and -90.0 <= dec <= 90.0):
            continue
        return ResolvedTarget(
            query=query,
            ra=ra % 360.0,
            dec=dec,
            source="sesame",
            name=_text(resolver, "oname"),
            object_type=_text(resolver, "otype"),
            pm_ra=_number(resolver, "pm/pmRA"),
            pm_dec=_number(resolver, "pm/pmDE"),
            parallax=_number(resolver, "plx/v"),
            radial_velocity=_number(resolver, "Vel/v"),
            ref_epoch=2000.0,
        )
    return None


# ---------------------------------------------------------------------- cache


def normalize_query(name: str) -> str:
    """El texto buscado sin espacios de mas. Es la clave de la cache y lo que se le manda a Sesame.

    No se pasa a minusculas: SIMBAD distingue algunas designaciones solo por
    las mayusculas (la letra griega `mu Col` y la variable `MU Col`).
    """
    return " ".join(name.split())


def cache_path(name: str, settings: Settings) -> Path:
    """Archivo de la cache para un texto buscado: un nombre legible mas un resumen del texto exacto."""
    text = normalize_query(name)
    slug = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:48] or "nombre"
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
    return settings.sesame_cache_dir / f"{slug}-{digest}.xml"


def _read_cache(path: Path, query: str) -> tuple[ResolvedTarget, float] | None:
    """El objeto guardado y su antiguedad en dias, o `None` si no hay copia o no se puede leer."""
    try:
        body = path.read_bytes()
        age_days = (time.time() - path.stat().st_mtime) / SECONDS_PER_DAY
        target = parse_sesame(_decode(body), query)
    except FileNotFoundError:
        return None
    except (OSError, SesameResponseError) as exc:
        logger.warning("copia de Sesame ilegible en %s: %s", path, exc)
        return None
    return None if target is None else (target, age_days)


def _write_cache(path: Path, body: bytes) -> None:
    """Guarda la respuesta, byte a byte, con un archivo temporal y un renombrado. Si no se puede, se sigue sin cache."""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(body)
        for attempt in range(1, 7):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                # En Windows falla si otro hilo tiene abierto el destino en ese instante.
                if attempt == 6:
                    raise
                time.sleep(0.02 * attempt)
    except OSError as exc:
        logger.warning("no se pudo guardar la respuesta de Sesame en %s: %s", path, exc)
    finally:
        tmp.unlink(missing_ok=True)


# ------------------------------------------------------------------- consulta


def _retry_after(response: requests.Response) -> float:
    """Segundos que pide esperar el servidor (`Retry-After` numerico); 0 si no lo dice."""
    try:
        return max(0.0, float(response.headers.get("Retry-After", "0")))
    except ValueError:
        return 0.0


def _decode(body: bytes) -> str:
    """El cuerpo como texto. Sesame declara UTF-8; lo que no lo sea no hace fallar la lectura."""
    return body.decode("utf-8", errors="replace")


def _fetch(base: str, text: str, settings: Settings, deadline: transport.Deadline) -> bytes:
    """El cuerpo de la respuesta de un servidor de Sesame. Lanza `_ServerFailed` si no contesta bien.

    El nombre va al final de la URL, codificado, igual que en el spike. Que el
    cuerpo sea de verdad un documento de Sesame lo decide `parse_sesame`.

    `deadline` es todo el tiempo que se le da a este servidor, sumando intentos
    y pausas; ningun timeout pasa de lo que queda. Despues de una demora (al
    conectar, al esperar la respuesta o por el plazo) no se insiste con el mismo
    servidor: uno que no contesto a tiempo no va a contestar mejor medio segundo
    despues, y repetirlo duplica la espera antes de probar el siguiente.
    """
    url = base + quote(text)
    last = "sin intentos"
    for attempt in range(1, ATTEMPTS_PER_SERVER + 1):
        pause = RETRY_PAUSE_S
        try:
            timeout = (
                deadline.cap(min(CONNECT_TIMEOUT_S, settings.sesame_timeout_s)),
                deadline.cap(settings.sesame_timeout_s),
            )
            with requests.get(
                url, headers={"User-Agent": settings.user_agent}, timeout=timeout, stream=True
            ) as response:
                # El cuerpo se lee contra el plazo: `response.content` solo tiene el timeout de
                # cada lectura del socket, y una respuesta que llega de a poco no lo dispara.
                body = transport.read_body(response.raw, deadline)
        except (requests.Timeout, urllib3.exceptions.TimeoutError) as exc:
            raise _ServerFailed(f"{type(exc).__name__}: {exc}") from exc
        except (requests.RequestException, urllib3.exceptions.HTTPError) as exc:
            # De `requests`, lo que falla hasta recibir las cabeceras; de urllib3, un corte al leer el cuerpo.
            last = f"{type(exc).__name__}: {exc}"
        else:
            if response.status_code == 200:
                return body
            last = f"HTTP {response.status_code}"
            if response.status_code not in RETRY_STATUS:
                break  # un 404 con la pagina de "servicio no disponible" no cambia por repetirlo
            wait = _retry_after(response)
            if wait > MAX_RETRY_AFTER_S:
                last += f" con Retry-After de {wait:.0f} s"
                break
            pause = max(pause, wait)
        if attempt < ATTEMPTS_PER_SERVER:
            remaining = deadline.remaining()
            if remaining is not None and remaining <= pause:
                last += "; no queda tiempo para otro intento"
                break
            time.sleep(pause)
    raise _ServerFailed(last)


def resolve_name(name: str, settings: Settings) -> ResolvedTarget:
    """Resuelve un nombre de objeto.

    - Busca primero en la cache de disco (`settings.sesame_cache_dir`, clave: el
      texto buscado, vigencia `settings.resolve_cache_days`).
    - Si no esta, consulta Sesame en CDS y, si no responde, el espejo de CfA,
      con timeout y reintentos. Guarda la respuesta.
    - Lanza `ApiError` `not_resolved` si Sesame no conoce el nombre, y
      `upstream_unavailable` si ningun servidor responde y no hay copia en cache.

    Si ningun servidor responde y hay una copia vencida, se usa esa copia. Una
    pagina de error en HTML cuenta como "no responde", no como nombre desconocido.

    Bloquea como mucho `settings.sesame_total_timeout_s` (20 s por defecto), con
    los servidores que sea: ese plazo se reparte en partes iguales entre los que
    falten consultar, asi uno colgado no le saca su parte al siguiente. Un
    servidor que no contesta a tiempo no se vuelve a consultar. El plazo corta
    la espera de la conexion y la lectura del cuerpo; un servidor que gotea las
    cabeceras puede pasarlo (`transport.Deadline`).
    """
    text = normalize_query(name)
    if not text:
        raise invalid_request("name no puede estar vacio")
    if len(text) > MAX_NAME_LENGTH:
        raise invalid_request(f"name tiene {len(text)} caracteres: se admiten hasta {MAX_NAME_LENGTH}")

    path = cache_path(text, settings)
    cached = _read_cache(path, text)
    if cached is not None and cached[1] <= settings.resolve_cache_days:
        return cached[0]
    # Nombres de los objetos precalculados, guardados con el repositorio: no vencen ni
    # dependen de la cache (que en el despliegue puede ser un disco aparte).
    seeded = _read_cache(settings.sesame_seed_dir / path.name, text)
    if seeded is not None:
        return seeded[0]

    total = transport.Deadline(settings.sesame_total_timeout_s)
    servers = settings.sesame_urls
    failures: list[str] = []
    for position, base in enumerate(servers):
        host = urlsplit(base).netloc or base
        remaining = total.remaining()
        if remaining is None:
            share = total  # sin plazo
        elif remaining <= 0:
            failures.append(f"{host}: sin consultar, se agoto el plazo de {total.seconds:g} s")
            continue
        else:
            share = transport.Deadline(remaining / (len(servers) - position))
        try:
            body = _fetch(base, text, settings, share)
            target = parse_sesame(_decode(body), text)
        except (_ServerFailed, SesameResponseError) as exc:
            failures.append(f"{host}: {exc}")
            logger.warning("Sesame en %s no sirvio para %r: %s", host, text, exc)
            continue
        if target is None:
            raise not_resolved(f"Sesame no conoce el nombre {text!r}")
        _write_cache(path, body)
        return target

    if cached is not None:
        logger.warning("Sesame no responde; se usa la copia de %r guardada hace %.0f dias", text, cached[1])
        return cached[0]
    detail = "; ".join(failures) or "no hay ningun servidor configurado"
    raise upstream_unavailable(f"Sesame no responde y no hay copia en cache de {text!r} ({detail})")
