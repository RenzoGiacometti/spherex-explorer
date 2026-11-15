"""De un recorte de 2MASS o de WISE a la grilla del campo.

La grilla es la del cubo (docs/contrato-cubo.md, secciones 2 y 5): proyeccion
TAN, norte arriba, `x` hacia el oeste, fila 0 = sur. El resultado tiene el
formato de un plano: Float32 de `grid.shape`, `NaN` donde no hay datos.

Que se hace con cada recorte:

1. Se lee la primera imagen de dos dimensiones del FITS y su WCS celeste. Los
   dos relevamientos entregan proyeccion SIN con el norte arriba (encabezados
   reales en tests/fixtures/context). Declaran `EQUINOX = 2000.0` sin `RADESYS`,
   o sea FK5 J2000: se lo trata como ICRS, del que difiere en menos de 0,03",
   una centesima de pixel de la grilla.
2. Se remuestrea a la grilla promediando el area de cada pixel de salida. Un
   pixel de la grilla base mide 3,075" y uno de 2MASS 1": tomar solo el valor
   interpolado en el centro tiraria ocho de cada nueve pixeles de entrada. Por
   eso cada pixel de salida se divide en `k x k` partes (`k` = cociente de
   escalas, redondeado), se interpola en el centro de cada una (bilineal, la
   misma cuenta que `app.pipeline.exposure`) y se promedian. El brillo
   superficial se conserva; el ruido baja.
3. Se resta el fondo (la mediana del recorte ya remuestreado), igual que hace el
   pipeline con los planos de SPHEREx.
4. Se pasa de cuentas a MJy/sr con el punto cero del encabezado (`MAGZP`) y el
   flujo de magnitud cero de la banda, para que el valor tenga la misma unidad
   que un plano de SPHEREx. Es una escala para mirar, no fotometria: las
   imagenes Atlas de WISE estan saturadas en las estrellas brillantes y la
   correccion de apertura no se aplica.

Si el campo cae sobre varias imagenes (2MASS las entrega en franjas de 8,5' de
ancho), `compose_mosaic` las junta.

Hilos: nada se guarda entre llamadas y el WCS de `grid` se copia antes de
usarlo, como en `app.pipeline.exposure`.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales
from numpy.typing import NDArray
from scipy.ndimage import map_coordinates

from app.domain import Grid

ARCSEC_PER_RADIAN = 180.0 * 3600.0 / math.pi

# Un pixel de salida vale si al menos esta fraccion de sus partes cayo sobre datos.
MIN_VALID_FRACTION = 0.5

# Tope de partes por lado de un pixel de salida: con 8 ya se promedian 64 valores.
MAX_OVERSAMPLE = 8


@dataclass(frozen=True, eq=False)
class SurveyCutout:
    """Un recorte de otra mision tal como llega: imagen, WCS celeste y encabezado."""

    data: NDArray[np.float64]  # (ny, nx), NaN sin datos
    wcs: WCS
    header: fits.Header

    @property
    def pixel_scale_arcsec(self) -> float:
        """Escala del recorte, en segundos de arco por pixel (media de los dos ejes)."""
        return pixel_scale_arcsec(self.wcs)


def pixel_scale_arcsec(wcs: WCS) -> float:
    """Escala de un WCS celeste en segundos de arco por pixel: raiz del area de un pixel."""
    scales = proj_plane_pixel_scales(wcs)  # grados por pixel en cada eje
    return math.sqrt(abs(float(scales[0]) * float(scales[1]))) * 3600.0


def read_cutout(path: Path) -> SurveyCutout:
    """Lee un recorte guardado. Lanza `ValueError` si no trae una imagen de dos dimensiones con WCS celeste."""
    path = Path(path)
    try:
        with fits.open(path, memmap=False) as hdul:
            for hdu in hdul:
                if not hdu.is_image or hdu.data is None:
                    continue
                raw = np.squeeze(np.asarray(hdu.data))
                if raw.ndim != 2:
                    continue
                data = raw.astype(np.float64)
                blank = hdu.header.get("BLANK")
                if raw.dtype.kind in "iu" and blank is not None:
                    data[raw == blank] = np.nan
                data[~np.isfinite(data)] = np.nan
                header = hdu.header.copy()
                wcs = WCS(header).celestial
                if not wcs.has_celestial or wcs.naxis != 2:
                    raise ValueError(f"{path.name}: el encabezado no trae un WCS celeste de dos ejes")
                return SurveyCutout(data=data, wcs=wcs, header=header)
    except ValueError:
        raise
    except Exception as exc:  # astropy lanza varias clases con un archivo cortado o que no es FITS
        raise ValueError(f"{path.name}: no se puede leer como recorte: {type(exc).__name__}: {exc}") from exc
    raise ValueError(f"{path.name}: el FITS no trae ninguna imagen de dos dimensiones")


def oversample_for(input_scale_arcsec: float, grid: Grid) -> int:
    """Partes por lado en que se divide un pixel de la grilla: el cociente de escalas, de 1 a `MAX_OVERSAMPLE`."""
    if not (input_scale_arcsec > 0.0):
        return 1
    return int(min(MAX_OVERSAMPLE, max(1, round(grid.pixel_scale_arcsec / input_scale_arcsec))))


def resample_to_grid(
    data: NDArray[np.floating], wcs_in: WCS, grid: Grid, *, oversample: int | None = None
) -> tuple[NDArray[np.float32], NDArray[np.bool_]]:
    """Remuestrea una imagen a la grilla del campo promediando el area de cada pixel de salida.

    Devuelve `(imagen, huella)`. La imagen es Float32 de `grid.shape` con `NaN`
    donde menos de la mitad del pixel cayo sobre datos; la huella es True donde
    alguna parte del pixel cayo dentro de la imagen de entrada, tenga o no datos.

    `oversample` es la cantidad de partes por lado de cada pixel de salida; por
    defecto sale de las dos escalas (`oversample_for`). Con 1 es una
    interpolacion bilineal en el centro del pixel.
    """
    values = np.asarray(data, dtype=np.float64)
    if values.ndim != 2:
        raise ValueError(f"la imagen tiene que ser de dos dimensiones, no de {values.ndim}")
    k = oversample_for(pixel_scale_arcsec(wcs_in), grid) if oversample is None else max(1, int(oversample))
    ny, nx = grid.shape
    ny_in, nx_in = values.shape

    # Centros de las `k x k` partes de cada pixel, en pixeles de la grilla (indices desde 0).
    offsets = (np.arange(k, dtype=np.float64) + 0.5) / k - 0.5
    columns = (np.arange(nx, dtype=np.float64)[:, None] + offsets[None, :]).ravel()  # nx*k
    rows = (np.arange(ny, dtype=np.float64)[:, None] + offsets[None, :]).ravel()  # ny*k
    xx = np.tile(columns, rows.size)
    yy = np.repeat(rows, columns.size)

    # Copia privada: un WCS de astropy no se puede usar desde dos hilos a la vez.
    ra, dec = grid.wcs.deepcopy().all_pix2world(xx, yy, 0)
    x_in, y_in = wcs_in.deepcopy().all_world2pix(ra, dec, 0)
    x_in = np.asarray(x_in, dtype=np.float64)
    y_in = np.asarray(y_in, dtype=np.float64)

    with np.errstate(invalid="ignore"):
        inside = (x_in >= -0.5) & (x_in < nx_in - 0.5) & (y_in >= -0.5) & (y_in < ny_in - 0.5)
    sampled = np.full(xx.size, np.nan, dtype=np.float64)
    if inside.any():
        # Como `reproject`: en la media franja exterior del borde vale el pixel del borde.
        coords = np.stack([np.clip(y_in[inside], 0.0, ny_in - 1.0), np.clip(x_in[inside], 0.0, nx_in - 1.0)])
        sampled[inside] = map_coordinates(values, coords, order=1, mode="constant", cval=np.nan, output=np.float64)

    # De (ny*k, nx*k) a (ny, nx, k*k): las partes de cada pixel de salida, juntas.
    def blocks(array: NDArray[np.generic]) -> NDArray[np.generic]:
        return array.reshape(ny, k, nx, k).transpose(0, 2, 1, 3).reshape(ny, nx, k * k)

    parts = blocks(sampled)
    valid = np.isfinite(parts)
    count = valid.sum(axis=2)
    total = np.where(valid, parts, 0.0).sum(axis=2)
    enough = count >= max(1, math.ceil(MIN_VALID_FRACTION * k * k))
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = np.where(enough, total / np.maximum(count, 1), np.nan)
    with np.errstate(over="ignore", invalid="ignore"):
        image = mean.astype(np.float32)
    image[~np.isfinite(image)] = np.nan
    footprint = blocks(inside).any(axis=2)
    return image, footprint


def background_level(image: NDArray[np.floating]) -> float:
    """Nivel de fondo de una imagen: la mediana de sus pixeles finitos (0 si no hay ninguno).

    Las fuentes ocupan una fraccion chica de un campo de 10 minutos, asi que la
    mediana es el cielo. Es la misma eleccion del pipeline de SPHEREx.
    """
    values = image[np.isfinite(image)]
    return float(np.median(values)) if values.size else 0.0


def surface_brightness_factor(magzp: float, zero_flux_jy: float, pixel_scale: float) -> float:
    """Factor que pasa de cuentas por pixel a MJy/sr.

    Una fuente de `DN` cuentas tiene magnitud `m = MAGZP - 2,5 log10(DN)` y
    flujo `F = F0 x 10^(-0,4 m)`, asi que una cuenta vale `F0 x 10^(-0,4 MAGZP)`
    Jy. Dividido por el angulo solido del pixel da Jy/sr, y por 10^6, MJy/sr.

    `pixel_scale` es la escala del recorte de origen en segundos de arco.
    """
    if not (pixel_scale > 0.0 and zero_flux_jy > 0.0 and math.isfinite(magzp)):
        raise ValueError("punto cero, flujo de magnitud cero o escala invalidos")
    jy_per_count = zero_flux_jy * 10.0 ** (-0.4 * magzp)
    steradians = (pixel_scale / ARCSEC_PER_RADIAN) ** 2
    return jy_per_count / steradians * 1e-6


def reproject_cutout(
    cutout: SurveyCutout, grid: Grid, *, zero_flux_jy: float | None = None, magzp: float | None = None
) -> tuple[NDArray[np.float32], NDArray[np.bool_]]:
    """Un recorte llevado a la grilla, con el fondo restado y, si se puede, en MJy/sr.

    Con `zero_flux_jy` (flujo de magnitud cero de la banda, en Jy) convierte a
    MJy/sr usando `magzp` o, si no se pasa, el `MAGZP` del encabezado. Sin el,
    deja las cuentas del relevamiento. Devuelve `(imagen, huella)`.
    """
    image, footprint = resample_to_grid(cutout.data, cutout.wcs, grid)
    image = image - np.float32(background_level(image))
    if zero_flux_jy is not None:
        zero_point = cutout.header.get("MAGZP") if magzp is None else magzp
        if zero_point is None:
            raise ValueError("el encabezado no trae MAGZP: no se puede pasar a MJy/sr")
        factor = surface_brightness_factor(float(zero_point), zero_flux_jy, cutout.pixel_scale_arcsec)
        image = (image.astype(np.float64) * factor).astype(np.float32)
    return image, footprint


def compose_mosaic(tiles: Sequence[NDArray[np.floating]]) -> NDArray[np.float32]:
    """Junta varias imagenes ya reproyectadas a la misma grilla.

    Cada pixel toma el valor de la primera imagen que lo tiene, en el orden
    dado: no se promedian, porque dos imagenes pueden ser de noches distintas y
    un objeto que se mueve quedaria doble. Quien llama las ordena (la que mas
    cubre el campo, primero). `NaN` donde ninguna tiene datos.
    """
    if not tiles:
        raise ValueError("no hay imagenes para juntar")
    shape = tiles[0].shape
    mosaic = np.full(shape, np.nan, dtype=np.float32)
    for tile in tiles:
        if tile.shape != shape:
            raise ValueError(f"las imagenes no miden lo mismo: {tile.shape} y {shape}")
        empty = ~np.isfinite(mosaic)
        mosaic[empty] = np.asarray(tile, dtype=np.float32)[empty]
    mosaic[~np.isfinite(mosaic)] = np.nan
    return mosaic


def valid_fraction(image: NDArray[np.floating]) -> float:
    """Fraccion de pixeles con datos."""
    return float(np.isfinite(image).sum()) / image.size if image.size else 0.0
