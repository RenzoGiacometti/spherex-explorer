"""Imagenes de 2MASS y de WISE que cubren un campo, y su recorte por coordenadas. Usa la red.

Todo verificado contra IRSA el 2026-11-15 (docs/contexto.md, con las URL exactas).

Recorte por coordenadas
    `<url de la imagen>?center=<ra>,<dec>deg&size=<lado>deg&gzip=false`,
    documentado en https://irsa.ipac.caltech.edu/ibe/cutouts.html ("Quick start
    guide for IBE cutouts"). Sirve para cualquier imagen servida desde
    `/ibe/data/`. Sin `gzip=false` el recorte llega comprimido. Si se sale de la
    imagen llega cortado al borde, y si no la toca en absoluto el servicio
    responde 500.

Que imagenes cubren el campo: un servicio por mision, y SIA2 de respaldo
    2MASS: el servicio de imagenes de 2MASS,
    `https://irsa.ipac.caltech.edu/cgi-bin/2MASS/IM/nph-im_sia`, con `POS`,
    `SIZE`, `FORMAT=image/fits`, `band`, `ds=asky` (All-Sky Release) y
    `type=at` (imagenes Atlas). Documentado en
    https://irsa.ipac.caltech.edu/applications/2MASS/IM/docs/siahelp.html.
    Devuelve un VOTable; de cada fila se usan `date`, `hem`, `scan`, `image`,
    `center_ra`, `center_dec` y el nombre del archivo, que viene en el parametro
    `name` de la columna `download`. Con eso se arma la URL de la imagen como
    indica https://irsa.ipac.caltech.edu/ibe/docs/twomass/allsky/allsky/:
    `/data/twomass/allsky/allsky/{ordate}{hemisphere}/s{scanno:03d}/image/{fname}`,
    con `fname` terminado en `.fits.gz`.

    WISE: la tabla de metadatos de las imagenes Atlas de AllWISE,
    `allwise_p3am_cdd`, consultada por Gator
    (`https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query`, con
    `spatial=None` y `constraints`). Las columnas salen de su diccionario,
    https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-dd?catalog=allwise_p3am_cdd&mode=ascii:
    `coadd_id`, `band`, `crval1`, `crval2` (centro del mosaico), `naxis1`,
    `naxis2`, `pxscal1`, `date_obs1`, `mid_obs` y `date_obs2`. La busqueda de
    cono de Gator no sirve aca: su radio maximo es menor que medio mosaico. La
    URL se arma como indica https://irsa.ipac.caltech.edu/ibe/docs/wise/allwise/p3am_cdd/:
    `/data/wise/allwise/p3am_cdd/{coadd_id[:2]}/{coadd_id[:4]}/{coadd_id}/{coadd_id}-w{band}-int-3.fits`.

    SIA2 (`https://irsa.ipac.caltech.edu/SIA`, colecciones `twomass_allsky` y
    `wise_allwise` de https://irsa.ipac.caltech.edu/include/SIA2_collection_info.tsv)
    da lo mismo con una sola interfaz y trae la URL ya armada en `access_url`,
    pero ese dia tardo 21 s cuando respondio y se colgo mas de 90 s la mitad de
    las veces. Por eso va segundo: los servicios de cada mision contestaron
    siempre en 1 a 2 s. En SIA2 la imagen de ciencia es la fila con
    `dataproduct_subtype = science`, y `energy_bandpassname` vale `J`, `H` y
    `K` en 2MASS y `W1` a `W4` en WISE.

    El buscador IBE (`/ibe/search/...`) y SIA v1 (`/ibe/sia/...`) no
    respondieron ese dia.

Fechas. Una imagen Atlas de 2MASS es de una sola noche: su encabezado trae
`UT_DATE` (aammdd) y `UT`. Una de AllWISE es la suma de todas las pasadas de
2010 y 2011 sobre esa zona: el encabezado trae `DATEOBS1` y `DATEOBS2`, el
intervalo, y `MIDOBS`, la fecha media de las exposiciones, que es la que se
informa. `observation_times` las lee del recorte mismo, asi no dependen de por
donde se listo la imagen.

Cache en `cache/context/` (git la ignora): las listas por mision, centro y
radio, y cada recorte por imagen, centro y lado. No vencen: son relevamientos
cerrados.
"""

from __future__ import annotations

import contextlib
import io
import math
import os
import re
import threading
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs, urlsplit

from astropy.io import ascii as ascii_tables
from astropy.io import fits
from astropy.io.votable import parse as parse_votable
from astropy.time import Time

from app.config import Settings
from app.context.http import ContextFetchError, get_bytes
from app.irsa.limits import get_limiter

SurveyName = Literal["2MASS", "WISE"]

IBE_DATA_URL = "https://irsa.ipac.caltech.edu/ibe/data"
TWOMASS_LIST_URL = "https://irsa.ipac.caltech.edu/cgi-bin/2MASS/IM/nph-im_sia"
GATOR_URL = "https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query"
WISE_ATLAS_TABLE = "allwise_p3am_cdd"
WISE_ATLAS_COLUMNS = (
    "coadd_id", "band", "crval1", "crval2", "naxis1", "naxis2", "pxscal1", "date_obs1", "mid_obs", "date_obs2",
)  # fmt: skip

# Medio lado de un mosaico Atlas de AllWISE: 4095 px de 1,375" (valores de `naxis1` y `pxscal1`
# en la tabla). Solo sirve para acotar la consulta; el tamano real sale de cada fila.
WISE_TILE_HALF_DEG = 4095 * 1.375 / 3600.0 / 2.0

# Margen de la comprobacion de solapamiento, en segundos de arco: es una cuenta plana.
OVERLAP_MARGIN_ARCSEC = 60.0

_FITS_SIGNATURE = b"SIMPLE  ="
_FITS_BLOCK = 2880
# Un recorte de 0,25 grados pesa 1,7 MB (WISE) o hasta 2,1 MB (2MASS): mas que esto no es esperable.
MAX_CUTOUT_BYTES = 64 * 1024 * 1024
MAX_LIST_BYTES = 32 * 1024 * 1024
# Intentos por recorte. Menos que con SPHEREx: un 500 puede ser "no toca la imagen" y no cambia.
CUTOUT_ATTEMPTS = 3
# Con SIA2 de respaldo no se espera mas que esto por intento: cuando se cuelga, se cuelga del todo.
SIA_FALLBACK_TIMEOUT_S = 45.0


@dataclass(frozen=True)
class SurveyBand:
    """Una banda de un relevamiento de contexto."""

    key: str  # nombre del archivo guardado y del parametro `layer` de la API
    survey: SurveyName
    band: str  # como se muestra: "Ks", "W2"
    collection: str  # coleccion de SIA2
    sia_band: str  # `energy_bandpassname` en SIA2; en 2MASS, tambien el parametro `band` de su servicio
    wave_um: float
    # Flujo de una fuente de magnitud cero, en Jy (ver `app.context.reproject.surface_brightness_factor`).
    zero_flux_jy: float


# 2MASS: longitudes de onda isofotales y flujos de magnitud cero del Explanatory Supplement,
# seccion VI.4a, tabla 2 (Cohen, Wheaton y Megeath 2003):
# https://irsa.ipac.caltech.edu/data/2MASS/docs/releases/allsky/doc/sec6_4a.html
# WISE: flujos de magnitud cero del Explanatory Supplement, seccion IV.4.h, tabla 1
# (columna F_nu0), y longitudes de onda de la palabra clave WAVELEN de las imagenes Atlas:
# https://irsa.ipac.caltech.edu/data/WISE/docs/release/All-Sky/expsup/sec4_4h.html
BANDS: tuple[SurveyBand, ...] = (
    SurveyBand("twomass_j", "2MASS", "J", "twomass_allsky", "J", 1.235, 1594.0),
    SurveyBand("twomass_h", "2MASS", "H", "twomass_allsky", "H", 1.662, 1024.0),
    SurveyBand("twomass_ks", "2MASS", "Ks", "twomass_allsky", "K", 2.159, 666.7),
    SurveyBand("wise_w1", "WISE", "W1", "wise_allwise", "W1", 3.368, 309.540),
    SurveyBand("wise_w2", "WISE", "W2", "wise_allwise", "W2", 4.618, 171.787),
)

# Lo que se guarda por defecto: una banda de cada mision. Ks es la de 2MASS mas cercana a
# SPHEREx (cae dentro de B3). De WISE va W2 y no W1 porque en W2 se ve WISE 0855, que en W1
# no se detecta; las estrellas se ven en las dos.
DEFAULT_BAND_KEYS: tuple[str, ...] = ("twomass_ks", "wise_w2")


def band_by_key(key: str) -> SurveyBand:
    """La banda con esa clave. Lanza `KeyError` si no existe."""
    for band in BANDS:
        if band.key == key:
            return band
    raise KeyError(key)


@dataclass(frozen=True)
class SurveyImage:
    """Una imagen de ciencia de un relevamiento."""

    obs_id: str
    url: str  # URL de la imagen entera, sin los parametros del recorte
    # Fechas segun la lista (MJD). Las definitivas se leen del recorte (`observation_times`).
    mjd_start: float | None = None
    mjd_end: float | None = None
    # Centro y medio tamano, si la lista los trae: sirven para no pedir un recorte que no toca el campo.
    center_ra: float | None = None
    center_dec: float | None = None
    half_width_arcsec: float | None = None
    half_height_arcsec: float | None = None

    @property
    def file_name(self) -> str:
        """Nombre del archivo en IRSA."""
        return self.url.rsplit("/", 1)[-1]


def may_overlap(image: SurveyImage, ra: float, dec: float, field_half_arcsec: float) -> bool:
    """Si la imagen puede tocar un campo cuadrado de ese medio lado. Sin datos de la imagen, se supone que si."""
    if None in (image.center_ra, image.center_dec, image.half_width_arcsec, image.half_height_arcsec):
        return True
    delta_ra = (float(image.center_ra) - ra + 180.0) % 360.0 - 180.0  # type: ignore[arg-type]
    dx = abs(delta_ra) * math.cos(math.radians(dec)) * 3600.0
    dy = abs(float(image.center_dec) - dec) * 3600.0  # type: ignore[arg-type]
    reach = field_half_arcsec + OVERLAP_MARGIN_ARCSEC
    return dx < float(image.half_width_arcsec) + reach and dy < float(image.half_height_arcsec) + reach  # type: ignore[arg-type]


# --------------------------------------------------------------------- cache


def context_cache_dir(settings: Settings) -> Path:
    """Raiz de la cache de contexto. No se versiona."""
    return settings.cache_dir / "context"


def _write_atomic(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        tmp.write_bytes(payload)
        os.replace(tmp, path)
    finally:
        with contextlib.suppress(OSError):
            tmp.unlink()


def _safe(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", text)


def list_cache_path(
    band: SurveyBand, source: str, ra: float, dec: float, radius_deg: float, settings: Settings
) -> Path:
    """Archivo de la cache de una lista. `source` dice de que servicio salio y da la extension."""
    extension = {"twomass": "xml", "gator": "tbl", "sia": "xml"}[source]
    name = f"{band.key}__{source}__{ra:.6f}_{dec:+.6f}_{radius_deg:.5f}.{extension}"
    return context_cache_dir(settings) / "lists" / name


# ------------------------------------------------------------------ 2MASS IM


def _twomass_year(two_digits: str) -> int:
    """Anio de una fecha `aammdd` de 2MASS, que observo de 1997 a 2001."""
    year = int(two_digits)
    return 1900 + year if year >= 90 else 2000 + year


def twomass_image_url(date: str, hemisphere: str, scan: int, file_name: str) -> str:
    """URL de una imagen Atlas de 2MASS segun la documentacion del IBE (ver el encabezado del modulo)."""
    name = file_name if file_name.endswith(".gz") else f"{file_name}.gz"
    return f"{IBE_DATA_URL}/twomass/allsky/allsky/{date}{hemisphere}/s{scan:03d}/image/{name}"


def parse_twomass_list(payload: bytes) -> list[SurveyImage]:
    """Imagenes de una respuesta del servicio de imagenes de 2MASS. Lanza `ValueError` si no es su VOTable."""
    try:
        votable = parse_votable(io.BytesIO(payload), verify="ignore")
        tables = list(votable.iter_tables())
    except Exception as exc:  # astropy lanza varias clases segun donde falle el XML
        raise ValueError(f"la respuesta no es un VOTable: {type(exc).__name__}: {exc}") from exc
    if not tables:
        raise ValueError("el VOTable no trae ninguna tabla")
    table = tables[0].to_table(use_names_over_ids=True)
    if len(table) == 0:
        return []
    names = ("download", "center_ra", "center_dec", "naxis", "scale", "date", "hem", "scan", "image", "ut_date")
    missing = [name for name in names if name not in table.colnames]
    if missing:
        raise ValueError(f"faltan las columnas {missing}")
    columns = {name: table[name].tolist() for name in names}

    images: dict[str, SurveyImage] = {}
    for i in range(len(table)):
        row = {name: values[i] for name, values in columns.items()}
        try:
            file_names = parse_qs(urlsplit(str(row["download"]).strip()).query).get("name", [])
            date, hemisphere, scan = str(row["date"]).strip(), str(row["hem"]).strip(), int(row["scan"])
            ut_date = str(row["ut_date"]).strip()
            night = Time(f"{_twomass_year(ut_date[:2]):04d}-{ut_date[2:4]}-{ut_date[4:6]}", format="iso", scale="utc")
            width, height = (abs(float(n) * float(s)) * 3600.0 for n, s in zip(row["naxis"], row["scale"], strict=True))
            center = float(row["center_ra"]), float(row["center_dec"])
            number = int(row["image"])
        except (TypeError, ValueError, IndexError):
            continue
        if not file_names or not re.fullmatch(r"\d{6}", date) or hemisphere not in ("n", "s"):
            continue
        url = twomass_image_url(date, hemisphere, scan, file_names[0])
        images.setdefault(
            url,
            SurveyImage(
                # El mismo identificador que da SIA2 (`obs_id`), para que la cache de recortes coincida.
                obs_id=f"allsky_{date}{hemisphere}_s{scan:03d}_{number:04d}",
                url=url,
                mjd_start=float(night.mjd),
                mjd_end=float(night.mjd),
                center_ra=center[0],
                center_dec=center[1],
                half_width_arcsec=width / 2.0,
                half_height_arcsec=height / 2.0,
            ),
        )
    return sorted(images.values(), key=lambda image: image.url)


def _list_twomass(band: SurveyBand, ra: float, dec: float, radius_deg: float, settings: Settings) -> bytes:
    params = {
        "POS": f"{ra:.6f},{dec:.6f}",
        # `SIZE` es el tamano de la region; con el diametro del circulo entran todas las que tocan el campo.
        "SIZE": f"{2.0 * radius_deg:.5f}",
        "FORMAT": "image/fits",
        "band": band.sia_band,
        "ds": "asky",
        "type": "at",
    }
    return get_bytes(
        TWOMASS_LIST_URL,
        settings,
        slot=get_limiter(settings).sia_slot,
        what="lista de imagenes de 2MASS",
        params=params,
        max_bytes=MAX_LIST_BYTES,
    )


# ----------------------------------------------------------------- WISE Atlas


def wise_image_url(coadd_id: str, band_number: int) -> str:
    """URL de una imagen Atlas de AllWISE segun la documentacion del IBE (ver el encabezado del modulo)."""
    folder = f"{IBE_DATA_URL}/wise/allwise/p3am_cdd/{coadd_id[:2]}/{coadd_id[:4]}/{coadd_id}"
    return f"{folder}/{coadd_id}-w{band_number}-int-3.fits"


def wise_constraints(band_number: int, ra: float, dec: float, reach_deg: float) -> str:
    """Condicion SQL para Gator: mosaicos de la banda cuyo centro esta a menos de `reach_deg` en cada eje."""
    parts = [f"band={band_number}", f"crval2>{dec - reach_deg:.5f}", f"crval2<{dec + reach_deg:.5f}"]
    cos_dec = math.cos(math.radians(min(89.0, abs(dec) + reach_deg)))
    reach_ra = reach_deg / cos_dec
    if reach_ra < 180.0:
        low, high = (ra - reach_ra) % 360.0, (ra + reach_ra) % 360.0
        if low < high:
            parts += [f"crval1>{low:.5f}", f"crval1<{high:.5f}"]
        else:  # el intervalo cruza el meridiano 0
            parts.append(f"(crval1>{low:.5f} or crval1<{high:.5f})")
    return " and ".join(parts)


def _mjd(text: object) -> float | None:
    """MJD de una fecha `AAAA-MM-DD HH:MM:SS` o ISO con `T`, o `None` si no se entiende."""
    value = str(text or "").strip().replace("T", " ")
    if not value or value.lower() == "null":
        return None
    try:
        return float(Time(value, format="iso", scale="utc").mjd)
    except ValueError:
        return None


def parse_wise_list(payload: bytes, band_number: int) -> list[SurveyImage]:
    """Mosaicos de una respuesta de Gator sobre `allwise_p3am_cdd`. Lanza `ValueError` si no es la tabla esperada."""
    if not payload.lstrip().startswith(b"\\"):
        raise ValueError(f"la respuesta no es una tabla IPAC: {payload[:160]!r}")
    try:
        table = ascii_tables.read(io.BytesIO(payload), format="ipac")
    except Exception as exc:  # astropy lanza varias clases con una tabla cortada
        raise ValueError(f"tabla IPAC ilegible: {type(exc).__name__}: {exc}") from exc
    missing = [name for name in WISE_ATLAS_COLUMNS if name not in table.colnames]
    if missing:
        raise ValueError(f"faltan las columnas {missing}")
    images: list[SurveyImage] = []
    for row in table:
        if int(row["band"]) != band_number:
            continue
        coadd_id = str(row["coadd_id"]).strip()
        scale = float(row["pxscal1"])
        images.append(
            SurveyImage(
                obs_id=coadd_id,
                url=wise_image_url(coadd_id, band_number),
                mjd_start=_mjd(row["date_obs1"]),
                mjd_end=_mjd(row["date_obs2"]),
                center_ra=float(row["crval1"]),
                center_dec=float(row["crval2"]),
                half_width_arcsec=float(row["naxis1"]) * scale / 2.0,
                half_height_arcsec=float(row["naxis2"]) * scale / 2.0,
            )
        )
    return sorted(images, key=lambda image: image.url)


def _list_wise(band: SurveyBand, ra: float, dec: float, radius_deg: float, settings: Settings) -> bytes:
    params = {
        "catalog": WISE_ATLAS_TABLE,
        "spatial": "None",
        "outfmt": "1",
        "selcols": ",".join(WISE_ATLAS_COLUMNS),
        "constraints": wise_constraints(int(band.band[1:]), ra, dec, WISE_TILE_HALF_DEG + radius_deg),
    }
    return get_bytes(
        GATOR_URL,
        settings,
        slot=get_limiter(settings).sia_slot,
        what=f"Gator {WISE_ATLAS_TABLE}",
        params=params,
        max_bytes=MAX_LIST_BYTES,
    )


# ----------------------------------------------------------------------- SIA2


def parse_sia_list(payload: bytes, band: SurveyBand) -> list[SurveyImage]:
    """Imagenes de ciencia de la banda en una respuesta VOTable de SIA2, sin repetir.

    Lanza `ValueError` si la respuesta no es un VOTable de SIA2 con
    `QUERY_STATUS = OK` o le faltan columnas.
    """
    try:
        votable = parse_votable(io.BytesIO(payload), verify="ignore")
    except Exception as exc:  # astropy lanza varias clases segun donde falle el XML
        raise ValueError(f"la respuesta no es un VOTable: {type(exc).__name__}: {exc}") from exc
    statuses = [info for resource in votable.resources for info in resource.infos if info.name == "QUERY_STATUS"]
    if not statuses:
        raise ValueError("el VOTable no trae QUERY_STATUS")
    for info in statuses:
        if info.value != "OK":
            raise ValueError(f"QUERY_STATUS={info.value}: {info.content or ''}".strip())
    tables = list(votable.iter_tables())
    if not tables:
        return []
    # IRSA pone ID="col_N" en cada FIELD; los nombres ObsCore estan en `name`.
    table = tables[0].to_table(use_names_over_ids=True)
    if len(table) == 0:
        return []
    names = ("dataproduct_type", "dataproduct_subtype", "energy_bandpassname", "obs_id", "t_min", "t_max", "access_url")
    missing = [name for name in names if name not in table.colnames]
    if missing:
        raise ValueError(f"faltan las columnas {missing}")
    columns = {name: table[name].tolist() for name in names}

    images: dict[str, SurveyImage] = {}
    for i in range(len(table)):
        row = {name: values[i] for name, values in columns.items()}
        if str(row["dataproduct_type"]) != "image" or str(row["dataproduct_subtype"]) != "science":
            continue
        if str(row["energy_bandpassname"]).strip() != band.sia_band:
            continue
        url = str(row["access_url"] or "").strip()
        try:
            start, end = float(row["t_min"]), float(row["t_max"])
        except (TypeError, ValueError):
            continue
        # El recorte por coordenadas solo existe para las URL del IBE (ibe/cutouts.html).
        if "/ibe/data/" not in url or not (math.isfinite(start) and math.isfinite(end)):
            continue
        images.setdefault(
            url, SurveyImage(obs_id=str(row["obs_id"] or "").strip(), url=url, mjd_start=start, mjd_end=end)
        )
    return sorted(images.values(), key=lambda image: image.url)


def _list_sia(band: SurveyBand, ra: float, dec: float, radius_deg: float, settings: Settings) -> bytes:
    patient = replace(
        settings,
        irsa_read_timeout_s=min(settings.irsa_read_timeout_s, SIA_FALLBACK_TIMEOUT_S),
        irsa_total_timeout_s=SIA_FALLBACK_TIMEOUT_S,
    )
    return get_bytes(
        settings.sia_url,
        patient,
        slot=get_limiter(settings).sia_slot,
        what=f"SIA2 {band.collection}",
        params={"COLLECTION": band.collection, "POS": f"circle {ra:.6f} {dec:.6f} {radius_deg:.5f}"},
        attempts=2,
        max_bytes=MAX_LIST_BYTES,
        retry_wait_s=settings.sia_retry_wait_s,
    )


# ---------------------------------------------------------------------- lista


def list_images(
    band: SurveyBand, ra: float, dec: float, radius_deg: float, settings: Settings, *, refresh: bool = False
) -> tuple[list[SurveyImage], str]:
    """Imagenes de la banda que pueden tocar el circulo, y el servicio que las listo.

    Prueba primero el servicio propio de la mision (`"twomass"` o `"gator"`) y,
    si falla, SIA2 (`"sia"`). Cada respuesta buena queda en la cache. Lanza
    `ContextFetchError` si ninguno responde.
    """
    own = "twomass" if band.survey == "2MASS" else "gator"
    fetchers = {"twomass": _list_twomass, "gator": _list_wise, "sia": _list_sia}

    def parse(source: str, payload: bytes) -> list[SurveyImage]:
        if source == "twomass":
            return parse_twomass_list(payload)
        if source == "gator":
            return parse_wise_list(payload, int(band.band[1:]))
        return parse_sia_list(payload, band)

    if not refresh:
        for source in (own, "sia"):
            path = list_cache_path(band, source, ra, dec, radius_deg, settings)
            if path.is_file():
                with contextlib.suppress(OSError, ValueError):
                    return parse(source, path.read_bytes()), source
    errors: list[str] = []
    for source in (own, "sia"):
        try:
            payload = fetchers[source](band, ra, dec, radius_deg, settings)
            images = parse(source, payload)
        except (ContextFetchError, ValueError) as exc:
            errors.append(str(exc))
            continue
        with contextlib.suppress(OSError):
            _write_atomic(list_cache_path(band, source, ra, dec, radius_deg, settings), payload)
        return images, source
    raise ContextFetchError(f"{band.survey} {band.band}: no se pudo listar: " + "; ".join(errors))


# -------------------------------------------------------------------- recorte


def cutout_url(image: SurveyImage, ra: float, dec: float, side_deg: float) -> str:
    """URL del recorte por coordenadas: `<url>?center=<ra>,<dec>deg&size=<lado>deg&gzip=false`."""
    return f"{image.url}?center={ra:.6f},{dec:.6f}deg&size={side_deg:g}deg&gzip=false"


def cutout_cache_path(
    band: SurveyBand, image: SurveyImage, ra: float, dec: float, side_deg: float, settings: Settings
) -> Path:
    stem = re.sub(r"\.fits(\.gz)?$", "", image.file_name)
    # En 2MASS el nombre del archivo se repite entre noches: la observacion va en el nombre.
    name = f"{_safe(image.obs_id)}__{_safe(stem)}__{ra:.6f}_{dec:+.6f}_{side_deg:g}.fits"
    return context_cache_dir(settings) / "cutouts" / band.collection / name


def _is_whole_fits(payload: bytes) -> bool:
    return payload.startswith(_FITS_SIGNATURE) and len(payload) % _FITS_BLOCK == 0


def download_cutout(
    band: SurveyBand,
    image: SurveyImage,
    ra: float,
    dec: float,
    side_deg: float,
    settings: Settings,
    *,
    refresh: bool = False,
) -> Path:
    """Baja el recorte de una imagen (o lo toma de la cache) y devuelve su ruta.

    Lanza `ContextFetchError` si IRSA no lo entrega. Un 500 puede querer decir
    que el recorte no toca la imagen (ibe/cutouts.html): quien llama sigue con
    las demas imagenes.
    """
    path = cutout_cache_path(band, image, ra, dec, side_deg, settings)
    if not refresh and path.is_file():
        with contextlib.suppress(OSError):
            if _is_whole_fits(path.read_bytes()):
                return path
    payload = get_bytes(
        cutout_url(image, ra, dec, side_deg),
        settings,
        slot=get_limiter(settings).cutout_slot,
        what=f"recorte de {image.file_name}",
        attempts=CUTOUT_ATTEMPTS,
        max_bytes=MAX_CUTOUT_BYTES,
    )
    if not _is_whole_fits(payload):
        raise ContextFetchError(
            f"recorte de {image.file_name}: la respuesta no es un FITS entero ({len(payload)} bytes)"
        )
    _write_atomic(path, payload)
    return path


# --------------------------------------------------------------------- fechas


@dataclass(frozen=True)
class ObservationTimes:
    """Fecha de una imagen (MJD, UTC): la que se informa y el intervalo que abarca."""

    mjd: float
    mjd_start: float
    mjd_end: float


def observation_times(header: fits.Header, band: SurveyBand, image: SurveyImage) -> ObservationTimes | None:
    """Fecha de observacion de un recorte, leida de su encabezado; si no la trae, la de la lista.

    2MASS: `UT_DATE` (aammdd) y `UT` (hh:mm:ss), la hora de esa imagen. WISE:
    `MIDOBS`, con `DATEOBS1` y `DATEOBS2` como intervalo. Devuelve `None` si no
    hay fecha en ninguno de los dos lados.
    """
    listed_start, listed_end = image.mjd_start, image.mjd_end
    if band.survey == "2MASS":
        date = str(header.get("UT_DATE", "")).strip()
        clock = str(header.get("UT", "00:00:00")).strip() or "00:00:00"
        if re.fullmatch(r"\d{6}", date):
            mjd = _mjd(f"{_twomass_year(date[:2]):04d}-{date[2:4]}-{date[4:6]} {clock}")
            if mjd is not None:
                return ObservationTimes(mjd, mjd, mjd)
    else:
        middle = _mjd(header.get("MIDOBS"))
        start = _mjd(header.get("DATEOBS1")) or listed_start
        end = _mjd(header.get("DATEOBS2")) or listed_end
        if middle is not None:
            return ObservationTimes(middle, start if start is not None else middle, end if end is not None else middle)
    if listed_start is None or listed_end is None:
        return None
    return ObservationTimes((listed_start + listed_end) / 2.0, listed_start, listed_end)
