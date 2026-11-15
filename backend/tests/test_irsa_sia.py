"""Lista de exposiciones por SIA2 contra un servidor local que hace de IRSA. Sin red.

Las respuestas son las reales guardadas en tests/fixtures/sia (campo de
Barnard, DR1 y QR3). Las variantes (lista vacia, estado de error, otro tipo de
producto) se derivan de esas respuestas y estan marcadas como sinteticas.
"""

from __future__ import annotations

import calendar
import gzip
import json
import os
import re
import shutil
import time
from collections import Counter
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from itertools import pairwise
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import pytest
from test_irsa_support import (
    SIA_DIR,
    Behaviour,
    Framing,
    Gate,
    IrsaStub,
    by_collection,
    cutout_index,
    respond,
    sequence,
    serve,
)

from app.api.errors import ApiError
from app.config import Settings
from app.domain import Exposure
from app.irsa import sia
from app.irsa.limits import get_limiter, reset_limiter
from app.irsa.sia import deduplicate, list_exposures, parse_exposures, sia_cache_path

INDEX = json.loads((SIA_DIR / "index.json").read_text(encoding="utf-8"))
RA, DEC = INDEX["center"]["ra"], INDEX["center"]["dec"]
QUERIES = {query["collection"]: query for query in INDEX["queries"]}
DR1 = (SIA_DIR / QUERIES["spherex_dr1"]["file"]).read_bytes()
QR3 = (SIA_DIR / QUERIES["spherex_qr3"]["file"]).read_bytes()

# Sintetica: la respuesta real de QR3 sin ninguna fila. En la Etapa 0, QR3 devolvio
# 0 filas para WISE 0855 (spike/RESULTADOS.md, seccion 4), pero esa respuesta no se guardo.
EMPTY = re.sub(rb"<TR>.*?</TR>\s*", b"", QR3, flags=re.S)
# Sinteticas: la misma respuesta con otro estado, como los define DALI para un servicio que falla o corta la lista.
STATUS_OK = b'<INFO name="QUERY_STATUS" value="OK"/>'
FAILED = EMPTY.replace(STATUS_OK, b'<INFO name="QUERY_STATUS" value="ERROR">roto</INFO>')
OVERFLOW = QR3.replace(STATUS_OK, b'<INFO name="QUERY_STATUS" value="OVERFLOW"/>')

# Comienzo de la pagina con la que el proxy de IRSA acompana sus 502 (visto con scripts/smoke_irsa.py).
PROXY_ERROR = (
    b'<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN"> <html><head> <title>502 Proxy Error</title> </head><body> '
    b"<h1>Proxy Error</h1> <p>The proxy server received an invalid response from an upstream server.</p> "
    b"</body></html>"
)

TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def votable(body: bytes) -> Behaviour:
    return respond(200, body, content_type="text/xml")


@pytest.fixture(autouse=True)
def _fresh_limiter() -> Iterator[None]:
    reset_limiter()
    yield
    reset_limiter()


@pytest.fixture
def stub() -> Iterator[IrsaStub]:
    server = IrsaStub()
    server.routes["/SIA"] = by_collection({"spherex_dr1": votable(DR1), "spherex_qr3": votable(QR3)})
    try:
        yield server
    finally:
        server.close()


@pytest.fixture
def settings(tmp_path: Path, stub: IrsaStub) -> Settings:
    return Settings(
        cache_dir=tmp_path / "cache",
        sia_url=stub.url("/SIA"),
        sia_attempts=3,
        sia_retry_wait_s=0.0,
        irsa_connect_timeout_s=5.0,
        irsa_read_timeout_s=10.0,
    )


def collections_asked(stub: IrsaStub) -> list[str]:
    return [hit.query["COLLECTION"] for hit in stub.hits]


def seconds(text: str) -> float:
    return float(calendar.timegm(time.strptime(text, "%Y-%m-%dT%H:%M:%SZ")))


def age_cache(settings: Settings, hours: float) -> str:
    """Hace de cuenta que las listas guardadas se consultaron hace `hours` horas. Devuelve esa fecha."""
    stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - hours * 3600.0))
    sidecars = sorted(settings.sia_cache_dir.glob("*.json"))
    assert len(sidecars) == len(settings.collections)
    for path in sidecars:
        meta = json.loads(path.read_text(encoding="utf-8"))
        path.write_text(json.dumps({**meta, "queried_at": stamp}), encoding="utf-8")
    return stamp


# ------------------------------------------------------- respuestas reales


def test_lists_the_exposures_of_the_real_responses(stub: IrsaStub, settings: Settings) -> None:
    before = time.time()
    listing = list_exposures(RA, DEC, settings)

    # Barnard: 358 exposiciones entre DR1 y QR3, sin repetidas (spike/RESULTADOS.md, seccion 4).
    assert len(listing.exposures) == 358
    assert Counter(item.collection for item in listing.exposures) == {"spherex_dr1": 239, "spherex_qr3": 119}
    assert len({(item.obs_id, item.detector) for item in listing.exposures}) == 358
    assert {item.detector for item in listing.exposures} == {1, 2, 3, 4, 5, 6}
    assert all(a.mjd_start <= b.mjd_start for a, b in pairwise(listing.exposures))
    for item in listing.exposures:
        assert item.url.startswith("https://irsa.ipac.caltech.edu/ibe/data/spherex/") and item.url.endswith(".fits")
        assert f"D{item.detector}_spx" in item.url and item.obs_id in item.url
        assert 60000.0 < item.mjd_start < item.mjd_end < item.mjd_start + 0.01
        assert 0.7 < item.wave_min_um < item.wave_max_um < 5.1

    assert not listing.stale
    assert TIME_RE.match(listing.listed_at)
    assert before - 1.0 <= seconds(listing.listed_at) <= time.time()

    # Las doce exposiciones de los recortes guardados estan en la lista, con los mismos datos.
    by_url = {item.url: item for item in listing.exposures}
    for entry in cutout_index()["cutouts"]:
        item = by_url[entry["url"]]
        assert (item.obs_id, item.collection) == (entry["obs_id"], entry["collection"])
        assert item.detector == entry["detector"]
        assert (item.mjd_start, item.mjd_end) == (entry["mjd"], entry["mjd_end"])
        assert item.wave_min_um == pytest.approx(entry["wave_min_um"], abs=1e-4)
        assert item.wave_max_um == pytest.approx(entry["wave_max_um"], abs=1e-4)


def test_asks_irsa_what_the_spike_asked(stub: IrsaStub, settings: Settings) -> None:
    list_exposures(RA, DEC, settings)
    # Una consulta por coleccion, con los mismos parametros que las consultas reales guardadas.
    assert collections_asked(stub) == ["spherex_dr1", "spherex_qr3"]
    for hit in stub.hits:
        assert hit.path == "/SIA"
        assert hit.query == dict(parse_qsl(urlsplit(QUERIES[hit.query["COLLECTION"]]["url"]).query))
        assert hit.query["POS"] == "circle 269.446287 4.768255 0.000278"
        assert hit.headers["user-agent"] == settings.user_agent
    assert get_limiter(settings).sia_in_flight == 0


def test_only_the_collections_of_settings(stub: IrsaStub, tmp_path: Path) -> None:
    settings = Settings(cache_dir=tmp_path / "cache", sia_url=stub.url("/SIA"), collections=("spherex_qr3",))
    listing = list_exposures(RA, DEC, settings)
    assert collections_asked(stub) == ["spherex_qr3"]
    assert len(listing.exposures) == 119 and {item.collection for item in listing.exposures} == {"spherex_qr3"}


# ------------------------------------------------------------------- cache


def test_fresh_cache_is_used_without_asking(stub: IrsaStub, settings: Settings) -> None:
    first = list_exposures(RA, DEC, settings)
    assert len(stub.hits) == 2

    # Queda guardada la respuesta de IRSA tal cual, una por coleccion, con el nombre que usaba el spike.
    files = sorted(path.name for path in settings.sia_cache_dir.iterdir())
    assert files == sorted(
        name for query in INDEX["queries"] for name in (query["file"], query["file"].replace(".xml", ".json"))
    )
    for query in INDEX["queries"]:
        path = sia_cache_path(query["collection"], RA, DEC, settings)
        assert path.name == query["file"]
        assert path.read_bytes() == (SIA_DIR / query["file"]).read_bytes()
        meta = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
        assert meta["rows"] == query["rows"] and TIME_RE.match(meta["queried_at"])
        assert dict(parse_qsl(urlsplit(meta["url"]).query)) == dict(parse_qsl(urlsplit(query["url"]).query))

    again = list_exposures(RA, DEC, settings)
    assert len(stub.hits) == 2
    assert again == first

    # A 23 horas sigue vigente.
    stamp = age_cache(settings, 23.0)
    still = list_exposures(RA, DEC, settings)
    assert len(stub.hits) == 2
    assert (still.exposures, still.listed_at, still.stale) == (first.exposures, stamp, False)


def test_another_center_is_another_query(stub: IrsaStub, settings: Settings) -> None:
    list_exposures(RA, DEC, settings)
    list_exposures(RA + 0.0001, DEC, settings)
    assert len(stub.hits) == 4
    assert stub.hits[2].query["POS"] == "circle 269.446387 4.768255 0.000278"
    assert len(list(settings.sia_cache_dir.glob("*.xml"))) == 4


def test_refresh_asks_again(stub: IrsaStub, settings: Settings) -> None:
    list_exposures(RA, DEC, settings)
    stamp = age_cache(settings, 1.0)
    listing = list_exposures(RA, DEC, settings, refresh=True)
    assert collections_asked(stub) == ["spherex_dr1", "spherex_qr3"] * 2
    assert len(listing.exposures) == 358 and not listing.stale
    assert seconds(listing.listed_at) > seconds(stamp) + 3000.0


def test_expired_cache_asks_again(stub: IrsaStub, settings: Settings) -> None:
    list_exposures(RA, DEC, settings)
    stamp = age_cache(settings, 25.0)
    listing = list_exposures(RA, DEC, settings)
    assert len(stub.hits) == 4
    assert not listing.stale and seconds(listing.listed_at) > seconds(stamp) + 80_000.0
    # La copia nueva reemplaza a la vencida: la proxima no consulta.
    list_exposures(RA, DEC, settings)
    assert len(stub.hits) == 4


def test_expired_copy_is_the_fallback_when_irsa_is_down(stub: IrsaStub, settings: Settings) -> None:
    good = list_exposures(RA, DEC, settings)
    stamp = age_cache(settings, 30.0)
    stub.routes["/SIA"] = respond(502, b"<html>Bad Gateway</html>")

    listing = list_exposures(RA, DEC, settings)
    assert listing.stale
    assert listing.exposures == good.exposures
    assert listing.listed_at == stamp
    # Insistio con cada coleccion antes de conformarse con la copia vencida.
    assert collections_asked(stub)[2:] == ["spherex_dr1"] * 3 + ["spherex_qr3"] * 3

    # La copia vencida no se pisa: cuando IRSA vuelve, la lista se actualiza.
    stub.routes["/SIA"] = by_collection({"spherex_dr1": votable(DR1), "spherex_qr3": votable(QR3)})
    back = list_exposures(RA, DEC, settings)
    assert not back.stale and seconds(back.listed_at) > seconds(stamp)


def test_one_collection_from_irsa_and_the_other_from_the_expired_copy(stub: IrsaStub, settings: Settings) -> None:
    good = list_exposures(RA, DEC, settings)
    stamp = age_cache(settings, 30.0)
    stub.routes["/SIA"] = by_collection({"spherex_dr1": votable(DR1), "spherex_qr3": respond(502)})
    listing = list_exposures(RA, DEC, settings)
    assert listing.stale and listing.exposures == good.exposures
    # La fecha de la lista es la de su parte mas vieja.
    assert listing.listed_at == stamp


def test_refresh_with_irsa_down_keeps_the_copy_and_says_so(stub: IrsaStub, settings: Settings) -> None:
    good = list_exposures(RA, DEC, settings)
    stub.routes["/SIA"] = respond(503, b"Server busy, retry later.")
    listing = list_exposures(RA, DEC, settings, refresh=True)
    # La copia estaba vigente, pero se pidio una lista nueva y no se consiguio.
    assert listing.stale and listing.exposures == good.exposures and listing.listed_at == good.listed_at
    # Sin `refresh`, la copia vigente se usa sin consultar y sin aviso.
    hits = len(stub.hits)
    assert not list_exposures(RA, DEC, settings).stale and len(stub.hits) == hits


def test_fixtures_copied_to_the_cache_work_without_any_server(tmp_path: Path) -> None:
    """Asi se le puede dar una lista real al planificador en un test, sin red."""
    settings = Settings(cache_dir=tmp_path / "cache", sia_url="http://127.0.0.1:9/SIA", sia_attempts=1)
    settings.sia_cache_dir.mkdir(parents=True)
    for query in INDEX["queries"]:
        shutil.copyfile(SIA_DIR / query["file"], settings.sia_cache_dir / query["file"])
    listing = list_exposures(RA, DEC, settings)
    assert len(listing.exposures) == 358 and not listing.stale

    # Sin el `.json`, la fecha de la consulta es la del archivo.
    old = time.time() - 3 * 86_400.0
    for path in settings.sia_cache_dir.glob("*.xml"):
        os.utime(path, (old, old))
    fast = Settings(cache_dir=tmp_path / "cache", sia_url="http://127.0.0.1:9/SIA", sia_attempts=1,
                    sia_retry_wait_s=0.0, irsa_connect_timeout_s=0.3)  # fmt: skip
    listing = list_exposures(RA, DEC, fast)
    assert listing.stale and len(listing.exposures) == 358
    assert abs(seconds(listing.listed_at) - old) <= 1.0


def test_unreadable_copy_counts_as_no_copy(stub: IrsaStub, settings: Settings) -> None:
    list_exposures(RA, DEC, settings)
    sia_cache_path("spherex_dr1", RA, DEC, settings).write_bytes(b"<VOTABLE>a medio escribir")
    listing = list_exposures(RA, DEC, settings)
    assert len(listing.exposures) == 358 and not listing.stale
    assert collections_asked(stub) == ["spherex_dr1", "spherex_qr3", "spherex_dr1"]
    assert sia_cache_path("spherex_dr1", RA, DEC, settings).read_bytes() == DR1


# -------------------------------------------------------------- fallas de IRSA


def test_a_502_is_retried(stub: IrsaStub, settings: Settings) -> None:
    stub.routes["/SIA"] = by_collection(
        {"spherex_dr1": sequence(respond(502, b"Bad Gateway"), votable(DR1)), "spherex_qr3": votable(QR3)}
    )
    listing = list_exposures(RA, DEC, settings)
    assert len(listing.exposures) == 358 and not listing.stale
    assert collections_asked(stub) == ["spherex_dr1", "spherex_dr1", "spherex_qr3"]


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
def test_repeated_failure_without_a_copy_is_upstream_unavailable(
    stub: IrsaStub, settings: Settings, status: int
) -> None:
    stub.routes["/SIA"] = respond(status, PROXY_ERROR, content_type="text/html")
    with pytest.raises(ApiError) as caught:
        list_exposures(RA, DEC, settings)
    assert (caught.value.code, caught.value.http_status, caught.value.retryable) == ("upstream_unavailable", 503, True)
    # El mensaje, que es para el log, dice que coleccion fallo y con que, sin las etiquetas de la pagina.
    assert f"SIA2 spherex_dr1: HTTP {status}: 502 Proxy Error Proxy Error The proxy server" in caught.value.message
    assert "<" not in caught.value.message and "tras 3 intentos" in caught.value.message
    # Los tres intentos de la configuracion, y no sigue con la otra coleccion.
    assert collections_asked(stub) == ["spherex_dr1"] * 3
    assert not settings.sia_cache_dir.exists() or list(settings.sia_cache_dir.iterdir()) == []
    assert get_limiter(settings).sia_in_flight == 0


def test_dropped_connection_is_retried(stub: IrsaStub, settings: Settings) -> None:
    stub.routes["/SIA"] = by_collection(
        {
            "spherex_dr1": sequence(lambda handler, hit: None, serve(DR1, cut_after=5000), votable(DR1)),
            "spherex_qr3": votable(QR3),
        }
    )
    listing = list_exposures(RA, DEC, settings)
    assert len(listing.exposures) == 358
    assert collections_asked(stub) == ["spherex_dr1"] * 3 + ["spherex_qr3"]


def test_slow_answer_hits_the_timeout(stub: IrsaStub, tmp_path: Path) -> None:
    settings = Settings(
        cache_dir=tmp_path / "cache", sia_url=stub.url("/SIA"), sia_attempts=2, sia_retry_wait_s=0.0,
        irsa_connect_timeout_s=5.0, irsa_read_timeout_s=0.3,
    )  # fmt: skip
    stub.routes["/SIA"] = serve(DR1, delay_s=30.0)
    started = time.perf_counter()
    with pytest.raises(ApiError) as caught:
        list_exposures(RA, DEC, settings)
    assert caught.value.code == "upstream_unavailable"
    assert time.perf_counter() - started < 5.0
    assert len(stub.hits) == 2


@pytest.mark.parametrize("framing", ["chunked", "length"])
def test_a_trickling_answer_hits_the_total_timeout(stub: IrsaStub, tmp_path: Path, framing: Framing) -> None:
    """Una lista que llega de a poco no dispara el timeout de lectura: cada intento tiene un plazo total."""
    settings = Settings(
        cache_dir=tmp_path / "cache", sia_url=stub.url("/SIA"), sia_attempts=2, sia_retry_wait_s=0.0,
        irsa_connect_timeout_s=5.0, irsa_read_timeout_s=5.0, irsa_total_timeout_s=0.5,
    )  # fmt: skip
    # 2 kB cada 0,1 s: la respuesta entera de DR1 tardaria mas de 10 s, sin un silencio de mas de 0,1 s.
    stub.routes["/SIA"] = serve(DR1, framing=framing, block=2048, pause_s=0.1, content_type="text/xml")
    assert len(DR1) > 200_000
    started = time.perf_counter()
    with pytest.raises(ApiError) as caught:
        list_exposures(RA, DEC, settings)
    elapsed = time.perf_counter() - started
    assert caught.value.code == "upstream_unavailable" and "plazo total de 0.5 s" in caught.value.message
    # Dos intentos de medio segundo, no los mas de 10 s que tardaria cada respuesta.
    assert 0.9 < elapsed < 4.0 and len(stub.hits) == 2
    assert get_limiter(settings).sia_in_flight == 0
    assert not settings.sia_cache_dir.exists() or list(settings.sia_cache_dir.iterdir()) == []


def test_a_slow_but_steady_answer_within_the_total_timeout_is_used(stub: IrsaStub, tmp_path: Path) -> None:
    settings = Settings(
        cache_dir=tmp_path / "cache", sia_url=stub.url("/SIA"), sia_attempts=1,
        irsa_read_timeout_s=5.0, irsa_total_timeout_s=20.0,
    )  # fmt: skip
    slow = serve(DR1, framing="chunked", block=64 * 1024, pause_s=0.02, content_type="text/xml")
    stub.routes["/SIA"] = by_collection({"spherex_dr1": slow, "spherex_qr3": votable(QR3)})
    assert len(list_exposures(RA, DEC, settings).exposures) == 358


def test_a_compressed_answer_is_read(stub: IrsaStub, settings: Settings) -> None:
    """El cuerpo se lee del flujo, no con `response.content`: si IRSA lo comprime, hay que descomprimirlo igual."""
    packed = respond(200, gzip.compress(DR1), {"Content-Encoding": "gzip"}, content_type="text/xml")
    stub.routes["/SIA"] = by_collection({"spherex_dr1": packed, "spherex_qr3": votable(QR3)})
    assert len(list_exposures(RA, DEC, settings).exposures) == 358
    assert "gzip" in stub.hits[0].headers["accept-encoding"]
    # En la cache queda el VOTable, no los bytes comprimidos.
    assert sia_cache_path("spherex_dr1", RA, DEC, settings).read_bytes() == DR1


def test_garbage_with_a_200_is_retried(stub: IrsaStub, settings: Settings) -> None:
    html = respond(200, b"<html><body>mantenimiento</body></html>", content_type="text/html")
    stub.routes["/SIA"] = by_collection({"spherex_dr1": sequence(html, votable(DR1)), "spherex_qr3": votable(QR3)})
    assert len(list_exposures(RA, DEC, settings).exposures) == 358
    assert len(stub.hits) == 3

    # Si nunca llega un VOTable, no se toma por una lista vacia.
    stub.routes["/SIA"] = html
    with pytest.raises(ApiError) as caught:
        list_exposures(RA + 1.0, DEC, settings)
    assert caught.value.code == "upstream_unavailable"


def test_client_error_is_not_retried(stub: IrsaStub, settings: Settings) -> None:
    stub.routes["/SIA"] = respond(400, b"UsageFault: invalid POS")
    with pytest.raises(ApiError) as caught:
        list_exposures(RA, DEC, settings)
    assert caught.value.code == "upstream_unavailable" and "HTTP 400" in caught.value.message
    assert len(stub.hits) == 1


@pytest.mark.parametrize(("body", "status"), [(FAILED, "ERROR"), (OVERFLOW, "OVERFLOW")])
def test_query_status_other_than_ok_is_a_failure(stub: IrsaStub, settings: Settings, body: bytes, status: str) -> None:
    stub.routes["/SIA"] = votable(body)
    with pytest.raises(ApiError) as caught:
        list_exposures(RA, DEC, settings)
    # Una lista cortada o fallida no se usa ni se guarda, y repetir la misma consulta no la arregla.
    assert caught.value.code == "upstream_unavailable" and f"QUERY_STATUS={status}" in caught.value.message
    assert len(stub.hits) == 1
    assert not settings.sia_cache_dir.exists() or list(settings.sia_cache_dir.iterdir()) == []


def test_retry_after_is_respected(stub: IrsaStub, settings: Settings) -> None:
    stub.routes["/SIA"] = by_collection(
        {
            "spherex_dr1": sequence(respond(503, b"busy", {"Retry-After": "0.4"}), votable(DR1)),
            "spherex_qr3": votable(QR3),
        }
    )
    started = time.perf_counter()
    assert len(list_exposures(RA, DEC, settings).exposures) == 358
    assert time.perf_counter() - started >= 0.4


def test_a_long_retry_after_is_not_waited(stub: IrsaStub, settings: Settings) -> None:
    stub.routes["/SIA"] = respond(503, b"busy", {"Retry-After": "600"})
    started = time.perf_counter()
    with pytest.raises(ApiError) as caught:
        list_exposures(RA, DEC, settings)
    assert time.perf_counter() - started < 5.0
    assert len(stub.hits) == 1
    # Quien arma la respuesta de la API puede pasarle la espera al cliente.
    assert caught.value.retry_after == 600.0 and caught.value.headers() == {"Retry-After": "600"}


def test_waits_between_attempts(stub: IrsaStub, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    settings = Settings(cache_dir=tmp_path / "cache", sia_url=stub.url("/SIA"), sia_attempts=4, sia_retry_wait_s=2.0)
    waits: list[float] = []
    monkeypatch.setattr(sia.time, "sleep", waits.append)
    stub.routes["/SIA"] = respond(502)
    with pytest.raises(ApiError):
        list_exposures(RA, DEC, settings)
    # Espera creciente entre intentos y ninguna despues del ultimo.
    assert waits == [2.0, 4.0, 6.0] and len(stub.hits) == 4
    assert Settings().sia_attempts >= 2 and Settings().sia_retry_wait_s > 0


def test_at_most_two_queries_at_once(stub: IrsaStub, settings: Settings) -> None:
    stub.gate = Gate(target=2, hold_s=0.03)
    centers = [(RA + 0.01 * i, DEC) for i in range(8)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        listings = list(pool.map(lambda center: list_exposures(*center, settings), centers))
    assert all(len(listing.exposures) == 358 for listing in listings)
    # Ocho hilos, dieciseis consultas, y el servidor nunca vio mas de dos a la vez.
    assert len(stub.hits) == 16 and stub.max_active == 2
    assert get_limiter(settings).sia_in_flight == 0


# ---------------------------------------------------------------- lista vacia


def test_no_exposures_is_an_empty_list_not_an_error(stub: IrsaStub, settings: Settings) -> None:
    stub.routes["/SIA"] = votable(EMPTY)
    listing = list_exposures(RA, DEC, settings)
    assert listing.exposures == [] and not listing.stale and TIME_RE.match(listing.listed_at)
    assert len(stub.hits) == 2
    # Tambien se guarda: no vuelve a consultar dentro de las 24 horas.
    assert list_exposures(RA, DEC, settings).exposures == []
    assert len(stub.hits) == 2


def test_one_empty_collection_leaves_the_other(stub: IrsaStub, settings: Settings) -> None:
    # Como WISE 0855 en la Etapa 0: exposiciones en DR1 y ninguna en QR3.
    stub.routes["/SIA"] = by_collection({"spherex_dr1": votable(DR1), "spherex_qr3": votable(EMPTY)})
    listing = list_exposures(RA, DEC, settings)
    assert len(listing.exposures) == 239 and {item.collection for item in listing.exposures} == {"spherex_dr1"}


def test_no_collections_is_an_empty_list(stub: IrsaStub, tmp_path: Path) -> None:
    settings = Settings(cache_dir=tmp_path / "cache", sia_url=stub.url("/SIA"), collections=())
    listing = list_exposures(RA, DEC, settings)
    assert listing.exposures == [] and not listing.stale and TIME_RE.match(listing.listed_at)
    assert stub.hits == []


# -------------------------------------------------------- lectura del VOTable


def test_parse_keeps_the_order_of_the_response() -> None:
    exposures = parse_exposures(QR3, "spherex_qr3")
    assert len(exposures) == QUERIES["spherex_qr3"]["rows"] == 119
    assert parse_exposures(EMPTY) == []
    # Sin la tabla tambien es una lista vacia, siempre que el estado diga OK.
    assert parse_exposures(re.sub(rb"<TABLE>.*</TABLE>", b"", QR3, flags=re.S)) == []


FIELDS = [name.decode("ascii") for name in re.findall(rb'<FIELD name="([^"]+)"', QR3)]


def with_cell(row: bytes, column: str, value: bytes) -> bytes:
    """La fila con otro valor en esa columna. Las celdas van en el orden de los FIELD."""
    cells = row.split(b"<TD>")
    assert len(cells) == len(FIELDS) + 1
    position = FIELDS.index(column) + 1
    cells[position] = value + cells[position][cells[position].index(b"</TD>") :]
    return b"<TD>".join(cells)


def test_parse_keeps_only_level_two_science_images() -> None:
    """Sintetico: la respuesta real con el tipo de producto de algunas filas cambiado."""
    rows = re.findall(rb"<TR>.*?</TR>", QR3, flags=re.S)
    assert len(rows) == 119
    changes = [
        ("dataproduct_subtype", b"auxiliar"),
        ("dataproduct_type", b"cube"),
        ("calib_level", b"3"),
        ("energy_bandpassname", b"SPHEREx-X1"),  # sin detector reconocible
        ("access_url", b""),
        ("t_min", b""),
    ]
    body = QR3
    for row, (column, value) in zip(rows, changes, strict=False):
        changed = with_cell(row, column, value)
        assert changed != row and body.count(row) == 1
        body = body.replace(row, changed)
    exposures = parse_exposures(body, "spherex_qr3")
    assert len(exposures) == 119 - len(changes)
    # Las descartadas son justo las filas cambiadas; las demas salen iguales.
    original = parse_exposures(QR3)
    assert [item for item in original if item in exposures] == exposures
    assert original[len(changes) :] == exposures


@pytest.mark.parametrize(
    "body",
    [
        b"",
        b"no es xml",
        b"<html><body>502 Bad Gateway</body></html>",
        QR3.replace(STATUS_OK, b""),  # sin estado no se sabe si esta entera
        QR3.replace(b'name="access_url"', b'name="otra_cosa"'),
        QR3[: len(QR3) // 2],
    ],
    ids=["vacio", "texto", "html", "sin_estado", "sin_columna", "cortado"],
)
def test_parse_rejects_what_is_not_a_sia_response(body: bytes) -> None:
    with pytest.raises(sia._BadResponse):
        parse_exposures(body)


# ------------------------------------------------------------- deduplicacion


def exposure(obs_id: str, detector: int, collection: str, mjd: float) -> Exposure:
    url = f"https://irsa.ipac.caltech.edu/ibe/data/spherex/{collection}/{obs_id}D{detector}.fits"
    return Exposure(
        obs_id=obs_id, collection=collection, detector=detector, mjd_start=mjd, mjd_end=mjd + 0.001, url=url,
        wave_min_um=1.0, wave_max_um=2.0,
    )  # fmt: skip


def test_duplicates_keep_dr1_and_the_list_is_sorted() -> None:
    collections = ("spherex_dr1", "spherex_qr3")
    exposures = [
        exposure("B", 2, "spherex_qr3", 61000.5),
        exposure("A", 3, "spherex_qr3", 60900.0),  # la misma que la de DR1 de abajo
        exposure("A", 1, "spherex_qr3", 60900.0),
        exposure("A", 3, "spherex_dr1", 60900.0),
        exposure("C", 6, "spherex_dr1", 60800.0),
        exposure("C", 6, "spherex_qr3", 60800.0),  # y esta, de la de arriba
    ]
    unique = deduplicate(exposures, collections)
    assert [(item.obs_id, item.detector, item.collection) for item in unique] == [
        ("C", 6, "spherex_dr1"),
        ("A", 1, "spherex_qr3"),
        ("A", 3, "spherex_dr1"),
        ("B", 2, "spherex_qr3"),
    ]
    # No depende del orden en que lleguen.
    assert deduplicate(exposures[::-1], collections) == unique
    # La misma observacion en otro detector no es un duplicado.
    other_detector = [exposure("A", 1, "spherex_dr1", 1.0), exposure("A", 2, "spherex_dr1", 1.0)]
    assert len(deduplicate(other_detector, collections)) == 2
    assert deduplicate([], collections) == []


def test_duplicate_between_collections_through_the_whole_path(stub: IrsaStub, settings: Settings) -> None:
    """Sintetico: QR3 devuelve tambien las exposiciones de DR1, rotuladas como QR3."""
    relabelled = DR1.replace(b"<TD>spherex_dr1</TD>", b"<TD>spherex_qr3</TD>")
    relabelled = relabelled.replace(b"/spherex/dr1/", b"/spherex/qr3/")
    stub.routes["/SIA"] = by_collection({"spherex_dr1": votable(DR1), "spherex_qr3": votable(relabelled)})
    listing = list_exposures(RA, DEC, settings)
    assert len(listing.exposures) == 239
    assert {item.collection for item in listing.exposures} == {"spherex_dr1"}
    assert all("/spherex/dr1/" in item.url for item in listing.exposures)
