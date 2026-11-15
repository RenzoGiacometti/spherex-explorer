"""Vista provisoria de WISE (contrato, seccion 4.10): por ahora, solo la eleccion de la banda."""

from __future__ import annotations

import pytest

from app.preview.hips2fits import preview_band


@pytest.mark.parametrize(
    ("band", "expected"),
    [(1, ("W1", 3.4)), (2, ("W1", 3.4)), (3, ("W1", 3.4)), (4, ("W1", 3.4)), (5, ("W2", 4.6)), (6, ("W2", 4.6))],
)
def test_preview_band_is_w2_only_for_the_two_longest_detectors(band: int, expected: tuple[str, float]) -> None:
    assert preview_band(band) == expected
