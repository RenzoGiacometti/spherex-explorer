// Forma del estado del campo (src/state/fieldStore.ts). Va aparte para que los
// selectores (selectors.ts) y el store compartan los tipos sin importarse entre si.

import type { AuxLayers, GridShape } from "@/api/binary";
import type { ApiErrorCode } from "@/api/errors";
import type { StreamStatus } from "@/api/sse";
import type { FieldMeta, Plane, PlaneStatus, ResolveResponse, TrackResponse } from "@/api/types";
import type { FieldFov } from "@/lib/fov";
import { type Band, DEFAULT_BAND } from "@/state/urlState";
import type { PlaneImage } from "@/viewer/planeImage";

/**
 * Momento del campo:
 * - idle: no hay campo abierto.
 * - requesting: salio el POST /api/field y todavia no hay respuesta.
 * - loading: el backend esta armando el campo; llegan eventos por SSE.
 * - ready: el trabajo termino (`meta.status` es `ready` o `partial`).
 * - error: fallo el pedido, el flujo de eventos o el trabajo; ver `error`.
 */
export type FieldPhase = "idle" | "requesting" | "loading" | "ready" | "error";

/** Campo pedido: centro y escalon de campo (no la vista de 5 minutos). */
export interface FieldRequestState {
  ra: number;
  dec: number;
  fov: FieldFov;
}

export interface FieldError {
  /** Codigo para traducir: uno del contrato, o `network`, `invalid_response` o `unknown`. */
  code: ApiErrorCode;
  /**
   * De donde salio: `request` es el POST /api/field, `stream` el flujo de
   * eventos (no se pudo conectar o se agotaron los reintentos) y `job` el
   * trabajo del backend (evento `error`).
   */
  source: "request" | "stream" | "job";
  /** Si tiene sentido reintentar. */
  retryable: boolean;
  /** Segundos de `Retry-After` (`queue_full`), o null. */
  retryAfterS: number | null;
  /** Momento, en ms de Date.now(), desde el que conviene reintentar; null si no hay espera. */
  retryAt: number | null;
  /** Detalle para el log; el texto visible sale de `code`. */
  message: string;
}

/** Un plano bajado y listo para dibujar. */
export interface LoadedPlane {
  epoch: number;
  detector: number;
  /** Revision de la imagen. */
  rev: number;
  /** `building` si la imagen es provisoria; `ready` o `partial` si es definitiva. */
  status: PlaneStatus;
  /** Metadatos del plano en esa revision: exposiciones usadas, estadisticas, regiones saturadas. */
  plane: Plane;
  image: PlaneImage;
}

/** Vista provisoria ya bajada. El rotulo y la escala salen de `meta.preview`. */
export interface LoadedPreview {
  image: PlaneImage;
  shape: GridShape;
}

/** Descarga de un plano que fallo; no se repite sola para esa revision. */
export interface PlaneLoadError {
  rev: number;
  code: ApiErrorCode;
}

/** Capas auxiliares de un plano (flags y cobertura). */
export interface AuxEntry {
  status: "loading" | "ready" | "error";
  /** Revision del plano para la que se pidieron. */
  rev: number;
  /** Las capas; mientras se vuelve a pedir quedan las de la revision anterior. */
  layers: AuxLayers | null;
  /**
   * Revision del plano a la que corresponden `layers`; null si no hay capas.
   * Es menor que `rev` mientras llegan las de la revision nueva.
   * `selectAuxLayers` solo las entrega si coinciden con la imagen bajada.
   */
  layersRev: number | null;
  error: ApiErrorCode | null;
}

/** El resto de las bandas, de una sola vez con /cube. */
export interface CubeState {
  /** idle: no se pidio. loading: bajando. ready: ya estan todos los planos. error: fallo. */
  status: "idle" | "loading" | "ready" | "error";
  error: ApiErrorCode | null;
}

export type RequestStatus = "idle" | "loading" | "ready" | "error";

/** Objeto buscado por nombre (`name` en la URL): su posicion y su trayectoria en este campo. */
export interface TargetState {
  /** Nombre pedido, o null si la URL no trae ninguno. */
  name: string | null;
  resolveStatus: RequestStatus;
  /** Respuesta de /api/resolve. */
  resolved: ResolveResponse | null;
  resolveError: ApiErrorCode | null;
  trackStatus: RequestStatus;
  /** Respuesta de /track para el campo abierto. `positions` vacio si no tiene movimiento propio. */
  track: TrackResponse | null;
  trackError: ApiErrorCode | null;
}

export interface FieldState {
  phase: FieldPhase;
  /** Campo pedido, o null si no hay ninguno. */
  request: FieldRequestState | null;
  /** Banda (detector) que la persona esta mirando. */
  band: Band;
  /** `id` del campo, desde que responde el POST. */
  fieldId: string | null;
  /** Documento de metadatos al dia. */
  meta: FieldMeta | null;
  /** Estado de la conexion SSE; null si no hay flujo abierto para este campo. */
  stream: StreamStatus | null;
  error: FieldError | null;
  /** Planos bajados, por `planeKey(epoca, detector)`. */
  planes: Readonly<Record<string, LoadedPlane>>;
  /** Descargas de planos que fallaron, por `planeKey`. */
  planeErrors: Readonly<Record<string, PlaneLoadError>>;
  /** Vista provisoria bajada; `selectPreview` dice si hay que mostrarla. */
  preview: LoadedPreview | null;
  /** Capas auxiliares pedidas, por `planeKey`. */
  aux: Readonly<Record<string, AuxEntry>>;
  cube: CubeState;
  target: TargetState;
}

export const EMPTY_TARGET: TargetState = {
  name: null,
  resolveStatus: "idle",
  resolved: null,
  resolveError: null,
  trackStatus: "idle",
  track: null,
  trackError: null,
};

export const INITIAL_FIELD_STATE: FieldState = {
  phase: "idle",
  request: null,
  band: DEFAULT_BAND,
  fieldId: null,
  meta: null,
  stream: null,
  error: null,
  planes: {},
  planeErrors: {},
  preview: null,
  aux: {},
  cube: { status: "idle", error: null },
  target: EMPTY_TARGET,
};
