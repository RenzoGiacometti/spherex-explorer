"""Acceso a IRSA para SPHEREx (Etapa 0): consultas SIA2 y TAP, y descarga de recortes.

Todo con timeout, reintentos y cache en disco, porque IRSA es lento e inestable.

Fuentes:
- Tablas y columnas: TAP_SCHEMA de https://irsa.ipac.caltech.edu/TAP
  (spherex.artifact, spherex.plane, spherex.observation, spherex.obscore);
  volcado en resultados/tap_schema.txt, generado con explore_schema.py.
- Consulta por punto y URL de recorte: tutorial oficial
  https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts/
- SIA2 con SPHEREx: https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/
- TAP asincrono (endpoints /async, /phase, /results/result):
  https://irsa.ipac.caltech.edu/docs/program_interface/TAP.html
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import random
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

import requests
import urllib3
from astropy.io import fits
from astropy.io.votable import parse as parse_votable

IRSA_BASE = "https://irsa.ipac.caltech.edu/"
TAP_ASYNC = IRSA_BASE + "TAP/async"
SIA_URL = IRSA_BASE + "SIA"

# CLAUDE.md: maximo 10 descargas en paralelo contra IRSA.
MAX_WORKERS = 10

RETRY_STATUS = frozenset({429, 500, 502, 503, 504})
TRANSIENT_ERRORS = (
    requests.ConnectionError,
    requests.Timeout,
    requests.exceptions.ChunkedEncodingError,
    requests.exceptions.ContentDecodingError,
)
FITS_BLOCK = 2880
IMAGE_HDUS = ("IMAGE", "FLAGS", "VARIANCE", "ZODI")
USER_AGENT = "spherex-explorer-spike/0.1 (python-requests)"

_thread_local = threading.local()


class IrsaError(RuntimeError):
    """Fallo de IRSA que no se resolvio con reintentos."""


class PermanentError(IrsaError):
    """Fallo que no tiene sentido reintentar (por ejemplo HTTP 4xx)."""


def _session() -> requests.Session:
    session = getattr(_thread_local, "session", None)
    if session is None:
        session = requests.Session()
        session.headers["User-Agent"] = USER_AGENT
        _thread_local.session = session
    return session


def _retry_after(resp: requests.Response) -> float:
    """Segundos que pide el servidor antes de reintentar (IRSA manda `Retry-After: 5`
    junto con el 503 "Server busy, retry later.")."""
    try:
        return max(0.0, float(resp.headers.get("Retry-After", "0")))
    except ValueError:
        return 0.0


def _backoff(attempt: int, minimum: float = 0.0) -> None:
    time.sleep(max(minimum, min(30.0, 1.5 * 2 ** (attempt - 1))) + random.uniform(0.0, 1.0))


def http(
    method: str,
    url: str,
    *,
    tries: int = 6,
    timeout: tuple[float, float] = (15.0, 60.0),
    **kwargs: object,
) -> requests.Response:
    """Peticion HTTP con reintentos ante 5xx, timeouts y cortes de conexion."""
    last = "sin intentos"
    for attempt in range(1, tries + 1):
        wait = 0.0
        try:
            resp = _session().request(method, url, timeout=timeout, **kwargs)
        except TRANSIENT_ERRORS as exc:
            last = f"{type(exc).__name__}: {exc}"
        else:
            if resp.status_code not in RETRY_STATUS:
                return resp
            last = f"HTTP {resp.status_code}"
            wait = _retry_after(resp)
        if attempt < tries:
            _backoff(attempt, wait)
    raise IrsaError(f"{method} {url}: {last} tras {tries} intentos")


# --------------------------------------------------------------------------- TAP


def tap_query(
    adql: str,
    cache_dir: Path,
    *,
    max_wait: float = 3600.0,
    refresh: bool = False,
    log: Callable[[str], None] = print,
) -> tuple[list[dict[str, str]], dict[str, object]]:
    """Ejecuta una consulta ADQL en modo asincrono y devuelve (filas, metadatos).

    El modo sincronico corta a los 5 minutos y el proxy de IRSA devuelve 502 de
    forma intermitente; el modo asincrono sobrevive a las dos cosas porque cada
    paso es una peticion corta que se puede reintentar.
    """
    key = hashlib.sha1(" ".join(adql.split()).encode("utf-8")).hexdigest()[:16]
    tap_dir = cache_dir / "tap"
    tap_dir.mkdir(parents=True, exist_ok=True)
    csv_path = tap_dir / f"{key}.csv"
    meta_path = tap_dir / f"{key}.json"

    if csv_path.exists() and meta_path.exists() and not refresh:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["from_cache"] = True
        return _parse_csv(csv_path.read_text(encoding="utf-8")), meta

    t0 = time.perf_counter()
    resp = http(
        "POST",
        TAP_ASYNC,
        data={"QUERY": adql, "FORMAT": "CSV", "LANG": "ADQL", "REQUEST": "doQuery", "PHASE": "RUN"},
        allow_redirects=False,
    )
    job_url = resp.headers.get("Location", "").replace("http://", "https://", 1)
    if resp.status_code not in (201, 302, 303) or not job_url:
        raise IrsaError(f"TAP no creo el trabajo: HTTP {resp.status_code}: {resp.text[:300]!r}")
    log(f"TAP: trabajo {job_url}")

    polls = 0
    phase = "?"
    phases_seen: list[str] = []
    while True:
        phase = http("GET", f"{job_url}/phase").text.strip()
        polls += 1
        if not phases_seen or phases_seen[-1] != phase:
            phases_seen.append(phase)
            log(f"TAP: fase {phase} a los {time.perf_counter() - t0:.0f} s")
        if phase in ("COMPLETED", "ERROR", "ABORTED", "ABORT"):
            break
        if phase == "PENDING":
            http("POST", f"{job_url}/phase", data={"PHASE": "RUN"}, allow_redirects=False)
        if time.perf_counter() - t0 > max_wait:
            http("POST", f"{job_url}/phase", data={"PHASE": "ABORT"}, allow_redirects=False)
            raise IrsaError(f"TAP: sin resultado tras {max_wait:.0f} s (fase {phase})")
        time.sleep(min(15.0, 2.0 + polls))

    if phase != "COMPLETED":
        detail = http("GET", f"{job_url}/error").text[:500]
        raise IrsaError(f"TAP termino en fase {phase}: {detail!r}")

    result = http("GET", f"{job_url}/results/result", timeout=(15.0, 300.0))
    if result.status_code != 200:
        raise IrsaError(f"TAP: resultado HTTP {result.status_code}: {result.text[:300]!r}")
    text = result.text
    rows = _parse_csv(text)
    meta: dict[str, object] = {
        "from_cache": False,
        "seconds": round(time.perf_counter() - t0, 2),
        "rows": len(rows),
        "polls": polls,
        "phases": phases_seen,
        "queried_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "adql": " ".join(adql.split()),
    }
    csv_path.write_text(text, encoding="utf-8", newline="")
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return rows, meta


def _parse_csv(text: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(text)))


# --------------------------------------------------------------------------- SIA


def sia_query(
    ra: float,
    dec: float,
    collection: str,
    cache_dir: Path,
    *,
    radius_deg: float = 1.0 / 3600.0,
    refresh: bool = False,
) -> tuple[list[dict[str, str]], dict[str, object]]:
    """Imagenes de una coleccion que cubren un punto, via SIA2 de IRSA.

    Parametros del estandar IVOA SIA 2.0 (COLLECTION, POS); uso con SPHEREx segun
    https://caltech-ipac.github.io/irsa-tutorials/spherex-intro/
    Se pide VOTable (formato por defecto): la salida CSV de IRSA no entrecomilla
    la columna `cloud_access`, que contiene comas, y desalinea las columnas.
    """
    sia_dir = cache_dir / "sia"
    sia_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{collection}__{ra:.6f}_{dec:+.6f}"
    xml_path = sia_dir / f"{stem}.xml"
    meta_path = sia_dir / f"{stem}.json"

    if xml_path.exists() and meta_path.exists() and not refresh:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["from_cache"] = True
        return _parse_votable(xml_path.read_bytes()), meta

    t0 = time.perf_counter()
    try:
        resp = http(
            "GET",
            SIA_URL,
            params={"COLLECTION": collection, "POS": f"circle {ra:.6f} {dec:.6f} {radius_deg:.6f}"},
            timeout=(15.0, 300.0),
        )
        if resp.status_code != 200:
            raise IrsaError(f"SIA {collection}: HTTP {resp.status_code}: {resp.text[:300]!r}")
        rows = _parse_votable(resp.content)
    except IrsaError as exc:
        # Si IRSA no responde y hay una copia anterior, se usa esa y se avisa.
        if xml_path.exists() and meta_path.exists():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["from_cache"] = True
            meta["refresh_error"] = str(exc)
            return _parse_votable(xml_path.read_bytes()), meta
        raise
    meta: dict[str, object] = {
        "from_cache": False,
        "seconds": round(time.perf_counter() - t0, 2),
        "rows": len(rows),
        "queried_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "url": resp.url,
    }
    xml_path.write_bytes(resp.content)
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return rows, meta


def _parse_votable(payload: bytes) -> list[dict[str, str]]:
    votable = parse_votable(io.BytesIO(payload))
    for resource in votable.resources:
        for info in resource.infos:
            if info.name == "QUERY_STATUS" and info.value != "OK":
                # ERROR, o OVERFLOW si el servicio corto la lista de resultados.
                raise IrsaError(f"SIA: QUERY_STATUS={info.value}: {info.content}")
    # IRSA pone ID="col_N" en cada FIELD; los nombres ObsCore estan en `name`.
    table = votable.get_first_table().to_table(use_names_over_ids=True)
    return [{name: str(row[name]) for name in table.colnames} for row in table]


# ----------------------------------------------------------------------- recortes


@dataclass
class CutoutResult:
    uri: str
    url: str
    path: Path | None
    ok: bool
    from_cache: bool
    attempts: int
    seconds: float
    nbytes: int
    error: str | None = None


def cutout_url(uri: str, ra: float, dec: float, size_deg: float) -> str:
    """URL de recorte. Formato verificado contra el servicio (verify.py):
    `?center=<ra>,<dec>d&size=<lado>`; `size` sin unidad esta en grados y la
    unidad de `center` va una sola vez, despues del segundo valor.

    `uri` puede ser la URL completa (`access_url` de SIA) o la ruta relativa
    (`spherex.artifact.uri` de TAP)."""
    base = uri if uri.startswith("http") else IRSA_BASE + uri
    return f"{base}?center={ra:.6f},{dec:.6f}d&size={size_deg:g}"


def _cache_path(cache_dir: Path, uri: str, ra: float, dec: float, size_deg: float, full: bool) -> Path:
    stem = uri.rsplit("/", 1)[-1].removesuffix(".fits")
    mode = "full" if full else "img"
    return cache_dir / "cutouts" / f"{stem}__{ra:.6f}_{dec:+.6f}_{size_deg:g}_{mode}.fits"


def _read_exact(raw: object, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = raw.read(n - len(buf))  # type: ignore[attr-defined]
        if not chunk:
            break
        buf += chunk
    return bytes(buf)


def _data_bytes(header: fits.Header) -> int:
    """Tamano del bloque de datos de un HDU (estandar FITS 4.0, seccion 7)."""
    naxis = int(header.get("NAXIS", 0))
    if naxis == 0:
        return 0
    count = 1
    for i in range(1, naxis + 1):
        count *= int(header[f"NAXIS{i}"])
    size = abs(int(header["BITPIX"])) // 8 * int(header.get("GCOUNT", 1)) * (int(header.get("PCOUNT", 0)) + count)
    return math.ceil(size / FITS_BLOCK) * FITS_BLOCK


def _read_until(raw: object, stop_before: str) -> bytes:
    """Lee un FITS desde un stream HDU por HDU y corta al llegar a `stop_before`.

    El recorte trae la tabla EPSF completa (3,9 MB de 4,0 MB) despues de las
    extensiones de imagen; cortar ahi evita transferir el 96 % de la respuesta.
    """
    out = bytearray()
    while True:
        header_bytes = bytearray()
        while True:
            block = _read_exact(raw, FITS_BLOCK)
            if not block and not header_bytes:
                return bytes(out)  # fin limpio del archivo
            if len(block) < FITS_BLOCK:
                raise OSError("FITS truncado dentro de un encabezado")
            header_bytes += block
            if any(block[i : i + 80].rstrip() == b"END" for i in range(0, FITS_BLOCK, 80)):
                break
        header = fits.Header.fromstring(bytes(header_bytes).decode("ascii", errors="replace"))
        if header.get("EXTNAME") == stop_before:
            return bytes(out)
        size = _data_bytes(header)
        data = _read_exact(raw, size)
        if len(data) < size:
            raise OSError("FITS truncado dentro de los datos")
        out += header_bytes + data


def _validate(payload: bytes) -> None:
    with fits.open(io.BytesIO(payload), memmap=False) as hdul:
        names = [hdu.name for hdu in hdul]
        missing = [name for name in IMAGE_HDUS if name not in names]
        if missing:
            raise OSError(f"faltan extensiones {missing}; hay {names}")
        shapes = {hdul[name].data.shape for name in IMAGE_HDUS}
        if len(shapes) != 1:
            raise OSError(f"extensiones con formas distintas: {shapes}")


def _strip_psf(payload: bytes) -> bytes:
    """Quita EPSF antes de guardar: ocupa 3,9 MB por recorte y la Etapa 0 no la usa."""
    with fits.open(io.BytesIO(payload), memmap=False) as hdul:
        kept = fits.HDUList([hdu.copy() for hdu in hdul if hdu.name != "EPSF"])
        buf = io.BytesIO()
        kept.writeto(buf)
        return buf.getvalue()


def fetch_cutout(
    uri: str,
    ra: float,
    dec: float,
    size_deg: float,
    cache_dir: Path,
    *,
    full: bool = False,
    tries: int = 6,
    timeout: tuple[float, float] = (15.0, 120.0),
) -> CutoutResult:
    """Descarga un recorte con reintentos y lo deja en la cache.

    `full=False` corta la transferencia antes de EPSF (no trae WCS-WAVE).
    `full=True` baja la respuesta completa y guarda todo menos EPSF.
    """
    url = cutout_url(uri, ra, dec, size_deg)
    path = _cache_path(cache_dir, uri, ra, dec, size_deg, full)
    if path.exists():
        return CutoutResult(uri, url, path, True, True, 0, 0.0, path.stat().st_size)

    t0 = time.perf_counter()
    last = "sin intentos"
    nbytes = 0
    for attempt in range(1, tries + 1):
        wait = 0.0
        try:
            with _session().get(url, stream=True, timeout=timeout, headers={"Accept-Encoding": "identity"}) as resp:
                if resp.status_code in RETRY_STATUS:
                    wait = _retry_after(resp)
                    detail = " ".join(resp.text[:160].split())
                    raise OSError(f"HTTP {resp.status_code} (Retry-After={wait:g}): {detail}")
                if resp.status_code != 200:
                    # Por ejemplo 422 "Arrays do not overlap.": no se arregla reintentando.
                    raise PermanentError(f"HTTP {resp.status_code}: {resp.text[:120]!r}")
                payload = resp.raw.read() if full else _read_until(resp.raw, "EPSF")
            nbytes = len(payload)
            _validate(payload)
            if full:
                payload = _strip_psf(payload)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(f"{path.name}.{threading.get_ident()}.tmp")
            tmp.write_bytes(payload)
            tmp.replace(path)
            return CutoutResult(uri, url, path, True, False, attempt, time.perf_counter() - t0, nbytes)
        except PermanentError as exc:
            return CutoutResult(uri, url, None, False, False, attempt, time.perf_counter() - t0, 0, str(exc))
        except (OSError, ValueError, KeyError, requests.RequestException, urllib3.exceptions.HTTPError) as exc:
            # Cortes de red al leer el stream (urllib3) y FITS truncado o invalido (astropy).
            last = f"{type(exc).__name__}: {exc}"[:200]
        if attempt < tries:
            _backoff(attempt, wait)
    return CutoutResult(uri, url, None, False, False, tries, time.perf_counter() - t0, nbytes, last)


def fetch_cutouts(
    uris: list[str],
    ra: float,
    dec: float,
    size_deg: float,
    cache_dir: Path,
    *,
    workers: int = MAX_WORKERS,
    full: bool = False,
    progress: Callable[[int, int, CutoutResult], None] | None = None,
) -> list[CutoutResult]:
    """Descarga recortes en paralelo; el resultado conserva el orden de `uris`."""
    workers = max(1, min(workers, MAX_WORKERS))
    results: list[CutoutResult | None] = [None] * len(uris)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(fetch_cutout, uri, ra, dec, size_deg, cache_dir, full=full): i for i, uri in enumerate(uris)
        }
        for done, future in enumerate(as_completed(futures), start=1):
            i = futures[future]
            results[i] = future.result()
            if progress is not None:
                progress(done, len(uris), results[i])  # type: ignore[arg-type]
    return [r for r in results if r is not None]
