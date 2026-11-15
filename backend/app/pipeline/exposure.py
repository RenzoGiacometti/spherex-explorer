"""De un recorte en disco a una exposicion reproyectada a la grilla del campo.

Misma ciencia que `load_and_reproject` en spike/field.py, que ya se probo con
recortes reales: IMAGE - ZODI - mediana residual, mascara por nombre de flag y
reproyeccion bilineal. Lo que el contrato pide de mas (docs/contrato-cubo.md,
secciones 6, 7 y 9) son los flags reproyectados, la huella del recorte y la
tabla de bits de cada archivo.

Diferencia de implementacion con el spike: la correspondencia entre los pixeles
de la grilla y los del recorte se calcula una sola vez y se usa para la imagen,
la varianza, los flags y la huella. La interpolacion es la misma que hace
`reproject_interp` (scipy `map_coordinates` de orden 1 sobre coordenadas
recortadas al borde), y `tests/test_pipeline_exposure.py` compara los dos
resultados sobre los recortes reales.

Hilos: `load_exposure` no guarda nada entre llamadas y no usa el WCS de `grid`
para transformar, sino una copia privada, asi que se puede llamar desde varios
hilos a la vez con el mismo `Grid`.
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, NoConvergence
from numpy.typing import NDArray
from scipy.ndimage import map_coordinates

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

# Flag de los pixeles que pertenecen a una fuente conocida. No se enmascara; se
# usa para dejarlos afuera de la mediana del fondo residual.
SOURCE_FLAG = "SOURCE"

# El fondo residual sale de los pixeles sin fuente solo si quedan al menos estos
# (igual que el spike); si no, de todos los validos.
MIN_SKY_PIXELS = 50

# Extensiones que hacen falta, por EXTNAME (contrato, seccion 9).
REQUIRED_EXTENSIONS: tuple[str, ...] = ("IMAGE", "FLAGS", "VARIANCE", "ZODI")

# FLAGS es un entero de 32 bits: los bits van de 0 a 31.
FLAG_BITS = 32

# Palabras clave de la tabla de bits en el encabezado de FLAGS (tutorial
# spherex-intro de IRSA, seccion 9, y encabezados reales en tests/fixtures/cutouts):
# MSKNnnnn = nombre del bit nnnn, MSKDnnnn = descripcion.
_NAME_KEY = "MSKN"
_DESCRIPTION_KEY = "MSKD"

# Tarjetas con las que se arma el WCS del recorte: las del WCS primario (sin letra de
# version alternativa) del estandar FITS 4.0, seccion 8, y los coeficientes de la convencion
# SIP. Los encabezados reales de IMAGE (tests/fixtures/cutouts) traen WCSAXES, CRPIXj,
# PCi_j, CDELTi, CUNITi, CTYPEi, CRVALi, LONPOLE, LATPOLE, RADESYS y A_, B_, AP_ y BP_
# (ORDER y p_q); CDi_j, PVi_m, CROTAi, EQUINOX y A_DMAX/B_DMAX son las otras formas
# estandar de escribir ese mismo WCS, por si una version futura del procesamiento las usa.
#
# El resto no se le pasa a astropy. Ese encabezado trae ademas dos WCS alternativos que
# aca no se usan (A, pixeles del detector, y W, la tabla de longitud de onda WAVE-TAB), y
# con una tarjeta danada del W, `WCS(header)` no lanza una excepcion: corrompe la memoria
# dentro de wcslib y tumba el proceso (astropy 8.0.2; visto con `CTYPE1W` ilegible). Con
# las tarjetas del primario la correspondencia de pixeles es identica bit a bit (medido
# sobre 2242 recortes reales) y armar el WCS tarda un tercio: 4,4 ms en vez de 13,7.
_WCS_KEYWORD = re.compile(
    r"WCSAXES|(?:CTYPE|CUNIT|CRVAL|CDELT|CRPIX|CROTA)[1-9]|(?:PC|CD)[1-9]_[1-9]|PV[1-9]_[0-9]{1,2}"
    r"|LONPOLE|LATPOLE|RADESYS|EQUINOX|[AB]P?_ORDER|[AB]P?_[0-9]_[0-9]|[AB]_DMAX"
)


def read_flag_table(header: fits.Header) -> tuple[dict[str, int], dict[str, str]]:
    """Tabla de bits del encabezado de FLAGS: `(nombre -> bit, nombre -> descripcion)`.

    Cada archivo trae la suya y no todos declaran los mismos bits. Lanza
    `ValueError` si el encabezado no declara ninguno, si un bit no entra en 32
    bits, si un mismo nombre aparece en dos bits o si una tarjeta `MSKNnnnn` o
    `MSKDnnnn` no se puede interpretar (un archivo danado).
    """
    bits: dict[str, int] = {}
    descriptions: dict[str, str] = {}
    try:
        for key in header[f"{_NAME_KEY}*"]:
            suffix = key[len(_NAME_KEY) :]
            if not suffix.isdigit():
                continue
            bit = int(suffix)
            name = str(header[key]).strip()
            if not name:
                raise ValueError(f"FLAGS: {key} no trae nombre")
            if bit >= FLAG_BITS:
                raise ValueError(f"FLAGS: {key} ({name}) declara un bit que no entra en {FLAG_BITS} bits")
            if name in bits:
                raise ValueError(f"FLAGS: el nombre {name} aparece en los bits {bits[name]} y {bit}")
            bits[name] = bit
            description = header.get(f"{_DESCRIPTION_KEY}{suffix}")
            if description is not None and str(description).strip():
                descriptions[name] = str(description).strip()
    except fits.VerifyError as exc:
        # astropy interpreta cada tarjeta recien al leer su valor, y una que no puede
        # interpretar lanza VerifyError, que no es ninguno de los tipos de `load_exposure`.
        raise ValueError(f"FLAGS: una tarjeta de la tabla de bits no se puede interpretar: {exc}") from exc
    if not bits:
        raise ValueError(f"FLAGS: el encabezado no declara ningun bit ({_NAME_KEY}nnnn)")
    return bits, descriptions


def flag_mask(flag_bits: dict[str, int], names: tuple[str, ...]) -> int:
    """Mascara con los bits de `names` que la tabla `flag_bits` declara."""
    mask = 0
    for name in names:
        bit = flag_bits.get(name)
        if bit is not None:
            mask |= 1 << bit
    return mask


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

    Detalles del resultado:
    - `image` es finita exactamente donde `variance` es finita y positiva. Un
      pixel de la grilla queda en NaN si alguno de los cuatro pixeles del
      recorte que lo rodean esta descartado.
    - `footprint` es True donde el centro del pixel de la grilla cae dentro del
      recorte, este o no enmascarado. Fuera de la huella, `image` y `variance`
      son NaN y `flags` vale 0.
    - `flags` trae todos los bits del archivo, tambien los que su encabezado no
      declara. Solo se enmascaran los de `MASKED_FLAGS` que el archivo declara.

    Se puede llamar desde varios hilos a la vez con el mismo `grid`.

    Lanza `OSError`, `KeyError` o `ValueError` si el archivo no se puede leer o
    le falta una extension, y ninguna otra excepcion: una tarjeta del encabezado
    que astropy no puede interpretar (un archivo danado) tambien es `ValueError`.
    Quien recibe cualquiera de las tres sobre un recorte de la cache lo descarta
    con `app.irsa.cutouts.discard_cutout` y lo vuelve a pedir.

    El WCS se arma solo con las tarjetas del WCS primario del encabezado de
    IMAGE (`wcs_cards`), no con el encabezado entero: los WCS alternativos que
    trae el archivo no se usan, y uno danado puede tumbar el proceso dentro de
    astropy en vez de lanzar una excepcion.
    """
    path = Path(path)
    image, flags, variance, zodi, header, flag_header = _read_cutout(path)
    flag_bits, flag_descriptions = read_flag_table(flag_header)

    # Limpieza, en pixeles del recorte: igual que el spike.
    data = image - zodi
    masked_bits = np.uint32(flag_mask(flag_bits, MASKED_FLAGS))
    with np.errstate(invalid="ignore"):
        bad = ((flags & masked_bits) != 0) | ~np.isfinite(data) | ~np.isfinite(variance) | (variance <= 0)

    # Fondo residual tras restar ZODI: mediana de los pixeles validos que no
    # pertenecen a fuentes conocidas (flag SOURCE), si quedan suficientes.
    background = 0.0
    sky = ~bad
    source_bit = flag_bits.get(SOURCE_FLAG)
    if source_bit is not None:
        no_source = sky & ((flags & np.uint32(1 << source_bit)) == 0)
        if int(no_source.sum()) >= MIN_SKY_PIXELS:
            sky = no_source
    if sky.any():
        background = float(np.median(data[sky]))
        data = data - background
    data[bad] = np.nan
    variance[bad] = np.nan

    # Correspondencia de pixeles, una sola vez para todo lo que se reproyecta.
    try:
        x, y = _cutout_pixels_of_grid(grid, _celestial_wcs(header, path))
    except NoConvergence as exc:
        raise ValueError(f"{path.name}: el WCS del recorte no converge sobre la grilla: {str(exc)[:200]}") from exc
    ny_in, nx_in = data.shape
    with np.errstate(invalid="ignore"):
        inside = (x >= -0.5) & (x < nx_in - 0.5) & (y >= -0.5) & (y < ny_in - 0.5)
    # Como `reproject`: en la media franja exterior de los pixeles del borde se
    # usa el valor del pixel del borde.
    x_in = np.clip(x[inside], 0.0, nx_in - 1.0)
    y_in = np.clip(y[inside], 0.0, ny_in - 1.0)

    n_pixels = grid.shape[0] * grid.shape[1]
    image_out = np.full(n_pixels, np.nan, dtype=np.float32)
    variance_out = np.full(n_pixels, np.nan, dtype=np.float32)
    flags_out = np.zeros(n_pixels, dtype=np.uint32)
    if x_in.size:
        coords = np.stack([y_in, x_in])
        image_in = _bilinear(data, coords)
        variance_in = _bilinear(variance, coords)
        with np.errstate(over="ignore", invalid="ignore"):
            image_32 = image_in.astype(np.float32)
            variance_32 = variance_in.astype(np.float32)
            # En Float32 un valor puede desbordar o una varianza quedar en 0: se descartan los dos.
            keep = np.isfinite(image_32) & np.isfinite(variance_32) & (variance_32 > 0)
        image_out[inside] = np.where(keep, image_32, np.float32(np.nan))
        variance_out[inside] = np.where(keep, variance_32, np.float32(np.nan))
        # Vecino mas cercano con indices enteros: ningun bit pasa por coma flotante.
        rows = np.floor(y_in + 0.5).astype(np.intp)
        cols = np.floor(x_in + 0.5).astype(np.intp)
        flags_out[inside] = flags[rows, cols]

    return ReprojectedExposure(
        image=image_out.reshape(grid.shape),
        variance=variance_out.reshape(grid.shape),
        flags=flags_out.reshape(grid.shape),
        footprint=inside.reshape(grid.shape),
        flag_bits=flag_bits,
        background=background,
        flag_descriptions=flag_descriptions,
    )


# ------------------------------------------------------------------- lectura


def _read_cutout(
    path: Path,
) -> tuple[NDArray[np.float64], NDArray[np.uint32], NDArray[np.float64], NDArray[np.float64], fits.Header, fits.Header]:
    """Lee las cuatro extensiones por nombre, esten en el orden que esten.

    Devuelve `(image, flags, variance, zodi, encabezado de IMAGE, encabezado de FLAGS)`.
    """
    try:
        with fits.open(path, memmap=False) as hdul:
            planes: dict[str, NDArray[np.generic]] = {}
            headers: dict[str, fits.Header] = {}
            for name in REQUIRED_EXTENSIONS:
                hdu = hdul[name]  # KeyError si falta la extension
                data = hdu.data
                if data is None or getattr(data, "ndim", 0) != 2:
                    raise ValueError(f"{path.name}: la extension {name} no trae una imagen de dos dimensiones")
                planes[name] = data
                headers[name] = hdu.header
            shapes = {name: plane.shape for name, plane in planes.items()}
            if len(set(shapes.values())) != 1:
                raise ValueError(f"{path.name}: las extensiones no miden lo mismo: {shapes}")
            image = planes["IMAGE"].astype(np.float64)
            variance = planes["VARIANCE"].astype(np.float64)
            zodi = planes["ZODI"].astype(np.float64)
            flags = _as_uint32(planes["FLAGS"], path)
            return image, flags, variance, zodi, headers["IMAGE"], headers["FLAGS"]
    except (OSError, KeyError, ValueError):
        raise
    except (TypeError, IndexError, AttributeError, EOFError, fits.VerifyError) as exc:
        # Lo que lanza astropy con un archivo cortado o corrupto, llevado a un solo tipo. VerifyError
        # sale de una tarjeta que no puede interpretar, por ejemplo el `EXTNAME` por el que se busca.
        raise ValueError(f"{path.name}: no se puede leer como recorte: {type(exc).__name__}: {exc}") from exc


def _as_uint32(flags: NDArray[np.generic], path: Path) -> NDArray[np.uint32]:
    """FLAGS como uint32, con los mismos 32 bits que trae el archivo (que los guarda como entero con signo)."""
    if flags.dtype.kind not in "iu":
        raise ValueError(f"{path.name}: FLAGS no es un entero ({flags.dtype})")
    if flags.dtype.itemsize > 4:
        if flags.size and (int(flags.min()) < -(2**31) or int(flags.max()) >= 2**32):
            raise ValueError(f"{path.name}: FLAGS no entra en {FLAG_BITS} bits")
        return (flags.astype(np.int64) & 0xFFFFFFFF).astype(np.uint32)
    if flags.dtype.kind == "i":
        # El bit 31 de un int32 es el signo: se conserva el patron de bits, no el valor.
        return flags.astype(np.int32).view(np.uint32)
    return flags.astype(np.uint32)


# -------------------------------------------------------------- reproyeccion


def wcs_cards(header: fits.Header) -> fits.Header:
    """Las tarjetas del WCS primario del encabezado de IMAGE, y nada mas (ver `_WCS_KEYWORD`).

    De las 276 tarjetas de un recorte quedan 62. Lanza `fits.VerifyError` si
    alguna de las que quedan no se puede interpretar.
    """
    cards = [card for card in header.cards if _WCS_KEYWORD.fullmatch(card.keyword)]
    for card in cards:
        # astropy interpreta cada tarjeta recien al leer su valor: mejor que falle aca, con una
        # excepcion de Python, que dentro de wcslib con una tarjeta a medio interpretar.
        _ = card.value
    return fits.Header(cards)


def _celestial_wcs(header: fits.Header, path: Path) -> WCS:
    """WCS del recorte (TAN con distorsion SIP), armado solo con las tarjetas del WCS primario.

    Lanza `ValueError` si el encabezado no trae un WCS celeste de dos ejes en
    ICRS o si alguna de sus tarjetas no se puede interpretar.
    """
    try:
        radesys = str(header.get("RADESYS", "ICRS")).strip().upper()
        wcs = WCS(wcs_cards(header))
        usable = bool(wcs.has_celestial) and wcs.naxis == 2
    except Exception as exc:
        # VerifyError de una tarjeta ilegible, o lo que lance wcslib con valores sin sentido:
        # de `load_exposure` solo salen OSError, KeyError y ValueError.
        raise ValueError(
            f"{path.name}: el WCS del encabezado de IMAGE no se puede interpretar: {type(exc).__name__}: {exc}"
        ) from exc
    # La grilla esta en ICRS y los niveles 2 de SPHEREx tambien (RADESYS). Otro
    # sistema necesitaria una conversion que aca no se hace.
    if radesys != "ICRS":
        raise ValueError(f"{path.name}: RADESYS={radesys!r}; solo se admite ICRS")
    if not usable:
        raise ValueError(f"{path.name}: el encabezado de IMAGE no trae un WCS celeste de dos ejes")
    return wcs


def _cutout_pixels_of_grid(grid: Grid, wcs_in: WCS) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Posicion `(x, y)` en pixeles del recorte del centro de cada pixel de la grilla, aplanada fila por fila.

    Mismo camino que `reproject_interp`: pixel de la grilla -> cielo -> pixel
    del recorte, con la inversion iterativa de la distorsion SIP de astropy.
    Lanza `NoConvergence` si esa inversion no converge (un recorte muy lejos del
    campo).
    """
    ny, nx = grid.shape
    # Copia privada del WCS de la grilla: un WCS de astropy no se puede usar
    # desde dos hilos a la vez (wcslib modifica la estructura al transformar).
    out_wcs = grid.wcs.deepcopy()
    columns = np.tile(np.arange(nx, dtype=np.float64), ny)
    rows = np.repeat(np.arange(ny, dtype=np.float64), nx)
    ra, dec = out_wcs.all_pix2world(columns, rows, 0)
    x, y = wcs_in.all_world2pix(ra, dec, 0)
    return np.asarray(x, dtype=np.float64), np.asarray(y, dtype=np.float64)


def _bilinear(array: NDArray[np.float64], coords: NDArray[np.float64]) -> NDArray[np.float64]:
    """Interpolacion bilineal en `coords` (filas, columnas), ya dentro del arreglo.

    La misma llamada que hace `reproject_interp` con `order="bilinear"`. Un NaN
    en cualquiera de los cuatro vecinos da NaN.
    """
    return map_coordinates(array, coords, order=1, mode="constant", cval=np.nan, output=np.float64)
