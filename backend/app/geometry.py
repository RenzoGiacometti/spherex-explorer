"""Geometria del campo: escalones, normalizacion del pedido, id, grilla y lado del recorte.

Reglas del contrato (docs/contrato-cubo.md, secciones 2, 3 y 9). La grilla se
construye igual que `output_grid` en spike/field.py, que ya se probo contra
recortes reales.

Coordenadas de pixel: desde 0 en el centro del primer pixel; `x` crece hacia el
oeste y `y` hacia el norte. La fila 0 es el borde sur y la columna 0 el borde este.
"""

from __future__ import annotations

import hashlib
import math

from astropy.wcs import WCS

from app.api.errors import invalid_request
from app.config import PIPELINE_VERSION
from app.contract import DEFAULT_BAND, DEFAULT_FOV, GridInfo
from app.domain import FovStep, Grid, NormalizedRequest

# Escala nativa de SPHEREx: `s_pixel_scale` de ObsCore (spike/RESULTADOS.md, seccion 2).
NATIVE_PIXEL_SCALE_ARCSEC = 6.15

# Limites de `fov` que acepta la API, en grados.
FOV_MIN = 0.02
FOV_MAX = 0.5

# Escalones admitidos, de menor a mayor. El base muestrea dos pixeles de salida
# por pixel nativo; el amplio usa la escala nativa.
FOV_STEPS: tuple[FovStep, ...] = (
    FovStep(name="base", fov=0.1667, pixel_scale_arcsec=3.075, size=195),
    FovStep(name="wide", fov=0.5, pixel_scale_arcsec=6.15, size=293),
)

# Margen del recorte, en pixeles nativos, sobre `fov x raiz(2)`.
CUTOUT_MARGIN_PX = 4

COORD_DECIMALS = 4
_TOLERANCE = 1e-9


def grid_size(fov: float, pixel_scale_arcsec: float) -> int:
    """Lado de la grilla en pixeles. Siempre impar, para que el centro caiga en un pixel."""
    return 2 * int(fov * 3600.0 / pixel_scale_arcsec / 2.0) + 1


def select_step(fov: float) -> FovStep:
    """Escalon para un `fov` pedido: se redondea hacia arriba al admitido mas cercano."""
    if not math.isfinite(fov) or fov < FOV_MIN - _TOLERANCE or fov > FOV_MAX + _TOLERANCE:
        raise invalid_request(f"fov={fov!r} fuera de rango: se admite de {FOV_MIN} a {FOV_MAX} grados")
    for step in FOV_STEPS:
        if fov <= step.fov + _TOLERANCE:
            return step
    return FOV_STEPS[-1]


def field_id(ra: float, dec: float, fov: float, pipeline: str = PIPELINE_VERSION) -> str:
    """Identificador del campo: primeros 16 hex del SHA-256 de `"{pipeline}|{ra:.4f}|{dec:+.4f}|{escalon}"`.

    El escalon se escribe como su `fov` con 4 decimales (`0.1667` o `0.5000`),
    asi el id sale de `request` en el documento de metadatos mas la version del
    pipeline. `ra` y `dec` tienen que venir ya normalizados.
    """
    text = f"{pipeline}|{ra:.4f}|{dec:+.4f}|{fov:.4f}"
    return hashlib.sha256(text.encode("ascii")).hexdigest()[:16]


def normalize_request(
    ra: float,
    dec: float,
    fov: float | None = None,
    band: int | None = None,
    refresh: bool = False,
    *,
    pipeline: str = PIPELINE_VERSION,
) -> NormalizedRequest:
    """Normaliza un pedido de campo (contrato, seccion 3) o lanza `invalid_request`.

    - `ra` se lleva a [0, 360) y se redondea, igual que `dec`, a 4 decimales.
    - `fov` se redondea hacia arriba al escalon admitido; por defecto, el base.
    - `band` es el detector que la persona esta mirando, de 1 a 6; por defecto 3.
    """
    if not (math.isfinite(ra) and math.isfinite(dec)):
        raise invalid_request("ra y dec tienen que ser numeros finitos")
    if dec < -90.0 or dec > 90.0:
        raise invalid_request(f"dec={dec!r} fuera de rango: se admite de -90 a 90 grados")
    band = DEFAULT_BAND if band is None else band
    if isinstance(band, bool) or not isinstance(band, int) or not 1 <= band <= 6:
        raise invalid_request(f"band={band!r} fuera de rango: se admite de 1 a 6")
    step = select_step(DEFAULT_FOV if fov is None else fov)

    # `+ 0.0` convierte -0.0 en 0.0: los dos se escriben distinto y darian ids distintos.
    ra_norm = round(ra % 360.0, COORD_DECIMALS) + 0.0
    if ra_norm >= 360.0:
        ra_norm = 0.0
    dec_norm = round(dec, COORD_DECIMALS) + 0.0
    return NormalizedRequest(
        ra=ra_norm,
        dec=dec_norm,
        fov=step.fov,
        band=band,
        refresh=bool(refresh),
        step=step,
        pipeline=pipeline,
        field_id=field_id(ra_norm, dec_norm, step.fov, pipeline),
    )


# ------------------------------------------------------------------- grilla


def make_grid(ra: float, dec: float, fov: float, pixel_scale_arcsec: float) -> Grid:
    """Grilla TAN centrada en (ra, dec), norte arriba y `x` hacia el oeste.

    Misma construccion que `output_grid` en spike/field.py: lado impar, `crpix`
    en el pixel central (contando desde 1) y `cdelt[0]` negativo.
    """
    n = grid_size(fov, pixel_scale_arcsec)
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [ra, dec]
    wcs.wcs.crpix = [(n + 1) / 2.0, (n + 1) / 2.0]
    wcs.wcs.cdelt = [-pixel_scale_arcsec / 3600.0, pixel_scale_arcsec / 3600.0]
    wcs.wcs.cunit = ["deg", "deg"]
    return Grid(wcs=wcs, shape=(n, n), pixel_scale_arcsec=pixel_scale_arcsec, fov=fov, ra=ra, dec=dec)


def build_grid(request: NormalizedRequest) -> Grid:
    """Grilla del campo de un pedido normalizado."""
    return make_grid(request.ra, request.dec, request.step.fov, request.step.pixel_scale_arcsec)


def grid_info(grid: Grid) -> GridInfo:
    """La grilla como va en el documento de metadatos (`grid`)."""
    crpix = grid.wcs.wcs.crpix
    cdelt = grid.wcs.wcs.cdelt
    return GridInfo(
        projection="TAN",
        crval=(grid.ra, grid.dec),
        crpix=(float(crpix[0]), float(crpix[1])),
        cdelt=(round(float(cdelt[0]), 12), round(float(cdelt[1]), 12)),
        shape=grid.shape,
        fov=grid.fov,
        pixel_scale_arcsec=grid.pixel_scale_arcsec,
        native_pixel_scale_arcsec=NATIVE_PIXEL_SCALE_ARCSEC,
    )


def grid_from_info(info: GridInfo) -> Grid:
    """Reconstruye la grilla a partir del documento de metadatos."""
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = list(info.crval)
    wcs.wcs.crpix = list(info.crpix)
    wcs.wcs.cdelt = list(info.cdelt)
    wcs.wcs.cunit = ["deg", "deg"]
    return Grid(
        wcs=wcs,
        shape=(info.shape[0], info.shape[1]),
        pixel_scale_arcsec=info.pixel_scale_arcsec,
        fov=info.fov,
        ra=info.crval[0],
        dec=info.crval[1],
    )


def sky_to_pixel(grid: Grid, ra: float, dec: float) -> tuple[float, float]:
    """Pixel `(x, y)` de un punto del cielo, con indices desde 0. Puede caer fuera de la grilla."""
    x, y = grid.wcs.world_to_pixel_values(ra, dec)
    return float(x), float(y)


def pixel_to_sky(grid: Grid, x: float, y: float) -> tuple[float, float]:
    """`(ra, dec)` en grados del centro de un pixel, con indices desde 0. `ra` queda en [0, 360)."""
    ra, dec = grid.wcs.pixel_to_world_values(x, y)
    return float(ra) % 360.0, float(dec)


def in_grid(grid: Grid, x: float, y: float) -> bool:
    """Si el punto `(x, y)` cae dentro del area de la grilla (los pixeles miden de -0.5 a n - 0.5)."""
    ny, nx = grid.shape
    return bool(-0.5 <= x < nx - 0.5 and -0.5 <= y < ny - 0.5)


# ------------------------------------------------------------------ recortes


def cutout_side_deg(fov: float) -> float:
    """Lado del recorte que se le pide a IRSA para un campo de lado `fov`, en grados.

    El recorte viene en la orientacion del detector: con `fov x raiz(2)` mas 4
    pixeles nativos la grilla queda cubierta con cualquier giro (contrato,
    seccion 9). Se redondea a 5 decimales porque el lado entra en la URL y en la
    clave de la cache de recortes.
    """
    return round(fov * math.sqrt(2.0) + CUTOUT_MARGIN_PX * NATIVE_PIXEL_SCALE_ARCSEC / 3600.0, 5)


# -------------------------------------------------------------------- cielo


def angular_separation_deg(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    """Separacion angular entre dos puntos, en grados (formula del semiverseno)."""
    a1, d1, a2, d2 = (math.radians(v) for v in (ra1, dec1, ra2, dec2))
    h = math.sin((d2 - d1) / 2.0) ** 2 + math.cos(d1) * math.cos(d2) * math.sin((a2 - a1) / 2.0) ** 2
    return math.degrees(2.0 * math.asin(min(1.0, math.sqrt(h))))
