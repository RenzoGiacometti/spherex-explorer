"""`assign_epochs`: la regla de 60 dias (contrato, seccion 2).

Los casos sinteticos cubren cada borde de la regla. El caso real son las 358
exposiciones de Barnard que devolvio SIA2 (tests/fixtures/sia), comparadas con
las epocas de la muestra que armo la Etapa 0.
"""

from __future__ import annotations

import io
import json
import math
import random
import warnings
from itertools import pairwise
from pathlib import Path

import pytest
from astropy.io.votable import parse as parse_votable

from app.contract import FieldMeta
from app.domain import EpochAssignment, EpochSummary, Exposure
from app.pipeline.epochs import EPOCH_GAP_DAYS, assign_epochs

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"


def at(mjd: float, detector: int = 3, obs_id: str | None = None) -> Exposure:
    """Una exposicion en esa fecha. Para las epocas solo importa `mjd_start`."""
    return Exposure(
        obs_id=obs_id or f"obs-{mjd}",
        collection="spherex_dr1",
        detector=detector,
        mjd_start=mjd,
        mjd_end=mjd + 0.0013,
        url=f"https://example.invalid/{mjd}.fits",
        wave_min_um=1.63,
        wave_max_um=2.43,
    )


def test_gap_is_sixty_days() -> None:
    assert EPOCH_GAP_DAYS == 60.0


def test_empty_list() -> None:
    assert assign_epochs([]) == EpochAssignment(indices=[], epochs=[])
    assert assign_epochs(()) == EpochAssignment(indices=[], epochs=[])


def test_single_exposure() -> None:
    result = assign_epochs([at(60902.864715)])
    assert result.indices == [1]
    assert result.epochs == [
        EpochSummary(epoch=1, mjd_start=60902.864715, mjd_end=60902.864715, mjd_mean=60902.864715, n_exposures=1)
    ]


def test_exposures_closer_than_the_gap_share_an_epoch() -> None:
    result = assign_epochs([at(60900.0), at(60930.0), at(60985.0), at(61044.9)])
    # Cada hueco es menor que 60 dias aunque de punta a punta pasen 145.
    assert result.indices == [1, 1, 1, 1]
    (epoch,) = result.epochs
    assert (epoch.mjd_start, epoch.mjd_end, epoch.n_exposures) == (60900.0, 61044.9, 4)
    assert epoch.mjd_mean == pytest.approx((60900.0 + 60930.0 + 60985.0 + 61044.9) / 4)


def test_a_gap_of_exactly_sixty_days_does_not_split() -> None:
    result = assign_epochs([at(60900.5), at(60960.5)])
    assert 60960.5 - 60900.5 == 60.0
    assert result.indices == [1, 1] and len(result.epochs) == 1


def test_a_gap_just_over_sixty_days_splits() -> None:
    result = assign_epochs([at(60900.5), at(60960.5 + 1e-6)])
    assert result.indices == [1, 2]
    assert [(epoch.epoch, epoch.n_exposures) for epoch in result.epochs] == [(1, 1), (2, 1)]


def test_the_gap_is_measured_between_consecutive_exposures() -> None:
    # 59 dias entre cada par: una sola epoca, aunque la primera y la ultima disten 118.
    assert assign_epochs([at(100.0), at(159.0), at(218.0)]).indices == [1, 1, 1]
    # 61 dias entre cada par: tres epocas.
    assert assign_epochs([at(100.0), at(161.0), at(222.0)]).indices == [1, 2, 3]


def test_input_order_does_not_matter() -> None:
    times = [60903.1, 60902.9, 61110.5, 60949.2, 61268.7, 61112.0, 61300.0, 60910.0]
    expected = [1, 1, 2, 1, 3, 2, 3, 1]
    result = assign_epochs([at(mjd) for mjd in times])
    # La epoca de cada exposicion va en el orden en que se recibieron.
    assert result.indices == expected
    assert [epoch.epoch for epoch in result.epochs] == [1, 2, 3]
    assert [epoch.n_exposures for epoch in result.epochs] == [4, 2, 2]
    assert [(epoch.mjd_start, epoch.mjd_end) for epoch in result.epochs] == [
        (60902.9, 60949.2),
        (61110.5, 61112.0),
        (61268.7, 61300.0),
    ]

    # Cualquier otro orden de entrada da las mismas epocas, y a cada exposicion la misma.
    by_time = dict(zip(times, expected, strict=True))
    shuffler = random.Random(4)
    for _ in range(20):
        shuffled = times.copy()
        shuffler.shuffle(shuffled)
        again = assign_epochs([at(mjd) for mjd in shuffled])
        assert again.indices == [by_time[mjd] for mjd in shuffled]
        assert again.epochs == result.epochs


def test_an_epoch_can_last_less_than_a_day() -> None:
    """La primera epoca de WISE 0855: 30 exposiciones en 0.8 dias (fechas de la muestra guardada)."""
    start, end = 60800.70003, 60801.51865
    first = [at(start + (end - start) * i / 29, detector=1 + i % 6) for i in range(30)]
    later = [at(60979.72268 + 0.5 * i) for i in range(10)]
    result = assign_epochs(first + later)
    assert result.indices == [1] * 30 + [2] * 10
    short = result.epochs[0]
    assert short.n_exposures == 30
    assert (short.mjd_start, short.mjd_end) == (start, pytest.approx(end))
    assert short.mjd_end - short.mjd_start == pytest.approx(0.8186, abs=1e-4)
    assert short.mjd_start < short.mjd_mean < short.mjd_end


def test_exposures_at_the_same_time_share_an_epoch() -> None:
    """Los seis detectores de una misma observacion tienen la misma fecha."""
    result = assign_epochs([at(60902.864715, detector=d) for d in range(1, 7)])
    assert result.indices == [1] * 6
    (epoch,) = result.epochs
    assert epoch.mjd_start == epoch.mjd_end == epoch.mjd_mean == 60902.864715 and epoch.n_exposures == 6


def test_summary_of_each_epoch() -> None:
    result = assign_epochs([at(10.0), at(12.0), at(20.0), at(100.0), at(104.0)])
    assert result.epochs == [
        EpochSummary(epoch=1, mjd_start=10.0, mjd_end=20.0, mjd_mean=14.0, n_exposures=3),
        EpochSummary(epoch=2, mjd_start=100.0, mjd_end=104.0, mjd_mean=102.0, n_exposures=2),
    ]
    # Lo que suman las epocas es lo que entro.
    assert sum(epoch.n_exposures for epoch in result.epochs) == len(result.indices) == 5


def test_custom_gap() -> None:
    exposures = [at(0.0), at(5.0), at(20.0), at(26.0)]
    assert assign_epochs(exposures, gap_days=10.0).indices == [1, 1, 2, 2]
    assert assign_epochs(exposures, 4.0).indices == [1, 2, 3, 4]
    assert assign_epochs(exposures, gap_days=15.0).indices == [1, 1, 1, 1]
    # Con hueco 0 solo comparten epoca las exposiciones simultaneas.
    assert assign_epochs([at(1.0), at(1.0), at(1.5)], gap_days=0.0).indices == [1, 1, 2]


@pytest.mark.parametrize("gap", [-1.0, math.nan, math.inf])
def test_gap_has_to_be_a_finite_non_negative_number(gap: float) -> None:
    with pytest.raises(ValueError, match="gap_days"):
        assign_epochs([at(1.0)], gap_days=gap)


def test_exposure_without_a_date_is_an_error() -> None:
    with pytest.raises(ValueError, match="sin-fecha"):
        assign_epochs([at(1.0), at(math.nan, obs_id="sin-fecha")])


def test_accepts_any_sequence_and_does_not_change_it() -> None:
    exposures = (at(200.0), at(100.0), at(300.0))
    result = assign_epochs(exposures)
    assert result.indices == [2, 1, 3]
    assert [exposure.mjd_start for exposure in exposures] == [200.0, 100.0, 300.0]


# ------------------------------------------------------- las 358 de Barnard


def barnard_exposures() -> list[Exposure]:
    """Las exposiciones de las dos respuestas de SIA2 guardadas, en el orden en que vinieron.

    Columnas ObsCore de la respuesta (las mismas que usa `list_exposures_sia` en
    spike/field.py): obs_id, obs_collection, energy_bandpassname, t_min, t_max,
    access_url, em_min, em_max.
    """
    index = json.loads((FIXTURES_DIR / "sia" / "index.json").read_text(encoding="utf-8"))
    exposures: list[Exposure] = []
    for query in index["queries"]:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            votable = parse_votable(io.BytesIO((FIXTURES_DIR / "sia" / query["file"]).read_bytes()))
        table = votable.get_first_table().to_table(use_names_over_ids=True)
        for row in table:
            exposures.append(
                Exposure(
                    obs_id=str(row["obs_id"]),
                    collection=str(row["obs_collection"]),
                    detector=int(str(row["energy_bandpassname"]).rsplit("D", 1)[-1]),
                    mjd_start=float(row["t_min"]),
                    mjd_end=float(row["t_max"]),
                    url=str(row["access_url"]),
                    wave_min_um=float(row["em_min"]) * 1e6,
                    wave_max_um=float(row["em_max"]) * 1e6,
                )
            )
    return exposures


def barnard_sample() -> FieldMeta:
    samples = json.loads((FIXTURES_DIR / "fields" / "index.json").read_text(encoding="utf-8"))["samples"]
    (sample,) = (item for item in samples if item["label"] == "barnard")
    return FieldMeta.model_validate_json(
        (FIXTURES_DIR / "fields" / sample["id"] / "meta.json").read_text(encoding="utf-8")
    )


def test_barnard_has_the_three_epochs_of_the_sample() -> None:
    exposures = barnard_exposures()
    assert len(exposures) == 358
    result = assign_epochs(exposures)
    meta = barnard_sample()
    assert meta.epochs is not None and meta.planes is not None

    assert len(result.indices) == 358 and set(result.indices) == {1, 2, 3}
    assert len(result.epochs) == len(meta.epochs) == 3
    for mine, sample in zip(result.epochs, meta.epochs, strict=True):
        assert mine.epoch == sample.epoch
        assert mine.n_exposures == sample.n_exposures
        assert mine.mjd_start == pytest.approx(sample.mjd_start, abs=1e-5)
        assert mine.mjd_end == pytest.approx(sample.mjd_end, abs=1e-5)
        assert mine.mjd_mean == pytest.approx(sample.mjd_mean, abs=1e-5)
    assert [epoch.n_exposures for epoch in result.epochs] == [118, 121, 119]

    # Cada exposicion cae en la epoca que contiene su fecha, y entre epocas hay mas de 60 dias.
    for exposure, epoch in zip(exposures, result.indices, strict=True):
        summary = result.epochs[epoch - 1]
        assert summary.mjd_start <= exposure.mjd_start <= summary.mjd_end
    for before, after in pairwise(result.epochs):
        assert after.mjd_start - before.mjd_end > EPOCH_GAP_DAYS

    # Por plano (epoca y detector) salen las cantidades de `planes[].n_exposures` de la muestra.
    counts: dict[tuple[int, int], int] = {}
    for exposure, epoch in zip(exposures, result.indices, strict=True):
        counts[(epoch, exposure.detector)] = counts.get((epoch, exposure.detector), 0) + 1
    assert counts == {(plane.epoch, plane.detector): plane.n_exposures for plane in meta.planes}
