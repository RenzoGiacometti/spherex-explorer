"""Tabla de flags del campo: `flags[]` como union de las tablas de bits de cada exposicion."""

from __future__ import annotations

import itertools
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pytest

from app import geometry
from app.contract import FieldMeta, FlagInfo
from app.domain import ReprojectedExposure
from app.pipeline.exposure import MASKED_FLAGS, SATURATION_FLAGS, load_exposure
from app.pipeline.flag_table import FlagTable, FlagTableError, field_flags

FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

# Las tres tablas que aparecen en los datos (contrato, seccion 9), reducidas a los bits que importan aca.
BASE = {"TRANSIENT": 0, "OVERFLOW": 1, "FULLSAMPLE": 12, "SOURCE": 21, "BLOOM": 26, "HALO": 28}
USUAL = {**BASE, "SNOWBALL": 27}
WITH_SATELLITE_HALO = {**USUAL, "SATELLITE_HALO": 29}

DESCRIPTIONS = {
    "TRANSIENT": "Transient detected during SUR",
    "OVERFLOW": "Overflow detected during SUR",
    "FULLSAMPLE": "Pixel full sample history is available",
    "SOURCE": "Pixel mapped to a known source",
    "BLOOM": "Pixel part of a bloom artifact",
    "SNOWBALL": "Pixel part of a snowball artifact",
    "HALO": "Pixel part of a transient halo",
    "SATELLITE_HALO": "Pixel part of a satellite streak halo",
}


def described(table: dict[str, int]) -> tuple[dict[str, int], dict[str, str]]:
    return table, {name: DESCRIPTIONS[name] for name in table}


def exposure_with(table: dict[str, int], descriptions: dict[str, str] | None = None) -> ReprojectedExposure:
    shape = (1, 1)
    return ReprojectedExposure(
        image=np.zeros(shape, dtype=np.float32),
        variance=np.ones(shape, dtype=np.float32),
        flags=np.zeros(shape, dtype=np.uint32),
        footprint=np.ones(shape, dtype=bool),
        flag_bits=dict(table),
        background=0.0,
        flag_descriptions=dict(descriptions or {}),
    )


def test_union_is_sorted_by_bit_with_masked_and_saturation() -> None:
    infos = field_flags([described(BASE), described(WITH_SATELLITE_HALO), described(USUAL)])
    assert infos == [
        FlagInfo(bit=0, name="TRANSIENT", description=DESCRIPTIONS["TRANSIENT"], masked=True, saturation=False),
        FlagInfo(bit=1, name="OVERFLOW", description=DESCRIPTIONS["OVERFLOW"], masked=True, saturation=True),
        FlagInfo(bit=12, name="FULLSAMPLE", description=DESCRIPTIONS["FULLSAMPLE"], masked=False, saturation=False),
        FlagInfo(bit=21, name="SOURCE", description=DESCRIPTIONS["SOURCE"], masked=False, saturation=False),
        FlagInfo(bit=26, name="BLOOM", description=DESCRIPTIONS["BLOOM"], masked=True, saturation=True),
        FlagInfo(bit=27, name="SNOWBALL", description=DESCRIPTIONS["SNOWBALL"], masked=True, saturation=False),
        FlagInfo(bit=28, name="HALO", description=DESCRIPTIONS["HALO"], masked=True, saturation=False),
        FlagInfo(
            bit=29, name="SATELLITE_HALO", description=DESCRIPTIONS["SATELLITE_HALO"], masked=True, saturation=False
        ),
    ]
    # `masked` y `saturation` salen de las listas del pipeline.
    assert {info.name for info in infos if info.masked} == set(WITH_SATELLITE_HALO) & set(MASKED_FLAGS)
    assert {info.name for info in infos if info.saturation} == set(SATURATION_FLAGS)


def test_result_does_not_depend_on_the_order_of_the_exposures() -> None:
    tables = [described(BASE), described(USUAL), described(WITH_SATELLITE_HALO), described(BASE)]
    expected = field_flags(tables)
    for permutation in itertools.permutations(tables):
        assert field_flags(permutation) == expected


def test_empty_and_single() -> None:
    assert field_flags([]) == []
    assert [info.bit for info in field_flags([described(BASE)])] == sorted(BASE.values())
    # El orden en que el encabezado lista los bits no importa.
    backwards = dict(reversed(list(BASE.items())))
    assert field_flags([described(backwards)]) == field_flags([described(BASE)])


def test_accepts_loaded_exposures_and_plain_tables() -> None:
    from_exposures = field_flags(
        [exposure_with(BASE, described(BASE)[1]), exposure_with(WITH_SATELLITE_HALO, described(WITH_SATELLITE_HALO)[1])]
    )
    mixed = field_flags([exposure_with(BASE, described(BASE)[1]), described(WITH_SATELLITE_HALO)])
    assert from_exposures == mixed == field_flags([described(WITH_SATELLITE_HALO)])
    # Tambien un generador, de una sola pasada.
    assert field_flags(described(table) for table in (BASE, USUAL)) == field_flags([described(USUAL)])


def test_same_bit_with_two_names_is_a_clear_error() -> None:
    with pytest.raises(FlagTableError, match="el bit 27 aparece como SNOWBALL y como SATELLITE_HALO"):
        field_flags([described(USUAL), ({**BASE, "SATELLITE_HALO": 27}, {})])
    # En cualquier orden, y es un ValueError: quien llama lo trata como un recorte que no se pudo leer.
    with pytest.raises(ValueError, match="el bit 27 aparece como SATELLITE_HALO y como SNOWBALL"):
        field_flags([({**BASE, "SATELLITE_HALO": 27}, {}), described(USUAL)])


def test_same_name_in_two_bits_is_an_error() -> None:
    with pytest.raises(FlagTableError, match="el flag SNOWBALL aparece en el bit 27 y en el bit 30"):
        field_flags([described(USUAL), ({**BASE, "SNOWBALL": 30}, {})])


def test_a_table_that_is_wrong_on_its_own_is_an_error() -> None:
    with pytest.raises(FlagTableError, match="el bit 5 aparece como UNO y como OTRO en la misma tabla"):
        field_flags([({"UNO": 5, "OTRO": 5}, {})])
    for bad in (32, -1, 2.5, "7", None, True):
        with pytest.raises(FlagTableError, match="los bits van de 0 a 31"):
            field_flags([({"FUERA": bad}, {})])  # type: ignore[dict-item]
    # Los extremos si valen, y un entero de numpy tambien.
    infos = field_flags([({"PRIMERO": 0, "ULTIMO": np.int64(31)}, {})])  # type: ignore[dict-item]
    assert [(info.bit, info.name) for info in infos] == [(0, "PRIMERO"), (31, "ULTIMO")]
    assert all(type(info.bit) is int for info in infos)


def test_incremental_table_reports_what_changed() -> None:
    table = FlagTable()
    assert len(table) == 0 and table.infos() == [] and table.bits == {}
    assert table.add(*described(BASE)) is True
    assert table.add(*described(BASE)) is False  # nada nuevo: no hace falta republicar `flags[]`
    assert table.add(*described(USUAL)) is True  # aparecio SNOWBALL
    assert table.add(BASE) is False
    assert len(table) == len(USUAL) and table.bits == USUAL
    assert table.add_exposure(exposure_with(WITH_SATELLITE_HALO)) is True
    assert [info.bit for info in table.infos()] == sorted(WITH_SATELLITE_HALO.values())
    # `bits` es una copia: modificarla no toca la tabla.
    table.bits.clear()
    assert len(table) == len(WITH_SATELLITE_HALO)


def test_failed_add_leaves_the_table_as_it_was() -> None:
    table = FlagTable()
    table.add(*described(USUAL))
    before = table.infos()
    # La tabla mala trae un bit nuevo valido (29) antes del conflicto: no tiene que quedar a medias.
    with pytest.raises(FlagTableError):
        table.add({"SATELLITE_HALO": 29, "OTRO": 27}, {"SATELLITE_HALO": DESCRIPTIONS["SATELLITE_HALO"]})
    assert table.infos() == before and table.bits == USUAL
    with pytest.raises(FlagTableError):
        table.check({"OTRO": 27})
    table.check(WITH_SATELLITE_HALO)  # compatible: no lanza ni agrega nada
    assert table.infos() == before


def test_descriptions() -> None:
    # Sin descripcion va vacia; no se inventa.
    assert field_flags([({"OVERFLOW": 1}, {})]) == [
        FlagInfo(bit=1, name="OVERFLOW", description="", masked=True, saturation=True)
    ]
    # Alcanza con que un archivo la traiga, llegue antes o despues.
    with_text = ({"OVERFLOW": 1}, {"OVERFLOW": "Overflow detected during SUR"})
    without = ({"OVERFLOW": 1}, {})
    for tables in ([with_text, without], [without, with_text]):
        assert field_flags(tables)[0].description == "Overflow detected during SUR"
    # Si dos archivos la escriben distinto queda la mas larga, en cualquier orden.
    longer = ({"OVERFLOW": 1}, {"OVERFLOW": "Overflow detected during SUR, all frames"})
    for tables in ([with_text, longer], [longer, with_text]):
        assert field_flags(tables)[0].description == "Overflow detected during SUR, all frames"
    # Las descripciones de flags que la tabla no declara se ignoran.
    assert field_flags([({"OVERFLOW": 1}, {"BLOOM": "no declarado"})])[0].description == ""

    table = FlagTable()
    assert table.add(*without) is True
    assert table.add(*with_text) is True  # la descripcion nueva tambien es un cambio
    assert table.add(*with_text) is False


def test_table_can_be_filled_from_many_threads() -> None:
    tables = [described(BASE), described(USUAL), described(WITH_SATELLITE_HALO)] * 40
    table = FlagTable()
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda item: table.add(*item), tables))
    assert table.infos() == field_flags(tables)


# --------------------------------------------------------------- datos reales


def test_real_cutouts_give_the_flags_of_the_barnard_sample() -> None:
    """Las tablas de los 12 recortes reales, unidas, son un subconjunto exacto de `flags[]` de la muestra."""
    cutouts = json.loads((FIXTURES_DIR / "cutouts" / "index.json").read_text(encoding="utf-8"))["cutouts"]
    grid = geometry.build_grid(geometry.normalize_request(269.4463, 4.7683))
    exposures = [load_exposure(FIXTURES_DIR / "cutouts" / entry["file"], grid) for entry in cutouts]
    # Dos tablas distintas entre los 12: una no declara SNOWBALL.
    assert sorted({len(exposure.flag_bits) for exposure in exposures}) == [21, 22]

    infos = field_flags(exposures)
    assert [info.bit for info in infos] == sorted(info.bit for info in infos) and len(infos) == 22
    assert {info.name for info in infos if info.saturation} == {"OVERFLOW", "BLOOM"}
    assert {info.name for info in infos if not info.masked} == {"FULLSAMPLE", "PHANMISS", "OUTLIER", "SOURCE"}
    assert all(info.description for info in infos)

    samples = json.loads((FIXTURES_DIR / "fields" / "index.json").read_text(encoding="utf-8"))["samples"]
    (sample,) = (item for item in samples if item["label"] == "barnard")
    meta = FieldMeta.model_validate_json(
        (FIXTURES_DIR / "fields" / sample["id"] / "meta.json").read_text(encoding="utf-8")
    )
    assert meta.flags is not None
    # La muestra salio de los 358 recortes del campo, y alguno declara SATELLITE_HALO: es lo unico que le sobra.
    assert all(info in meta.flags for info in infos)
    assert [info.name for info in meta.flags if info not in infos] == ["SATELLITE_HALO"]
