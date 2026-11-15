"""Modelos pydantic del contrato del cubo del campo (docs/contrato-cubo.md, version 1).

Cada modelo es el JSON de una seccion del contrato, con los mismos nombres de
campo. Si el contrato cambia, se cambia primero el documento y despues este
archivo; `tests/test_contract.py` valida los ejemplos del documento contra
estos modelos.

Convenciones del contrato (seccion 2): angulos en grados ICRS, escalas en
segundos de arco, fechas como MJD (UTC) y como texto ISO, longitudes de onda en
micrones, brillo superficial en MJy/sr. `epoch` va de 1 a N y `detector` de 1 a 6.

Campos opcionales:
- Los que el contrato dice que "no trae" antes de `listed` (`grid`, `detectors`,
  `epochs`, `planes`, `flags`) se omiten del JSON mientras no existen, igual que
  `provenance`.
- Los que pueden no tener valor todavia (`stats` de un plano pendiente,
  `display` de un detector sin planos, `cube_offset`, `motion`) van como `null`.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, SerializerFunctionWrapHandler, TypeAdapter, model_serializer

# --------------------------------------------------------------------- valores

ErrorCode = Literal[
    "invalid_request",
    "not_resolved",
    "not_found",
    "not_ready",
    "no_coverage",
    "queue_full",
    "upstream_unavailable",
]
FieldStatus = Literal["queued", "listing", "downloading", "ready", "partial", "failed"]
PlaneStatus = Literal["pending", "building", "ready", "partial", "empty"]
ProgressPhase = Literal["queued", "listing", "downloading", "finishing", "done"]
PreviewStatus = Literal["pending", "ready", "unavailable"]
DownloadMode = Literal["truncated", "full", "mixed"]
ResolveSource = Literal["sesame", "coordinates"]
DoneStatus = Literal["ready", "partial"]
EventName = Literal["state", "queued", "preview", "listed", "progress", "plane", "warning", "done", "error"]

# Estados de un campo terminado y de un plano que tiene binario definitivo.
FINISHED_FIELD_STATUSES: frozenset[str] = frozenset({"ready", "partial"})
CUBE_PLANE_STATUSES: frozenset[str] = frozenset({"ready", "partial"})
# Estados de un plano que tiene binario, provisorio o definitivo.
DATA_PLANE_STATUSES: frozenset[str] = frozenset({"building", "ready", "partial"})

DEFAULT_FOV = 0.1667
DEFAULT_BAND = 3

DetectorNumber = Annotated[int, Field(ge=1, le=6)]
EpochNumber = Annotated[int, Field(ge=1)]
Pair = tuple[float, float]


class ContractModel(BaseModel):
    """Base de todos los modelos: los numeros tienen que ser finitos, porque JSON no admite NaN ni infinito."""

    model_config = ConfigDict(allow_inf_nan=False)


class RequestModel(ContractModel):
    """Base de los cuerpos que manda el cliente: tipos exactos de JSON.

    Un numero no puede venir como texto ni un entero como booleano. Un entero
    donde se espera un numero con decimales si se acepta.
    """

    model_config = ConfigDict(allow_inf_nan=False, strict=True)


def utc_timestamp(moment: datetime | None = None) -> str:
    """Fecha y hora UTC con el formato del contrato: `2026-11-15T06:21:10Z`."""
    moment = datetime.now(UTC) if moment is None else moment.astimezone(UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


# ------------------------------------------------------------ errores (seccion 2)


class ErrorDetail(ContractModel):
    """El mensaje es para el log; el texto que ve la persona lo arma el frontend a partir de `code`."""

    code: ErrorCode
    message: str
    retryable: bool


class ErrorBody(ContractModel):
    """Cuerpo de cualquier respuesta de error y dato del evento SSE `error`."""

    error: ErrorDetail


# --------------------------------------------------- POST /api/field (seccion 4.1)


class FieldRequest(RequestModel):
    """Pedido de un campo. Los rangos los valida `app.geometry.normalize_request`."""

    ra: float
    dec: float
    fov: float = DEFAULT_FOV
    band: int = DEFAULT_BAND
    refresh: bool = False


class PriorityRequest(RequestModel):
    """Cuerpo de `POST /api/field/{id}/priority` (seccion 4.7)."""

    band: DetectorNumber


# ------------------------------------------- documento de metadatos (seccion 5)


class Display(ContractModel):
    """Escala de contraste: `vmin = median - 2 sigma`, `vmax = max(p99.7, median + 10 sigma)`."""

    vmin: float
    vmax: float
    median: float
    sigma: float


class DetectorDisplay(Display):
    """Escala de un detector tal como viaja en el evento `plane`."""

    detector: DetectorNumber


class FieldRequestInfo(ContractModel):
    """Pedido ya normalizado (seccion 3)."""

    ra: float
    dec: float
    fov: float


class GridInfo(ContractModel):
    """WCS de la grilla con las convenciones de FITS: `crpix` cuenta desde 1 y `cdelt[0]` es negativo."""

    projection: Literal["TAN"] = "TAN"
    crval: Pair
    crpix: Pair
    cdelt: Pair
    shape: tuple[int, int]  # [ny, nx]
    fov: float
    pixel_scale_arcsec: float
    native_pixel_scale_arcsec: float


class DetectorInfo(ContractModel):
    """Rango real del detector segun IRSA y escala comun a todas sus epocas.

    `display` es `null` mientras el detector no tiene ningun plano con datos.
    """

    detector: DetectorNumber
    wave_min_um: float
    wave_max_um: float
    display: Display | None = None


class EpochInfo(ContractModel):
    """Una pasada del relevamiento."""

    epoch: EpochNumber
    start: str  # AAAA-MM-DD
    end: str  # AAAA-MM-DD
    mjd_start: float
    mjd_end: float
    mjd_mean: float
    n_exposures: int


class PlaneStats(ContractModel):
    """Estadisticas sobre los pixeles finitos; las fracciones son del total de pixeles."""

    min: float
    max: float
    median: float
    sigma: float  # 1.4826 x MAD
    p01: float
    p99: float
    p997: float
    valid_fraction: float
    saturated_fraction: float


class SaturatedRegion(ContractModel):
    """Region saturada de al menos 4 pixeles: centro, radio equivalente y cantidad de pixeles."""

    x: float
    y: float
    radius_px: float
    n_pixels: int


class PlaneInfo(ContractModel):
    """Coadd de una epoca y un detector.

    `mjd_mean` y `stats` son `null` mientras el plano no tiene datos (`pending`
    o `empty`). `cube_offset` es `null` mientras el trabajo no termina y en los
    planos `empty`.

    `rev` vale 0 mientras el plano no cambio desde la lista de exposiciones
    (`pending`, o `empty` porque no tiene exposiciones) y sube de a 1 con cada
    revision: la provisoria es la 1 y la definitiva la 2 o una posterior. Un
    plano que se emite una sola vez (definitivo de entrada, o `empty` porque
    ninguna de sus exposiciones sirvio) queda en la 1.
    """

    epoch: EpochNumber
    detector: DetectorNumber
    status: PlaneStatus
    rev: int = 0
    n_exposures: int = 0
    n_used: int = 0
    n_failed: int = 0
    mjd_mean: float | None = None
    stats: PlaneStats | None = None
    saturated: list[SaturatedRegion] = Field(default_factory=list)
    cube_offset: int | None = None


class FlagInfo(ContractModel):
    """Un bit de FLAGS, leido del encabezado de los archivos (`MSKNnnnn`, `MSKDnnnn`)."""

    bit: int
    name: str
    description: str
    masked: bool  # el pipeline descarta los pixeles con este bit
    saturation: bool  # cuenta como saturacion (OVERFLOW y BLOOM)


class Progress(ContractModel):
    """Avance del trabajo. Todos los contadores viajan siempre, en cero mientras no aplican.

    Como se cuenta:
    - `cutouts_total` son todas las exposiciones listadas. `cutouts_done` son
      los recortes que llegaron y `cutouts_failed` los que se dieron por
      perdidos: no se superponen. La fraccion de avance es
      `(cutouts_done + cutouts_failed) / cutouts_total`; con solo
      `cutouts_done` un campo `partial` nunca llegaria al 100 %.
    - `planes_total` cuenta todas las entradas de `planes`, tambien las
      `empty`. `planes_ready` cuenta las que ya tienen estado definitivo
      (`ready`, `partial` o `empty`); una revision `building` no suma.
    - `phase` no tiene un valor para la falla: si el trabajo falla, queda en la
      fase en la que estaba y lo que manda es `status: "failed"`.
    - `listing_attempt` y `retry_in_s` son opcionales y viajan juntos, solo
      mientras el trabajo lista las exposiciones (`phase: "listing"`); fuera de
      eso las dos claves no aparecen en el JSON. `listing_attempt` es el numero
      del intento de listado en curso o, si `retry_in_s` no es `null`, del que
      viene: 1 en el primero, 2 o mas si IRSA no respondio y se esta
      reintentando. `retry_in_s` son los segundos que faltan para ese intento,
      o `null` si se esta consultando ahora.
    """

    phase: ProgressPhase
    queue_position: int = 0
    cutouts_total: int = 0
    cutouts_done: int = 0
    cutouts_failed: int = 0
    cutouts_cached: int = 0
    planes_total: int = 0
    planes_ready: int = 0
    elapsed_s: float = 0.0
    listing_attempt: int | None = None
    retry_in_s: float | None = None

    @model_serializer(mode="wrap")
    def _omit_listing_retry(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        data: dict[str, Any] = handler(self)
        if data.get("listing_attempt") is None:
            data.pop("listing_attempt", None)
            data.pop("retry_in_s", None)
        return data


class PreviewInfo(ContractModel):
    """Vista provisoria de WISE (seccion 4.10). `display` es `null` hasta que `status` es `ready`."""

    status: PreviewStatus
    survey: str = "WISE"
    band: Literal["W1", "W2"]
    wave_um: float
    hips: str
    display: Display | None = None


class Provenance(ContractModel):
    """Origen de los datos. `download_mode` y `built_at` son `null` hasta que se conocen."""

    source: str = "SPHEREx / IRSA"
    collections: list[str]
    listed_at: str
    list_stale: bool = False
    download_mode: DownloadMode | None = None
    built_at: str | None = None


# Avisos: union discriminada por `code`.


class PlaneRef(ContractModel):
    """Referencia a un plano dentro de un aviso."""

    epoch: EpochNumber
    detector: DetectorNumber


class SaturatedSourceWarning(ContractModel):
    """Hay una fuente saturada; su centro no tiene medicion valida."""

    code: Literal["saturated_source"] = "saturated_source"
    ra: float
    dec: float
    radius_arcsec: float
    epochs: list[int]
    detectors: list[int]


class PlaneEmptyWarning(ContractModel):
    """Esa epoca no tiene exposiciones en ese detector."""

    code: Literal["plane_empty"] = "plane_empty"
    epoch: EpochNumber
    detector: DetectorNumber


class FewExposuresWarning(ContractModel):
    """El plano se armo con menos de 5 exposiciones."""

    code: Literal["few_exposures"] = "few_exposures"
    epoch: EpochNumber
    detector: DetectorNumber
    n: int


class LowCoverageWarning(ContractModel):
    """Menos del 90 % del plano tiene datos."""

    code: Literal["low_coverage"] = "low_coverage"
    epoch: EpochNumber
    detector: DetectorNumber
    valid_fraction: float


class CutoutsFailedWarning(ContractModel):
    """Faltan recortes despues de todos los reintentos. `planes` son los planos afectados."""

    code: Literal["cutouts_failed"] = "cutouts_failed"
    n: int
    planes: list[PlaneRef]


class StaleExposureListWarning(ContractModel):
    """La lista de exposiciones es una copia guardada."""

    code: Literal["stale_exposure_list"] = "stale_exposure_list"
    listed_at: str


class FullDownloadWarning(ContractModel):
    """Se bajaron archivos completos porque no se pudo cortar la descarga."""

    code: Literal["full_download"] = "full_download"
    reason: str


FieldWarning = Annotated[
    SaturatedSourceWarning
    | PlaneEmptyWarning
    | FewExposuresWarning
    | LowCoverageWarning
    | CutoutsFailedWarning
    | StaleExposureListWarning
    | FullDownloadWarning,
    Field(discriminator="code"),
]

# Claves del documento que se omiten del JSON mientras no tienen valor.
_OMITTED_WHILE_MISSING = ("grid", "detectors", "epochs", "planes", "flags", "provenance")


class FieldMeta(ContractModel):
    """Documento de metadatos: el mismo objeto en `POST /api/field`, en `/meta` y en `state` y `listed`.

    Antes de `listed` no trae `grid`, `detectors`, `epochs`, `planes`, `flags`
    ni `provenance`: esas claves no aparecen en el JSON.

    Lo que se completa despues de `listed`:
    - `flags` va como lista vacia hasta que se lee el primer archivo, porque
      los bits salen del encabezado de los recortes. `provenance.download_mode`
      es `null` hasta ese mismo momento.
    - `planes[].cube_offset` y `provenance.built_at` recien tienen valor cuando
      el trabajo termina.
    Ningun evento `plane` ni `progress` lleva esos campos: el servidor manda un
    `state` con el documento final justo antes de `done`, y `GET .../meta` los
    trae en cualquier momento.
    """

    id: str
    pipeline: str
    status: FieldStatus
    rev: int = 0
    request: FieldRequestInfo
    grid: GridInfo | None = None
    detectors: list[DetectorInfo] | None = None
    epochs: list[EpochInfo] | None = None
    planes: list[PlaneInfo] | None = None
    flags: list[FlagInfo] | None = None
    progress: Progress
    warnings: list[FieldWarning] = Field(default_factory=list)
    preview: PreviewInfo
    provenance: Provenance | None = None

    @model_serializer(mode="wrap")
    def _omit_missing(self, handler: SerializerFunctionWrapHandler) -> dict[str, Any]:
        data: dict[str, Any] = handler(self)
        for key in _OMITTED_WHILE_MISSING:
            if key in data and data[key] is None:
                del data[key]
        return data

    def plane(self, epoch: int, detector: int) -> PlaneInfo | None:
        """El plano de esa epoca y detector, o `None` si no existe o todavia no hay lista de planos."""
        for item in self.planes or ():
            if item.epoch == epoch and item.detector == detector:
                return item
        return None


class FieldResponse(ContractModel):
    """Respuesta de `POST /api/field`: 200 si el campo esta terminado, 202 si no."""

    id: str
    status: FieldStatus
    events_url: str
    meta: FieldMeta


# -------------------------------------------- eventos SSE (seccion 4.2)


class QueuedEvent(ContractModel):
    """Dato del evento `queued`."""

    position: int


class PlaneEvent(ContractModel):
    """Dato del evento `plane`: una revision nueva de un plano y la escala actualizada de su detector.

    `detector_display` solo es `null` si el detector todavia no tiene ningun
    plano con datos (un plano que paso de `pending` a `empty`).
    """

    plane: PlaneInfo
    detector_display: DetectorDisplay | None = None


class DoneEvent(ContractModel):
    """Dato del evento `done`."""

    status: DoneStatus
    rev: int
    elapsed_s: float


# Modelo del dato de cada evento, para validar al emitir y en los tests.
EVENT_ADAPTERS: dict[str, TypeAdapter[Any]] = {
    "state": TypeAdapter(FieldMeta),
    "queued": TypeAdapter(QueuedEvent),
    "preview": TypeAdapter(PreviewInfo),
    "listed": TypeAdapter(FieldMeta),
    "progress": TypeAdapter(Progress),
    "plane": TypeAdapter(PlaneEvent),
    "warning": TypeAdapter(FieldWarning),
    "done": TypeAdapter(DoneEvent),
    "error": TypeAdapter(ErrorBody),
}


# ------------------------------------------- GET /api/resolve (seccion 4.8)


class SkyPosition(ContractModel):
    ra: float
    dec: float


class Motion(ContractModel):
    """Movimiento del objeto. `pm_ra` incluye el factor cos(dec).

    Unidades: mas/anio, mas y km/s. `parallax` y `radial_velocity` son `null`
    si el catalogo no los trae: un 0 no se distinguiria de una paralaje o una
    velocidad radial medidas que valen 0.
    """

    pm_ra: float
    pm_dec: float
    parallax: float | None = None
    radial_velocity: float | None = None
    per_year_arcsec: float


class FieldCenter(ContractModel):
    """Donde centrar el campo: la posicion propagada a una epoca fija."""

    ra: float
    dec: float
    epoch: float


class ResolveResponse(ContractModel):
    """Para coordenadas, `source` es `coordinates` y `name`, `object_type` y `motion` son `null`."""

    query: str
    name: str | None = None
    source: ResolveSource
    object_type: str | None = None
    j2000: SkyPosition
    motion: Motion | None = None
    field_center: FieldCenter
    moved_arcsec: float = 0.0


# --------------------------------- GET /api/field/{id}/track (seccion 4.9)


class TrackPosition(ContractModel):
    """Posicion esperada del objeto en una epoca, en cielo y en pixeles de la grilla (desde 0)."""

    epoch: EpochNumber
    mjd: float
    ra: float
    dec: float
    x: float
    y: float
    in_field: bool


class TrackResponse(ContractModel):
    """`positions` va vacio si el objeto no tiene movimiento propio."""

    name: str
    positions: list[TrackPosition] = Field(default_factory=list)
