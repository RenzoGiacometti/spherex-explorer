"""Coadd incremental de un plano (una epoca y un detector).

Media ponderada por inversa de la varianza, como `coadd` en spike/field.py,
pero acumulando de a una exposicion para poder emitir una revision provisoria
cuando entro la mitad (contrato, seccion 8).

Pendiente de implementar: por ahora solo estan las firmas.
"""

from __future__ import annotations

from app.domain import Grid, PlaneArrays, ReprojectedExposure


class PlaneAccumulator:
    """Acumula las exposiciones de un plano y entrega el coadd en cualquier momento.

    Guarda sumas por pixel (peso, peso x valor, cantidad de aportes validos,
    cantidad de exposiciones que cubren el pixel y, por cada bit de FLAGS,
    cuantas lo tienen encendido), no las exposiciones.
    """

    def __init__(self, grid: Grid, n_exposures: int) -> None:
        """Prepara los acumuladores para un plano de `grid.shape` que espera `n_exposures` exposiciones."""
        raise NotImplementedError

    @property
    def n_used(self) -> int:
        """Exposiciones agregadas hasta ahora."""
        raise NotImplementedError

    def add(self, exposure: ReprojectedExposure) -> None:
        """Suma una exposicion ya reproyectada a los acumuladores."""
        raise NotImplementedError

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
        """
        raise NotImplementedError
