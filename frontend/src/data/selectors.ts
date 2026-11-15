// Selectores del estado del campo para la interfaz. Son funciones puras sobre
// `FieldState`:
//
//   const timeline = useFieldStore(selectTimeline);
//   const provisional = useFieldStore((state) => selectIsProvisional(state, epoch));
//
// Los que arman listas u objetos recuerdan el ultimo resultado y lo devuelven
// tal cual mientras no cambie aquello de lo que dependen: zustand compara por
// identidad, y un selector que devuelve un objeto nuevo en cada llamada vuelve
// a dibujar sin fin.
//
// Los que reciben un parametro (una epoca) recuerdan un resultado por cada
// valor del parametro: dos componentes, o dos hooks del mismo componente, que
// piden epocas distintas no se pisan la memoria.
//
// La memoria es una por selector, no por store: estan pensados para el unico
// store de la aplicacion (`useFieldStore`). Dos stores suscriptos a la vez en
// la misma pantalla se la pisarian.

import type { AuxLayers } from "@/api/binary";
import type { ApiErrorCode } from "@/api/errors";
import type {
  Detector,
  Display,
  Epoch,
  FieldMeta,
  FieldWarning,
  Grid,
  Plane,
  Preview,
  PreviewBand,
  ProgressPhase,
  ResolveResponse,
  SaturatedRegion,
  TrackResponse,
  WarningCode,
} from "@/api/types";
import { isInsideGrid, skyToPixel } from "@/lib/wcs";
import type { PlaneImage } from "@/viewer/planeImage";
import type { FieldState, LoadedPlane, LoadedPreview, RequestStatus } from "./fieldState";
import { findPlane, planeKey } from "./planeKey";

/**
 * Recuerda el ultimo resultado mientras los argumentos sean los mismos (por
 * identidad). Con `isSame`, si el resultado nuevo dice lo mismo que el
 * anterior se devuelve el anterior, para que quien lo usa no vuelva a dibujar.
 */
function memoizeLast<Args extends readonly unknown[], Result>(
  compute: (...args: Args) => Result,
  isSame?: (previous: Result, next: Result) => boolean,
): (...args: Args) => Result {
  let lastArgs: Args | null = null;
  let lastResult: Result;
  return (...args: Args): Result => {
    if (
      lastArgs !== null &&
      lastArgs.length === args.length &&
      lastArgs.every((value, index) => Object.is(value, args[index]))
    ) {
      return lastResult;
    }
    const next = compute(...args);
    if (lastArgs === null || !isSame?.(lastResult, next)) lastResult = next;
    lastArgs = args;
    return lastResult;
  };
}

/** Dos listas con los mismos elementos, comparados campo por campo por identidad. */
function sameItems<Item extends object>(previous: readonly Item[], next: readonly Item[]): boolean {
  return (
    previous.length === next.length &&
    previous.every((item, index) => {
      const other = next[index];
      if (other === undefined) return false;
      const keys = Object.keys(item) as Array<keyof Item>;
      return keys.every((key) => Object.is(item[key], other[key]));
    })
  );
}

const NO_REGIONS: readonly SaturatedRegion[] = [];

// ---- Planos de la banda actual -------------------------------------------

export interface BandPlane {
  epoch: Epoch;
  /** Metadatos al dia del plano; pueden ir una revision adelante de la imagen bajada. */
  plane: Plane | null;
  /** Imagen bajada de esa epoca en la banda actual, o null si todavia no hay. */
  loaded: LoadedPlane | null;
}

const NO_BAND_PLANES: readonly BandPlane[] = [];

// Depende de las listas del documento y no del documento entero: un evento
// `progress` (hasta 4 por segundo) no cambia ninguna de las dos.
const bandPlanes = memoizeLast(
  (
    epochs: readonly Epoch[] | undefined,
    metaPlanes: readonly Plane[] | undefined,
    planes: FieldState["planes"],
    band: number,
  ): readonly BandPlane[] => {
    if (!epochs || !metaPlanes) return NO_BAND_PLANES;
    return epochs.map((epoch) => ({
      epoch,
      plane: findPlane(metaPlanes, epoch.epoch, band) ?? null,
      loaded: planes[planeKey(epoch.epoch, band)] ?? null,
    }));
  },
  sameItems,
);

/** Planos de la banda actual, uno por epoca y en orden temporal. Vacio antes de `listed`. */
export function selectBandPlanes(state: FieldState): readonly BandPlane[] {
  return bandPlanes(state.meta?.epochs, state.meta?.planes, state.planes, state.band);
}

/** Imagen bajada de una epoca en la banda actual, o null. */
export function selectLoadedPlane(state: FieldState, epoch: number | null): LoadedPlane | null {
  if (epoch === null) return null;
  return state.planes[planeKey(epoch, state.band)] ?? null;
}

// ---- Linea de tiempo ------------------------------------------------------

/**
 * Estado de una epoca en la linea de tiempo (DESIGN.md, "Tiempo y carga"), en
 * la banda actual:
 * - loaded: hay imagen definitiva.
 * - provisional: la imagen se armo con parte de sus exposiciones (`building`).
 * - unloaded: todavia no hay imagen (plano sin construir o sin bajar).
 * - empty: la epoca no tiene datos en esta banda; no va a haber imagen.
 */
export type EpochLoadState = "loaded" | "provisional" | "unloaded" | "empty";

export interface TimelineEpoch {
  epoch: Epoch;
  state: EpochLoadState;
}

function epochLoadState(entry: BandPlane): EpochLoadState {
  if (entry.loaded) return entry.loaded.status === "building" ? "provisional" : "loaded";
  return entry.plane?.status === "empty" ? "empty" : "unloaded";
}

const timeline = memoizeLast(
  (entries: readonly BandPlane[]): readonly TimelineEpoch[] =>
    entries.map((entry) => ({ epoch: entry.epoch, state: epochLoadState(entry) })),
  sameItems,
);

/** Una marca por epoca, con su estado en la banda actual. Vacio antes de `listed`. */
export function selectTimeline(state: FieldState): readonly TimelineEpoch[] {
  return timeline(selectBandPlanes(state));
}

/** Estado de una epoca en la banda actual; null si esa epoca no existe. */
export function selectEpochState(state: FieldState, epoch: number | null): EpochLoadState | null {
  if (epoch === null) return null;
  const entry = selectBandPlanes(state).find((candidate) => candidate.epoch.epoch === epoch);
  return entry ? epochLoadState(entry) : null;
}

/** Dice si la imagen que se ve de esa epoca, en la banda actual, es provisoria. */
export function selectIsProvisional(state: FieldState, epoch: number | null): boolean {
  return selectLoadedPlane(state, epoch)?.status === "building";
}

/**
 * Dice si alguna de las epocas comparadas es provisoria, para el aviso de los
 * modos de comparacion (contrato, seccion 8).
 */
export function selectAnyProvisional(state: FieldState, epochs: readonly number[]): boolean {
  return epochs.some((epoch) => selectIsProvisional(state, epoch));
}

// ---- Avance y cola --------------------------------------------------------

export interface LoadProgress {
  phase: ProgressPhase;
  /** Recortes resueltos: bajados o leidos de la cache, mas los fallidos. */
  done: number;
  total: number;
  /** Avance de la barra, de 0 a 1: (cutouts_done + cutouts_failed) / cutouts_total. */
  fraction: number;
  cutoutsFailed: number;
  planesReady: number;
  planesTotal: number;
  elapsedS: number;
}

const loadProgress = memoizeLast((progress: FieldMeta["progress"]): LoadProgress => {
  const done = progress.cutouts_done + progress.cutouts_failed;
  const total = progress.cutouts_total;
  return {
    phase: progress.phase,
    done,
    total,
    // Antes de `listed` no se sabe cuantos recortes son: el avance es 0.
    fraction: total > 0 ? Math.min(1, done / total) : 0,
    cutoutsFailed: progress.cutouts_failed,
    planesReady: progress.planes_ready,
    planesTotal: progress.planes_total,
    elapsedS: progress.elapsed_s,
  };
});

/** Avance del trabajo; null si todavia no hay documento. */
export function selectLoadProgress(state: FieldState): LoadProgress | null {
  return state.meta === null ? null : loadProgress(state.meta.progress);
}

/** Posicion en la cola (1 es el proximo); null si el trabajo no esta esperando turno. */
export function selectQueuePosition(state: FieldState): number | null {
  const progress = state.meta?.progress;
  if (state.phase !== "loading" || !progress || progress.phase !== "queued") return null;
  return progress.queue_position > 0 ? progress.queue_position : null;
}

// ---- Avisos ---------------------------------------------------------------

export interface WarningGroup<Code extends WarningCode = WarningCode> {
  code: Code;
  count: number;
  warnings: readonly Extract<FieldWarning, { code: Code }>[];
}

/** Orden de los grupos: primero lo que cambia lo que se ve, despues lo que afecta a cada plano. */
export const WARNING_ORDER: readonly WarningCode[] = [
  "saturated_source",
  "cutouts_failed",
  "stale_exposure_list",
  "full_download",
  "plane_empty",
  "few_exposures",
  "low_coverage",
];

const warningGroups = memoizeLast((warnings: readonly FieldWarning[]): readonly WarningGroup[] =>
  WARNING_ORDER.flatMap((code) => {
    const matching = warnings.filter((warning) => warning.code === code);
    return matching.length > 0 ? [{ code, count: matching.length, warnings: matching }] : [];
  }),
);

const NO_GROUPS: readonly WarningGroup[] = [];

/** Avisos de calidad agrupados por codigo, en el orden de `WARNING_ORDER`. */
export function selectWarningGroups(state: FieldState): readonly WarningGroup[] {
  return state.meta === null ? NO_GROUPS : warningGroups(state.meta.warnings);
}

/** Cantidad total de avisos, para el encabezado del panel. */
export function selectWarningCount(state: FieldState): number {
  return state.meta?.warnings.length ?? 0;
}

// ---- Plano actual y banda -------------------------------------------------

/**
 * Regiones saturadas del plano de esa epoca en la banda actual. Salen de la
 * revision que esta bajada, para que el contorno coincida con la imagen que se
 * ve; si todavia no hay imagen, de los metadatos.
 */
export function selectSaturatedRegions(
  state: FieldState,
  epoch: number | null,
): readonly SaturatedRegion[] {
  if (epoch === null) return NO_REGIONS;
  const loaded = selectLoadedPlane(state, epoch);
  if (loaded) return loaded.plane.saturated;
  return findPlane(state.meta?.planes, epoch, state.band)?.saturated ?? NO_REGIONS;
}

export interface BandInfo {
  detector: number;
  /** Rango real del detector segun IRSA, en micrometros. */
  waveMinUm: number;
  waveMaxUm: number;
  /** Escala comun a todas las epocas; null mientras el detector no tiene ningun plano con datos. */
  display: Display | null;
}

const bandInfo = memoizeLast(
  (detectors: readonly Detector[] | undefined, band: number): BandInfo | null => {
    const detector = detectors?.find((candidate) => candidate.detector === band);
    if (!detector) return null;
    return {
      detector: detector.detector,
      waveMinUm: detector.wave_min_um,
      waveMaxUm: detector.wave_max_um,
      display: detector.display ?? null,
    };
  },
  // La escala de otra banda cambia la lista de detectores, pero no esta banda.
  (previous, next) =>
    previous !== null &&
    next !== null &&
    previous.detector === next.detector &&
    previous.waveMinUm === next.waveMinUm &&
    previous.waveMaxUm === next.waveMaxUm &&
    previous.display === next.display,
);

/** Rango de onda y escala de contraste de la banda actual; null antes de `listed`. */
export function selectBandInfo(state: FieldState): BandInfo | null {
  return bandInfo(state.meta?.detectors, state.band);
}

// ---- Capas auxiliares -----------------------------------------------------

/**
 * Capas auxiliares (flags y cobertura) de una epoca en la banda actual, si son
 * las de la imagen que se ve. null si no se pidieron, si todavia no llegaron o
 * si son de otra revision que la imagen bajada: unas capas viejas debajo de una
 * imagen nueva marcarian pixeles que ya no corresponden.
 *
 * Se piden con `loadAux`; despues el store las renueva solo cada vez que el
 * plano cambia de revision.
 */
export function selectAuxLayers(state: FieldState, epoch: number | null): AuxLayers | null {
  if (epoch === null) return null;
  const key = planeKey(epoch, state.band);
  const entry = state.aux[key];
  const loaded = state.planes[key];
  if (!entry || entry.layers === null || !loaded) return null;
  return entry.layersRev === loaded.rev ? entry.layers : null;
}

// ---- Error ----------------------------------------------------------------

/** Codigo del error actual, para traducirlo; null si no hay error. */
export function selectErrorCode(state: FieldState): ApiErrorCode | null {
  return state.error?.code ?? null;
}

// ---- Vista provisoria -----------------------------------------------------

export interface VisiblePreview {
  /** Imagen de WISE en la grilla del campo. Sus valores no son MJy/sr. */
  image: PlaneImage;
  /** Relevamiento, para el rotulo ("WISE"). */
  survey: string;
  /** Banda con la que se rotula; es la del pedido que creo el trabajo, no la que se esta mirando. */
  band: PreviewBand;
  waveUm: number;
  /** Escala propia de la vista; null si el backend no la mando. */
  display: Display | null;
}

/** Dice si ya hay alguna imagen de SPHEREx bajada de esa banda, provisoria o definitiva. */
export function hasLoadedPlaneOfBand(planes: FieldState["planes"], band: number): boolean {
  return Object.values(planes).some((loaded) => loaded.detector === band);
}

const visiblePreview = memoizeLast(
  (
    loaded: LoadedPreview | null,
    preview: Preview | undefined,
    planes: FieldState["planes"],
    band: number,
  ): VisiblePreview | null => {
    if (loaded === null || preview?.status !== "ready") return null;
    // Se retira al llegar el primer plano de la banda actual, aunque sea provisorio.
    if (hasLoadedPlaneOfBand(planes, band)) return null;
    return {
      image: loaded.image,
      survey: preview.survey,
      band: preview.band,
      waveUm: preview.wave_um,
      display: preview.display ?? null,
    };
  },
);

/**
 * Vista provisoria de WISE, si hay que mostrarla: mientras no haya ninguna
 * imagen de SPHEREx de la banda actual y `preview.status` sea `ready`
 * (contrato, secciones 4.10 y 8). null en cualquier otro caso.
 */
export function selectPreview(state: FieldState): VisiblePreview | null {
  return visiblePreview(state.preview, state.meta?.preview, state.planes, state.band);
}

// ---- Objeto buscado -------------------------------------------------------

export interface TargetPosition {
  /** Pixel de la grilla, desde 0 y con fracciones. */
  x: number;
  y: number;
  ra: number;
  dec: number;
  inField: boolean;
  /** `track`: posicion esperada en esa epoca. `field_center`: el objeto no tiene trayectoria. */
  source: "track" | "field_center";
}

/** Lo que hace falta para ubicar el objeto, y las posiciones ya calculadas con eso. */
interface TargetPositions {
  readonly track: TrackResponse | null;
  readonly trackStatus: RequestStatus;
  readonly resolved: ResolveResponse | null;
  readonly grid: Grid | undefined;
  /** Posicion de cada epoca ya consultada; null si en esa epoca no hay. */
  readonly byEpoch: Map<number | null, TargetPosition | null>;
  /** La de `field_center`, que es la misma para todas las epocas. */
  fieldCenter: TargetPosition | null | undefined;
}

// Una memoria por epoca: cada posicion se calcula una vez y se devuelve el
// mismo objeto mientras no cambien la trayectoria, lo resuelto o la grilla.
// Con una sola memoria para todas las epocas, dos suscripciones de epocas
// distintas se la invalidaban una a otra y React cortaba con "Maximum update
// depth exceeded".
const targetPositions = memoizeLast(
  (
    track: TrackResponse | null,
    trackStatus: RequestStatus,
    resolved: ResolveResponse | null,
    grid: Grid | undefined,
  ): TargetPositions => ({
    track,
    trackStatus,
    resolved,
    grid,
    byEpoch: new Map(),
    fieldCenter: undefined,
  }),
);

function fieldCenterPosition(positions: TargetPositions): TargetPosition | null {
  if (positions.fieldCenter !== undefined) return positions.fieldCenter;
  const { resolved, grid } = positions;
  let position: TargetPosition | null = null;
  if (resolved !== null && grid !== undefined) {
    const { ra, dec } = resolved.field_center;
    const pixel = skyToPixel(grid, ra, dec);
    if (pixel !== null) {
      position = {
        x: pixel.x,
        y: pixel.y,
        ra,
        dec,
        inField: isInsideGrid(grid.shape, pixel.x, pixel.y),
        source: "field_center",
      };
    }
  }
  positions.fieldCenter = position;
  return position;
}

function computeTargetPosition(
  positions: TargetPositions,
  epoch: number | null,
): TargetPosition | null {
  const position = positions.track?.positions.find((candidate) => candidate.epoch === epoch);
  if (position) {
    return {
      x: position.x,
      y: position.y,
      ra: position.ra,
      dec: position.dec,
      inField: position.in_field,
      source: "track",
    };
  }
  // Mientras la trayectoria esta en camino no se dibuja nada, para que la mira no salte.
  if (positions.trackStatus === "idle" || positions.trackStatus === "loading") return null;
  // Sin movimiento propio `positions` viene vacio y la mira va en `field_center` (seccion 4.9).
  return fieldCenterPosition(positions);
}

function targetPositionAt(positions: TargetPositions, epoch: number | null): TargetPosition | null {
  const known = positions.byEpoch.get(epoch);
  if (known !== undefined) return known;
  const position = computeTargetPosition(positions, epoch);
  positions.byEpoch.set(epoch, position);
  return position;
}

function targetPositionsOf(state: FieldState): TargetPositions {
  const { target } = state;
  return targetPositions(target.track, target.trackStatus, target.resolved, state.meta?.grid);
}

/**
 * Donde va la mira del objeto buscado en una epoca: su posicion esperada segun
 * /track o, si no tiene trayectoria, `field_center`. null si la URL no trae
 * nombre, si todavia no se sabe o si no hay grilla.
 *
 * Devuelve el mismo objeto para la misma epoca mientras no cambie nada, asi que
 * se puede usar en varios hooks con epocas distintas (la mira de A y la de B).
 */
export function selectTargetPosition(
  state: FieldState,
  epoch: number | null,
): TargetPosition | null {
  if (state.target.name === null) return null;
  return targetPositionAt(targetPositionsOf(state), epoch);
}

/** Posicion del objeto buscado en una epoca del campo. */
export interface EpochTargetPosition {
  /** Numero de epoca, desde 1. */
  epoch: number;
  position: TargetPosition;
}

const NO_TRAIL: readonly EpochTargetPosition[] = [];

const targetTrail = memoizeLast(
  (positions: TargetPositions, epochs: readonly Epoch[]): readonly EpochTargetPosition[] =>
    epochs.flatMap((item) => {
      const position = targetPositionAt(positions, item.epoch);
      return position === null ? [] : [{ epoch: item.epoch, position }];
    }),
);

/**
 * Posicion del objeto buscado en cada epoca del campo, en orden temporal, para
 * el rastro. Cada `position` es el mismo objeto que da `selectTargetPosition`.
 * Sin trayectoria todas son `field_center`: el objeto no se mueve y no hay
 * rastro que dibujar. Vacio si la URL no trae nombre, antes de `listed` o
 * mientras la trayectoria esta en camino.
 */
export function selectTargetTrail(state: FieldState): readonly EpochTargetPosition[] {
  const epochs = state.meta?.epochs;
  if (state.target.name === null || !epochs) return NO_TRAIL;
  return targetTrail(targetPositionsOf(state), epochs);
}
