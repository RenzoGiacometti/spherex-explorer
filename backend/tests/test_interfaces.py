"""Las interfaces acordadas entre modulos: que todo se pueda importar y que las firmas no cambien sin querer.

Varias de estas funciones todavia no estan implementadas. Este test no las
llama: solo fija los nombres y los parametros con los que el resto del backend
cuenta. Agregar un parametro opcional al final o un campo nuevo a una
dataclass no rompe nada; quitar o renombrar uno de los acordados, si.
"""

from __future__ import annotations

import dataclasses
import importlib
import inspect
import pkgutil
from collections.abc import Callable

import pytest

import app


def _module_names() -> list[str]:
    return sorted(module.name for module in pkgutil.walk_packages(app.__path__, prefix="app."))


@pytest.mark.parametrize("name", _module_names())
def test_every_module_imports(name: str) -> None:
    importlib.import_module(name)


def test_expected_modules_exist() -> None:
    assert {
        "app.api.errors",
        "app.api.main",
        "app.config",
        "app.contract",
        "app.domain",
        "app.fake",
        "app.geometry",
        "app.irsa.cutouts",
        "app.irsa.limits",
        "app.irsa.sia",
        "app.jobs.events",
        "app.jobs.manager",
        "app.jobs.store",
        "app.pipeline.coadd",
        "app.pipeline.epochs",
        "app.pipeline.exposure",
        "app.pipeline.stats",
        "app.preview.hips2fits",
        "app.resolve.coords",
        "app.resolve.motion",
        "app.resolve.sesame",
    } <= set(_module_names())


def _parameters(function: Callable[..., object]) -> list[inspect.Parameter]:
    return [item for name, item in inspect.signature(function).parameters.items() if name != "self"]


@pytest.mark.parametrize(
    ("module", "attribute", "parameters"),
    [
        ("app.irsa.sia", "list_exposures", ["ra", "dec", "settings", "refresh"]),
        ("app.irsa.cutouts", "fetch_cutout", ["exposure", "ra", "dec", "side_deg", "settings"]),
        ("app.irsa.limits", "get_limiter", ["settings"]),
        ("app.irsa.limits", "IrsaLimiter.cutout_slot", []),
        ("app.irsa.limits", "IrsaLimiter.sia_slot", []),
        ("app.pipeline.exposure", "load_exposure", ["path", "grid"]),
        ("app.pipeline.coadd", "PlaneAccumulator.__init__", ["grid", "n_exposures"]),
        ("app.pipeline.coadd", "PlaneAccumulator.add", ["exposure"]),
        ("app.pipeline.coadd", "PlaneAccumulator.snapshot", []),
        ("app.pipeline.epochs", "assign_epochs", ["exposures", "gap_days"]),
        ("app.pipeline.stats", "plane_stats", ["image"]),
        ("app.pipeline.stats", "detector_display", ["planes"]),
        ("app.pipeline.stats", "saturated_regions", ["image", "min_pixels"]),
        ("app.resolve.sesame", "resolve_name", ["name", "settings"]),
        ("app.resolve.coords", "parse_coordinates", ["text"]),
        ("app.resolve.motion", "position_at", ["target", "mjd"]),
        ("app.resolve.motion", "field_center", ["target", "epoch"]),
        ("app.resolve.motion", "track", ["target", "epochs", "grid"]),
        ("app.preview.hips2fits", "fetch_preview", ["grid", "band", "settings"]),
        ("app.jobs.manager", "JobManager.__init__", ["settings", "store", "bus"]),
        ("app.jobs.manager", "JobManager.submit", ["request"]),
        ("app.jobs.manager", "JobManager.get_meta", ["field_id"]),
        ("app.jobs.manager", "JobManager.subscribe", ["field_id"]),
        ("app.jobs.manager", "JobManager.set_priority", ["field_id", "band"]),
        ("app.jobs.events", "EventBus.publish", ["field_id", "event", "data"]),
        ("app.jobs.events", "EventBus.subscribe", ["field_id"]),
        ("app.api.main", "create_app", ["settings"]),
        ("app.geometry", "normalize_request", ["ra", "dec", "fov", "band", "refresh", "pipeline"]),
        ("app.geometry", "cutout_side_deg", ["fov"]),
    ],
)
def test_signature(module: str, attribute: str, parameters: list[str]) -> None:
    target: object = importlib.import_module(module)
    for part in attribute.split("."):
        target = getattr(target, part)
    assert callable(target)
    actual = _parameters(target)
    assert [item.name for item in actual[: len(parameters)]] == parameters
    # Lo que se agregue despues de lo acordado tiene que ser opcional.
    assert all(item.default is not inspect.Parameter.empty for item in actual[len(parameters) :])


def test_domain_dataclasses_have_the_agreed_fields() -> None:
    from app import domain

    expected = {
        "Exposure": [
            "obs_id", "collection", "detector", "mjd_start", "mjd_end", "url", "wave_min_um", "wave_max_um",
        ],
        "ExposureList": ["exposures", "listed_at", "stale"],
        "CutoutFile": ["path", "mode", "from_cache", "nbytes"],
        "Grid": ["wcs", "shape", "pixel_scale_arcsec", "fov", "ra", "dec"],
        "PlaneArrays": ["image", "flags", "coverage"],
        "ReprojectedExposure": [
            "image", "variance", "flags", "footprint", "flag_bits", "background", "flag_descriptions",
        ],
        "EpochAssignment": ["indices", "epochs"],
        "NormalizedRequest": ["ra", "dec", "fov", "band", "refresh", "step", "pipeline", "field_id"],
    }  # fmt: skip
    for name, names in expected.items():
        actual = [item.name for item in dataclasses.fields(getattr(domain, name))]
        assert actual[: len(names)] == names, name
    target_fields = {item.name for item in dataclasses.fields(domain.ResolvedTarget)}
    assert {"ra", "dec", "pm_ra", "pm_dec", "parallax", "radial_velocity", "name", "source"} <= target_fields


def test_cutout_exceptions() -> None:
    from app.irsa.cutouts import IrsaBusy, IrsaError, IrsaPermanent, IrsaTransient

    busy = IrsaBusy("Server busy, retry later.", retry_after=5.0)
    assert busy.retry_after == 5.0 and isinstance(busy, IrsaError)
    assert issubclass(IrsaTransient, IrsaError) and issubclass(IrsaPermanent, IrsaError)
    assert not issubclass(IrsaTransient, IrsaPermanent) and not issubclass(IrsaBusy, IrsaTransient)


def test_resolved_target_knows_if_it_moves() -> None:
    from app.domain import ResolvedTarget

    assert not ResolvedTarget(query="10 20", ra=10.0, dec=20.0).has_proper_motion
    assert not ResolvedTarget(query="x", ra=10.0, dec=20.0, pm_ra=0.0, pm_dec=0.0).has_proper_motion
    assert ResolvedTarget(query="x", ra=10.0, dec=20.0, pm_ra=-801.551, pm_dec=10362.394).has_proper_motion
