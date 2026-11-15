"""Error real de la curva de luz, medido sobre estrellas que no varian.

El error formal de una medida (el de VARIANCE) es mucho menor que la diferencia
real entre dos exposiciones de la misma estrella: la PSF esta submuestreada, la
estrella cae en otra parte del detector y, en las alas, cambia que pixeles
quedan enmascarados. Ese error no se puede calcular; se mide. Dos estrellas de
control, que no deberian variar, pasan por el mismo camino que cualquier otra:

- Barnard's Star, que satura en los seis detectores: control de las alas.
- Epsilon Indi B, que no satura: control de la apertura.

`scripts/calibrate_lightcurve.py` las mide con los recortes de la cache y
guarda en `data/calibration.json`, por metodo y por detector, cuanto se aparta
de 1 el brillo relativo de cada pasada y cuanto dispersan las medidas sueltas.
De ahi salen dos pisos de error por metodo, que se suman en cuadratura al error
de toda curva:

    epoch_floor   lo peor que se aparto una pasada de la estrella de control
    point_floor   la dispersion de sus medidas sueltas

y, por detector, si el metodo quedo validado: la estrella de control salio
plana. Las alas no validaron en los detectores 2 y 3 (Barnard dispersa mas del
15 % entre exposiciones del mismo canal, aunque las estrellas de campo de esas
mismas imagenes son estables al 1-2 %).

Esa falla no es un efecto del borde del hueco. En los coadds hay una franja de
cobertura parcial junto al nucleo saturado que sesga las alas; por exposicion se
comprobo que no aplica: el anillo ya tiene validos el 98-99 % de sus pixeles, la
dispersion no baja al correrlo 3 o 6 px hacia afuera (detector 2: 21, 16 y 17 %;
detector 3: 24, 23 y 24 %) y el valor de una medida no depende de la fraccion
valida de su anillo (correlacion de 0,25 o menos, en valor absoluto). Lo que
cambia de una exposicion a otra es el halo entero, junto con el tamano del hueco.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

Method = Literal["aperture", "wings"]

CALIBRATION_PATH = Path(__file__).resolve().parent / "data" / "calibration.json"

# Una estrella de control "sale plana" en un detector si sus pasadas no se apartan mas que esto
# y sus medidas sueltas no dispersan mas que esto otro.
VALID_EPOCH_DEVIATION = 0.04
VALID_POINT_SCATTER = 0.10


@dataclass(frozen=True)
class DetectorControl:
    """Como salio la estrella de control en un detector."""

    n_points: int
    epoch_deviation: float  # mayor apartamiento de 1 entre sus pasadas (fraccion)
    point_scatter: float  # dispersion robusta de sus medidas alrededor del modelo (fraccion)
    valid: bool


@dataclass(frozen=True)
class MethodCalibration:
    control: str  # nombre de la estrella de control
    epoch_floor: float
    point_floor: float
    detectors: Mapping[int, DetectorControl] = field(default_factory=dict)

    def validated(self, detector: int) -> bool:
        item = self.detectors.get(detector)
        return item is not None and item.valid


@dataclass(frozen=True)
class Calibration:
    methods: Mapping[str, MethodCalibration]

    def for_method(self, method: Method) -> MethodCalibration | None:
        return self.methods.get(method)


# Sin archivo de calibracion no hay pisos: los errores quedan en los formales y nada figura como validado.
EMPTY = Calibration(methods={})


def calibration_from_document(document: Mapping[str, Any]) -> Calibration:
    methods: dict[str, MethodCalibration] = {}
    for name, item in document.get("methods", {}).items():
        detectors = {
            int(detector): DetectorControl(
                n_points=int(values["n_points"]),
                epoch_deviation=float(values["epoch_deviation"]),
                point_scatter=float(values["point_scatter"]),
                valid=bool(values["valid"]),
            )
            for detector, values in item.get("detectors", {}).items()
        }
        methods[str(name)] = MethodCalibration(
            control=str(item["control"]),
            epoch_floor=float(item["epoch_floor"]),
            point_floor=float(item["point_floor"]),
            detectors=detectors,
        )
    return Calibration(methods=methods)


@lru_cache(maxsize=4)
def load_calibration(path: Path = CALIBRATION_PATH) -> Calibration:
    """Calibracion guardada en el repositorio; `EMPTY` si el archivo no existe o no se puede leer."""
    try:
        return calibration_from_document(json.loads(Path(path).read_text(encoding="utf-8")))
    except (OSError, ValueError, KeyError, TypeError):
        return EMPTY
