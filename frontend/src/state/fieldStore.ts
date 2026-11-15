// Estado del campo abierto en el visor: pide el campo, sigue su carga por SSE
// y baja las imagenes (docs/contrato-cubo.md).
//
//   const openField = useFieldStore((state) => state.openField);
//   const timeline = useFieldStore(selectTimeline);        // src/data/selectors.ts
//
// Que hace:
// - `openField` manda POST /api/field. Si el campo ya esta terminado quedan
//   los metadatos y se bajan los planos; si no, se suscribe a /events y aplica
//   cada evento como dice la seccion 4.2 (src/data/fieldEvents.ts).
// - Planos: primero los de la banda actual, cada revision nueva apenas se
//   conoce. Las otras bandas, al cambiar de banda o, con el campo terminado,
//   de una sola vez con /cube. Todo pasa por una cola con limite de pedidos
//   simultaneos y sin duplicados (src/data/downloadQueue.ts).
// - Al cambiar de banda se descartan los planos de las otras bandas que
//   esperaban turno: si la persona vuelve se piden de nuevo y, con el campo
//   terminado, llegan igual con el cubo. Los que ya estaban bajando terminan.
// - Vista provisoria: se baja /preview cuando esta lista y no hay nada de
//   SPHEREx para mostrar en la banda actual. `selectPreview` dice cuando verla.
// - Capas auxiliares (flags y cobertura): se piden con `loadAux`. Desde ahi
//   las de la banda actual se renuevan solas cuando el plano cambia de
//   revision. `selectAuxLayers` entrega solo las de la imagen que se ve.
// - Al cambiar de campo se cancela todo lo del anterior: pedidos, cola y flujo.
//
// Las imagenes se guardan como `PlaneImage` (src/viewer/planeImage.ts), que es
// lo que recibe el visor.

import { create } from "zustand";
import { cubePlaneView, type GridShape, isInCube, planeView, splitAux } from "@/api/binary";
import { type ApiClient, api as defaultApi } from "@/api/client";
import { isAbortError, isApiError } from "@/api/errors";
import {
  type FieldEventsOptions,
  type FieldEventsSubscription,
  subscribeFieldEvents,
} from "@/api/sse";
import {
  type FieldEvent,
  type FieldMeta,
  type FieldResponse,
  isListed,
  type ListedFieldMeta,
  type Plane,
} from "@/api/types";
import { createDownloadQueue } from "@/data/downloadQueue";
import { applyFieldEvent, isFinishedStatus } from "@/data/fieldEvents";
import {
  type AuxEntry,
  EMPTY_TARGET,
  type FieldError,
  type FieldRequestState,
  type FieldState,
  INITIAL_FIELD_STATE,
  type LoadedPlane,
} from "@/data/fieldState";
import { contractGridShape, sameShape } from "@/data/gridShape";
import {
  createNameResolver,
  nameResolver as defaultResolver,
  errorCodeOf,
  type NameResolver,
} from "@/data/nameResolver";
import { findPlane, hasBinary, planeKey } from "@/data/planeKey";
import { hasLoadedPlaneOfBand } from "@/data/selectors";
import { fieldFovForView } from "@/lib/fov";
import { toPlaneImage } from "@/viewer/planeImage";
import { type Band, hasField, type UrlState } from "./urlState";

/** Pedidos de binarios simultaneos. El navegador da 6 conexiones por origen y una es del flujo SSE. */
const DEFAULT_MAX_DOWNLOADS = 4;
/** Reintentos de una descarga que fallo por algo pasajero (red, 503). */
const DEFAULT_DOWNLOAD_RETRIES = 2;
/** Tope para la espera que pide Retry-After en una descarga. */
const MAX_RETRY_AFTER_MS = 60_000;

// Orden de salida de la cola: el numero mas bajo va antes.
const PRIORITY_AUX = 0;
const PRIORITY_CURRENT_BAND = 1;
const PRIORITY_OTHER_BAND = 2;
const PRIORITY_CUBE = 3;

const PREVIEW_JOB = "preview";
const CUBE_JOB = "cube";
const PLANE_JOB_PREFIX = "plane:";

/** Clave en la cola de la descarga de un plano. */
function planeJobKey(key: string): string {
  return `${PLANE_JOB_PREFIX}${key}`;
}

/** Epoca y detector de una clave de plano ("epoca:detector"). */
function parsePlaneKey(key: string): { epoch: number; detector: number } | null {
  const [epoch, detector] = key.split(":").map(Number);
  if (epoch === undefined || detector === undefined) return null;
  return Number.isInteger(epoch) && Number.isInteger(detector) ? { epoch, detector } : null;
}

export interface OpenFieldRequest {
  /** Centro del campo en grados ICRS. */
  ra: number;
  dec: number;
  /** Lado de la vista en grados (5, 10 o 30 minutos); se pide el escalon de campo que la contiene. */
  fov: number;
  /** Banda que se esta mirando; sus planos se construyen y se bajan primero. */
  band: Band;
}

export interface FieldActions {
  /**
   * Abre un campo. Si es el que ya esta abierto solo cambia la banda. La
   * promesa termina cuando llego la respuesta del POST (o su error); nunca se
   * rechaza: el error queda en `error`.
   */
  openField(request: OpenFieldRequest): Promise<void>;
  /** Lleva el store al estado de la URL: abre o cierra el campo, cambia la banda y el objeto buscado. */
  syncWithUrl(url: UrlState): void;
  /** Cambia la banda que se esta mirando. Con el trabajo en curso avisa al backend (POST /priority). */
  setBand(band: Band): void;
  /** Objeto buscado por nombre: pide /api/resolve y, para el campo abierto, /track. null lo quita. */
  setTarget(name: string | null): void;
  /**
   * Baja las capas auxiliares (flags y cobertura) de un plano; por defecto, el
   * de la banda actual. Si la lista de flags esta vacia pide /meta antes. No
   * repite un pedido que ya esta hecho o en camino para la misma revision.
   *
   * Alcanza con pedirlas una vez: cuando el plano cambia de revision, las de
   * la banda actual se vuelven a pedir solas. Para dibujarlas, `selectAuxLayers`.
   */
  loadAux(epoch: number, detector?: number): Promise<void>;
  /** Vuelve a pedir el campo desde cero, despues de un error. */
  retry(): Promise<void>;
  /** Vuelve a intentar las descargas que fallaron: planos, vista provisoria y cubo. */
  retryDownloads(): void;
  /** Cierra el campo y cancela todo lo que estaba en curso. */
  close(): void;
}

export type FieldStore = FieldState & FieldActions;

export interface FieldStoreDeps {
  /** Cliente de la API; por defecto el del mismo origen. */
  api?: ApiClient;
  /** Resolucion de nombres; por defecto la compartida con la entrada. */
  resolver?: NameResolver;
  /** Reemplazo de la suscripcion a /events, para los tests. */
  subscribe?: typeof subscribeFieldEvents;
  /** Opciones extra de la suscripcion: fetch, reintentos y esperas. */
  eventsOptions?: Partial<Omit<FieldEventsOptions, "onEvent" | "onStatus" | "onFailure">>;
  /** Pedidos de binarios simultaneos como maximo. Por defecto 4. */
  maxConcurrentDownloads?: number;
  /** Reintentos de una descarga que fallo por algo pasajero. Por defecto 2. */
  downloadRetries?: number;
  /** Espera en ms antes del reintento numero `attempt` (desde 1). Por defecto 0,5 s, 1 s, 2 s. */
  retryDelayMs?: (attempt: number) => number;
  /** Reloj en ms, para `error.retryAt`. Por defecto Date.now. */
  now?: () => number;
}

/** Lo que vive mientras hay un campo abierto y se descarta al cambiarlo. */
interface Session {
  /** Corta los pedidos JSON de este campo. */
  controller: AbortController;
  subscription: FieldEventsSubscription | null;
  /** Revision de cada plano que esta en la cola o bajando. */
  pendingRevs: Map<string, number>;
  /** Forma con la que se pidio la vista provisoria: en camino, lista o fallida. */
  previewShape: GridShape | null;
  /** Pedido de capas auxiliares en camino, por plano. */
  auxJobs: Map<string, Promise<void>>;
  /** GET /meta en camino. */
  metaRequest: Promise<void> | null;
  /** Ya se pidio /meta al terminar el trabajo. */
  finalMetaRequested: boolean;
  /** Nombre para el que ya se pidio /track en este campo. */
  trackName: string | null;
  trackController: AbortController | null;
}

function newSession(): Session {
  return {
    controller: new AbortController(),
    subscription: null,
    pendingRevs: new Map(),
    previewShape: null,
    auxJobs: new Map(),
    metaRequest: null,
    finalMetaRequested: false,
    trackName: null,
    trackController: null,
  };
}

function sameRequest(a: FieldRequestState, b: FieldRequestState): boolean {
  return a.ra === b.ra && a.dec === b.dec && a.fov === b.fov;
}

function defaultRetryDelayMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1);
}

/** Espera que se corta, con el motivo del corte, si se cancela `signal`. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Dice si al terminar el trabajo hace falta GET /meta: algun plano con datos
 * quedo sin `cube_offset` o `flags` esta vacio. Pasa si el cliente no recibio
 * el `state` que sale justo antes de `done` (contrato, seccion 4.2).
 */
function needsFinalMeta(meta: FieldMeta | null): boolean {
  if (meta === null || !isListed(meta)) return true;
  return (
    meta.flags.length === 0 ||
    meta.planes.some((plane) => isInCube(plane) && plane.cube_offset === null)
  );
}

/**
 * Saca lo bajado que ya no corresponde al documento: planos que dejaron de
 * tener binario o cuya revision retrocedio (el trabajo se rehizo).
 */
function pruneByPlane<Entry extends { rev: number }>(
  entries: Readonly<Record<string, Entry>>,
  meta: FieldMeta,
): Readonly<Record<string, Entry>> {
  const kept: Record<string, Entry> = {};
  let changed = false;
  for (const [key, entry] of Object.entries(entries)) {
    const parsed = parsePlaneKey(key);
    const plane =
      parsed === null ? undefined : findPlane(meta.planes, parsed.epoch, parsed.detector);
    if (plane && hasBinary(plane) && plane.rev >= entry.rev) kept[key] = entry;
    else changed = true;
  }
  return changed ? kept : entries;
}

export function createFieldStore(deps: FieldStoreDeps = {}) {
  const api = deps.api ?? defaultApi;
  // Con un cliente propio la memoria de nombres tambien es propia.
  const resolver = deps.resolver ?? (deps.api ? createNameResolver(api) : defaultResolver);
  const subscribe = deps.subscribe ?? subscribeFieldEvents;
  const downloadRetries = deps.downloadRetries ?? DEFAULT_DOWNLOAD_RETRIES;
  const retryDelayMs = deps.retryDelayMs ?? defaultRetryDelayMs;
  const now = deps.now ?? Date.now;
  const queue = createDownloadQueue({
    concurrency: deps.maxConcurrentDownloads ?? DEFAULT_MAX_DOWNLOADS,
  });

  return create<FieldStore>()((set, get) => {
    let session: Session | null = null;
    let targetController: AbortController | null = null;

    function isCurrent(candidate: Session): boolean {
      return session === candidate;
    }

    /** Cancela todo lo del campo abierto: pedidos, cola de descargas y flujo de eventos. */
    function endSession(): void {
      const ended = session;
      if (!ended) return;
      session = null;
      ended.controller.abort();
      ended.trackController?.abort();
      ended.subscription?.close();
      queue.cancelAll();
    }

    function toFieldError(error: unknown, source: FieldError["source"]): FieldError {
      if (!isApiError(error)) {
        return {
          code: "unknown",
          source,
          retryable: false,
          retryAfterS: null,
          retryAt: null,
          message: String(error),
        };
      }
      return {
        code: error.code,
        source,
        retryable: error.retryable,
        retryAfterS: error.retryAfterS,
        retryAt: error.retryAfterS === null ? null : now() + error.retryAfterS * 1000,
        message: error.message,
      };
    }

    /** Repite una descarga que fallo por algo pasajero, respetando Retry-After. */
    async function withRetries<Result>(
      task: () => Promise<Result>,
      signal: AbortSignal,
    ): Promise<Result> {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await task();
        } catch (error) {
          if (signal.aborted || !isApiError(error) || !error.retryable) throw error;
          if (attempt > downloadRetries) throw error;
          const wait =
            error.retryAfterS !== null
              ? Math.min(error.retryAfterS * 1000, MAX_RETRY_AFTER_MS)
              : retryDelayMs(attempt);
          await sleep(wait, signal);
        }
      }
    }

    // ---- Planos -----------------------------------------------------------

    /** Guarda planos bajados y, en el mismo cambio de estado, lo que venga en `extra`. */
    function storePlanes(loaded: readonly LoadedPlane[], extra: Partial<FieldState> = {}): void {
      const state = get();
      const planes = { ...state.planes };
      const planeErrors = { ...state.planeErrors };
      let changed = false;
      for (const entry of loaded) {
        const key = planeKey(entry.epoch, entry.detector);
        const previous = planes[key];
        // Gana la revision mas alta; una descarga vieja que llega tarde no pisa a la nueva.
        if (previous && previous.rev >= entry.rev) continue;
        planes[key] = entry;
        delete planeErrors[key];
        changed = true;
      }
      if (changed) set({ ...extra, planes, planeErrors });
      else if (Object.keys(extra).length > 0) set(extra);
    }

    async function downloadPlane(
      current: Session,
      fieldId: string,
      shape: GridShape,
      plane: Plane,
      signal: AbortSignal,
    ): Promise<void> {
      const key = planeKey(plane.epoch, plane.detector);
      try {
        // El cubo pudo haberlo traido mientras este pedido esperaba turno.
        if ((get().planes[key]?.rev ?? -1) >= plane.rev) return;
        const buffer = await withRetries(
          () =>
            api.getPlane(fieldId, plane.epoch, plane.detector, shape, { rev: plane.rev, signal }),
          signal,
        );
        if (!isCurrent(current) || signal.aborted) return;
        storePlanes([
          {
            epoch: plane.epoch,
            detector: plane.detector,
            rev: plane.rev,
            status: plane.status,
            plane,
            image: toPlaneImage(planeView(buffer, shape), shape),
          },
        ]);
      } catch (error) {
        if (isAbortError(error) || !isCurrent(current) || signal.aborted) return;
        console.warn(`plano ${key} rev ${plane.rev}: no se pudo bajar`, error);
        set({
          planeErrors: {
            ...get().planeErrors,
            [key]: { rev: plane.rev, code: errorCodeOf(error) },
          },
        });
      } finally {
        if (current.pendingRevs.get(key) === plane.rev) current.pendingRevs.delete(key);
        // Puede ser el ultimo de la banda actual: es el momento de pedir el cubo.
        if (isCurrent(current) && !signal.aborted) reconcile();
      }
    }

    /** Pide un plano si su revision es mas nueva que la que esta bajada o en camino. */
    function wantPlane(current: Session, fieldId: string, shape: GridShape, plane: Plane): void {
      const key = planeKey(plane.epoch, plane.detector);
      const state = get();
      if ((state.planes[key]?.rev ?? -1) >= plane.rev) return;
      // Una descarga que fallo no se repite sola para la misma revision.
      if (state.planeErrors[key]?.rev === plane.rev) return;

      const jobKey = planeJobKey(key);
      const pending = current.pendingRevs.get(key);
      if (pending !== undefined) {
        if (pending >= plane.rev) return;
        // Sin `rev` vigente el backend devuelve la revision mas nueva: el pedido
        // viejo traeria los mismos bytes con el rotulo equivocado. Se reemplaza.
        queue.cancel(jobKey);
      }
      current.pendingRevs.set(key, plane.rev);
      void queue.add({
        key: jobKey,
        priority: () =>
          plane.detector === get().band ? PRIORITY_CURRENT_BAND : PRIORITY_OTHER_BAND,
        run: (signal) => downloadPlane(current, fieldId, shape, plane, signal),
      });
    }

    /**
     * Saca de la cola los planos de otras bandas que todavia no salieron. Sin
     * esto, recorrer las bandas rapido deja encolados los planos de cada una y
     * se terminan bajando todos, uno por uno, aunque nadie los este mirando.
     */
    function dropWaitingPlanes(current: Session, band: Band): void {
      const dropped = queue.cancelWaiting((jobKey) => {
        if (!jobKey.startsWith(PLANE_JOB_PREFIX)) return false;
        const parsed = parsePlaneKey(jobKey.slice(PLANE_JOB_PREFIX.length));
        return parsed !== null && parsed.detector !== band;
      });
      // El trabajo no llego a correr: nadie mas borra su marca de "en camino".
      for (const jobKey of dropped) {
        current.pendingRevs.delete(jobKey.slice(PLANE_JOB_PREFIX.length));
      }
    }

    // ---- Vista provisoria -------------------------------------------------

    async function downloadPreview(
      current: Session,
      fieldId: string,
      shape: GridShape,
      signal: AbortSignal,
    ): Promise<void> {
      try {
        const buffer = await withRetries(() => api.getPreview(fieldId, shape, { signal }), signal);
        if (!isCurrent(current) || signal.aborted) return;
        set({ preview: { image: toPlaneImage(planeView(buffer, shape), shape), shape } });
      } catch (error) {
        if (isAbortError(error) || !isCurrent(current) || signal.aborted) return;
        // La vista provisoria es opcional: si falla, el campo carga igual.
        console.warn("vista provisoria: no se pudo bajar", error);
      }
    }

    function syncPreview(current: Session, fieldId: string, meta: FieldMeta): void {
      const state = get();
      if (meta.preview.status !== "ready") {
        // `unavailable`: se descarto. `pending`: todavia no esta.
        if (meta.preview.status === "unavailable" && state.preview !== null) {
          set({ preview: null });
        }
        return;
      }
      // Antes de `listed` no hay `grid`: se adelanta con la tabla del contrato.
      const shape = meta.grid?.shape ?? contractGridShape(meta.request.fov);
      if (shape === null) return;
      if (state.preview !== null) {
        if (sameShape(state.preview.shape, shape)) return;
        // Se bajo con la forma de la tabla y la grilla real resulto otra.
        set({ preview: null });
      }
      // Ya se pidio con esta forma: esta en camino o fallo.
      if (current.previewShape !== null && sameShape(current.previewShape, shape)) return;
      // Solo hace falta mientras no haya nada de SPHEREx para mostrar en la banda actual.
      if (hasLoadedPlaneOfBand(state.planes, state.band)) return;
      if (meta.planes?.some((plane) => plane.detector === state.band && hasBinary(plane))) return;

      current.previewShape = shape;
      queue.cancel(PREVIEW_JOB);
      void queue.add({
        key: PREVIEW_JOB,
        priority: () => PRIORITY_CURRENT_BAND,
        run: (signal) => downloadPreview(current, fieldId, shape, signal),
      });
    }

    // ---- Cubo -------------------------------------------------------------

    async function downloadCube(
      current: Session,
      fieldId: string,
      meta: ListedFieldMeta,
      signal: AbortSignal,
    ): Promise<void> {
      const shape = meta.grid.shape;
      try {
        const buffer = await withRetries(
          () => api.getCube(fieldId, { shape, planes: meta.planes }, { rev: meta.rev, signal }),
          signal,
        );
        if (!isCurrent(current) || signal.aborted) return;
        const known = get().planes;
        const loaded: LoadedPlane[] = [];
        for (const plane of meta.planes) {
          if (!isInCube(plane)) continue;
          // Lo que ya esta bajado en esa revision no se vuelve a convertir.
          if ((known[planeKey(plane.epoch, plane.detector)]?.rev ?? -1) >= plane.rev) continue;
          const values = cubePlaneView(buffer, shape, plane);
          if (values === null) continue;
          loaded.push({
            epoch: plane.epoch,
            detector: plane.detector,
            rev: plane.rev,
            status: plane.status,
            plane,
            image: toPlaneImage(values, shape),
          });
        }
        storePlanes(loaded, { cube: { status: "ready", error: null } });
      } catch (error) {
        if (isAbortError(error) || !isCurrent(current) || signal.aborted) return;
        console.warn("cubo: no se pudo bajar", error);
        set({ cube: { status: "error", error: errorCodeOf(error) } });
      }
    }

    /** Con el campo terminado y la banda actual ya bajada, trae el resto de una sola vez. */
    function syncCube(current: Session, fieldId: string, meta: ListedFieldMeta): void {
      const state = get();
      if (state.phase !== "ready" || state.cube.status !== "idle") return;
      const inCube = meta.planes.filter(isInCube);
      // Sin `cube_offset` no se puede partir el cubo; llega con GET /meta.
      if (inCube.some((plane) => plane.cube_offset === null)) return;

      const missing = inCube.filter(
        (plane) => (state.planes[planeKey(plane.epoch, plane.detector)]?.rev ?? -1) < plane.rev,
      );
      if (missing.length === 0) {
        // Todo llego plano por plano: no hace falta el cubo.
        set({ cube: { status: "ready", error: null } });
        return;
      }
      // Primero la banda actual: el cubo espera a que sus planos esten bajados o hayan fallado.
      const bandPending = missing.some(
        (plane) =>
          plane.detector === state.band &&
          state.planeErrors[planeKey(plane.epoch, plane.detector)]?.rev !== plane.rev,
      );
      if (bandPending) return;
      // Lo que falta ya esta bajando plano por plano: el cubo traeria todo de
      // nuevo. Cuando esos pedidos terminan se vuelve a mirar; si alguno fallo,
      // ahi si se pide el cubo.
      const allOnTheWay = missing.every(
        (plane) =>
          (current.pendingRevs.get(planeKey(plane.epoch, plane.detector)) ?? -1) >= plane.rev,
      );
      if (allOnTheWay) return;

      set({ cube: { status: "loading", error: null } });
      void queue.add({
        key: CUBE_JOB,
        priority: () => PRIORITY_CUBE,
        run: (signal) => downloadCube(current, fieldId, meta, signal),
      });
    }

    // ---- Objeto buscado ---------------------------------------------------

    async function resolveTarget(name: string, controller: AbortController): Promise<void> {
      try {
        const resolved = await resolver.resolve(name, { signal: controller.signal });
        if (controller.signal.aborted) return;
        set({ target: { ...get().target, resolveStatus: "ready", resolved } });
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return;
        set({
          target: { ...get().target, resolveStatus: "error", resolveError: errorCodeOf(error) },
        });
      }
    }

    async function loadTrack(
      fieldId: string,
      name: string,
      controller: AbortController,
    ): Promise<void> {
      try {
        const track = await api.getTrack(fieldId, name, { signal: controller.signal });
        if (controller.signal.aborted) return;
        set({ target: { ...get().target, trackStatus: "ready", track } });
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return;
        set({ target: { ...get().target, trackStatus: "error", trackError: errorCodeOf(error) } });
      }
    }

    /** Pide /track una vez por campo y por nombre, cuando ya se conocen las epocas. */
    function syncTrack(current: Session, fieldId: string): void {
      const { target } = get();
      if (target.name === null || current.trackName === target.name) return;
      current.trackName = target.name;
      current.trackController?.abort();
      const controller = new AbortController();
      current.trackController = controller;
      set({ target: { ...target, trackStatus: "loading", track: null, trackError: null } });
      void loadTrack(fieldId, target.name, controller);
    }

    // ---- Metadatos --------------------------------------------------------

    /** Lleva lo bajado a lo que dice un documento nuevo. */
    function replaceMeta(meta: FieldMeta): void {
      const state = get();
      set({
        meta,
        planes: pruneByPlane(state.planes, meta),
        planeErrors: pruneByPlane(state.planeErrors, meta),
        aux: pruneByPlane(state.aux, meta),
      });
    }

    /** GET /meta. Solo hay un pedido en camino a la vez. */
    function refreshMeta(current: Session): Promise<void> {
      if (current.metaRequest) return current.metaRequest;
      const fieldId = get().fieldId;
      if (fieldId === null) return Promise.resolve();

      const request = (async () => {
        try {
          const fresh = await api.getMeta(fieldId, { signal: current.controller.signal });
          if (!isCurrent(current)) return;
          const state = get();
          if (state.meta === null || state.phase !== "loading") {
            // Sin eventos en camino manda el documento del servidor.
            replaceMeta(fresh);
          } else if (
            state.meta.flags &&
            fresh.flags &&
            fresh.flags.length > state.meta.flags.length
          ) {
            // Con el flujo abierto un evento ya aplicado puede ser mas nuevo que
            // esta respuesta: solo se toma la lista de flags, que nunca se achica.
            set({ meta: { ...state.meta, flags: fresh.flags } });
          }
          reconcile();
        } catch (error) {
          if (!isAbortError(error) && isCurrent(current)) {
            console.warn("GET /meta: sin respuesta", error);
          }
        } finally {
          current.metaRequest = null;
        }
      })();
      current.metaRequest = request;
      return request;
    }

    /** Al terminar el trabajo: si faltan `cube_offset` o los flags, se piden con /meta. */
    function finalize(current: Session): void {
      if (current.finalMetaRequested || !needsFinalMeta(get().meta)) return;
      current.finalMetaRequested = true;
      void refreshMeta(current);
    }

    // ---- Capas auxiliares -------------------------------------------------

    function setAux(key: string, entry: AuxEntry): void {
      set({ aux: { ...get().aux, [key]: entry } });
    }

    async function downloadAux(
      current: Session,
      fieldId: string,
      shape: GridShape,
      plane: Plane,
      signal: AbortSignal,
    ): Promise<void> {
      const key = planeKey(plane.epoch, plane.detector);
      try {
        // Los bits se nombran con `flags[]`. Mientras el campo carga esa lista
        // llega vacia por el flujo y la que esta al dia es la de /meta.
        if ((get().meta?.flags?.length ?? 0) === 0) await refreshMeta(current);
        if (!isCurrent(current) || signal.aborted) return;
        const buffer = await withRetries(
          () => api.getAux(fieldId, plane.epoch, plane.detector, shape, { signal }),
          signal,
        );
        if (!isCurrent(current) || signal.aborted) return;
        setAux(key, {
          status: "ready",
          rev: plane.rev,
          layers: splitAux(buffer, shape),
          layersRev: plane.rev,
          error: null,
        });
      } catch (error) {
        if (isAbortError(error) || !isCurrent(current) || signal.aborted) return;
        console.warn(`capas auxiliares ${key}: no se pudieron bajar`, error);
        setAux(key, {
          status: "error",
          rev: plane.rev,
          layers: null,
          layersRev: null,
          error: errorCodeOf(error),
        });
      }
    }

    /**
     * Pide las capas auxiliares de un plano, salvo que las de esa revision ya
     * esten o esten en camino. Un pedido que fallo se vuelve a intentar.
     */
    function requestAux(
      current: Session,
      fieldId: string,
      shape: GridShape,
      plane: Plane,
    ): Promise<void> {
      const key = planeKey(plane.epoch, plane.detector);
      const entry = get().aux[key];
      if (entry && entry.status !== "error" && entry.rev >= plane.rev) {
        // Las de esta revision ya estan o estan en camino.
        return current.auxJobs.get(key) ?? Promise.resolve();
      }

      const jobKey = `aux:${key}`;
      queue.cancel(jobKey);
      // Mientras llegan las nuevas quedan guardadas las de la revision anterior.
      setAux(key, {
        status: "loading",
        rev: plane.rev,
        layers: entry?.layers ?? null,
        layersRev: entry?.layersRev ?? null,
        error: null,
      });
      const job: Promise<void> = queue
        .add({
          key: jobKey,
          priority: () => PRIORITY_AUX,
          run: (signal) => downloadAux(current, fieldId, shape, plane, signal),
        })
        .finally(() => {
          if (current.auxJobs.get(key) === job) current.auxJobs.delete(key);
        });
      current.auxJobs.set(key, job);
      return job;
    }

    /**
     * Vuelve a pedir las capas auxiliares de la banda actual cuyo plano cambio
     * de revision. Sin esto, con la capa de flags prendida sobre un plano
     * provisorio, al llegar el definitivo quedaba la cobertura vieja debajo de
     * la imagen nueva. Las de otras bandas esperan a que se vuelva a ellas.
     */
    function syncAux(current: Session, fieldId: string, meta: ListedFieldMeta): void {
      const { aux, band } = get();
      for (const [key, entry] of Object.entries(aux)) {
        const parsed = parsePlaneKey(key);
        if (parsed === null || parsed.detector !== band) continue;
        const plane = findPlane(meta.planes, parsed.epoch, parsed.detector);
        // Solo si hay una revision mas nueva: un pedido que fallo para la
        // revision vigente no se repite solo (para eso esta `loadAux`).
        if (!plane || !hasBinary(plane) || plane.rev <= entry.rev) continue;
        void requestAux(current, fieldId, meta.grid.shape, plane);
      }
    }

    // ---- Eventos ----------------------------------------------------------

    /** Baja lo que falta segun el estado actual. Se llama despues de cada cambio. */
    function reconcile(): void {
      const current = session;
      const state = get();
      if (!current || state.fieldId === null || state.meta === null) return;
      const { fieldId, meta } = state;

      syncPreview(current, fieldId, meta);
      if (!isListed(meta)) return;
      for (const plane of meta.planes) {
        if (plane.detector === state.band && hasBinary(plane)) {
          wantPlane(current, fieldId, meta.grid.shape, plane);
        }
      }
      syncAux(current, fieldId, meta);
      syncCube(current, fieldId, meta);
      syncTrack(current, fieldId);
    }

    function closeStream(current: Session): void {
      current.subscription?.close();
      current.subscription = null;
    }

    function handleEvent(current: Session, event: FieldEvent): void {
      const meta = applyFieldEvent(get().meta, event);
      switch (event.type) {
        case "state":
        case "listed":
          // Todo `state` reemplaza el documento, tambien a mitad del flujo.
          replaceMeta(event.data);
          break;
        case "done":
          set({ meta, phase: "ready", stream: "closed" });
          // El cliente cierra de su lado para que nada reconecte solo.
          closeStream(current);
          finalize(current);
          break;
        case "error":
          set({
            meta,
            phase: "error",
            stream: "closed",
            error: {
              code: event.data.code,
              source: "job",
              retryable: event.data.retryable,
              retryAfterS: null,
              retryAt: null,
              message: event.data.message,
            },
          });
          closeStream(current);
          break;
        default:
          // Un evento repetido o viejo deja el documento igual: no hay nada que avisar.
          if (meta !== get().meta) set({ meta });
      }
      reconcile();
    }

    function connect(current: Session, fieldId: string): void {
      current.subscription = subscribe(api.eventsUrl(fieldId), {
        ...deps.eventsOptions,
        onEvent: (event) => {
          if (isCurrent(current)) handleEvent(current, event);
        },
        onStatus: (status) => {
          if (isCurrent(current) && get().stream !== status) set({ stream: status });
        },
        onFailure: (error) => {
          if (!isCurrent(current)) return;
          current.subscription = null;
          set({ phase: "error", error: toFieldError(error, "stream") });
        },
      });
    }

    async function sendPriority(current: Session, fieldId: string, band: Band): Promise<void> {
      try {
        await api.setPriority(fieldId, band, { signal: current.controller.signal });
      } catch (error) {
        // No cambia lo que se ve: los planos de la banda llegan igual, mas tarde.
        if (!isAbortError(error) && isCurrent(current)) {
          console.warn("POST /priority: sin respuesta", error);
        }
      }
    }

    async function start(request: FieldRequestState, band: Band): Promise<void> {
      endSession();
      const current = newSession();
      session = current;
      const { target } = get();
      set({
        ...INITIAL_FIELD_STATE,
        phase: "requesting",
        request,
        band,
        // El objeto buscado sigue siendo el mismo; su trayectoria es de cada campo.
        target: { ...target, trackStatus: "idle", track: null, trackError: null },
      });

      let response: FieldResponse;
      try {
        response = await api.requestField(
          { ra: request.ra, dec: request.dec, fov: request.fov, band },
          { signal: current.controller.signal },
        );
      } catch (error) {
        if (isAbortError(error) || !isCurrent(current)) return;
        set({ phase: "error", error: toFieldError(error, "request") });
        return;
      }
      if (!isCurrent(current)) return;

      const finished = isFinishedStatus(response.meta.status);
      set({ fieldId: response.id, meta: response.meta, phase: finished ? "ready" : "loading" });
      if (finished) {
        // Un campo ya calculado no necesita SSE (contrato, seccion 1).
        finalize(current);
      } else {
        connect(current, response.id);
        // La banda pudo cambiar mientras el POST estaba en camino.
        const currentBand = get().band;
        if (currentBand !== band) void sendPriority(current, response.id, currentBand);
      }
      reconcile();
    }

    return {
      ...INITIAL_FIELD_STATE,

      openField(request) {
        const next: FieldRequestState = {
          ra: request.ra,
          dec: request.dec,
          fov: fieldFovForView(request.fov),
        };
        const state = get();
        if (state.request !== null && sameRequest(state.request, next)) {
          // Es el campo abierto (las vistas de 5 y 10 minutos comparten cubo).
          get().setBand(request.band);
          return Promise.resolve();
        }
        return start(next, request.band);
      },

      syncWithUrl(url) {
        if (!hasField(url)) {
          get().close();
          return;
        }
        void get().openField({ ra: url.ra, dec: url.dec, fov: url.fov, band: url.band });
        get().setTarget(url.name);
      },

      setBand(band) {
        const state = get();
        if (state.band === band) return;
        set({ band });
        if (session) {
          dropWaitingPlanes(session, band);
          if (state.phase === "loading" && state.fieldId !== null) {
            void sendPriority(session, state.fieldId, band);
          }
        }
        reconcile();
      },

      setTarget(name) {
        const wanted = name?.trim() || null;
        if (get().target.name === wanted) return;

        targetController?.abort();
        targetController = null;
        if (session) {
          session.trackController?.abort();
          session.trackController = null;
          session.trackName = null;
        }
        if (wanted === null) {
          set({ target: EMPTY_TARGET });
          return;
        }
        const controller = new AbortController();
        targetController = controller;
        set({ target: { ...EMPTY_TARGET, name: wanted, resolveStatus: "loading" } });
        void resolveTarget(wanted, controller);
        reconcile();
      },

      loadAux(epoch, detector) {
        const current = session;
        const state = get();
        if (!current || state.fieldId === null || state.meta === null || !isListed(state.meta)) {
          return Promise.resolve();
        }
        const plane = findPlane(state.meta.planes, epoch, detector ?? state.band);
        if (!plane || !hasBinary(plane)) return Promise.resolve();
        return requestAux(current, state.fieldId, state.meta.grid.shape, plane);
      },

      retry() {
        const { request, band } = get();
        return request === null ? Promise.resolve() : start(request, band);
      },

      retryDownloads() {
        const state = get();
        if (session && state.preview === null) session.previewShape = null;
        set({
          planeErrors: {},
          cube: state.cube.status === "error" ? { status: "idle", error: null } : state.cube,
        });
        reconcile();
      },

      close() {
        endSession();
        targetController?.abort();
        targetController = null;
        set(INITIAL_FIELD_STATE);
      },
    };
  });
}

/** Estado del campo abierto en el visor. */
export const useFieldStore = createFieldStore();
