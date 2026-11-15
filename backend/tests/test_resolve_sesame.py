"""Sesame: lectura de la respuesta XML y `resolve_name` con cache, espejo y reintentos.

Sin red: las respuestas son las guardadas en tests/fixtures/sesame (los cinco
objetos de prueba, del spike) y tests/fixtures/sesame_extra (espejo de CfA, el
2026-11-15: un nombre inexistente, un objeto sin movimiento propio, uno con
movimiento propio y sin paralaje, y la pagina HTML que devuelve CDS caido).
Los servidores de Sesame son servidores HTTP locales en 127.0.0.1.
"""

from __future__ import annotations

import os
import socket
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

import pytest

from app.api.errors import ApiError
from app.config import Settings
from app.resolve import sesame
from app.resolve.sesame import SESAME_URLS, SesameResponseError, cache_path, parse_sesame, resolve_name

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SESAME_DIR = FIXTURES / "sesame"
EXTRA_DIR = FIXTURES / "sesame_extra"

BARNARD_XML = (SESAME_DIR / "barnard_s_star.xml").read_bytes()
UNKNOWN_XML = (EXTRA_DIR / "nombre_inexistente.xml").read_bytes()
CDS_DOWN_HTML = (EXTRA_DIR / "cds_page_unavailable.html").read_bytes()


# ------------------------------------------------------------------ respuesta


@pytest.mark.parametrize(
    ("filename", "query", "name", "object_type", "ra", "dec", "pm_ra", "pm_dec", "parallax", "radial_velocity"),
    [
        ("barnard_s_star.xml", "Barnard's Star", "NAME Barnard's star", "BY*",
         269.4520769586187, 4.69336496657667, -801.551, 10362.394, 546.9759, -110.11),
        ("epsilon_indi_b.xml", "Epsilon Indi B", "* eps Ind B", "BD*",
         331.04414658852124, -56.78284419511611, 3981.977, -2466.832, 270.658, None),
        ("wise_j085510_83_071442_5.xml", "WISE J085510.83-071442.5", "WISEA J085510.74-071442.5", "BD*",
         133.81890825, -7.247048, -8123.7, 673.2, 439.0, None),
        ("r_draconis.xml", "R Draconis", "V* R Dra", "Mi*",
         248.16761083295, 66.75497941722, -20.643, 6.149, 1.2509, -132.8),
        ("rw_aurigae.xml", "RW Aurigae", "V* RW Aur", "TT*",
         76.95652603458, 30.40143817389, 7.23, -20.33, 15.42, 15.0),
    ],
)  # fmt: skip
def test_parse_the_five_test_objects(
    filename: str,
    query: str,
    name: str,
    object_type: str,
    ra: float,
    dec: float,
    pm_ra: float,
    pm_dec: float,
    parallax: float,
    radial_velocity: float | None,
) -> None:
    target = parse_sesame((SESAME_DIR / filename).read_text(encoding="utf-8"), query)
    assert target is not None
    assert target.query == query and target.source == "sesame"
    assert target.name == name and target.object_type == object_type
    assert (target.ra, target.dec) == (ra, dec)
    assert (target.pm_ra, target.pm_dec, target.parallax) == (pm_ra, pm_dec, parallax)
    # Epsilon Indi B y WISE 0855 no tienen velocidad radial en el catalogo: `None`, no 0.
    assert target.radial_velocity == radial_velocity
    assert target.ref_epoch == 2000.0 and target.has_proper_motion


def test_parse_an_object_without_proper_motion() -> None:
    target = parse_sesame((EXTRA_DIR / "abell_2218.xml").read_text(encoding="utf-8"), "Abell 2218")
    assert target is not None
    # SIMBAD escribe `ACO  2218`, con dos espacios: se normalizan.
    assert target.name == "ACO 2218" and target.object_type == "ClG"
    assert (target.ra, target.dec) == (248.975, 66.21666667)
    assert target.pm_ra is None and target.pm_dec is None
    assert target.parallax is None and target.radial_velocity is None
    assert not target.has_proper_motion


def test_parse_proper_motion_without_parallax_or_radial_velocity() -> None:
    """M 87 trae `pm` (de Gaia) sin `plx`, y un corrimiento al rojo `z` en vez de `Vel`: `z` no se lee."""
    target = parse_sesame((EXTRA_DIR / "m_87.xml").read_text(encoding="utf-8"), "M 87")
    assert target is not None
    assert target.name == "M 87" and target.object_type == "AGN"
    assert (target.pm_ra, target.pm_dec) == (-8.029, 10.734)
    assert target.parallax is None and target.radial_velocity is None
    assert target.has_proper_motion


def test_parse_unknown_name_gives_none() -> None:
    assert parse_sesame(UNKNOWN_XML.decode("utf-8"), "Objeto Inexistente 12345") is None


@pytest.mark.parametrize(
    "text",
    [
        CDS_DOWN_HTML.decode("utf-8"),  # la pagina "Page unavailable" de CDS
        "",
        "Service Temporarily Unavailable",
        "<html><body><h1>503</h1></body></html>",  # HTML bien formado: se lee como XML, pero no es de Sesame
        '<?xml version="1.0"?><Sesame></Sesame>',  # sin ningun <Target>
    ],
)
def test_parse_rejects_what_is_not_a_sesame_answer(text: str) -> None:
    """Una pagina de error no es "nombre desconocido": no devuelve `None`, lanza."""
    with pytest.raises(SesameResponseError):
        parse_sesame(text, "Barnard's Star")


@pytest.mark.parametrize(
    "resolver",
    [
        "<jradeg>10.0</jradeg>",  # falta la declinacion
        "<jradeg></jradeg><jdedeg>5.0</jdedeg>",
        "<jradeg>abc</jradeg><jdedeg>5.0</jdedeg>",
        "<jradeg>nan</jradeg><jdedeg>5.0</jdedeg>",
        "<jradeg>10.0</jradeg><jdedeg>95.0</jdedeg>",  # fuera de rango
    ],
)
def test_parse_ignores_a_resolver_without_a_usable_position(resolver: str) -> None:
    text = f"<Sesame><Target><name>x</name><Resolver>{resolver}</Resolver></Target></Sesame>"
    assert parse_sesame(text, "x") is None


def test_parse_reads_optional_numbers_only_when_they_are_numbers() -> None:
    text = (
        "<Sesame><Target><Resolver><jradeg>10.5</jradeg><jdedeg>-5.25</jdedeg>"
        "<pm><pmRA>12.5</pmRA><pmDE>x</pmDE></pm><plx><v></v></plx></Resolver></Target></Sesame>"
    )
    target = parse_sesame(text, "x")
    assert target is not None
    assert (target.ra, target.dec, target.pm_ra) == (10.5, -5.25, 12.5)
    assert target.pm_dec is None and target.parallax is None and target.name is None and target.object_type is None
    assert not target.has_proper_motion


def test_default_servers_are_cds_first_and_the_cfa_mirror_second() -> None:
    assert Settings().sesame_urls == SESAME_URLS
    assert [url.split("/")[2] for url in SESAME_URLS] == ["cds.unistra.fr", "vizier.cfa.harvard.edu"]
    # Salida XML (`-ox`) solo con SIMBAD (`S`), como en el spike.
    assert all(url.endswith("/nph-sesame/-ox/S?") for url in SESAME_URLS)
    assert Settings().sesame_timeout_s == 10.0 and Settings().resolve_cache_days == 30.0


def test_servers_can_be_changed_from_the_environment() -> None:
    """Por ejemplo, para consultar solo el espejo mientras CDS esta caido."""
    settings = Settings.from_env(
        {"SPHEREX_SESAME_URLS": f"{SESAME_URLS[1]}, {SESAME_URLS[0]}", "SPHEREX_SESAME_TIMEOUT_S": "4"}
    )
    assert settings.sesame_urls == (SESAME_URLS[1], SESAME_URLS[0])
    assert settings.sesame_timeout_s == 4.0


# ---------------------------------------------------------------- servidores


@dataclass
class Canned:
    """Respuesta que da un servidor local."""

    status: int = 200
    body: bytes = b""
    content_type: str = "text/xml"
    headers: dict[str, str] = field(default_factory=dict)
    delay: float = 0.0
    trickle: tuple[int, float] | None = None  # (bytes por tramo, pausa): manda el cuerpo de a poco


class LocalSesame:
    """Servidor HTTP en 127.0.0.1 que hace de Sesame. Anota cada pedido que recibe."""

    def __init__(self, responder: Callable[[str, int], Canned]) -> None:
        self.names: list[str] = []  # nombre pedido, ya decodificado
        self.paths: list[str] = []  # tal como llego en la URL
        self.user_agents: list[str] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                query = self.path.split("?", 1)[1] if "?" in self.path else ""
                outer.paths.append(self.path)
                outer.names.append(unquote(query))
                outer.user_agents.append(self.headers.get("User-Agent", ""))
                canned = responder(unquote(query), len(outer.names))
                if canned.delay:
                    time.sleep(canned.delay)
                try:
                    self.send_response(canned.status)
                    self.send_header("Content-Type", canned.content_type)
                    self.send_header("Content-Length", str(len(canned.body)))
                    for key, value in canned.headers.items():
                        self.send_header(key, value)
                    self.end_headers()
                    if canned.trickle is None:
                        self.wfile.write(canned.body)
                    else:
                        size, pause = canned.trickle
                        for start in range(0, len(canned.body), size):
                            self.wfile.write(canned.body[start : start + size])
                            self.wfile.flush()
                            time.sleep(pause)
                except OSError:
                    pass  # el cliente ya corto (timeout)

            def log_message(self, *_args: object) -> None:
                pass

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._httpd.daemon_threads = True
        # Con el intervalo por defecto (0.5 s) cerrar cada servidor tarda medio segundo.
        self._thread = threading.Thread(target=self._httpd.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._httpd.server_address[1]}/viz-bin/nph-sesame/-ox/S?"

    def close(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()


ServerFactory = Callable[[Callable[[str, int], Canned] | Canned], LocalSesame]


@pytest.fixture
def serve(monkeypatch: pytest.MonkeyPatch) -> Iterator[ServerFactory]:
    """Crea servidores locales y los cierra al terminar el test."""
    # Si la maquina tiene un proxy configurado, que no se use para 127.0.0.1.
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")
    # Las pausas entre reintentos no hacen falta en los tests.
    monkeypatch.setattr(sesame, "RETRY_PAUSE_S", 0.01)
    servers: list[LocalSesame] = []

    def factory(responder: Callable[[str, int], Canned] | Canned) -> LocalSesame:
        server = LocalSesame((lambda _name, _n: responder) if isinstance(responder, Canned) else responder)
        servers.append(server)
        return server

    yield factory
    for server in servers:
        server.close()


def closed_url() -> str:
    """URL de un puerto local donde no escucha nadie."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    return f"http://127.0.0.1:{port}/viz-bin/nph-sesame/-ox/S?"


def make_settings(
    tmp_path: Path, *urls: str, timeout: float = 2.0, days: float = 30.0, total: float = 20.0
) -> Settings:
    return Settings(
        # Carpeta de datos vacia: los nombres guardados con el repositorio no cuentan en estos tests.
        data_dir=tmp_path / "data",
        cache_dir=tmp_path / "cache",
        sesame_urls=urls,
        sesame_timeout_s=timeout,
        sesame_total_timeout_s=total,
        resolve_cache_days=days,
    )


def cached_files(settings: Settings) -> list[Path]:
    return sorted(settings.sesame_cache_dir.glob("*")) if settings.sesame_cache_dir.is_dir() else []


# ---------------------------------------------------------------- resolve_name


def test_resolves_from_the_first_server_and_saves_the_answer(tmp_path: Path, serve: ServerFactory) -> None:
    cds, mirror = serve(Canned(body=BARNARD_XML)), serve(Canned(body=BARNARD_XML))
    settings = make_settings(tmp_path, cds.url, mirror.url)

    target = resolve_name("Barnard's Star", settings)

    assert target.name == "NAME Barnard's star" and target.query == "Barnard's Star" and target.source == "sesame"
    assert (target.pm_ra, target.pm_dec) == (-801.551, 10362.394)
    # El nombre va codificado al final de la URL, como en el spike.
    assert cds.paths == ["/viz-bin/nph-sesame/-ox/S?Barnard%27s%20Star"] and cds.names == ["Barnard's Star"]
    assert cds.user_agents == [settings.user_agent]
    assert mirror.names == []
    # En la cache queda la respuesta tal como llego.
    path = cache_path("Barnard's Star", settings)
    assert cached_files(settings) == [path] and path.read_bytes() == BARNARD_XML
    assert path.parent == settings.sesame_cache_dir


def test_a_cached_name_does_not_query_anything(tmp_path: Path, serve: ServerFactory) -> None:
    server = serve(Canned(body=BARNARD_XML))
    settings = make_settings(tmp_path, server.url)
    first = resolve_name("Barnard's Star", settings)
    # Otro proceso, sin ningun servidor a mano: alcanza con la copia.
    offline = make_settings(tmp_path, closed_url(), timeout=0.3)
    assert resolve_name("Barnard's Star", offline) == first
    # Los espacios de mas no cambian la clave.
    assert resolve_name("  Barnard's   Star ", offline) == first
    assert server.names == ["Barnard's Star"]


def test_the_cache_key_keeps_the_case(tmp_path: Path) -> None:
    """SIMBAD distingue `mu Col` (letra griega) de `MU Col` (estrella variable)."""
    settings = make_settings(tmp_path)
    assert cache_path("mu Col", settings) != cache_path("MU Col", settings)
    assert cache_path(" mu   Col ", settings) == cache_path("mu Col", settings)
    assert cache_path("mu Col", settings).name.startswith("mu_col-")
    # Un nombre sin letras ni numeros tambien tiene archivo.
    assert cache_path("***", settings).name.startswith("nombre-")


def test_special_characters_travel_encoded(tmp_path: Path, serve: ServerFactory) -> None:
    server = serve(Canned(body=BARNARD_XML))
    resolve_name("BD+20 307", make_settings(tmp_path, server.url))
    assert server.paths == ["/viz-bin/nph-sesame/-ox/S?BD%2B20%20307"] and server.names == ["BD+20 307"]


@pytest.mark.parametrize(
    "down",
    [
        Canned(status=404, body=CDS_DOWN_HTML, content_type="text/html"),  # lo que hace CDS caido
        Canned(status=200, body=CDS_DOWN_HTML, content_type="text/html"),  # la misma pagina tras una redireccion
        Canned(status=200, body=b""),
    ],
)
def test_an_error_page_is_not_an_unknown_name(tmp_path: Path, serve: ServerFactory, down: Canned) -> None:
    cds, mirror = serve(down), serve(Canned(body=BARNARD_XML))
    settings = make_settings(tmp_path, cds.url, mirror.url)

    target = resolve_name("Barnard's Star", settings)

    assert target.name == "NAME Barnard's star"
    # Una pagina de error no cambia por repetir el pedido: un solo intento y al espejo.
    assert len(cds.names) == 1 and mirror.names == ["Barnard's Star"]
    assert cache_path("Barnard's Star", settings).read_bytes() == BARNARD_XML


def test_falls_back_to_the_mirror_when_the_first_server_is_unreachable(tmp_path: Path, serve: ServerFactory) -> None:
    mirror = serve(Canned(body=BARNARD_XML))
    settings = make_settings(tmp_path, closed_url(), mirror.url, timeout=0.5)
    assert resolve_name("Barnard's Star", settings).name == "NAME Barnard's star"
    assert mirror.names == ["Barnard's Star"]


def test_falls_back_to_the_mirror_when_the_first_server_is_slow(tmp_path: Path, serve: ServerFactory) -> None:
    slow, mirror = serve(Canned(body=BARNARD_XML, delay=4.0)), serve(Canned(body=BARNARD_XML))
    settings = make_settings(tmp_path, slow.url, mirror.url, timeout=0.3)

    started = time.perf_counter()
    target = resolve_name("Barnard's Star", settings)
    elapsed = time.perf_counter() - started

    assert target.name == "NAME Barnard's star"
    # Despues de una demora no se insiste con el mismo servidor: un solo pedido, y al espejo.
    assert len(slow.names) == 1 and sesame.ATTEMPTS_PER_SERVER == 2
    assert mirror.names == ["Barnard's Star"]
    assert elapsed < 2.0  # un timeout de 0.3 s, no los 4 s del servidor lento


def test_two_hung_servers_cost_one_timeout_each(tmp_path: Path, serve: ServerFactory) -> None:
    """Aceptan la conexion y no contestan. Antes eran dos intentos por servidor: cuatro timeouts mas las pausas."""
    hung = Canned(body=BARNARD_XML, delay=6.0)
    cds, mirror = serve(hung), serve(hung)
    settings = make_settings(tmp_path, cds.url, mirror.url, timeout=0.4)

    started = time.perf_counter()
    with pytest.raises(ApiError) as caught:
        resolve_name("Barnard's Star", settings)
    elapsed = time.perf_counter() - started

    assert caught.value.code == "upstream_unavailable" and caught.value.retryable
    assert caught.value.message.count("Read timed out") == 2
    assert len(cds.names) == 1 and len(mirror.names) == 1
    assert 0.75 < elapsed < 1.5  # 2 x 0.4 s; con los reintentos serian 1.6 s


def test_the_whole_resolution_has_a_total_timeout(tmp_path: Path, serve: ServerFactory) -> None:
    """`sesame_total_timeout_s` acota todo, con los servidores que haya, y se reparte entre ellos."""
    hung = Canned(body=BARNARD_XML, delay=6.0)
    servers = [serve(hung), serve(hung), serve(hung)]
    settings = make_settings(tmp_path, *(server.url for server in servers), timeout=5.0, total=0.9)

    started = time.perf_counter()
    with pytest.raises(ApiError) as caught:
        resolve_name("Barnard's Star", settings)
    elapsed = time.perf_counter() - started

    assert caught.value.code == "upstream_unavailable"
    # Los tres se consultaron, cada uno con un tercio del plazo, y no con sus 5 s de timeout.
    assert [len(server.names) for server in servers] == [1, 1, 1]
    assert 0.8 < elapsed < 2.0
    assert Settings().sesame_total_timeout_s == 20.0
    assert Settings.from_env({"SPHEREX_SESAME_TOTAL_TIMEOUT_S": "7.5"}).sesame_total_timeout_s == 7.5


def test_a_trickling_server_does_not_use_up_the_time_of_the_mirror(tmp_path: Path, serve: ServerFactory) -> None:
    """Manda la respuesta de a poco, sin un silencio que dispare el timeout de lectura: lo corta su parte del plazo."""
    trickle = serve(Canned(body=BARNARD_XML, trickle=(20, 0.1)))  # 20 bytes cada 0,1 s: casi 6 s
    assert len(BARNARD_XML) > 1100
    mirror = serve(Canned(body=BARNARD_XML))
    settings = make_settings(tmp_path, trickle.url, mirror.url, timeout=5.0, total=1.0)

    started = time.perf_counter()
    target = resolve_name("Barnard's Star", settings)
    elapsed = time.perf_counter() - started

    assert target.name == "NAME Barnard's star"
    assert len(trickle.names) == 1 and mirror.names == ["Barnard's Star"]
    assert 0.45 < elapsed < 2.0  # la mitad del plazo para el primero, y el espejo contesta enseguida
    assert cache_path("Barnard's Star", settings).read_bytes() == BARNARD_XML


def test_a_retry_does_not_overrun_the_time_of_its_server(tmp_path: Path, serve: ServerFactory) -> None:
    busy = serve(Canned(status=503, body=b"Server busy", content_type="text/plain", headers={"Retry-After": "3"}))
    mirror = serve(Canned(body=BARNARD_XML))
    settings = make_settings(tmp_path, busy.url, mirror.url, total=2.0)

    started = time.perf_counter()
    target = resolve_name("Barnard's Star", settings)

    # Esperar los 3 s que pide pasaria de su parte del plazo (1 s): no se espera, y sigue el espejo.
    assert time.perf_counter() - started < 1.0
    assert target.name == "NAME Barnard's star" and len(busy.names) == 1 and len(mirror.names) == 1


def test_without_a_total_timeout_each_attempt_keeps_its_own(tmp_path: Path, serve: ServerFactory) -> None:
    slow, mirror = serve(Canned(body=BARNARD_XML, delay=4.0)), serve(Canned(body=BARNARD_XML))
    settings = make_settings(tmp_path, slow.url, mirror.url, timeout=0.3, total=0.0)
    assert resolve_name("Barnard's Star", settings).name == "NAME Barnard's star"
    assert len(slow.names) == 1 and len(mirror.names) == 1


def test_retries_a_busy_server_after_what_retry_after_says(tmp_path: Path, serve: ServerFactory) -> None:
    def responder(_name: str, n: int) -> Canned:
        if n == 1:
            return Canned(status=503, body=b"Server busy", content_type="text/plain", headers={"Retry-After": "0.4"})
        return Canned(body=BARNARD_XML)

    server = serve(responder)
    started = time.perf_counter()
    target = resolve_name("Barnard's Star", make_settings(tmp_path, server.url))
    assert time.perf_counter() - started >= 0.35  # espero lo que pidio el servidor (con margen por el reloj)
    assert target.name == "NAME Barnard's star" and len(server.names) == 2


def test_a_long_retry_after_sends_the_query_to_the_mirror(tmp_path: Path, serve: ServerFactory) -> None:
    busy = serve(Canned(status=503, body=b"Server busy", content_type="text/plain", headers={"Retry-After": "120"}))
    mirror = serve(Canned(body=BARNARD_XML))
    started = time.perf_counter()
    target = resolve_name("Barnard's Star", make_settings(tmp_path, busy.url, mirror.url))
    assert time.perf_counter() - started < 5.0
    assert target.name == "NAME Barnard's star"
    assert len(busy.names) == 1 and len(mirror.names) == 1  # no se lo espera ni se insiste


def test_unknown_name_is_not_resolved_and_is_not_cached(tmp_path: Path, serve: ServerFactory) -> None:
    cds, mirror = serve(Canned(body=UNKNOWN_XML)), serve(Canned(body=BARNARD_XML))
    settings = make_settings(tmp_path, cds.url, mirror.url)

    for _ in range(2):
        with pytest.raises(ApiError) as caught:
            resolve_name("Objeto Inexistente 12345", settings)
        assert caught.value.code == "not_resolved" and caught.value.http_status == 404
        assert not caught.value.retryable

    # Sesame contesto: no se le pregunta al espejo. Y un "no lo conozco" no se guarda.
    assert len(cds.names) == 2 and mirror.names == []
    assert cached_files(settings) == []


def test_nobody_answers_and_there_is_no_copy(tmp_path: Path, serve: ServerFactory) -> None:
    down = serve(Canned(status=404, body=CDS_DOWN_HTML, content_type="text/html"))
    settings = make_settings(tmp_path, down.url, closed_url(), timeout=0.3)

    with pytest.raises(ApiError) as caught:
        resolve_name("Barnard's Star", settings)

    assert caught.value.code == "upstream_unavailable" and caught.value.http_status == 503
    assert caught.value.retryable
    assert "HTTP 404" in caught.value.message
    assert cached_files(settings) == []


def test_no_servers_configured_is_upstream_unavailable(tmp_path: Path) -> None:
    with pytest.raises(ApiError) as caught:
        resolve_name("Barnard's Star", make_settings(tmp_path))
    assert caught.value.code == "upstream_unavailable"


def _age(path: Path, days: float) -> None:
    moment = time.time() - days * 86400.0
    os.utime(path, (moment, moment))


def test_an_expired_copy_is_refreshed(tmp_path: Path, serve: ServerFactory) -> None:
    server = serve(Canned(body=BARNARD_XML))
    settings = make_settings(tmp_path, server.url)
    resolve_name("Barnard's Star", settings)
    path = cache_path("Barnard's Star", settings)

    _age(path, 29.0)
    resolve_name("Barnard's Star", settings)
    assert len(server.names) == 1  # todavia vigente

    _age(path, 31.0)
    resolve_name("Barnard's Star", settings)
    assert len(server.names) == 2  # vencida: se vuelve a consultar
    assert time.time() - path.stat().st_mtime < 60.0  # y la copia queda renovada


def test_an_expired_copy_is_used_when_nobody_answers(tmp_path: Path, serve: ServerFactory) -> None:
    server = serve(Canned(body=BARNARD_XML))
    settings = make_settings(tmp_path, server.url)
    fresh = resolve_name("Barnard's Star", settings)
    path = cache_path("Barnard's Star", settings)
    _age(path, 90.0)

    down = serve(Canned(status=404, body=CDS_DOWN_HTML, content_type="text/html"))
    offline = make_settings(tmp_path, down.url, closed_url(), timeout=0.3)

    assert resolve_name("Barnard's Star", offline) == fresh
    assert len(down.names) == 1  # se intento antes de recurrir a la copia vencida
    assert path.read_bytes() == BARNARD_XML


def test_an_unreadable_copy_is_ignored(tmp_path: Path, serve: ServerFactory) -> None:
    server = serve(Canned(body=BARNARD_XML))
    settings = make_settings(tmp_path, server.url)
    path = cache_path("Barnard's Star", settings)
    path.parent.mkdir(parents=True)
    path.write_bytes(CDS_DOWN_HTML)  # alguien guardo una pagina de error

    assert resolve_name("Barnard's Star", settings).name == "NAME Barnard's star"
    assert len(server.names) == 1 and path.read_bytes() == BARNARD_XML


@pytest.mark.parametrize("name", ["", "   ", "\t\n"])
def test_empty_name_is_invalid(tmp_path: Path, name: str) -> None:
    with pytest.raises(ApiError) as caught:
        resolve_name(name, make_settings(tmp_path, closed_url(), timeout=0.3))
    assert caught.value.code == "invalid_request"


def test_a_huge_name_is_invalid(tmp_path: Path) -> None:
    with pytest.raises(ApiError) as caught:
        resolve_name("x" * 500, make_settings(tmp_path, closed_url(), timeout=0.3))
    assert caught.value.code == "invalid_request"
