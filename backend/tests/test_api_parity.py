"""Paridad entre la aplicacion real y el servidor falso sobre los campos de muestra del repositorio.

El frontend se construyo contra el servidor falso (`app.fake`). Aca las tres
muestras de tests/fixtures/fields se le dan a la aplicacion real como campos
precalculados (su carpeta hace de `data/fields`, con el `pipeline` de las
muestras), y se comprueba que para un campo en cache los dos servidores
responden lo mismo, byte por byte y con las mismas cabeceras: `POST /api/field`,
metadatos, flujo de eventos, planos, cubo, capas auxiliares, vista provisoria,
prioridad y resolucion de nombres.

Diferencias que quedan, todas fuera de lo que fija el contrato:

- `/track`. El servidor falso devuelve la trayectoria guardada con la muestra,
  que el generador armo con la fecha media de las exposiciones de cada plano. La
  aplicacion real exige que las fechas sean `epochs[].mjd_mean` (contrato 4.9):
  como las guardadas no lo son, la calcula de nuevo. Mismo nombre y mismas
  epocas; la fecha difiere en dias y el pixel en centesimas.
- El texto de `message` en los errores, que es para el log. `code`, codigo HTTP
  y `retryable` coinciden.
- Nombres. El servidor falso solo conoce las respuestas de Sesame guardadas y
  las encuentra sin distinguir mayusculas ni signos; uno que no tiene es
  `not_resolved`. La aplicacion real busca el texto exacto y, si no esta en su
  cache, consulta Sesame.
- `POST /api/field`. El servidor falso elige la muestra mas cercana y acepta
  `?scenario=`; la aplicacion real calcula el `id` del pedido. Aca se pide el
  centro exacto de cada muestra, asi que el `id` es el mismo.
- `/api/health` y las cabeceras de CORS, que no son parte del contrato.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from test_api_support import FIELDS_DIR, FIXTURES, IMMUTABLE, SAVED_SESAME, SESAME_DIR, error_of, seed_sesame

from app.api.main import create_app
from app.config import SAMPLE_PIPELINE_VERSION, Settings
from app.contract import CUBE_PLANE_STATUSES, FieldMeta, TrackResponse
from app.fake import create_fake_app
from app.jobs.store import FieldStore, cube_nbytes, plane_nbytes

SAMPLE_IDS = FieldStore(FIELDS_DIR).list_ids()

pytestmark = pytest.mark.skipif(not SAMPLE_IDS, reason=f"no hay campos de muestra en {FIELDS_DIR}")

# Cabeceras que tienen que coincidir cuando estan (y faltar en los dos cuando faltan).
COMPARED_HEADERS = (
    "content-type",
    "content-length",
    "content-encoding",
    "cache-control",
    "etag",
    "x-plane-rev",
    "x-accel-buffering",
    "retry-after",
)

# Objeto de cada muestra: texto buscado y nombre principal.
SAMPLE_OBJECTS = {
    "4a2e877f8ee4efd2": "Barnard's Star",
    "4022da836c5a1505": "WISE J085510.83-071442.5",
    "02a1d503e540822b": "Epsilon Indi B",
}


def vary_of(response: Any) -> set[str]:
    """Lo que dice `Vary`, sin `Origin`: ese lo agrega el CORS del servidor falso, que la aplicacion real no tiene."""
    return {item.strip() for item in response.headers.get("vary", "").split(",") if item.strip()} - {"Origin"}


class Pair:
    """Los dos servidores, para hacerles el mismo pedido."""

    def __init__(self, real: TestClient, fake: TestClient) -> None:
        self.real = real
        self.fake = fake

    def request(self, method: str, url: str, *, fake_params: dict[str, str] | None = None, **kwargs: Any) -> Any:
        """Hace el pedido a los dos y comprueba que respondan lo mismo. Devuelve la respuesta de la aplicacion real."""
        where = f"{method} {url} {kwargs}"
        real = self.real.request(method, url, **kwargs)
        params = {**(kwargs.pop("params", None) or {}), **(fake_params or {})}
        fake = self.fake.request(method, url, params=params or None, **kwargs)
        assert real.status_code == fake.status_code, where
        for name in COMPARED_HEADERS:
            assert real.headers.get(name) == fake.headers.get(name), f"{where}: cabecera {name}"
        assert vary_of(real) == vary_of(fake), where
        if real.status_code >= 400:
            assert error_of(real) == error_of(fake), where  # el `message` es para el log y puede diferir
        else:
            assert real.content == fake.content, where
        return real

    def get(self, url: str, **kwargs: Any) -> Any:
        return self.request("GET", url, **kwargs)


def fixture_snapshot() -> dict[str, tuple[int, int]]:
    return {
        path.relative_to(FIXTURES).as_posix(): (path.stat().st_size, path.stat().st_mtime_ns)
        for path in sorted(FIELDS_DIR.rglob("*"))
        if path.is_file()
    }


@pytest.fixture(scope="module")
def servers(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[Pair, Settings]]:
    root = tmp_path_factory.mktemp("paridad")
    # La carpeta de fixtures hace de `data/`: sus `fields/` son los campos precalculados. No se escribe ahi.
    settings = Settings(
        data_dir=FIXTURES, cache_dir=root / "cache", pipeline_version=SAMPLE_PIPELINE_VERSION, sesame_urls=()
    )
    assert settings.precomputed_fields_dir == FIELDS_DIR
    seed_sesame(settings, main_names=True)
    before = fixture_snapshot()
    fake_app = create_fake_app(FIELDS_DIR, sesame_dir=SESAME_DIR, seconds=100.0, settings=Settings())
    # La aplicacion real comprime si el cliente acepta gzip y el servidor falso no: se comparan sin comprimir.
    identity = {"Accept-Encoding": "identity"}
    with TestClient(create_app(settings), headers=identity) as real, TestClient(fake_app, headers=identity) as fake:
        yield Pair(real, fake), settings
    assert fixture_snapshot() == before, "la aplicacion real escribio en los campos de muestra"


@pytest.fixture(scope="module")
def metas(servers: tuple[Pair, Settings]) -> dict[str, FieldMeta]:
    """Pide cada muestra a los dos servidores, que la tienen en cache, y devuelve su documento."""
    pair, _ = servers
    found: dict[str, FieldMeta] = {}
    for field_id in SAMPLE_IDS:
        sample = FieldStore(FIELDS_DIR).read_meta(field_id)
        body = {"ra": sample.request.ra, "dec": sample.request.dec, "fov": sample.request.fov, "band": 3}
        posted = pair.request("POST", "/api/field", json=body, fake_params={"scenario": "cached"})
        assert posted.status_code == 200
        assert posted.json()["id"] == field_id and posted.json()["events_url"] == f"/api/field/{field_id}/events"
        found[field_id] = FieldMeta.model_validate(posted.json()["meta"])
        assert found[field_id].status in ("ready", "partial")
    return found


def test_the_samples_are_the_three_of_the_repository(metas: dict[str, FieldMeta]) -> None:
    assert set(metas) == set(SAMPLE_OBJECTS)
    assert {meta.pipeline for meta in metas.values()} == {SAMPLE_PIPELINE_VERSION}


@pytest.mark.parametrize("field_id", SAMPLE_IDS or ["sin-muestras"])
def test_meta_and_events(servers: tuple[Pair, Settings], metas: dict[str, FieldMeta], field_id: str) -> None:
    pair, _ = servers
    base = f"/api/field/{field_id}"
    meta = pair.get(f"{base}/meta")
    assert FieldMeta.model_validate(meta.json()) == metas[field_id]
    assert meta.headers["cache-control"] == "no-cache"
    # El mismo documento, byte por byte: el `ETag` de uno le sirve al otro.
    unchanged = pair.get(f"{base}/meta", headers={"If-None-Match": meta.headers["etag"]})
    assert unchanged.status_code == 304 and unchanged.content == b""

    # Campo terminado: `state`, `done` y cierre, con los mismos ids y el mismo JSON.
    events = pair.get(f"{base}/events")
    assert events.headers["content-type"].startswith("text/event-stream")
    assert events.text.startswith("event: state\nid: 1\ndata: {") and "\n\nevent: done\nid: 2\ndata: {" in events.text

    assert pair.request("POST", f"{base}/priority", json={"band": 6}).status_code == 204
    # Pedir el campo otra vez, con `refresh`: sigue en cache en los dos (sobre un precalculado no hace nada).
    body = {"ra": metas[field_id].request.ra, "dec": metas[field_id].request.dec, "refresh": True}
    again = pair.request("POST", "/api/field", json=body, fake_params={"scenario": "cached"})
    assert again.status_code == 200 and FieldMeta.model_validate(again.json()["meta"]) == metas[field_id]


@pytest.mark.parametrize("field_id", SAMPLE_IDS or ["sin-muestras"])
def test_planes_aux_cube_and_preview(
    servers: tuple[Pair, Settings], metas: dict[str, FieldMeta], field_id: str
) -> None:
    pair, _ = servers
    meta = metas[field_id]
    assert meta.grid is not None and meta.planes is not None
    base = f"/api/field/{field_id}"
    size = plane_nbytes(meta.grid.shape)

    with_data = 0
    for plane in meta.planes:
        url = f"{base}/plane/{plane.epoch}/{plane.detector}"
        aux_url = f"{base}/aux/{plane.epoch}/{plane.detector}"
        if plane.status not in CUBE_PLANE_STATUSES:
            # Plano vacio: no tiene binario en ninguno de los dos.
            assert error_of(pair.get(url)) == (404, "not_found", False)
            assert error_of(pair.get(aux_url)) == (404, "not_found", False)
            continue
        with_data += 1
        current = pair.get(url, params={"rev": plane.rev})
        assert len(current.content) == size
        assert (current.headers["cache-control"], current.headers["x-plane-rev"]) == (IMMUTABLE, str(plane.rev))
        for params in (None, {"rev": plane.rev - 1}, {"rev": plane.rev + 1}):
            other = pair.get(url, params=params)
            assert other.content == current.content and other.headers["cache-control"] == "no-cache"
        packed = pair.get(aux_url, headers={"Accept-Encoding": "gzip"})
        assert packed.headers["content-encoding"] == "gzip" and packed.headers["x-plane-rev"] == str(plane.rev)
        plain = pair.get(aux_url, headers={"Accept-Encoding": "identity"})
        assert "content-encoding" not in plain.headers and len(plain.content) == 6 * size // 4
        assert plain.content == packed.content
    assert with_data >= 16

    cube = pair.get(f"{base}/cube", params={"rev": meta.rev})
    assert cube.headers["cache-control"] == IMMUTABLE
    assert len(cube.content) == cube_nbytes(meta) == with_data * size
    assert cube.headers["content-length"] == str(cube_nbytes(meta))
    assert pair.get(f"{base}/cube").headers["cache-control"] == "no-cache"
    assert pair.get(f"{base}/cube", params={"rev": meta.rev + 1}).headers["cache-control"] == "no-cache"

    preview = pair.get(f"{base}/preview")
    assert len(preview.content) == size and preview.headers["cache-control"] == "no-cache"

    # Lo que no existe y lo que no se puede interpretar, igual en los dos.
    for url in (f"{base}/plane/9/3", f"{base}/plane/1/7", f"{base}/aux/9/3", f"{base}/otra"):
        assert pair.get(url).status_code == 404, url
    for url in (f"{base}/plane/uno/3", f"{base}/plane/1/3?rev=-1", f"{base}/cube?rev=x", f"{base}/track"):
        assert pair.get(url).status_code == 422, url


@pytest.mark.parametrize("field_id", SAMPLE_IDS or ["sin-muestras"])
def test_track_differs_only_in_the_dates(
    servers: tuple[Pair, Settings], metas: dict[str, FieldMeta], field_id: str
) -> None:
    pair, settings = servers
    meta = metas[field_id]
    assert meta.epochs is not None
    query = SAMPLE_OBJECTS[field_id]
    main_name = SAVED_SESAME[query][1]
    url = f"/api/field/{field_id}/track"
    for name in (query, main_name):
        real = TrackResponse.model_validate(pair.real.get(url, params={"name": name}).json())
        fake = TrackResponse.model_validate(pair.fake.get(url, params={"name": name}).json())
        assert real.name == fake.name == main_name
        assert [item.epoch for item in real.positions] == [item.epoch for item in fake.positions]
        assert [item.epoch for item in real.positions] == [epoch.epoch for epoch in meta.epochs]
        for mine, theirs, epoch in zip(real.positions, fake.positions, meta.epochs, strict=True):
            # La aplicacion real usa la fecha media de la epoca (contrato 4.9); la guardada con la muestra
            # promedia las de cada detector. Unos dias de diferencia son centesimas de pixel.
            assert mine.mjd == round(epoch.mjd_mean, 4)
            assert abs(mine.mjd - theirs.mjd) < 5.0
            assert abs(mine.x - theirs.x) < 0.03 and abs(mine.y - theirs.y) < 0.03
            assert mine.in_field and theirs.in_field
    # Sin movimiento propio, y con coordenadas, los dos responden lo mismo.
    pair.get(url, params={"name": "269.4463 4.7683"})
    # El campo es precalculado: la aplicacion real no guarda nada, ni ahi ni en su cache.
    assert not (settings.cached_fields_dir / field_id).exists()


def test_resolve(servers: tuple[Pair, Settings]) -> None:
    pair, _ = servers
    for query, (_, main_name) in SAVED_SESAME.items():
        if query == "Abell 2218":
            continue  # el servidor falso no tiene esa respuesta
        resolved = pair.get("/api/resolve", params={"name": query})
        assert resolved.json()["name"] == main_name and resolved.json()["query"] == query
        assert pair.get("/api/resolve", params={"name": main_name}).json()["query"] == main_name
    for text in ("269.4463 4.7683", "08h55m10.831s -07d14m42.53s", "  08:55:10.83   -07:14:42.5 ", "269,4463 +4,7683"):
        assert pair.get("/api/resolve", params={"name": text}).json()["source"] == "coordinates"
    # Una `ra` fuera de rango es un error, como la `dec`: no se envuelve.
    for params in ({"name": ""}, {"name": "10 95"}, {"name": "25:00:00 +10:00:00"}, {"name": "629.4463, 4.7683"}, {}):
        assert pair.get("/api/resolve", params=params).status_code == 422, params


def test_errors(servers: tuple[Pair, Settings]) -> None:
    pair, _ = servers
    unknown = "/api/field/ffffffffffffffff"
    for url in ("/meta", "/events", "/plane/1/1", "/cube", "/aux/1/1", "/preview", "/track?name=x"):
        assert pair.get(unknown + url).status_code == 404, url
    assert pair.request("POST", f"{unknown}/priority", json={"band": 3}).status_code == 404
    for body in ({"ra": 10.0, "dec": 100.0}, {"ra": 10.0, "dec": 20.0, "fov": 0.9}, {"ra": "10", "dec": 20.0}, {}):
        assert pair.request("POST", "/api/field", json=body).status_code == 422, body
    assert pair.request("PUT", "/api/field", json={"ra": 10.0, "dec": 20.0}).status_code == 422
    assert pair.get("/api/no-existe").status_code == 404
