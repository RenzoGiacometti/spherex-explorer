"""Configuracion comun de los tests. Ningun test usa la red.

Tambien arma los campos sinteticos con los que se prueba el servidor falso:
chicos (23 x 23 px), con el mismo formato en disco que un campo real.
"""

from __future__ import annotations

import socket
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pytest
from astropy.utils import iers

from app import geometry
from app.contract import (
    CutoutsFailedWarning,
    DetectorInfo,
    EpochInfo,
    FieldMeta,
    FieldRequestInfo,
    FlagInfo,
    FullDownloadWarning,
    LowCoverageWarning,
    PlaneEmptyWarning,
    PlaneInfo,
    PlaneRef,
    PreviewInfo,
    Progress,
    Provenance,
    SaturatedSourceWarning,
    TrackPosition,
    TrackResponse,
)
from app.jobs.store import FieldStore, with_cube_offsets
from app.pipeline.stats import detector_display, plane_stats, saturated_regions

# astropy no tiene que salir a buscar tablas de rotacion terrestre durante los tests.
iers.conf.auto_download = False

_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


@pytest.fixture(autouse=True, scope="session")
def _no_network() -> Iterator[None]:
    """Hace fallar cualquier conexion que no sea local (el bucle de asyncio usa un par de sockets locales)."""
    original = socket.socket.connect

    def guarded(self: socket.socket, address: object) -> None:
        host = address[0] if isinstance(address, tuple) and address else address
        if isinstance(host, str) and host not in _LOOPBACK:
            raise RuntimeError(f"los tests no usan la red: intento de conexion a {address!r}")
        original(self, address)  # type: ignore[arg-type]

    socket.socket.connect = guarded  # type: ignore[method-assign]
    try:
        yield
    finally:
        socket.socket.connect = original  # type: ignore[method-assign]


# ------------------------------------------------------------ campos sinteticos

Key = tuple[int, int]  # (epoca, detector)

# Pipeline de los campos sinteticos. Como el de las muestras del repositorio, no es
# el del backend real: el servidor falso solo marca `immutable` lo que no comparte
# `id` con un campo real.
TEST_PIPELINE = "prueba"

_EPOCHS = [
    EpochInfo(
        epoch=1, start="2025-08-15", end="2025-10-01", mjd_start=60902.86, mjd_end=60949.31, mjd_mean=60914.9,
        n_exposures=0,
    ),
    EpochInfo(
        epoch=2, start="2026-03-11", end="2026-05-05", mjd_start=61110.2, mjd_end=61165.6, mjd_mean=61130.0,
        n_exposures=0,
    ),
]  # fmt: skip


@dataclass
class SampleField:
    """Un campo sintetico guardado en disco, con sus arreglos para comparar."""

    meta: FieldMeta
    images: dict[Key, np.ndarray] = field(default_factory=dict)
    flags: dict[Key, np.ndarray] = field(default_factory=dict)
    coverage: dict[Key, np.ndarray] = field(default_factory=dict)
    preview: np.ndarray | None = None
    track: TrackResponse | None = None

    @property
    def id(self) -> str:
        return self.meta.id

    @property
    def shape(self) -> tuple[int, int]:
        assert self.meta.grid is not None
        return self.meta.grid.shape

    @property
    def plane_nbytes(self) -> int:
        return 4 * self.shape[0] * self.shape[1]

    @property
    def data_keys(self) -> list[Key]:
        """Planos con datos, en el orden de `planes`."""
        return [(plane.epoch, plane.detector) for plane in self.meta.planes or () if plane.status != "empty"]


def build_sample_field(
    root: Path,
    ra: float,
    dec: float,
    *,
    n_epochs: int = 2,
    empty: tuple[Key, ...] = (),
    unusable: tuple[Key, ...] = (),
    partial: tuple[Key, ...] = (),
    with_preview: bool = True,
    track_name: str | None = None,
    seed: int = 1,
    pipeline: str = TEST_PIPELINE,
    plane_rev: int = 2,
) -> SampleField:
    """Escribe en `root` un campo terminado de 23 x 23 px y devuelve lo que se guardo.

    `empty` son planos sin exposiciones; `unusable`, planos que tenian
    exposiciones y ninguna sirvio; `partial`, planos a los que les falto un recorte.

    `plane_rev` es la revision de los planos con datos: 2 si tuvieron una
    provisoria antes (lo normal) o 1 si se emitieron una sola vez. El campo es
    mas chico que cualquier escalon del contrato, para que los tests sean
    rapidos: `request.fov` vale 0.02, que como pedido se normaliza al escalon base.
    """
    grid = geometry.make_grid(ra, dec, 0.02, 3.075)
    shape = grid.shape
    field_id = geometry.field_id(ra, dec, 0.02, pipeline)
    rng = np.random.default_rng(seed)
    yy, xx = np.indices(shape)
    star = 5.0 * np.exp(-((xx - 11) ** 2 + (yy - 11) ** 2) / 4.0)

    sample = SampleField(meta=None)  # type: ignore[arg-type]
    planes: list[PlaneInfo] = []
    warnings: list[object] = []
    for epoch in range(1, n_epochs + 1):
        for detector in range(1, 7):
            key = (epoch, detector)
            if key in empty or key in unusable:
                lost = 3 if key in unusable else 0
                # Pasar de pendiente a vacio al procesar las exposiciones es una revision; sin exposiciones, no.
                planes.append(
                    PlaneInfo(
                        epoch=epoch,
                        detector=detector,
                        status="empty",
                        rev=1 if lost else 0,
                        n_exposures=lost,
                        n_failed=lost,
                    )
                )
                warnings.append(PlaneEmptyWarning(epoch=epoch, detector=detector))
                continue
            image = (rng.normal(0.0, 0.05, shape) + star).astype(np.float32)
            image[0:2, 0:3] = np.nan  # una esquina sin datos
            if detector == 3:
                image[10:13, 10:13] = np.inf  # nucleo saturado, 9 pixeles
            n = 8 + detector
            failed = 1 if key in partial else 0
            flags = np.where(np.isposinf(image), 2, 0).astype(np.uint32)  # bit 1: OVERFLOW
            coverage = np.where(np.isfinite(image), n - failed, 0).astype(np.uint16)
            planes.append(
                PlaneInfo(
                    epoch=epoch,
                    detector=detector,
                    status="partial" if failed else "ready",
                    rev=plane_rev,
                    n_exposures=n,
                    n_used=n - failed,
                    n_failed=failed,
                    mjd_mean=_EPOCHS[epoch - 1].mjd_mean,
                    stats=plane_stats(image),
                    saturated=saturated_regions(image),
                )
            )
            sample.images[key], sample.flags[key], sample.coverage[key] = image, flags, coverage

    warnings.append(
        SaturatedSourceWarning(ra=ra, dec=dec, radius_arcsec=5.2, epochs=list(range(1, n_epochs + 1)), detectors=[3])
    )
    warnings.append(LowCoverageWarning(epoch=1, detector=5, valid_fraction=0.85))
    warnings.append(FullDownloadWarning(reason="prueba"))
    if partial:
        refs = [PlaneRef(epoch=epoch, detector=detector) for epoch, detector in partial]
        warnings.append(CutoutsFailedWarning(n=len(partial), planes=refs))

    epochs = [
        item.model_copy(update={"n_exposures": sum(p.n_exposures for p in planes if p.epoch == item.epoch)})
        for item in _EPOCHS[:n_epochs]
    ]
    detectors = [
        DetectorInfo(
            detector=detector,
            wave_min_um=0.75 + 0.7 * (detector - 1),
            wave_max_um=1.45 + 0.7 * (detector - 1),
            display=detector_display([image for (_, d), image in sample.images.items() if d == detector]),
        )
        for detector in range(1, 7)
    ]
    preview_image = (rng.normal(2.0, 0.4, shape) + 30.0 * star).astype(np.float32) if with_preview else None
    preview = PreviewInfo(
        status="ready" if with_preview else "unavailable",
        band="W1",
        wave_um=3.4,
        hips="prueba/WISE/W1",
        display=detector_display([preview_image]) if preview_image is not None else None,
    )
    total = sum(plane.n_exposures for plane in planes)
    failed_total = sum(plane.n_failed for plane in planes)
    meta = with_cube_offsets(
        FieldMeta(
            id=field_id,
            pipeline=pipeline,
            status="partial" if partial else "ready",
            rev=1,
            request=FieldRequestInfo(ra=ra, dec=dec, fov=0.02),
            grid=geometry.grid_info(grid),
            detectors=detectors,
            epochs=epochs,
            planes=planes,
            flags=[
                FlagInfo(
                    bit=1, name="OVERFLOW", description="Overflow detected during SUR", masked=True, saturation=True
                ),
                FlagInfo(bit=5, name="FLAG_DE_PRUEBA", description="Bit inventado para los tests", masked=False,
                         saturation=False),
            ],
            progress=Progress(
                phase="done",
                cutouts_total=total,
                cutouts_done=total - failed_total,
                cutouts_failed=failed_total,
                planes_total=len(planes),
                planes_ready=len(planes),
                elapsed_s=155.4,
            ),
            warnings=warnings,  # type: ignore[arg-type]
            preview=preview,
            provenance=Provenance(
                collections=["spherex_dr1", "spherex_qr3"],
                listed_at="2026-11-15T06:21:10Z",
                download_mode="truncated",
                built_at="2026-11-15T06:23:34Z",
            ),
        )
    )  # fmt: skip
    sample.meta = meta

    store = FieldStore(root)
    store.write_meta(meta)
    for key, image in sample.images.items():
        store.write_plane(field_id, *key, image)
        store.write_aux(field_id, *key, sample.flags[key], sample.coverage[key])
    if preview_image is not None:
        store.write_preview(field_id, preview_image)
        sample.preview = preview_image
    if track_name is not None:
        positions = [
            TrackPosition(
                epoch=item.epoch, mjd=item.mjd_mean, ra=ra, dec=dec + 0.0001 * item.epoch, x=11.0,
                y=11.0 + 0.117 * item.epoch, in_field=True,
            )
            for item in epochs
        ]  # fmt: skip
        sample.track = TrackResponse(name=track_name, positions=positions)
        store.write_track(field_id, sample.track)
    return sample


@dataclass
class SampleFields:
    """Carpeta de muestras para el servidor falso: dos campos lejos uno del otro."""

    root: Path
    a: SampleField  # completo: dos epocas, un plano vacio, vista provisoria y trayectoria
    b: SampleField  # parcial: una epoca, un recorte fallido, sin vista provisoria


@pytest.fixture(scope="session")
def sample_field_builder() -> Callable[..., SampleField]:
    """La funcion que arma un campo sintetico, para los tests que necesitan uno propio."""
    return build_sample_field


@pytest.fixture(scope="session")
def sample_fields(tmp_path_factory: pytest.TempPathFactory) -> SampleFields:
    root = tmp_path_factory.mktemp("muestras")
    a = build_sample_field(root, 10.0, 20.0, empty=((2, 1),), track_name="NAME Estrella de prueba", seed=1)
    b = build_sample_field(root, 200.0, -30.0, n_epochs=1, partial=((1, 4),), with_preview=False, seed=2)
    return SampleFields(root=root, a=a, b=b)
