"""Precalcula los campos de los objetos de prueba y los deja en backend/data/fields. Usa la red.

Los cinco objetos de prueba (CLAUDE.md) se arman una vez y se guardan en el
repositorio: el backend busca primero ahi y los sirve sin tocar IRSA (contrato,
seccion 11). El script hace lo mismo que el backend cuando llega un campo nuevo,
con el mismo gestor de trabajos, pero escribiendo en `data/fields` en vez de la
cache: resuelve el nombre con Sesame, centra el campo en `field_center` (la
posicion propagada a 2026.0), lo arma en el escalon base (10 minutos) y guarda
con el la trayectoria del objeto, para que `/track` no dependa de Sesame.

Uso, desde backend/:

    uv run python scripts/precompute.py                    # los cinco, de a uno
    uv run python scripts/precompute.py barnard wise0855   # algunos, por su alias
    uv run python scripts/precompute.py "RW Aurigae" --band 6
    uv run python scripts/precompute.py --refresh          # vuelve a listar los que ya estan

Objetos: `barnard` (Barnard's Star), `epsindb` (Epsilon Indi B), `wise0855`
(WISE J085510.83-071442.5), `rwaur` (RW Aurigae) y `rdra` (R Draconis). Cualquier
otro texto se toma como un nombre para Sesame, o como coordenadas.

`--band` es la banda que se construye primero (por defecto 3). Tambien decide
la banda de la vista provisoria de WISE: W2 con 5 o 6, W1 con las demas.

Que hace con cada objeto:

- Si el campo ya esta terminado en `data/fields`, lo deja como esta y solo
  revisa su trayectoria. Con `--refresh` vuelve a listar las exposiciones y
  rehace los planos que cambiaron (mas exposiciones, recortes que antes
  fallaron), subiendo su revision.
- Si el campo esta terminado en la cache de ejecucion (`cache/fields`, porque el
  backend ya lo armo), lo copia a `data/fields` en vez de armarlo de nuevo.
- Si no esta, lo arma. Los recortes quedan en `cache/cutouts`: repetir el script
  despues de un corte no los vuelve a bajar.
- Si el trabajo falla o el script se interrumpe, borra de `data/fields` lo que
  quedo a medio armar. Una carpeta sin terminar ahi taparia al campo que el
  backend arme despues en su cache, porque `data/fields` se busca primero.

Cuidado con IRSA: el limite de 10 descargas en paralelo vale por proceso. No hay
que correr este script mientras el backend esta armando campos, porque cada uno
tendria su propio cupo.

Para armar un campo desde cero hay que borrar su carpeta a mano. Conviene no
hacerlo con un campo que ya se sirvio: las revisiones volverian a empezar en 1 y
un navegador podria conservar planos viejos con la misma URL.

Codigo de salida: 0 si todos los campos quedaron `ready`; 2 si alguno quedo
`partial` (le faltaron recortes: `--refresh` lo completa); 1 si alguno fallo.
"""

from __future__ import annotations

import argparse
import contextlib
import logging
import re
import shutil
import sys
import time
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    # El backend no es un paquete instalable: se importa desde backend/.
    sys.path.insert(0, str(BACKEND_DIR))

from app import geometry  # noqa: E402
from app.api.errors import ApiError  # noqa: E402
from app.config import Settings, get_settings  # noqa: E402
from app.contract import CUBE_PLANE_STATUSES, FINISHED_FIELD_STATUSES, EventName, FieldMeta  # noqa: E402
from app.domain import ResolvedTarget  # noqa: E402
from app.jobs.deps import JobDeps  # noqa: E402
from app.jobs.events import EventBus, FieldEvent  # noqa: E402
from app.jobs.manager import JobManager  # noqa: E402
from app.jobs.store import META_FILENAME, FieldStore, StoreError  # noqa: E402
from app.resolve import service as resolve_service  # noqa: E402

# Alias -> texto que se le pregunta a Sesame. Los cinco objetos de prueba de CLAUDE.md.
TEST_OBJECTS: dict[str, str] = {
    "barnard": "Barnard's Star",
    "epsindb": "Epsilon Indi B",
    "wise0855": "WISE J085510.83-071442.5",
    "rwaur": "RW Aurigae",
    "rdra": "R Draconis",
}

# Escalon base del contrato (seccion 3): 10 minutos, 195 x 195 px.
BASE_FOV = geometry.FOV_STEPS[0].fov

# Archivos del formato de campo en disco (`app/jobs/store.py`), y los temporales de una escritura cortada.
_FIELD_FILE = re.compile(
    r"^(meta\.json|preview\.f32|plane_e\d+_d\d+\.f32|aux_e\d+_d\d+\.bin\.gz|track_[a-z0-9-]+\.json|\..+\.tmp)$"
)

Outcome = Literal["built", "refreshed", "kept", "copied", "failed"]
OUTCOME_TEXT: dict[str, str] = {
    "built": "armado",
    "refreshed": "actualizado",
    "kept": "ya estaba",
    "copied": "copiado de la cache",
    "failed": "fallo",
}

Printer = Callable[[str], None]


def print_line(line: str) -> None:
    """Escribe una linea y la manda enseguida, para ver el avance aunque la salida vaya a un archivo.

    Si la consola no puede escribir algun caracter (el texto de un error del
    sistema, por ejemplo), lo reemplaza en vez de cortar el script.
    """
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        print(line.encode("ascii", "replace").decode("ascii"), flush=True)


@dataclass
class FieldReport:
    """Lo que paso con un objeto."""

    query: str
    outcome: Outcome = "failed"
    name: str | None = None  # nombre principal del catalogo
    field_id: str | None = None
    ra: float | None = None
    dec: float | None = None
    status: str | None = None  # `ready`, `partial` o `failed`
    rev: int = 0
    exposures: int = 0
    epochs: int = 0
    planes: int = 0
    planes_ready: int = 0
    planes_partial: int = 0
    planes_empty: int = 0
    cutouts_failed: int = 0
    cutouts_cached: int = 0
    seconds: float = 0.0  # lo que tardo este script con el objeto
    megabytes: float = 0.0
    track_positions: int | None = None  # `None` si no hay trayectoria guardada
    warnings: dict[str, int] = field(default_factory=dict)
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.status in FINISHED_FIELD_STATUSES


class _ErrorKeepingBus(EventBus):
    """Un bus que ademas se queda con el `error` con el que termino cada trabajo, para poder mostrarlo."""

    def __init__(self) -> None:
        super().__init__()
        self.errors: dict[str, Mapping[str, Any]] = {}

    def publish(self, field_id: str, event: EventName, data: Mapping[str, Any]) -> FieldEvent:
        if event == "error":
            self.errors[field_id] = dict(data.get("error", {}))
        return super().publish(field_id, event, data)


def select_objects(texts: Sequence[str]) -> list[str]:
    """Textos a resolver: cada alias pasa a su nombre y lo demas queda como esta. Sin argumentos, los cinco."""
    if not texts:
        return list(TEST_OBJECTS.values())
    chosen: list[str] = []
    for text in texts:
        query = TEST_OBJECTS.get(text.strip().lower(), " ".join(text.split()))
        if query and query not in chosen:
            chosen.append(query)
    return chosen


# -------------------------------------------------------------------- carpetas


def _same_folder(a: Path, b: Path) -> bool:
    with contextlib.suppress(OSError):
        return a.resolve() == b.resolve()
    return a.absolute() == b.absolute()


def _is_precomputed(store: FieldStore, field_id: str) -> bool:
    """Si el campo que encuentra el almacen esta en `data/fields` (y no en la cache de ejecucion)."""
    folder = store.locate(field_id)
    return folder is not None and _same_folder(folder.parent, store.write_root)


def copy_from_cache(store: FieldStore, field_id: str) -> int:
    """Copia a `data/fields` un campo terminado que esta en la cache de ejecucion. Devuelve cuantos archivos copio.

    `meta.json` va al final: mientras falta, el almacen no ve la carpeta nueva.
    """
    source = store.locate(field_id)
    assert source is not None
    target = store.write_root / field_id
    target.mkdir(parents=True, exist_ok=True)
    names = sorted(path.name for path in source.iterdir() if path.is_file() and _FIELD_FILE.match(path.name))
    names = [name for name in names if not name.endswith(".tmp") and name != META_FILENAME]
    for name in [*names, META_FILENAME]:
        shutil.copyfile(source / name, target / name)
    return len(names) + 1


def remove_unfinished(store: FieldStore, field_id: str) -> bool:
    """Borra de `data/fields` la carpeta de un campo que no quedo terminado. Devuelve si borro algo.

    Solo toca archivos del formato de campo, y la carpeta si queda vacia. Un
    campo terminado no se toca.
    """
    folder = store.write_root / field_id
    if not folder.is_dir():
        return False
    try:
        meta = FieldStore(store.write_root).read_meta(field_id)
        if meta.status in FINISHED_FIELD_STATUSES:
            return False
    except StoreError:
        pass  # sin `meta.json`, o ilegible: tampoco sirve
    removed = False
    for path in folder.iterdir():
        if path.is_file() and _FIELD_FILE.match(path.name):
            with contextlib.suppress(OSError):
                path.unlink()
                removed = True
    with contextlib.suppress(OSError):
        folder.rmdir()
    return removed


def _megabytes(folder: Path | None) -> float:
    if folder is None or not folder.is_dir():
        return 0.0
    return sum(path.stat().st_size for path in folder.iterdir() if path.is_file()) / 1e6


# --------------------------------------------------------------------- avance


def describe_progress(meta: FieldMeta) -> str:
    """Una linea con el avance de un trabajo."""
    progress = meta.progress
    if progress.phase == "queued":
        return "en cola"
    if progress.phase == "listing":
        if (progress.listing_attempt or 1) > 1:
            # IRSA no respondio al listado: el trabajo reintenta solo (`Settings.listing_retry_s`).
            return f"listando exposiciones... IRSA no responde, intento {progress.listing_attempt}"
        return "listando exposiciones..."
    return (
        f"recortes {progress.cutouts_done + progress.cutouts_failed}/{progress.cutouts_total} "
        f"({progress.cutouts_failed} fallidos, {progress.cutouts_cached} de la cache), "
        f"planos {progress.planes_ready}/{progress.planes_total}, {progress.elapsed_s:.0f} s"
    )


def describe_listing(meta: FieldMeta) -> str | None:
    """Una linea con lo que dio la lista de exposiciones, o `None` si el campo todavia no la tiene."""
    if meta.epochs is None or meta.planes is None:
        return None
    without = sum(1 for plane in meta.planes if plane.n_exposures == 0)
    return (
        f"{meta.progress.cutouts_total} exposiciones en {len(meta.epochs)} epocas, "
        f"{len(meta.planes)} planos ({without} sin exposiciones)"
    )


def _follow(
    manager: JobManager, field_id: str, out: Printer, *, poll_s: float, report_every_s: float, silent: bool
) -> bool:
    """Espera a que el gestor quede sin trabajo, mostrando el avance cada `report_every_s` segundos.

    `silent` es un `refresh`: el trabajo no publica su documento, asi que solo se
    muestra cuantos recortes le falta pedir. Devuelve si llego a mostrar lo que
    dio la lista de exposiciones.
    """
    last_line, last_time, listed = "", time.perf_counter(), False
    while not manager.wait_idle(poll_s):
        if silent:
            pending = manager.queue_state().pending_cutouts.get(field_id)
            line = "listando exposiciones..." if pending is None else f"faltan pedir {pending} recortes"
        else:
            try:
                meta = manager.get_meta(field_id)
            except ApiError:
                continue
            listing = None if listed else describe_listing(meta)
            if listing is not None:
                listed = True
                out(f"      {listing}")
            line = describe_progress(meta)
        now = time.perf_counter()
        if line != last_line and (now - last_time >= report_every_s or not last_line):
            out(f"      {line}")
            last_line, last_time = line, now
    return listed


# ---------------------------------------------------------------------- campo


def _fill_report(report: FieldReport, meta: FieldMeta, store: FieldStore) -> None:
    planes = meta.planes or []
    report.status = meta.status
    report.rev = meta.rev
    report.exposures = meta.progress.cutouts_total
    report.epochs = len(meta.epochs or [])
    report.planes = len(planes)
    report.planes_ready = sum(1 for plane in planes if plane.status == "ready")
    report.planes_partial = sum(1 for plane in planes if plane.status == "partial")
    report.planes_empty = sum(1 for plane in planes if plane.status not in CUBE_PLANE_STATUSES)
    report.cutouts_failed = meta.progress.cutouts_failed
    report.cutouts_cached = meta.progress.cutouts_cached
    report.warnings = dict(Counter(warning.code for warning in meta.warnings))
    report.megabytes = _megabytes(store.locate(meta.id))


def save_track(store: FieldStore, meta: FieldMeta, target: ResolvedTarget) -> int | None:
    """Guarda con el campo la trayectoria del objeto (contrato 4.9). Devuelve cuantas posiciones tiene.

    Unas coordenadas no tienen nombre ni movimiento: no se guarda nada.
    """
    if target.source != "sesame" or meta.grid is None or meta.epochs is None:
        return None
    track = resolve_service.build_track_response(
        target, resolve_service.epoch_summaries(meta.epochs), geometry.grid_from_info(meta.grid)
    )
    if store.read_track(meta.id, track.name) != track:
        store.write_track(meta.id, track)
    return len(track.positions)


def precompute_object(
    query: str,
    manager: JobManager,
    bus: _ErrorKeepingBus,
    settings: Settings,
    out: Printer,
    *,
    band: int,
    refresh: bool,
    poll_s: float,
    report_every_s: float,
) -> FieldReport:
    """Deja en `data/fields` el campo de un objeto. No lanza excepciones por lo que falle de ese objeto."""
    report = FieldReport(query=query)
    store = manager.store
    started = time.perf_counter()
    try:
        target = resolve_service.resolve_target(query, settings)
        resolved = resolve_service.build_resolve_response(target, settings.field_epoch)
        center = resolved.field_center
        request = geometry.normalize_request(
            center.ra, center.dec, BASE_FOV, band, refresh, pipeline=settings.pipeline_version
        )
        report.name, report.field_id, report.ra, report.dec = target.name, request.field_id, request.ra, request.dec
        moved = f', se movio {resolved.moved_arcsec:.1f}" desde J2000' if resolved.motion is not None else ""
        out(
            f"      {target.name or query}: centro {request.ra:.4f} {request.dec:+.4f} "
            f"({center.epoch:.1f}{moved}), campo {request.field_id}"
        )
        if target.name and target.name != target.query and target.source == "sesame":
            # El frontend lleva en el link el nombre principal y vuelve a preguntar por el: que quede en la cache.
            try:
                resolve_service.resolve_target(target.name, settings)
            except ApiError as exc:
                out(f"      aviso: Sesame no resolvio el nombre principal {target.name!r}: {exc.message}")

        # Un resto sin terminar de otra corrida taparia al campo: se borra antes de mirar si ya esta.
        if remove_unfinished(store, request.field_id):
            out("      se borro un resto sin terminar de una corrida anterior")
        before: FieldMeta | None = None
        with contextlib.suppress(ApiError):
            before = manager.get_meta(request.field_id)
        existed = before is not None and before.status in FINISHED_FIELD_STATUSES
        if existed and not _is_precomputed(store, request.field_id):
            copied = copy_from_cache(store, request.field_id)
            report.outcome = "copied"
            out(f"      estaba terminado en la cache de ejecucion: {copied} archivos copiados a {store.write_root}")
        elif existed:
            report.outcome = "kept"

        manager.submit(request)
        listed = existed
        if not existed or refresh:
            if existed:
                out("      refresh: se vuelven a listar las exposiciones")
            listed = _follow(
                manager, request.field_id, out, poll_s=poll_s, report_every_s=report_every_s, silent=existed
            )
        meta = manager.get_meta(request.field_id)
        listing = describe_listing(meta)
        if listing is not None and not listed:
            out(f"      {listing}")  # el trabajo termino antes de la primera mirada
        if meta.status not in FINISHED_FIELD_STATUSES:
            error = bus.errors.get(request.field_id, {})
            report.status = "failed"
            report.error = f"{error.get('code', 'sin codigo')}: {error.get('message', 'el trabajo no termino')}"
            remove_unfinished(store, request.field_id)
            return report
        if not existed:
            report.outcome = "built"
        elif refresh and before is not None and meta.rev != before.rev:
            report.outcome = "refreshed"
        _fill_report(report, meta, store)
        report.track_positions = save_track(store, meta, target)
        report.megabytes = _megabytes(store.locate(meta.id))
    except ApiError as exc:
        report.status, report.error = "failed", f"{exc.code}: {exc.message}"
    except (StoreError, OSError) as exc:
        report.status, report.error = "failed", f"{type(exc).__name__}: {exc}"
    finally:
        report.seconds = time.perf_counter() - started
    return report


def describe_report(report: FieldReport) -> str:
    """Una linea con lo que quedo de un objeto."""
    if not report.ok:
        return f"FALLO: {report.error}"
    track = "sin trayectoria" if report.track_positions is None else f"trayectoria de {report.track_positions}"
    warnings = ", ".join(f"{code} x{count}" for code, count in sorted(report.warnings.items())) or "ninguno"
    return (
        f"{OUTCOME_TEXT[report.outcome]}: {report.status} (rev {report.rev}) en {report.seconds:.1f} s; "
        f"{report.exposures} exposiciones, {report.epochs} epocas, {report.planes} planos "
        f"({report.planes_ready} completos, {report.planes_partial} parciales, {report.planes_empty} vacios), "
        f"{report.cutouts_failed} recortes fallidos; {track}; {report.megabytes:.1f} MB; avisos: {warnings}"
    )


def precompute(
    queries: Sequence[str],
    settings: Settings,
    *,
    band: int = 3,
    refresh: bool = False,
    deps: JobDeps | None = None,
    out: Printer = print_line,
    poll_s: float = 1.0,
    report_every_s: float = 5.0,
) -> list[FieldReport]:
    """Arma, de a uno, el campo de cada objeto en `settings.precomputed_fields_dir`.

    `deps` reemplaza las funciones externas del gestor (IRSA, hips2fits,
    pipeline), para los tests. Devuelve un informe por objeto, en el orden pedido.
    """
    store = FieldStore.from_settings(settings, write_precomputed=True)
    bus = _ErrorKeepingBus()
    manager = JobManager(settings, store, bus, deps)
    reports: list[FieldReport] = []
    try:
        for number, query in enumerate(queries, start=1):
            out(f"[{number}/{len(queries)}] {query}")
            report = precompute_object(
                query, manager, bus, settings, out, band=band, refresh=refresh, poll_s=poll_s,
                report_every_s=report_every_s,
            )  # fmt: skip
            reports.append(report)
            out(f"      {describe_report(report)}")
    finally:
        manager.shutdown()
        # Si se interrumpio a mitad de un campo, lo que quedo sin terminar no puede quedar en `data/fields`.
        for field_id in store.list_ids():
            if (store.write_root / field_id).is_dir() and remove_unfinished(store, field_id):
                out(f"se borro el campo sin terminar {field_id}")
    return reports


def summary_lines(reports: Sequence[FieldReport]) -> list[str]:
    """Tabla final: una fila por objeto."""
    header = (
        f"{'objeto':<26} {'campo':<16} {'resultado':<19} {'estado':<8} {'expos':>5} {'epocas':>6} "
        f"{'planos ok/parc/vacios':>21} {'fallidos':>8} {'tiempo':>8}"
    )
    lines = [header, "-" * len(header)]
    for report in reports:
        planes = f"{report.planes_ready}/{report.planes_partial}/{report.planes_empty}" if report.ok else "-"
        lines.append(
            f"{report.query[:26]:<26} {report.field_id or '-':<16} {OUTCOME_TEXT[report.outcome]:<19} "
            f"{report.status or '-':<8} {report.exposures:>5} {report.epochs:>6} {planes:>21} "
            f"{report.cutouts_failed:>8} {report.seconds:>6.1f} s"
        )
        if report.error:
            lines.append(f"    {report.error}")
    return lines


def exit_code(reports: Sequence[FieldReport]) -> int:
    if any(not report.ok for report in reports):
        return 1
    return 2 if any(report.status == "partial" for report in reports) else 0


def main(
    argv: Sequence[str] | None = None,
    *,
    settings: Settings | None = None,
    deps: JobDeps | None = None,
    out: Printer = print_line,
) -> int:
    parser = argparse.ArgumentParser(
        description="Precalcula los campos de los objetos de prueba en backend/data/fields. Usa la red (IRSA y CDS).",
        epilog="Alias: " + ", ".join(f"{alias} ({name})" for alias, name in TEST_OBJECTS.items()),
    )
    parser.add_argument("objects", nargs="*", help="alias o nombres de los objetos; por defecto, los cinco de prueba")
    parser.add_argument("--band", type=int, default=3, choices=range(1, 7), help="banda que se construye primero (3)")
    parser.add_argument(
        "--refresh", action="store_true", help="vuelve a listar las exposiciones de los campos que ya estan"
    )
    parser.add_argument("--report-every", type=float, default=5.0, help="segundos entre lineas de avance (5)")
    args = parser.parse_args(argv)

    settings = get_settings() if settings is None else settings
    queries = select_objects(args.objects)
    out(f"Campos precalculados en {settings.precomputed_fields_dir} (pipeline {settings.pipeline_version})")
    out(f"Recortes en {settings.cutout_cache_dir}; banda inicial {args.band}; {len(queries)} objetos")
    started = time.perf_counter()
    try:
        reports = precompute(
            queries, settings, band=args.band, refresh=args.refresh, deps=deps, out=out,
            report_every_s=args.report_every,
        )  # fmt: skip
    except KeyboardInterrupt:
        out("interrumpido")
        return 130
    out("")
    for line in summary_lines(reports):
        out(line)
    out(f"Total: {time.perf_counter() - started:.1f} s")
    return exit_code(reports)


if __name__ == "__main__":
    # Los avisos del backend (un servidor que no responde, un recorte perdido) van a la salida de errores.
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
    raise SystemExit(main())
