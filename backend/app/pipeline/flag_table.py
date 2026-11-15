"""Tabla de flags del campo: `flags[]` del documento de metadatos (contrato, secciones 5 y 9).

Cada archivo declara su tabla de bits en el encabezado de FLAGS y no todos
declaran los mismos: sobre 2242 recortes hay tres tablas distintas (SNOWBALL,
bit 27, falta en 87; SATELLITE_HALO, bit 29, aparece en 6). El numero de bit de
cada nombre coincide en todos. `flags[]` es la union de las tablas de las
exposiciones procesadas, ordenada por bit.

Si alguna vez un mismo bit trae dos nombres (o un mismo nombre, dos bits), las
tablas no se pueden unir: se lanza `FlagTableError` y quien llama trata ese
recorte como fallido.
"""

from __future__ import annotations

import operator
import threading
from collections.abc import Iterable, Mapping

from app.contract import FlagInfo
from app.domain import ReprojectedExposure
from app.pipeline.exposure import FLAG_BITS, MASKED_FLAGS, SATURATION_FLAGS

# Tabla de una exposicion: `(nombre -> bit, nombre -> descripcion)`.
ExposureFlagTable = tuple[Mapping[str, int], Mapping[str, str]]


class FlagTableError(ValueError):
    """Dos tablas de bits no son compatibles: un bit con dos nombres, o un nombre en dos bits."""


class FlagTable:
    """Union de las tablas de bits de las exposiciones procesadas.

    Se va completando con `add()` a medida que se leen los recortes; `infos()`
    entrega en cualquier momento la lista para `flags[]`. El resultado no
    depende del orden en que se agregan las tablas.

    `add()`, `check()` e `infos()` se pueden llamar desde varios hilos.
    """

    def __init__(self) -> None:
        self._names: dict[int, str] = {}  # bit -> nombre
        self._bits: dict[str, int] = {}  # nombre -> bit
        self._descriptions: dict[int, str] = {}  # bit -> descripcion
        self._lock = threading.Lock()

    def __len__(self) -> int:
        return len(self._names)

    @property
    def bits(self) -> dict[str, int]:
        """Copia de la union hasta ahora: nombre -> bit."""
        with self._lock:
            return dict(self._bits)

    def check(self, flag_bits: Mapping[str, int]) -> None:
        """Lanza `FlagTableError` si `flag_bits` no se puede unir con lo acumulado. No modifica nada."""
        with self._lock:
            self._check(flag_bits)

    def add(self, flag_bits: Mapping[str, int], flag_descriptions: Mapping[str, str] | None = None) -> bool:
        """Suma la tabla de una exposicion. Devuelve True si aparecio algun bit o descripcion nuevos.

        Si la tabla no es compatible con lo acumulado lanza `FlagTableError` y
        no modifica nada.
        """
        descriptions = flag_descriptions or {}
        with self._lock:
            checked = self._check(flag_bits)
            changed = False
            for name, bit in checked.items():
                if bit not in self._names:
                    self._names[bit] = name
                    self._bits[name] = bit
                    changed = True
                text = str(descriptions.get(name, "")).strip()
                current = self._descriptions.get(bit, "")
                # Si dos archivos describen distinto el mismo bit queda la descripcion mas larga
                # (y, a igual largo, la primera en orden alfabetico): no depende del orden de llegada.
                if len(text) > len(current) or (len(text) == len(current) and text < current):
                    self._descriptions[bit] = text
                    changed = True
            return changed

    def add_exposure(self, exposure: ReprojectedExposure) -> bool:
        """`add()` con la tabla de una exposicion ya cargada."""
        return self.add(exposure.flag_bits, exposure.flag_descriptions)

    def infos(self) -> list[FlagInfo]:
        """La lista `flags[]`: un `FlagInfo` por bit, ordenada por bit.

        `masked` dice si el pipeline descarta los pixeles con ese bit
        (`MASKED_FLAGS`) y `saturation`, si cuenta como saturacion
        (`SATURATION_FLAGS`). La descripcion va vacia si ningun archivo la trajo.
        """
        with self._lock:
            return [
                FlagInfo(
                    bit=bit,
                    name=name,
                    description=self._descriptions.get(bit, ""),
                    masked=name in MASKED_FLAGS,
                    saturation=name in SATURATION_FLAGS,
                )
                for bit, name in sorted(self._names.items())
            ]

    def _check(self, flag_bits: Mapping[str, int]) -> dict[str, int]:
        """Valida una tabla contra lo acumulado y la devuelve con los bits como `int`."""
        checked: dict[str, int] = {}
        seen: dict[int, str] = {}
        for name, value in flag_bits.items():
            try:
                bit = -1 if isinstance(value, bool) else operator.index(value)
            except TypeError:
                bit = -1
            if not 0 <= bit < FLAG_BITS:
                raise FlagTableError(f"el flag {name} declara el bit {value!r}, y los bits van de 0 a {FLAG_BITS - 1}")
            if bit in seen:
                raise FlagTableError(f"el bit {bit} aparece como {seen[bit]} y como {name} en la misma tabla")
            seen[bit] = name
            known_name = self._names.get(bit)
            if known_name is not None and known_name != name:
                raise FlagTableError(f"el bit {bit} aparece como {known_name} y como {name}")
            known_bit = self._bits.get(name)
            if known_bit is not None and known_bit != bit:
                raise FlagTableError(f"el flag {name} aparece en el bit {known_bit} y en el bit {bit}")
            checked[name] = bit
        return checked


def field_flags(tables: Iterable[ExposureFlagTable | ReprojectedExposure]) -> list[FlagInfo]:
    """`flags[]` del campo a partir de la tabla de cada exposicion procesada.

    Cada elemento es una exposicion ya cargada o el par `(nombre -> bit, nombre
    -> descripcion)` de su encabezado. Devuelve la union ordenada por bit; lanza
    `FlagTableError` si un mismo bit aparece con dos nombres distintos.
    """
    table = FlagTable()
    for item in tables:
        if isinstance(item, ReprojectedExposure):
            table.add_exposure(item)
        else:
            flag_bits, flag_descriptions = item
            table.add(flag_bits, flag_descriptions)
    return table.infos()
