"""Configuracion: valores del contrato y variables de entorno SPHEREX_*."""

from __future__ import annotations

from pathlib import Path

import pytest

from app import config
from app.config import Settings


def test_defaults_are_the_contract_limits() -> None:
    settings = Settings.from_env({})
    assert settings.max_cutout_downloads == 10
    assert settings.max_sia_queries == 2
    assert settings.max_active_jobs == 2
    assert settings.max_queued_jobs == 20
    assert settings.cutout_attempts == 6
    assert settings.field_epoch == config.FIELD_EPOCH == 2026.0
    assert settings.pipeline_version == config.PIPELINE_VERSION == "1"
    assert settings.collections == ("spherex_dr1", "spherex_qr3")
    assert settings.epoch_gap_days == 60.0
    assert settings.sse_ping_s == 15.0
    assert settings.preview_timeout_s == 20.0
    assert settings.fake_seconds == 25.0


def test_sample_pipeline_is_not_the_real_one() -> None:
    """Las muestras del servidor falso no comparten `id` ni URL con los campos del backend real."""
    assert config.SAMPLE_PIPELINE_VERSION != config.PIPELINE_VERSION
    # Entra en el texto del que sale el `id`, que se codifica en ASCII.
    assert config.SAMPLE_PIPELINE_VERSION.isascii() and "|" not in config.SAMPLE_PIPELINE_VERSION


def test_default_paths_hang_from_the_backend_folder() -> None:
    settings = Settings.from_env({})
    backend = Path(config.__file__).resolve().parent.parent
    assert backend.name == "backend"
    assert settings.data_dir == backend / "data"
    assert settings.cache_dir == backend / "cache"
    assert settings.precomputed_fields_dir == backend / "data" / "fields"
    assert settings.cached_fields_dir == backend / "cache" / "fields"
    assert settings.cutout_cache_dir == backend / "cache" / "cutouts"
    assert settings.sia_cache_dir == backend / "cache" / "sia"
    assert settings.sesame_cache_dir == backend / "cache" / "sesame"
    assert settings.fake_fields_dir == backend / "tests" / "fixtures" / "fields"
    assert settings.fake_sesame_dir == backend / "tests" / "fixtures" / "sesame"


def test_every_field_can_be_overridden_from_the_environment(tmp_path: Path) -> None:
    settings = Settings.from_env(
        {
            "SPHEREX_DATA_DIR": str(tmp_path / "datos"),
            "SPHEREX_CACHE_DIR": str(tmp_path / "cache"),
            "SPHEREX_MAX_CUTOUT_DOWNLOADS": "4",
            "SPHEREX_MAX_SIA_QUERIES": "1",
            "SPHEREX_MAX_ACTIVE_JOBS": "3",
            "SPHEREX_MAX_QUEUED_JOBS": "5",
            "SPHEREX_CUTOUT_ATTEMPTS": "2",
            "SPHEREX_FIELD_EPOCH": "2027.5",
            "SPHEREX_PIPELINE_VERSION": "2",
            "SPHEREX_COLLECTIONS": "spherex_dr1, spherex_qr3 ,otra",
            "SPHEREX_FAKE_FIELDS_DIR": str(tmp_path / "muestras"),
            "SPHEREX_FAKE_SECONDS": "3.5",
            "SPHEREX_SSE_PING_S": "",  # vacia: queda el valor por defecto
            "OTRA_VARIABLE": "x",
        }
    )
    assert settings.data_dir == tmp_path / "datos"
    assert settings.cached_fields_dir == tmp_path / "cache" / "fields"
    assert settings.max_cutout_downloads == 4
    assert settings.max_sia_queries == 1
    assert settings.max_active_jobs == 3
    assert settings.max_queued_jobs == 5
    assert settings.cutout_attempts == 2
    assert settings.field_epoch == 2027.5
    assert settings.pipeline_version == "2"
    assert settings.collections == ("spherex_dr1", "spherex_qr3", "otra")
    assert settings.fake_fields_dir == tmp_path / "muestras"
    assert settings.fake_seconds == 3.5
    assert settings.sse_ping_s == 15.0


def test_parallel_downloads_never_exceed_ten() -> None:
    assert Settings.from_env({"SPHEREX_MAX_CUTOUT_DOWNLOADS": "50"}).max_cutout_downloads == 10
    assert Settings(max_cutout_downloads=11).max_cutout_downloads == 10


def test_invalid_values_are_reported() -> None:
    with pytest.raises(ValueError, match="SPHEREX_MAX_ACTIVE_JOBS"):
        Settings.from_env({"SPHEREX_MAX_ACTIVE_JOBS": "dos"})
    with pytest.raises(ValueError):
        Settings.from_env({"SPHEREX_MAX_ACTIVE_JOBS": "0"})
    with pytest.raises(ValueError):
        Settings.from_env({"SPHEREX_FAKE_SECONDS": "-1"})


def test_get_settings_reads_the_process_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SPHEREX_PIPELINE_VERSION", "7")
    config.get_settings.cache_clear()
    try:
        assert config.get_settings().pipeline_version == "7"
        assert config.get_settings() is config.get_settings()
    finally:
        config.get_settings.cache_clear()
