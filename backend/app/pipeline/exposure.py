"""De un recorte en disco a una exposicion reproyectada a la grilla del campo.

Referencia probada con recortes reales: `load_and_reproject` en spike/field.py.

Pendiente de implementar: por ahora solo estan las constantes y la firma.
"""

from __future__ import annotations

from pathlib import Path

from app.domain import Grid, ReprojectedExposure

# Flags que descartan un pixel (`flags[].masked`): los del aviso conservador
# CONTAINS_BAD_PIXEL del SPHEREx Explanatory Supplement (tabla 16), tal como los
# usa el tutorial oficial:
# https://caltech-ipac.github.io/irsa-tutorials/spherex-source-discovery-tool-demo/
# Misma lista que BAD_FLAGS en spike/field.py. SOURCE queda afuera a proposito:
# marca pixeles de fuentes conocidas. Se enmascaran solo los que figuren en el
# encabezado de cada archivo: el bit se lee siempre por nombre (MSKNnnnn).
MASKED_FLAGS: tuple[str, ...] = (
    "TRANSIENT", "OVERFLOW", "SUR_ERROR", "NONFUNC", "DICHROIC", "MISSING_DATA", "HOT", "COLD",
    "NONLINEAR", "CROSSTALK", "GHOST", "GHOST_FPA", "GHOST_EXT", "STREAK", "PERSIST",
    "BLOOM", "SNOWBALL", "HALO", "SATELLITE_HALO",
)  # fmt: skip

# Flags que cuentan como saturacion (`flags[].saturation`; contrato, seccion 7).
SATURATION_FLAGS: tuple[str, ...] = ("OVERFLOW", "BLOOM")


def load_exposure(path: Path, grid: Grid) -> ReprojectedExposure:
    """Carga un recorte, lo limpia y lo lleva a la grilla del campo.

    Pasos (contrato, seccion 9):
    1. Lee IMAGE, FLAGS, VARIANCE y ZODI por `EXTNAME`, y la tabla de bits del
       encabezado de FLAGS (`MSKNnnnn` da el nombre, `MSKDnnnn` la descripcion).
    2. Resta ZODI y despues la mediana residual de los pixeles validos que no
       son de fuentes conocidas (flag SOURCE), si quedan suficientes.
    3. Descarta (NaN en imagen y varianza) los pixeles con algun flag de
       `MASKED_FLAGS`, los no finitos y los de varianza no positiva.
    4. Reproyecta imagen y varianza a `grid` con interpolacion bilineal; los
       flags, por vecino mas cercano y conservando todos los bits (uint32).

    Devuelve la imagen y la varianza reproyectadas con lo descartado en NaN, los
    flags, la huella booleana del recorte sobre la grilla, la tabla nombre->bit
    con sus descripciones y el fondo residual restado.

    Lanza `OSError`, `KeyError` o `ValueError` si el archivo no se puede leer o
    le falta una extension.
    """
    raise NotImplementedError
