"""Coadd incremental de un plano (una epoca y un detector).

Media ponderada por inversa de la varianza, como `coadd` en spike/field.py,
pero acumulando de a una exposicion para poder emitir una revision provisoria
cuando entro la mitad (contrato, seccion 8). Las reglas de cada pixel estan en
las secciones 6 y 7 del contrato y en `PlaneAccumulator.snapshot`.
"""

from __future__ import annotations

import threading

import numpy as np
from numpy.typing import NDArray

from app.domain import Grid, PlaneArrays, ReprojectedExposure
from app.pipeline.exposure import SATURATION_FLAGS, flag_mask
from app.pipeline.flag_table import FlagTable

# La cobertura viaja como Uint16 (contrato, seccion 6): es el tope de exposiciones de un plano.
MAX_EXPOSURES = int(np.iinfo(np.uint16).max)

_FLOAT32_MAX = float(np.finfo(np.float32).max)


class PlaneAccumulator:
    """Acumula las exposiciones de un plano y entrega el coadd en cualquier momento.

    Guarda sumas por pixel (peso, peso x valor, cantidad de aportes validos,
    cantidad de exposiciones que cubren el pixel, cuantas de esas tienen un flag
    de saturacion y, por cada bit de FLAGS, cuantas lo tienen encendido), no las
    exposiciones.

    Tablas de bits: cada exposicion trae la suya y se la interpreta por nombre.
    Una exposicion que no declara un flag cuenta como que no lo tiene. Los bits
    que una exposicion trae encendidos sin declararlos en su encabezado no se
    cuentan, asi la capa de flags solo usa bits de `flags[]`. Si una exposicion
    trae una tabla incompatible con las anteriores (un bit con dos nombres),
    `add()` lanza `FlagTableError` y el acumulador queda como estaba.

    Hilos: `add()` y `snapshot()` se pueden llamar desde varios hilos; un
    candado interno hace que cada llamada vea el acumulador entero. El coadd no
    depende del orden de los `add()` salvo por el redondeo de las sumas en coma
    flotante (del orden de 1e-16 relativo): para obtener siempre los mismos
    bytes hay que agregar las exposiciones en el mismo orden.
    """

    def __init__(self, grid: Grid, n_exposures: int) -> None:
        """Prepara los acumuladores para un plano de `grid.shape` que espera `n_exposures` exposiciones."""
        if isinstance(n_exposures, bool) or not isinstance(n_exposures, int | np.integer):
            raise ValueError(f"n_exposures tiene que ser un entero, no {n_exposures!r}")
        if not 0 <= n_exposures <= MAX_EXPOSURES:
            raise ValueError(f"n_exposures={n_exposures} fuera de rango: de 0 a {MAX_EXPOSURES}")
        self._shape: tuple[int, int] = (int(grid.shape[0]), int(grid.shape[1]))
        self._n_exposures = int(n_exposures)
        self._n_used = 0
        self._weight = np.zeros(self._shape, dtype=np.float64)
        self._weighted = np.zeros(self._shape, dtype=np.float64)
        self._n_valid = np.zeros(self._shape, dtype=np.uint16)
        self._n_covering = np.zeros(self._shape, dtype=np.uint16)
        self._n_saturated = np.zeros(self._shape, dtype=np.uint16)
        # Por bit, cuantas exposiciones lo tienen encendido. Se crea al aparecer el bit:
        # de los 22 o 23 declarados, en un campo se encienden unos pocos.
        self._bit_counts: dict[int, NDArray[np.uint16]] = {}
        self._table = FlagTable()
        self._lock = threading.Lock()

    @property
    def shape(self) -> tuple[int, int]:
        """Forma del plano, `(ny, nx)`."""
        return self._shape

    @property
    def n_exposures(self) -> int:
        """Exposiciones que el plano espera, tal como se paso al crearlo."""
        return self._n_exposures

    @property
    def n_used(self) -> int:
        """Exposiciones agregadas hasta ahora."""
        return self._n_used

    def add(self, exposure: ReprojectedExposure) -> None:
        """Suma una exposicion ya reproyectada a los acumuladores.

        Un pixel de la exposicion aporta si esta dentro de su huella y tiene
        imagen finita y varianza finita y positiva; su peso es `1 / varianza`.

        Lanza `ValueError` si la exposicion no tiene la forma del plano o si ya
        hay `MAX_EXPOSURES`, y `FlagTableError` (que es un `ValueError`) si su
        tabla de bits contradice a las anteriores. En los dos casos el
        acumulador no cambia.
        """
        image = np.asarray(exposure.image)
        variance = np.asarray(exposure.variance)
        flags = np.asarray(exposure.flags)
        footprint = np.asarray(exposure.footprint, dtype=bool)
        for name, array in (("image", image), ("variance", variance), ("flags", flags), ("footprint", footprint)):
            if array.shape != self._shape:
                raise ValueError(f"exposicion con {name} de forma {array.shape}; el plano es {self._shape}")
        if flags.dtype.kind not in "iu":
            raise ValueError(f"exposicion con flags de tipo {flags.dtype}; tienen que ser enteros")
        self._table.check(exposure.flag_bits)  # FlagTableError si no es compatible

        # Todo lo que se va a sumar se calcula antes de tomar el candado.
        with np.errstate(invalid="ignore"):
            valid = footprint & np.isfinite(image) & np.isfinite(variance) & (variance > 0)
        weight = np.where(valid, 1.0 / np.where(valid, variance, 1.0).astype(np.float64), 0.0)
        weighted = weight * np.where(valid, image, 0.0)

        declared = 0
        for bit in exposure.flag_bits.values():
            declared |= 1 << int(bit)
        own_flags = np.where(footprint, flags.astype(np.uint32, copy=False) & np.uint32(declared), np.uint32(0))
        saturation = np.uint32(flag_mask(exposure.flag_bits, SATURATION_FLAGS))
        saturated = (own_flags & saturation) != 0
        present = int(np.bitwise_or.reduce(own_flags, axis=None))
        bit_masks = {
            bit: (own_flags & np.uint32(1 << bit)) != 0 for bit in range(present.bit_length()) if present >> bit & 1
        }

        with self._lock:
            if self._n_used >= MAX_EXPOSURES:
                raise ValueError(f"el plano ya tiene {MAX_EXPOSURES} exposiciones: la cobertura es Uint16")
            # Otra vez, ahora con el candado: otro hilo pudo sumar una tabla distinta mientras tanto.
            self._table.add(exposure.flag_bits, exposure.flag_descriptions)
            self._weight += weight
            self._weighted += weighted
            self._n_valid += valid
            self._n_covering += footprint
            self._n_saturated += saturated
            for bit, mask in bit_masks.items():
                counts = self._bit_counts.get(bit)
                if counts is None:
                    counts = self._bit_counts[bit] = np.zeros(self._shape, dtype=np.uint16)
                counts += mask
            self._n_used += 1

    def snapshot(self) -> PlaneArrays:
        """Coadd con lo acumulado hasta ahora, sin modificar el acumulador.

        Reglas de cada pixel (contrato, secciones 6 y 7):
        - Si alguna exposicion aporto un valor valido: media ponderada por
          inversa de la varianza.
        - Si ninguna aporto y al menos la mitad de las que lo cubren tienen un
          flag de saturacion (OVERFLOW o BLOOM): `+Infinity`.
        - En cualquier otro caso: `NaN`.
        - `flags`: el bit `n` queda encendido si al menos la mitad de las
          exposiciones que cubren el pixel lo tienen encendido.
        - `coverage`: exposiciones que aportaron un valor valido; vale 0
          exactamente donde la imagen es `NaN` o `+Infinity`.

        "Al menos la mitad" incluye la mitad justa: 1 de 2 y 2 de 4 alcanzan, 1
        de 3 no. Un pixel que ninguna exposicion cubre queda en `NaN`, sin
        flags y con cobertura 0.

        La saturacion mira los dos flags juntos y la capa de flags, cada bit por
        separado: la mitad de las exposiciones puede tener OVERFLOW o BLOOM sin
        que ninguno de los dos llegue a la mitad por su cuenta. Para que la capa
        explique siempre por que un pixel esta saturado, en un pixel `+Infinity`
        que quedaria sin ningun flag de saturacion se enciende el que esta en
        mas exposiciones (a igual cantidad, el de bit mas bajo). Contrato,
        seccion 7.

        Los arreglos devueltos son nuevos: no cambian con los `add()` que sigan.
        """
        with self._lock:
            n_valid = self._n_valid.copy()
            covering = self._n_covering.astype(np.int32)
            n_saturated = self._n_saturated.astype(np.int32)
            with np.errstate(divide="ignore", invalid="ignore"):
                mean = self._weighted / self._weight
            bit_counts = {bit: counts.astype(np.int32) for bit, counts in self._bit_counts.items()}
            table_bits = self._table.bits

        has_value = n_valid > 0
        saturated = ~has_value & (covering > 0) & (2 * n_saturated >= covering)
        image = np.full(self._shape, np.nan, dtype=np.float32)
        # Una media de valores Float32 puede pasarse del maximo por redondeo: +Infinity queda solo para saturacion.
        image[has_value] = np.clip(mean[has_value], -_FLOAT32_MAX, _FLOAT32_MAX)
        image[saturated] = np.inf

        flags = np.zeros(self._shape, dtype=np.uint32)
        for bit, counts in bit_counts.items():
            majority = (counts > 0) & (2 * counts >= covering)
            flags |= majority.astype(np.uint32) << np.uint32(bit)

        # Un pixel saturado lleva siempre algun flag de saturacion. En un pixel saturado al menos
        # una exposicion tiene OVERFLOW o BLOOM, asi que el mas frecuente tiene cuenta mayor que 0.
        saturation_bits = sorted(
            bit for name, bit in table_bits.items() if name in SATURATION_FLAGS and bit in bit_counts
        )
        if saturation_bits:
            any_saturation = np.uint32(sum(1 << bit for bit in saturation_bits))
            unexplained = saturated & ((flags & any_saturation) == 0)
            if unexplained.any():
                # `argmax` devuelve el primero de los maximos: a igual cantidad gana el bit mas bajo.
                most_frequent = np.argmax(np.stack([bit_counts[bit] for bit in saturation_bits]), axis=0)
                for index, bit in enumerate(saturation_bits):
                    chosen = unexplained & (most_frequent == index)
                    flags |= chosen.astype(np.uint32) << np.uint32(bit)
        return PlaneArrays(image=image, flags=flags, coverage=n_valid)
