"""El script de precalculo (scripts/precompute.py), con IRSA, hips2fits y el pipeline reemplazados. Sin red.

Los nombres salen de una cache de Sesame sembrada con las respuestas guardadas
de los cinco objetos de prueba, y la configuracion no tiene servidores de
Sesame. Los campos se arman en un `data/fields` temporal.
"""

from __future__ import annotations

import importlib.util
import itertools
import sys
import threading
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from fastapi.testclient import TestClient
from test_api_support import SAVED_SESAME, fake_deps, seed_sesame
from test_jobs_support import (
    SHAPE,
    Harness,
    HarnessFactory,
    harness_factory,
    make_exposures,
    manager_threads,
    wait_until,
)

from app import geometry
from app.api.main import create_app
from app.contract import FieldMeta, TrackResponse
from app.irsa.cutouts import IrsaPermanent, IrsaTransient
from app.jobs.store import FieldStore, track_filename

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "precompute.py"

# Centro del campo de cada objeto de prueba: su `field_center` en 2026.0 (tests/test_resolve_service.py).
CENTERS = {
    "Barnard's Star": (269.4463, 4.7683),
    "Epsilon Indi B": (331.0966, -56.8006),
    "WISE J085510.83-071442.5": (133.7598, -7.2422),
    "RW Aurigae": (76.9566, 30.4013),
    "R Draconis": (248.1672, 66.7550),
}
COUNTS = {(1, 3): 2, (2, 3): 2, (1, 6): 2}


@pytest.fixture(scope="module")
def script() -> ModuleType:
    """El script, cargado como modulo (scripts/ no es un paquete)."""
    spec = importlib.util.spec_from_file_location("precompute_script", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def build(tmp_path: Path) -> Iterator[HarnessFactory]:
    with harness_factory(tmp_path) as factory:
        yield factory


def field_id_of(query: str) -> str:
    return geometry.field_id(*CENTERS[query], 0.1667)


def prepare(build: HarnessFactory, **options: Any) -> Harness:
    """Piezas de mentira y configuracion para una corrida del script. El gestor del `Harness` no se usa."""
    harness = build(COUNTS, sesame_urls=(), **options)
    seed_sesame(harness.settings)
    fields = harness.settings.precomputed_fields_dir

    def settle_preview(ra: float, dec: float) -> None:
        # La lista no vuelve hasta que la vista provisoria quedo guardada: asi nunca llega tarde.
        if harness.preview.mode == "ready":
            folder = fields / geometry.normalize_request(ra, dec).field_id
            wait_until(lambda: (folder / "preview.f32").is_file(), 5.0, "la vista provisoria no se guardo")

    harness.irsa.before_list = settle_preview
    return harness


def run(script: ModuleType, harness: Harness, *args: str) -> tuple[int, list[str]]:
    lines: list[str] = []
    code = script.main(
        [*args, "--report-every", "0"], settings=harness.settings, deps=fake_deps(harness), out=lines.append
    )
    return code, lines


def stored(harness: Harness, query: str) -> FieldMeta:
    return FieldStore(harness.settings.precomputed_fields_dir).read_meta(field_id_of(query))


# ------------------------------------------------------------------- objetos


def test_objects_can_be_chosen_by_alias_or_by_name(script: ModuleType) -> None:
    assert script.select_objects([]) == list(CENTERS)  # sin argumentos, los cinco de CLAUDE.md
    assert script.select_objects(["barnard", "WISE0855"]) == ["Barnard's Star", "WISE J085510.83-071442.5"]
    assert script.select_objects(["rdra", "R Draconis", "rdra"]) == ["R Draconis"]
    assert script.select_objects(["  M   87 ", "269.4463 4.7683"]) == ["M 87", "269.4463 4.7683"]
    assert sorted(script.TEST_OBJECTS.values()) == sorted(CENTERS)


# ------------------------------------------------------------ los cinco campos


def test_the_five_test_objects_are_built_one_at_a_time(script: ModuleType, build: HarnessFactory) -> None:
    harness = prepare(build, max_cutout_downloads=1)  # una sola conexion: los recortes se piden en orden
    code, lines = run(script, harness, "--band", "6")
    text = "\n".join(lines)
    assert code == 0, text
    fields = harness.settings.precomputed_fields_dir
    store = FieldStore(fields)
    assert store.list_ids() == sorted(field_id_of(query) for query in CENTERS)
    assert not harness.settings.cached_fields_dir.exists()  # nada en la cache de ejecucion

    for query, (ra, dec) in CENTERS.items():
        meta = stored(harness, query)
        # Centrado en `field_center` (la posicion de 2026.0), en el escalon base.
        assert meta.request.model_dump() == {"ra": ra, "dec": dec, "fov": 0.1667}
        assert meta.grid is not None and meta.grid.shape == SHAPE
        assert (meta.status, meta.rev, meta.pipeline) == ("ready", 1, harness.settings.pipeline_version)
        assert meta.planes is not None and meta.epochs is not None and len(meta.epochs) == 2
        with_data = [(plane.epoch, plane.detector) for plane in meta.planes if plane.status == "ready"]
        assert with_data == [(1, 3), (1, 6), (2, 3)]
        folder = fields / meta.id
        for epoch, detector in with_data:
            assert (folder / f"plane_e{epoch}_d{detector}.f32").stat().st_size == 4 * SHAPE[0] * SHAPE[1]
            assert (folder / f"aux_e{epoch}_d{detector}.bin.gz").is_file()
        # La banda inicial decide la de la vista provisoria (contrato 4.10).
        assert (meta.preview.status, meta.preview.band) == ("ready", "W2")
        assert (folder / "preview.f32").is_file()
        # La trayectoria del objeto, guardada bajo su nombre principal, con una posicion por epoca.
        main_name = SAVED_SESAME[query][1]
        track = store.read_track(meta.id, main_name)
        assert track is not None and track.name == main_name
        assert [(item.epoch, item.mjd) for item in track.positions] == [
            (epoch.epoch, round(epoch.mjd_mean, 4)) for epoch in meta.epochs
        ]
        assert all(item.in_field for item in track.positions)
        assert sorted(path.name for path in folder.iterdir() if not path.name.startswith(("plane_", "aux_"))) == [
            "meta.json", "preview.f32", track_filename(main_name),
        ]  # fmt: skip

    # De a uno, en el orden pedido: los pedidos de un campo no se mezclan con los de otro.
    assert harness.irsa.list_calls == [False] * 5
    assert [center for center, _ in itertools.groupby(harness.irsa.centers)] == list(CENTERS.values())
    # Dentro de cada campo, primero la banda pedida.
    assert harness.irsa.first_calls()[:2] == ["E1D6N0", "E1D6N1"]
    assert not manager_threads()  # el gestor del script quedo detenido

    # La salida: el avance de cada campo y un resumen final por objeto.
    for number, query in enumerate(CENTERS, start=1):
        assert f"[{number}/5] {query}" in lines
    assert text.count("6 exposiciones en 2 epocas, 12 planos (9 sin exposiciones)") == 5
    assert text.count("armado: ready (rev 1)") == 5
    assert "NAME Barnard's star: centro 269.4463 +4.7683 (2026.0, se movio 270.4\" desde J2000)" in text
    assert "3 completos, 0 parciales, 9 vacios), 0 recortes fallidos; trayectoria de 2" in text
    summary = lines[lines.index("") + 1 :]
    assert summary[0].split() == [
        "objeto", "campo", "resultado", "estado", "expos", "epocas", "planos", "ok/parc/vacios", "fallidos", "tiempo",
    ]  # fmt: skip
    rows = [line for line in summary if "armado" in line]
    assert len(rows) == 5 and all("ready" in row and "3/0/9" in row for row in rows)
    assert field_id_of("R Draconis") in rows[4] and rows[4].startswith("R Draconis")
    assert summary[-1].startswith("Total: ")


def test_the_backend_serves_what_the_script_left_without_irsa_or_sesame(
    script: ModuleType, build: HarnessFactory
) -> None:
    harness = prepare(build)
    assert run(script, harness, "barnard")[0] == 0
    calls = len(harness.irsa.calls)
    # Otra maquina: ni la cache de Sesame ni la de recortes; solo `data/fields`.
    for path in harness.settings.sesame_cache_dir.iterdir():
        path.unlink()
    harness.irsa.list_error = IrsaTransient("IRSA no deberia consultarse")
    with TestClient(create_app(harness.settings, deps=fake_deps(harness))) as client:
        posted = client.post("/api/field", json={"ra": 269.4463, "dec": 4.7683})
        assert posted.status_code == 200 and posted.json()["status"] == "ready"
        field_id = posted.json()["id"]
        assert field_id == field_id_of("Barnard's Star")
        meta = FieldMeta.model_validate(posted.json()["meta"])
        assert meta == stored(harness, "Barnard's Star")
        assert client.get(f"/api/field/{field_id}/plane/1/3", params={"rev": 2}).status_code == 200
        assert len(client.get(f"/api/field/{field_id}/cube").content) == 3 * 4 * SHAPE[0] * SHAPE[1]
        # El frontend pide la trayectoria con el nombre principal, que es el que lleva en el link.
        track = client.get(f"/api/field/{field_id}/track", params={"name": "NAME Barnard's star"})
        assert track.status_code == 200
        assert len(TrackResponse.model_validate(track.json()).positions) == 2
        # `refresh` sobre un campo precalculado no hace nada (contrato, seccion 11): se regenera con el script.
        again = client.post("/api/field", json={"ra": 269.4463, "dec": 4.7683, "refresh": True})
        assert again.status_code == 200
    assert len(harness.irsa.calls) == calls and harness.irsa.list_calls == [False]
    assert not harness.settings.cached_fields_dir.exists()


def test_a_second_run_keeps_what_is_already_there(script: ModuleType, build: HarnessFactory) -> None:
    harness = prepare(build)
    assert run(script, harness, "barnard", "rdra")[0] == 0
    folder = harness.settings.precomputed_fields_dir / field_id_of("Barnard's Star")
    before = {path.name: path.stat().st_mtime_ns for path in folder.iterdir()}
    calls = len(harness.irsa.calls)

    code, lines = run(script, harness, "barnard", "rdra")
    assert code == 0
    assert "\n".join(lines).count("ya estaba: ready (rev 1)") == 2
    assert len(harness.irsa.calls) == calls and harness.irsa.list_calls == [False, False]
    assert {path.name: path.stat().st_mtime_ns for path in folder.iterdir()} == before

    # Si falta la trayectoria, la vuelve a dejar.
    (folder / track_filename("NAME Barnard's star")).unlink()
    assert run(script, harness, "barnard")[0] == 0
    assert (folder / track_filename("NAME Barnard's star")).is_file()


def test_refresh_rebuilds_the_planes_that_changed(script: ModuleType, build: HarnessFactory) -> None:
    harness = prepare(build)
    assert run(script, harness, "barnard")[0] == 0
    # Sin exposiciones nuevas, `--refresh` vuelve a listar y deja todo como estaba.
    code, lines = run(script, harness, "barnard", "--refresh")
    assert code == 0 and "ya estaba: ready (rev 1)" in "\n".join(lines)
    assert harness.irsa.list_calls == [False, True]

    # Aparece una epoca nueva: el campo sube de revision y la trayectoria suma su posicion.
    harness.irsa.exposures = make_exposures({**COUNTS, (3, 3): 2})
    code, lines = run(script, harness, "barnard", "--refresh")
    assert code == 0 and "actualizado: ready (rev 2)" in "\n".join(lines)
    meta = stored(harness, "Barnard's Star")
    assert meta.rev == 2 and meta.epochs is not None and len(meta.epochs) == 3
    track = FieldStore(harness.settings.precomputed_fields_dir).read_track(meta.id, "NAME Barnard's star")
    assert track is not None and [item.epoch for item in track.positions] == [1, 2, 3]
    assert not harness.settings.cached_fields_dir.exists()


def test_a_partial_field_is_reported_and_refresh_completes_it(script: ModuleType, build: HarnessFactory) -> None:
    harness = prepare(build)
    harness.irsa.script["E1D3N1"] = [IrsaPermanent("422 Arrays do not overlap (simulado)")]
    code, lines = run(script, harness, "rwaur")
    text = "\n".join(lines)
    assert code == 2  # quedo `partial`
    assert "armado: partial (rev 1)" in text and "2 completos, 1 parciales, 9 vacios), 1 recortes fallidos" in text
    assert "cutouts_failed x1" in text
    assert stored(harness, "RW Aurigae").status == "partial"
    # El recorte ahora baja: `--refresh` completa el campo.
    code, lines = run(script, harness, "rwaur", "--refresh")
    assert code == 0 and "actualizado: ready (rev 2)" in "\n".join(lines)
    assert stored(harness, "RW Aurigae").progress.cutouts_failed == 0


# ------------------------------------------------------------------- fallas


def test_a_failed_job_leaves_nothing_in_data_fields_and_the_others_go_on(
    script: ModuleType, build: HarnessFactory
) -> None:
    harness = prepare(build)
    # El primer objeto falla despues de armar un plano (falla interna al procesar el tercer recorte).
    harness.pipeline.fail_at = 3
    code, lines = run(script, harness, "barnard", "Objeto Sin Resolver", "epsindb")
    text = "\n".join(lines)
    assert code == 1
    fields = harness.settings.precomputed_fields_dir
    # Lo que quedo a medio armar se borro: una carpeta sin terminar ahi taparia al campo de la cache.
    assert not (fields / field_id_of("Barnard's Star")).exists()
    assert "FALLO: upstream_unavailable: falla interna al armar el campo" in text
    # Un nombre que Sesame no puede resolver no frena a los demas.
    assert "FALLO: upstream_unavailable: Sesame no responde" in text
    assert stored(harness, "Epsilon Indi B").status == "ready"
    assert FieldStore(fields).list_ids() == [field_id_of("Epsilon Indi B")]
    summary = lines[lines.index("") + 1 :]
    assert [line.split()[0] for line in summary if "fallo" in line] == ["Barnard's", "Objeto"]
    assert not manager_threads()


def test_a_point_without_coverage(script: ModuleType, build: HarnessFactory) -> None:
    harness = prepare(build)
    harness.irsa.exposures = []
    code, lines = run(script, harness, "10.0 20.0")
    assert code == 1 and "FALLO: no_coverage: " in "\n".join(lines)
    assert FieldStore(harness.settings.precomputed_fields_dir).list_ids() == []
    assert not (harness.settings.precomputed_fields_dir / geometry.field_id(10.0, 20.0, 0.1667)).exists()


def test_coordinates_build_a_field_without_a_track(script: ModuleType, build: HarnessFactory) -> None:
    harness = prepare(build)
    code, lines = run(script, harness, "269.4463 4.7683")
    assert code == 0 and "sin trayectoria" in "\n".join(lines)
    folder = harness.settings.precomputed_fields_dir / field_id_of("Barnard's Star")
    assert (folder / "meta.json").is_file() and list(folder.glob("track_*.json")) == []


def test_an_unfinished_leftover_is_removed_and_built_again(script: ModuleType, build: HarnessFactory) -> None:
    harness = prepare(build)
    assert run(script, harness, "barnard")[0] == 0
    # Un resto de otra corrida: el documento dice que el campo quedo a medio bajar.
    store = FieldStore(harness.settings.precomputed_fields_dir)
    meta = stored(harness, "Barnard's Star")
    store.write_meta(meta.model_copy(update={"status": "downloading", "rev": 0}))
    (harness.settings.precomputed_fields_dir / meta.id / "nota.txt").write_text("no es del script", encoding="utf-8")
    calls = len(harness.irsa.calls)

    code, lines = run(script, harness, "barnard")
    assert code == 0 and "se borro un resto sin terminar de una corrida anterior" in "\n".join(lines)
    assert "armado: ready (rev 1)" in "\n".join(lines)
    assert len(harness.irsa.calls) == calls + 6
    assert stored(harness, "Barnard's Star").status == "ready"
    assert (harness.settings.precomputed_fields_dir / meta.id / "nota.txt").is_file()  # lo ajeno no se toca


def test_a_field_already_in_the_runtime_cache_is_copied(script: ModuleType, build: HarnessFactory) -> None:
    harness = prepare(build)
    # El backend ya armo el campo de Barnard: esta en cache/fields.
    harness.irsa.before_list = None
    built = harness.run(harness.request(*CENTERS["Barnard's Star"]))
    source = harness.settings.cached_fields_dir / built.id
    assert built.status == "ready" and source.is_dir()
    calls = len(harness.irsa.calls)

    code, lines = run(script, harness, "barnard")
    assert code == 0 and "copiado de la cache: ready (rev 1)" in "\n".join(lines)
    assert len(harness.irsa.calls) == calls  # sin volver a bajar nada
    target = harness.settings.precomputed_fields_dir / built.id
    copied = {path.name: path.read_bytes() for path in target.iterdir()}
    assert {name: data for name, data in copied.items() if not name.startswith("track_")} == {
        path.name: path.read_bytes() for path in source.iterdir()
    }
    assert track_filename("NAME Barnard's star") in copied
    assert stored(harness, "Barnard's Star") == built


def test_an_interrupted_run_stops_the_manager_and_cleans_up(script: ModuleType, build: HarnessFactory) -> None:
    harness = prepare(build)
    lines: list[str] = []

    def out(line: str) -> None:
        lines.append(line)
        if "exposiciones en 2 epocas" in line and "[2/2] R Draconis" in lines:
            # Ctrl+C a mitad del segundo campo. Las descargas retenidas vuelven un momento despues.
            threading.Timer(0.3, harness.irsa.resume.set).start()
            raise KeyboardInterrupt

    harness.irsa.hold_after = 8  # el segundo campo no puede terminar: sus descargas quedan retenidas
    code = script.main(
        ["barnard", "rdra", "--report-every", "0"], settings=harness.settings, deps=fake_deps(harness), out=out
    )
    assert code == 130 and lines[-1] == "interrumpido"
    fields = harness.settings.precomputed_fields_dir
    # El primero quedo; del segundo, a medio armar, no queda nada.
    assert FieldStore(fields).list_ids() == [field_id_of("Barnard's Star")]
    assert not (fields / field_id_of("R Draconis")).exists()
    assert f"se borro el campo sin terminar {field_id_of('R Draconis')}" in lines
    wait_until(lambda: not manager_threads(), 10.0, f"quedaron hilos del gestor: {manager_threads()}")


def test_errors_of_the_command_line(script: ModuleType, build: HarnessFactory) -> None:
    harness = prepare(build)
    for arguments in (["--band", "7"], ["--band", "tres"], ["--otra"]):
        with pytest.raises(SystemExit) as caught:
            script.main(arguments, settings=harness.settings, deps=fake_deps(harness), out=lambda _: None)
        assert caught.value.code == 2
    assert harness.irsa.list_calls == []
