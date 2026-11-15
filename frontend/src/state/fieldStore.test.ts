// @vitest-environment node
//
// Estado del campo contra un backend simulado (fieldStore.testkit.ts), sin
// red. Los documentos y la secuencia de eventos son los datos de muestra de
// src/test/fixtures; los binarios son sinteticos y reconocibles.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/api/client";
import { planeKey } from "@/data/planeKey";
import {
  selectAuxLayers,
  selectBandInfo,
  selectErrorCode,
  selectIsProvisional,
  selectLoadProgress,
  selectPreview,
  selectQueuePosition,
  selectTargetPosition,
  selectTimeline,
  selectWarningGroups,
} from "@/data/selectors";
import { resolveBarnard, resolveCoordinates } from "@/test/contractExamples";
import { FRONTEND_DIR } from "@/test/sourceFiles";
import { MASK_NO_DATA, MASK_SATURATED, MASK_VALID } from "@/viewer/planeImage";
import { createFieldStore, type FieldStoreDeps, type OpenFieldRequest } from "./fieldStore";
import {
  binaryResponse,
  createFakeBackend,
  type EventStream,
  errorResponse,
  type FakeBackend,
  jsonResponse,
  PREVIEW_FILL,
  planeFill,
  type RawMeta,
  type RawPlane,
} from "./fieldStore.testkit";
import { DEFAULT_URL_STATE } from "./urlState";

const FIXTURES = join(FRONTEND_DIR, "src", "test", "fixtures");

function fixture<Value = unknown>(name: string): Value {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Value;
}

interface RawEvent {
  event: string;
  id: number;
  data: unknown;
}

const WISE_ID = "4022da836c5a1505";
const BARNARD_ID = "4a2e877f8ee4efd2";
const WISE: OpenFieldRequest = { ra: 133.7598, dec: -7.2422, fov: 0.1667, band: 3 };
const EPSINDB: OpenFieldRequest = { ra: 331.0966, dec: -56.8006, fov: 0.1667, band: 2 };
const BARNARD: OpenFieldRequest = { ra: 269.4463, dec: 4.7683, fov: 0.1667, band: 3 };
const NOW = 1_700_000_000_000;

const stores: Array<ReturnType<typeof createFieldStore>> = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.getState().close();
});

/** Store sobre un backend simulado que sirve el documento de una muestra. */
function setup(sampleName = "wise0855", deps: FieldStoreDeps = {}) {
  const backend = createFakeBackend(fixture(`meta-${sampleName}.json`));
  const store = createFieldStore({
    api: createApiClient({ fetch: backend.fetch }),
    eventsOptions: { fetch: backend.fetch, retryDelayMs: () => 0 },
    retryDelayMs: () => 0,
    now: () => NOW,
    ...deps,
  });
  stores.push(store);
  return { backend, store };
}

/** Lleva al documento del backend simulado lo que dice un evento, como haria el backend real. */
function serverApply(backend: FakeBackend, event: RawEvent): void {
  if (event.event === "state" || event.event === "listed") {
    backend.state.meta = event.data as RawMeta;
  } else if (event.event === "plane") {
    const { plane } = event.data as { plane: RawPlane };
    const meta = backend.state.meta;
    backend.state.meta = {
      ...meta,
      planes: meta.planes?.map((item) =>
        item.epoch === plane.epoch && item.detector === plane.detector ? plane : item,
      ),
    };
  }
}

async function streamAt(backend: FakeBackend, index: number): Promise<EventStream> {
  await vi.waitFor(() => expect(backend.streams.length).toBeGreaterThan(index));
  const stream = backend.streams[index];
  if (!stream) throw new Error(`no hay conexion ${index} a /events`);
  return stream;
}

/**
 * Abre un campo nuevo: el POST responde 202 con el trabajo en cola y el test
 * reproduce la transcripcion de eventos de WISE 0855 hasta donde quiera.
 */
async function openNewField(
  request: OpenFieldRequest = WISE,
  deps: FieldStoreDeps = {},
  editEvents: (events: RawEvent[]) => RawEvent[] = (events) => events,
) {
  const { backend, store } = setup("wise0855", deps);
  const events = editEvents(fixture<RawEvent[]>("events-new-field.json"));
  const first = events[0];
  if (!first) throw new Error("la transcripcion esta vacia");
  backend.state.meta = first.data as RawMeta;
  backend.state.fallbackShape = [195, 195];
  backend.handlers.field = () =>
    jsonResponse(
      {
        id: backend.state.meta.id,
        status: backend.state.meta.status,
        events_url: `/api/field/${backend.state.meta.id}/events`,
        meta: backend.state.meta,
      },
      202,
    );

  await store.getState().openField(request);
  const stream = await streamAt(backend, 0);
  let cursor = 0;

  return {
    backend,
    store,
    events,
    stream,
    /** El evento con ese `id` en la transcripcion. */
    eventById(id: number): RawEvent {
      const event = events.find((candidate) => candidate.id === id);
      if (!event) throw new Error(`la transcripcion no tiene el evento ${id}`);
      return event;
    },
    /** Emite, en orden, los eventos que faltan hasta el de ese `id` inclusive. */
    play(lastId: number, target: EventStream = stream): void {
      for (;;) {
        const event = events[cursor];
        if (!event || event.id > lastId) return;
        cursor += 1;
        serverApply(backend, event);
        target.event(event.event, event.data, event.id);
      }
    },
    /** Avanza el backend sin mandar los eventos: lo que se pierde un cliente desconectado. */
    skip(lastId: number): void {
      for (;;) {
        const event = events[cursor];
        if (!event || event.id > lastId) return;
        cursor += 1;
        serverApply(backend, event);
      }
    },
  };
}

/** Pedidos de planos como "epoca/detector?rev=N", en orden. */
function planeRequests(backend: FakeBackend): string[] {
  return backend
    .requests("plane")
    .map((call) => `${call.path.split("/plane/")[1]}?rev=${call.query.get("rev")}`);
}

function loadedRevs(store: ReturnType<typeof createFieldStore>, band: number): number[] {
  return Object.values(store.getState().planes)
    .filter((plane) => plane.detector === band)
    .sort((a, b) => a.epoch - b.epoch)
    .map((plane) => plane.rev);
}

function timelineStates(store: ReturnType<typeof createFieldStore>): string[] {
  return selectTimeline(store.getState()).map((entry) => entry.state);
}

function silenceWarnings() {
  return vi.spyOn(console, "warn").mockImplementation(() => {});
}

/**
 * Hace que /aux diga de que revision del plano son las capas: la cobertura
 * del primer pixel es la revision vigente en el servidor.
 */
function serveAuxWithRevision(backend: FakeBackend): void {
  backend.handlers.aux = (_call, epoch, detector) => {
    const plane = backend.state.meta.planes?.find(
      (item) => item.epoch === epoch && item.detector === detector,
    );
    const size = 195 * 195;
    const bytes = new ArrayBuffer(6 * size);
    new Uint16Array(bytes, 4 * size, size)[0] = plane?.rev ?? 0;
    return binaryResponse(bytes);
  };
}

/**
 * Deja con datos solo los planos de esas bandas; los demas quedan vacios, como
 * en un campo que no tiene exposiciones en un detector.
 */
function onlyBands(meta: RawMeta, bands: readonly number[]): RawMeta {
  let inCube = 0;
  return {
    ...meta,
    planes: meta.planes?.map((plane) => {
      if (!bands.includes(plane.detector)) {
        return {
          ...plane,
          status: "empty",
          rev: 0,
          n_exposures: 0,
          n_used: 0,
          n_failed: 0,
          mjd_mean: null,
          stats: null,
          saturated: [],
          cube_offset: null,
        };
      }
      const cube_offset = inCube * 4 * 195 * 195;
      inCube += 1;
      return { ...plane, cube_offset };
    }),
  };
}

// ---------------------------------------------------------------------------

describe("campo ya calculado", () => {
  it("usa los metadatos del POST, baja la banda actual y despues el resto con /cube", async () => {
    const { backend, store } = setup();
    await store.getState().openField(WISE);

    expect(backend.requests("field")[0]?.body).toEqual({
      ra: 133.7598,
      dec: -7.2422,
      fov: 0.1667,
      band: 3,
    });
    expect(store.getState().phase).toBe("ready");
    expect(store.getState().fieldId).toBe(WISE_ID);
    expect(store.getState().meta?.status).toBe("partial");
    expect(store.getState().error).toBeNull();

    await vi.waitFor(() => expect(store.getState().cube.status).toBe("ready"));

    // Un campo terminado no necesita SSE, ni /meta, ni vista provisoria.
    expect(backend.streams).toHaveLength(0);
    expect(store.getState().stream).toBeNull();
    expect(backend.requests("meta")).toHaveLength(0);
    expect(backend.requests("preview")).toHaveLength(0);

    // Primero los tres planos de la banda actual, cada uno una vez y con su revision.
    expect(planeRequests(backend)).toEqual(["1/3?rev=2", "2/3?rev=2", "3/3?rev=2"]);
    const cubeCalls = backend.requests("cube");
    expect(cubeCalls).toHaveLength(1);
    expect(cubeCalls[0]?.query.get("rev")).toBe("1");
    const order = backend.calls.map((call) => call.path.split("/").at(3) ?? call.path);
    expect(order).toEqual(["/field", "plane", "plane", "plane", "cube"]);

    // Quedan los 18 planos, por (epoca, detector), con su rev y su status.
    const { planes } = store.getState();
    expect(Object.keys(planes)).toHaveLength(18);
    const plane = planes[planeKey(2, 6)];
    expect(plane?.rev).toBe(2);
    expect(plane?.status).toBe("ready");
    expect(plane?.plane.n_used).toBe(plane?.plane.n_exposures);
    expect(planes[planeKey(2, 3)]?.status).toBe("partial");

    // Cada imagen es un PlaneImage: valores sin NaN ni infinito y su mascara.
    const image = plane?.image;
    expect([image?.width, image?.height]).toEqual([195, 195]);
    expect(image?.values[2]).toBe(planeFill(2, 6, 2));
    expect(image?.values[0]).toBe(0);
    expect(image?.values[1]).toBe(0);
    expect([image?.mask[0], image?.mask[1], image?.mask[2]]).toEqual([
      MASK_NO_DATA,
      MASK_SATURATED,
      MASK_VALID,
    ]);
    expect(image?.saturatedCount).toBe(1);
    // Los del cubo salen de su `cube_offset`: cada plano tiene sus propios valores.
    expect(planes[planeKey(3, 1)]?.image.values[2]).toBe(planeFill(3, 1, 2));

    expect(timelineStates(store)).toEqual(["loaded", "loaded", "loaded"]);
    expect(selectLoadProgress(store.getState())?.fraction).toBe(1);
  });

  it("las vistas de 5 y 10 minutos comparten el cubo base: no hay otro POST", async () => {
    const { backend, store } = setup();
    await store.getState().openField({ ...WISE, fov: 0.0833 });

    expect(backend.requests("field")[0]?.body).toMatchObject({ fov: 0.1667 });
    expect(store.getState().request).toEqual({ ra: 133.7598, dec: -7.2422, fov: 0.1667 });

    await store.getState().openField({ ...WISE, fov: 0.1667 });
    await store.getState().openField({ ...WISE, fov: 0.0833, band: 5 });

    expect(backend.requests("field")).toHaveLength(1);
    expect(store.getState().band).toBe(5);
  });

  it("la vista de 30 minutos pide el escalon amplio y es otro campo", async () => {
    const { backend, store } = setup();
    await store.getState().openField(WISE);
    backend.handlers.field = () => errorResponse("no_coverage", 404);
    await store.getState().openField({ ...WISE, fov: 0.5 });

    expect(backend.requests("field")[1]?.body).toMatchObject({ fov: 0.5 });
    expect(store.getState().request?.fov).toBe(0.5);
    expect(selectErrorCode(store.getState())).toBe("no_coverage");
  });

  it("al cambiar de banda baja esos planos si el cubo todavia no llego", async () => {
    const { backend, store } = setup();
    backend.hold("cube");
    await store.getState().openField(WISE);
    await vi.waitFor(() => expect(backend.heldCount("cube")).toBe(1));
    expect(store.getState().cube.status).toBe("loading");

    store.getState().setBand(6);
    await vi.waitFor(() => expect(loadedRevs(store, 6)).toEqual([2, 2, 2]));
    expect(planeRequests(backend).slice(3)).toEqual(["1/6?rev=2", "2/6?rev=2", "3/6?rev=2"]);
    // El trabajo ya termino: no hay nada que priorizar.
    expect(backend.requests("priority")).toHaveLength(0);

    backend.release("cube");
    await vi.waitFor(() => expect(store.getState().cube.status).toBe("ready"));
    expect(Object.keys(store.getState().planes)).toHaveLength(18);

    // Con todo bajado, volver a cambiar de banda no pide nada.
    const before = backend.calls.length;
    store.getState().setBand(1);
    store.getState().setBand(3);
    expect(backend.calls).toHaveLength(before);
  });

  it("si al campo terminado le faltan cube_offset o flags, pide /meta antes del cubo", async () => {
    const { backend, store } = setup();
    const complete = backend.state.meta as RawMeta & { flags: unknown[] };
    const incomplete = {
      ...complete,
      flags: [],
      planes: complete.planes?.map((plane) => ({ ...plane, cube_offset: null })),
    };
    backend.handlers.field = () =>
      jsonResponse({ id: WISE_ID, status: "partial", events_url: "/x", meta: incomplete });

    await store.getState().openField(WISE);
    await vi.waitFor(() => expect(store.getState().cube.status).toBe("ready"));

    expect(backend.requests("meta")).toHaveLength(1);
    expect(store.getState().meta?.flags).toHaveLength(complete.flags.length);
    expect(Object.keys(store.getState().planes)).toHaveLength(18);
  });

  it("los planos vacios no se piden y la epoca queda marcada como vacia", async () => {
    // Epsilon Indi B: la epoca 4 no tiene exposiciones en los detectores 1 y 4.
    const { backend, store } = setup("epsindb");
    await store.getState().openField({ ...EPSINDB, band: 1 });
    await vi.waitFor(() => expect(store.getState().cube.status).toBe("ready"));

    expect(planeRequests(backend)).toEqual(["1/1?rev=2", "2/1?rev=2", "3/1?rev=2"]);
    expect(timelineStates(store)).toEqual(["loaded", "loaded", "loaded", "empty"]);
    expect(Object.keys(store.getState().planes)).toHaveLength(22);
    expect(
      selectWarningGroups(store.getState()).find((group) => group.code === "low_coverage")?.count,
    ).toBe(22);
  });
});

describe("campo nuevo, con la secuencia de eventos de la muestra", () => {
  it("sigue el trabajo desde la cola hasta done", async () => {
    const { backend, store, stream, play, eventById } = await openNewField();
    const state = () => store.getState();

    // ---- En cola -----------------------------------------------------------
    expect(state().phase).toBe("loading");
    expect(state().meta?.status).toBe("queued");
    play(2);
    await vi.waitFor(() => expect(state().stream).toBe("open"));
    expect(selectQueuePosition(state())).toBe(1);
    expect(timelineStates(store)).toEqual([]);
    expect(selectLoadProgress(state())?.fraction).toBe(0);

    play(3);
    await vi.waitFor(() => expect(state().meta?.status).toBe("listing"));
    expect(selectQueuePosition(state())).toBeNull();

    // ---- Vista provisoria, antes de conocer la grilla ---------------------
    play(4);
    await vi.waitFor(() => expect(selectPreview(state())).not.toBeNull());
    const preview = selectPreview(state());
    expect(preview?.band).toBe("W1");
    expect(preview?.survey).toBe("WISE");
    expect(preview?.waveUm).toBe(3.4);
    expect(preview?.display).toEqual((eventById(4).data as { display: unknown }).display);
    expect([preview?.image.width, preview?.image.height]).toEqual([195, 195]);
    expect(preview?.image.values[0]).toBe(PREVIEW_FILL);

    // ---- listed: epocas, bandas y grilla, todavia sin imagenes ------------
    play(7);
    await vi.waitFor(() => expect(selectLoadProgress(state())?.done).toBe(1));
    expect(timelineStates(store)).toEqual(["unloaded", "unloaded", "unloaded"]);
    expect(selectBandInfo(state())).toMatchObject({
      detector: 3,
      waveMinUm: 1.6301,
      display: null,
    });
    expect(state().meta?.flags).toEqual([]);
    expect(selectLoadProgress(state())).toMatchObject({
      done: 1,
      total: 258,
      phase: "downloading",
    });
    expect(planeRequests(backend)).toEqual([]);
    expect(selectPreview(state())).not.toBeNull();

    // ---- Primer plano provisorio de la banda pedida -----------------------
    play(8);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([1]));
    expect(planeRequests(backend)).toEqual(["1/3?rev=1"]);
    const provisional = state().planes[planeKey(1, 3)];
    expect(provisional?.status).toBe("building");
    expect(provisional?.plane.n_used).toBeLessThan(provisional?.plane.n_exposures ?? 0);
    expect(provisional?.image.values[2]).toBe(planeFill(1, 3, 1));
    expect(selectIsProvisional(state(), 1)).toBe(true);
    expect(timelineStates(store)).toEqual(["provisional", "unloaded", "unloaded"]);
    // La vista de WISE se retira al llegar el primer plano, aunque sea provisorio.
    expect(selectPreview(state())).toBeNull();
    // La escala del detector llega con el evento.
    const display = (eventById(8).data as { detector_display: Record<string, number> })
      .detector_display;
    expect(selectBandInfo(state())?.display).toEqual({
      vmin: display.vmin,
      vmax: display.vmax,
      median: display.median,
      sigma: display.sigma,
    });

    // ---- Toda la banda pedida: provisorios y despues definitivos ----------
    play(13);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([1, 1, 1]));
    expect(timelineStates(store)).toEqual(["provisional", "provisional", "provisional"]);

    play(18);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([2, 2, 2]));
    expect(timelineStates(store)).toEqual(["loaded", "loaded", "loaded"]);
    expect(state().planes[planeKey(2, 3)]?.status).toBe("partial");
    expect(state().planes[planeKey(1, 3)]?.image.values[2]).toBe(planeFill(1, 3, 2));
    expect(selectIsProvisional(state(), 1)).toBe(false);
    // Cada revision se pidio una sola vez.
    expect(planeRequests(backend)).toEqual([
      "1/3?rev=1",
      "2/3?rev=1",
      "3/3?rev=1",
      "1/3?rev=2",
      "2/3?rev=2",
      "3/3?rev=2",
    ]);

    // ---- Las otras bandas avanzan en el backend y no se bajan una por una --
    play(80);
    await vi.waitFor(() => expect(state().meta?.progress.phase).toBe("finishing"));
    expect(planeRequests(backend)).toHaveLength(6);
    expect(backend.requests("cube")).toHaveLength(0);
    expect(state().phase).toBe("loading");
    expect(selectLoadProgress(state())).toMatchObject({ done: 258, total: 258, fraction: 1 });
    expect(selectWarningGroups(state()).map((group) => [group.code, group.count])).toEqual([
      ["cutouts_failed", 1],
      ["few_exposures", 4],
    ]);

    // ---- state final y done -------------------------------------------------
    play(82);
    await vi.waitFor(() => expect(state().phase).toBe("ready"));
    expect(state().meta?.status).toBe("partial");
    expect(state().meta?.rev).toBe(1);
    expect(state().meta?.progress.phase).toBe("done");
    // El cliente cierra de su lado y no reconecta.
    expect(state().stream).toBe("closed");
    expect(stream.aborted).toBe(true);

    await vi.waitFor(() => expect(state().cube.status).toBe("ready"));
    // El state final trajo cube_offset y flags: no hizo falta /meta.
    expect(backend.requests("meta")).toHaveLength(0);
    expect(state().meta?.flags?.length).toBeGreaterThan(0);
    expect(backend.requests("cube")).toHaveLength(1);
    expect(planeRequests(backend)).toHaveLength(6);
    expect(Object.keys(state().planes)).toHaveLength(18);
    expect(state().planes[planeKey(3, 6)]?.image.values[2]).toBe(planeFill(3, 6, 2));
    expect(backend.requests("preview")).toHaveLength(1);
    expect(backend.streams).toHaveLength(1);
    expect(state().error).toBeNull();
  });

  it("los eventos plane son idempotentes: el plano se vuelve a pedir solo si rev aumento", async () => {
    const { backend, store, stream, play, eventById } = await openNewField();
    play(8);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([1]));

    // El mismo evento otra vez: no hay pedido nuevo.
    const first = eventById(8);
    stream.event(first.event, first.data, first.id);
    play(9);
    await vi.waitFor(() => expect(store.getState().meta?.progress.cutouts_done).toBe(11));
    expect(planeRequests(backend)).toEqual(["1/3?rev=1"]);

    // La definitiva (rev 2) si se pide, y la provisoria repetida despues no la pisa.
    const definitive = eventById(14);
    serverApply(backend, definitive);
    stream.event(definitive.event, definitive.data, definitive.id);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([2]));
    stream.event(first.event, first.data, first.id);
    stream.event("queued", { position: 7 });
    await vi.waitFor(() => expect(store.getState().meta?.progress.queue_position).toBe(7));

    expect(planeRequests(backend)).toEqual(["1/3?rev=1", "1/3?rev=2"]);
    expect(store.getState().planes[planeKey(1, 3)]?.status).toBe("ready");
    expect(store.getState().meta?.planes?.find((plane) => plane.detector === 3)?.rev).toBe(2);
  });

  it("una revision nueva reemplaza al pedido de la anterior que seguia en camino", async () => {
    const { backend, store, play } = await openNewField();
    play(7);
    await vi.waitFor(() => expect(timelineStates(store)).toHaveLength(3));
    backend.hold("plane");

    play(8);
    await vi.waitFor(() => expect(backend.heldCount("plane")).toBe(1));
    play(14);
    await vi.waitFor(() => expect(planeRequests(backend)).toContain("1/3?rev=2"));

    // El pedido de la rev 1 se corto: con la rev 2 vigente traeria los mismos bytes mal rotulados.
    const old = backend.requests("plane", "/plane/1/3")[0];
    expect(old?.query.get("rev")).toBe("1");
    expect(old?.aborted).toBe(true);

    backend.release("plane");
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([2, 1, 1]));
    expect(store.getState().planes[planeKey(1, 3)]?.status).toBe("ready");
    expect(backend.requests("plane", "/plane/1/3")).toHaveLength(2);
  });

  it("al reconectar, el state nuevo reemplaza el documento y se bajan las revisiones que aumentaron", async () => {
    const { backend, store, stream, play, skip } = await openNewField();
    play(13);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([1, 1, 1]));

    // Se corta la conexion y el backend sigue: los eventos 14 a 30 se pierden.
    stream.drop();
    skip(30);
    const second = await streamAt(backend, 1);
    expect(store.getState().stream).not.toBe("closed");
    second.event("state", backend.state.meta, 30);

    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([2, 2, 2]));
    expect(store.getState().stream).toBe("open");
    expect(planeRequests(backend).slice(3)).toEqual(["1/3?rev=2", "2/3?rev=2", "3/3?rev=2"]);
    // El documento es el del state: trae lo que paso mientras no habia conexion.
    const detector2 = store.getState().meta?.planes?.filter((plane) => plane.detector === 2);
    expect(detector2?.map((plane) => plane.status)).toEqual(["ready", "ready", "ready"]);
    expect(store.getState().phase).toBe("loading");

    // Y el flujo sigue desde ahi.
    play(82, second);
    await vi.waitFor(() => expect(store.getState().cube.status).toBe("ready"));
    expect(Object.keys(store.getState().planes)).toHaveLength(18);
  });

  it("un state que vuelve atras descarta las imagenes que ya no corresponden", async () => {
    const { store, stream, play, eventById } = await openNewField();
    play(13);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([1, 1, 1]));

    // El trabajo se rehizo: el documento vuelve a tener todos los planos sin construir.
    stream.event("state", eventById(5).data, 99);
    await vi.waitFor(() => expect(Object.keys(store.getState().planes)).toHaveLength(0));
    expect(timelineStates(store)).toEqual(["unloaded", "unloaded", "unloaded"]);
  });

  it("tras done, si falto el state final, pide /meta y recien entonces el cubo", async () => {
    const { backend, store, stream, play, skip, eventById } = await openNewField();
    play(80);
    await vi.waitFor(() => expect(store.getState().meta?.progress.phase).toBe("finishing"));
    expect(store.getState().meta?.flags).toEqual([]);

    // El state final (81) no llega; el backend ya tiene el documento terminado.
    skip(81);
    const done = eventById(82);
    stream.event(done.event, done.data, done.id);

    await vi.waitFor(() => expect(store.getState().cube.status).toBe("ready"));
    expect(backend.requests("meta")).toHaveLength(1);
    const order = backend.calls.map((call) => call.path.split("/").at(3));
    expect(order.indexOf("meta")).toBeLessThan(order.indexOf("cube"));
    expect(store.getState().meta?.flags?.length).toBeGreaterThan(0);
    expect(store.getState().meta?.planes?.every((plane) => plane.cube_offset !== null)).toBe(true);
    expect(Object.keys(store.getState().planes)).toHaveLength(18);
  });

  it("un evento error deja el codigo, cierra el flujo y conserva lo que ya se bajo", async () => {
    const { backend, store, stream, play } = await openNewField();
    play(13);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([1, 1, 1]));

    stream.event("error", {
      error: { code: "upstream_unavailable", message: "IRSA dejo de responder", retryable: true },
    });
    await vi.waitFor(() => expect(store.getState().phase).toBe("error"));

    expect(store.getState().error).toEqual({
      code: "upstream_unavailable",
      source: "job",
      retryable: true,
      retryAfterS: null,
      retryAt: null,
      message: "IRSA dejo de responder",
    });
    expect(selectErrorCode(store.getState())).toBe("upstream_unavailable");
    expect(store.getState().meta?.status).toBe("failed");
    expect(store.getState().stream).toBe("closed");
    expect(stream.aborted).toBe(true);
    // Los planos ya construidos se siguen viendo.
    expect(timelineStates(store)).toEqual(["provisional", "provisional", "provisional"]);
    expect(backend.requests("cube")).toHaveLength(0);
    expect(backend.streams).toHaveLength(1);

    // Reintentar vuelve a pedir el campo desde cero.
    backend.hold("plane");
    await store.getState().retry();
    expect(backend.requests("field")).toHaveLength(2);
    expect(store.getState().phase).toBe("loading");
    expect(store.getState().error).toBeNull();
    expect(Object.keys(store.getState().planes)).toHaveLength(0);
    await streamAt(backend, 1);
  });

  it("si el flujo de eventos no se puede abrir, queda el error del flujo", async () => {
    silenceWarnings();
    const { backend, store } = setup();
    backend.handlers.field = () =>
      jsonResponse(
        {
          id: WISE_ID,
          status: "queued",
          events_url: "/x",
          meta: fixture<RawEvent[]>("events-new-field.json")[0]?.data,
        },
        202,
      );
    backend.state.eventsOverride = () => errorResponse("not_found", 404);

    await store.getState().openField(WISE);
    await vi.waitFor(() => expect(store.getState().phase).toBe("error"));

    expect(store.getState().error).toMatchObject({ code: "not_found", source: "stream" });
    expect(store.getState().stream).toBe("closed");
  });
});

describe("cambio de banda con el trabajo en curso", () => {
  it("avisa al backend con POST /priority y baja los planos de la banda nueva", async () => {
    const { backend, store, stream, play, eventById } = await openNewField();
    play(13);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([1, 1, 1]));
    expect(selectPreview(store.getState())).toBeNull();

    store.getState().setBand(6);
    await vi.waitFor(() => expect(backend.requests("priority")).toHaveLength(1));
    expect(backend.requests("priority")[0]?.body).toEqual({ band: 6 });
    expect(backend.requests("priority")[0]?.path).toBe(`/field/${WISE_ID}/priority`);

    // En la banda nueva todavia no hay nada de SPHEREx: vuelve la vista de WISE,
    // rotulada con la banda del pedido que creo el trabajo.
    expect(timelineStates(store)).toEqual(["unloaded", "unloaded", "unloaded"]);
    expect(selectPreview(store.getState())?.band).toBe("W1");
    expect(backend.requests("preview")).toHaveLength(1);

    // El backend reordena y manda primero la banda 6.
    const firstOfBand = eventById(68);
    serverApply(backend, firstOfBand);
    stream.event(firstOfBand.event, firstOfBand.data, firstOfBand.id);
    await vi.waitFor(() => expect(loadedRevs(store, 6)).toEqual([1]));

    expect(planeRequests(backend).at(-1)).toBe("1/6?rev=1");
    expect(selectPreview(store.getState())).toBeNull();
    expect(timelineStates(store)).toEqual(["provisional", "unloaded", "unloaded"]);
    expect(selectBandInfo(store.getState())?.detector).toBe(6);

    // Las revisiones nuevas de la banda que se dejo de mirar no se bajan...
    const oldBand = eventById(14);
    serverApply(backend, oldBand);
    stream.event(oldBand.event, oldBand.data, oldBand.id);
    stream.event("queued", { position: 7 });
    await vi.waitFor(() => expect(store.getState().meta?.progress.queue_position).toBe(7));
    expect(planeRequests(backend)).not.toContain("1/3?rev=2");

    // ...hasta que se vuelve a ella. Lo que ya estaba bajado no se repite.
    store.getState().setBand(3);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([2, 1, 1]));
    expect(backend.requests("priority").map((call) => call.body)).toEqual([
      { band: 6 },
      { band: 3 },
    ]);
    expect(planeRequests(backend).filter((request) => request.endsWith("/3?rev=1"))).toHaveLength(
      3,
    );
  });

  it("si la banda cambia mientras el POST esta en camino, la prioridad sale al tener el id", async () => {
    const { backend, store } = setup();
    const queued = fixture<RawEvent[]>("events-new-field.json")[0]?.data;
    backend.handlers.field = () =>
      jsonResponse({ id: WISE_ID, status: "queued", events_url: "/x", meta: queued }, 202);
    backend.hold("field");

    const opening = store.getState().openField(WISE);
    expect(store.getState().phase).toBe("requesting");
    store.getState().setBand(5);
    expect(backend.requests("priority")).toHaveLength(0);

    backend.release("field");
    await opening;
    await vi.waitFor(() => expect(backend.requests("priority")).toHaveLength(1));
    expect(backend.requests("priority")[0]?.body).toEqual({ band: 5 });
    expect(store.getState().band).toBe(5);
  });

  it("un fallo de /priority no cambia nada: es solo un aviso en la consola", async () => {
    const warn = silenceWarnings();
    const { backend, store, play } = await openNewField();
    play(7);
    await vi.waitFor(() => expect(timelineStates(store)).toHaveLength(3));
    backend.handlers.priority = () => errorResponse("upstream_unavailable", 503);

    store.getState().setBand(2);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(store.getState().band).toBe(2);
    expect(store.getState().phase).toBe("loading");
    expect(store.getState().error).toBeNull();
  });
});

describe("vista provisoria", () => {
  it("un campo pedido con la banda 5 trae la vista rotulada W2", async () => {
    const asW2 = (events: RawEvent[]): RawEvent[] =>
      events.map((event) => {
        const w2 = { band: "W2", wave_um: 4.6 };
        if (event.event === "preview")
          return { ...event, data: { ...(event.data as object), ...w2 } };
        if (event.event === "state" || event.event === "listed") {
          const meta = event.data as { preview: object };
          return { ...event, data: { ...meta, preview: { ...meta.preview, ...w2 } } };
        }
        return event;
      });
    const { backend, store, play } = await openNewField({ ...WISE, band: 5 }, {}, asW2);

    expect(backend.requests("field")[0]?.body).toMatchObject({ band: 5 });
    play(7);
    await vi.waitFor(() => expect(selectPreview(store.getState())).not.toBeNull());

    expect(store.getState().band).toBe(5);
    expect(selectPreview(store.getState())).toMatchObject({ band: "W2", waveUm: 4.6 });
    // La banda pedida todavia no tiene planos: la vista sigue aunque otras bandas avancen.
    play(18);
    await vi.waitFor(() => expect(store.getState().meta?.progress.planes_ready).toBe(3));
    expect(planeRequests(backend)).toEqual([]);
    expect(selectPreview(store.getState())?.band).toBe("W2");

    // Se retira con el primer plano de la banda 5.
    play(56);
    await vi.waitFor(() => expect(loadedRevs(store, 5)).toEqual([1]));
    expect(selectPreview(store.getState())).toBeNull();
  });

  it("si la vista se descarta (unavailable) no se pide y el campo carga igual", async () => {
    const unavailable = (events: RawEvent[]): RawEvent[] =>
      events.map((event) =>
        event.event === "preview"
          ? { ...event, data: { ...(event.data as object), status: "unavailable", display: null } }
          : event,
      );
    const { backend, store, play } = await openNewField(WISE, {}, unavailable);
    play(4);
    await vi.waitFor(() => expect(store.getState().meta?.preview.status).toBe("unavailable"));

    expect(backend.requests("preview")).toHaveLength(0);
    expect(selectPreview(store.getState())).toBeNull();
  });

  it("rechaza una vista de otro tamano y la vuelve a pedir cuando la grilla real es otra", async () => {
    const warn = silenceWarnings();
    // El backend arma una grilla de 100 x 100 en vez de la de la tabla del contrato.
    const smallGrid = (events: RawEvent[]): RawEvent[] =>
      events.map((event) => {
        if (event.event !== "listed") return event;
        const meta = event.data as { grid: object };
        return { ...event, data: { ...meta, grid: { ...meta.grid, shape: [100, 100] } } };
      });
    const { backend, store, play } = await openNewField(WISE, {}, smallGrid);
    backend.state.fallbackShape = [100, 100];

    play(4);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(backend.requests("preview")).toHaveLength(1);
    expect(store.getState().preview).toBeNull();
    expect(selectPreview(store.getState())).toBeNull();

    play(5);
    await vi.waitFor(() => expect(selectPreview(store.getState())).not.toBeNull());
    expect(backend.requests("preview")).toHaveLength(2);
    expect(selectPreview(store.getState())?.image.width).toBe(100);
  });
});

describe("limite de pedidos, duplicados y cancelacion", () => {
  it("no pasa del limite de pedidos simultaneos ni repite un plano", async () => {
    const { backend, store } = setup("epsindb", { maxConcurrentDownloads: 2 });
    backend.hold("plane");
    await store.getState().openField(EPSINDB);
    await vi.waitFor(() => expect(backend.heldCount("plane")).toBe(2));

    // Ida y vuelta de banda con todo en espera: ningun pedido de mas.
    store.getState().setBand(3);
    store.getState().setBand(2);
    store.getState().setBand(3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backend.state.inFlight).toBe(2);
    expect(planeRequests(backend)).toHaveLength(2);

    backend.release("plane");
    await vi.waitFor(() => expect(store.getState().cube.status).toBe("ready"));

    expect(backend.state.maxInFlight).toBe(2);
    const requests = planeRequests(backend);
    expect(new Set(requests).size).toBe(requests.length);
    // Los dos de la banda 2 que ya habian salido y los cuatro de la banda que
    // se esta mirando. Los otros dos de la banda 2 esperaban turno cuando se
    // la dejo: no se piden por plano, llegan con el cubo.
    expect([...requests].sort()).toEqual(
      ["1/2", "2/2", "1/3", "2/3", "3/3", "4/3"].map((key) => `${key}?rev=2`).sort(),
    );
    expect(backend.requests("cube")).toHaveLength(1);
    expect(Object.keys(store.getState().planes)).toHaveLength(22);
    expect(store.getState().planes[planeKey(4, 2)]?.rev).toBe(2);
  });

  it("pasar de largo por las bandas no deja en la cola los planos de cada una", async () => {
    const { backend, store } = setup();
    backend.hold("plane");
    await store.getState().openField(WISE);
    await vi.waitFor(() => expect(backend.heldCount("plane")).toBe(3));

    // La persona recorre las bandas rapido y se queda en la 2.
    for (const band of [4, 5, 6, 1, 2] as const) store.getState().setBand(band);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Solo salio lo que tenia lugar: los tres de la banda 3 y el primero de la 4.
    const inFlight = ["1/3?rev=2", "2/3?rev=2", "3/3?rev=2", "1/4?rev=2"];
    expect(planeRequests(backend)).toEqual(inFlight);

    backend.release("plane");
    await vi.waitFor(() => expect(store.getState().cube.status).toBe("ready"));

    // De las bandas por las que paso de largo no se pidio nada mas: el resto
    // llega con el cubo. Antes se bajaban los 18 planos uno por uno, y el cubo.
    expect(planeRequests(backend)).toEqual([...inFlight, "1/2?rev=2", "2/2?rev=2", "3/2?rev=2"]);
    expect(backend.requests("plane").some((call) => call.aborted)).toBe(false);
    expect(backend.requests("cube")).toHaveLength(1);
    expect(Object.keys(store.getState().planes)).toHaveLength(18);
    expect(store.getState().planes[planeKey(2, 5)]?.image.values[2]).toBe(planeFill(2, 5, 2));
  });

  it("un plano descartado de la cola se vuelve a pedir si se vuelve a su banda", async () => {
    const { backend, store } = setup("wise0855", { maxConcurrentDownloads: 1 });
    backend.hold("plane");
    backend.hold("cube");
    await store.getState().openField(WISE);
    await vi.waitFor(() => expect(backend.heldCount("plane")).toBe(1));

    // Ida y vuelta: los dos planos de la banda 3 que esperaban se descartan y se vuelven a pedir.
    store.getState().setBand(6);
    store.getState().setBand(3);
    backend.release("plane");
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([2, 2, 2]));

    expect(planeRequests(backend)).toEqual(["1/3?rev=2", "2/3?rev=2", "3/3?rev=2"]);
    backend.release("cube");
  });

  it("no pide el cubo si todo lo que falta ya esta bajando plano por plano", async () => {
    const { backend, store } = setup("wise0855", { maxConcurrentDownloads: 6 });
    backend.state.meta = onlyBands(backend.state.meta, [3, 6]);
    backend.hold("plane");
    await store.getState().openField(WISE);
    store.getState().setBand(6);
    store.getState().setBand(3);
    await vi.waitFor(() => expect(backend.heldCount("plane")).toBe(6));

    // Llega la banda que se esta mirando; los tres planos de la otra siguen en camino.
    backend.release("plane", 3);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([2, 2, 2]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // El cubo traeria de nuevo los seis planos, tres ya bajados y tres por llegar.
    expect(backend.requests("cube")).toHaveLength(0);
    expect(store.getState().cube.status).toBe("idle");

    backend.release("plane");
    await vi.waitFor(() => expect(store.getState().cube.status).toBe("ready"));
    expect(backend.requests("cube")).toHaveLength(0);
    expect(planeRequests(backend)).toHaveLength(6);
    expect(Object.keys(store.getState().planes)).toHaveLength(6);
  });

  it("si un plano que estaba en camino falla, lo que falta llega con el cubo", async () => {
    silenceWarnings();
    const { backend, store } = setup("wise0855", { maxConcurrentDownloads: 6 });
    backend.state.meta = onlyBands(backend.state.meta, [3, 6]);
    const plane = backend.handlers.plane;
    backend.handlers.plane = (call, epoch, detector) =>
      epoch === 2 && detector === 6
        ? binaryResponse(new Float32Array(10))
        : plane(call, epoch, detector);
    backend.hold("plane");
    await store.getState().openField(WISE);
    store.getState().setBand(6);
    store.getState().setBand(3);
    await vi.waitFor(() => expect(backend.heldCount("plane")).toBe(6));

    backend.release("plane");
    await vi.waitFor(() => expect(store.getState().cube.status).toBe("ready"));

    expect(backend.requests("cube")).toHaveLength(1);
    expect(store.getState().planes[planeKey(2, 6)]?.image.values[2]).toBe(planeFill(2, 6, 2));
    expect(store.getState().planeErrors).toEqual({});
  });

  it("al cambiar de campo cancela los pedidos, la cola y el flujo del anterior", async () => {
    const { backend, store, stream, play } = await openNewField(WISE, {
      maxConcurrentDownloads: 1,
    });
    play(7);
    await vi.waitFor(() => expect(timelineStates(store)).toHaveLength(3));
    backend.hold("plane");
    play(13);
    await vi.waitFor(() => expect(backend.heldCount("plane")).toBe(1));

    // Otro campo: el POST queda en camino para ver el estado intermedio.
    backend.hold("field");
    const opening = store.getState().openField(BARNARD);

    expect(stream.aborted).toBe(true);
    expect(backend.requests("plane").map((call) => call.aborted)).toEqual([true]);
    expect(store.getState()).toMatchObject({
      phase: "requesting",
      request: { ra: 269.4463, dec: 4.7683, fov: 0.1667 },
      fieldId: null,
      meta: null,
      stream: null,
      preview: null,
    });
    expect(store.getState().planes).toEqual({});

    // Lo que quedaba del campo anterior no llega nunca: ni lo que bajaba ni lo que esperaba turno.
    backend.release("plane");
    stream.event("queued", { position: 9 });
    backend.state.meta = fixture<RawMeta>("meta-barnard.json");
    backend.handlers.field = () =>
      jsonResponse({
        id: BARNARD_ID,
        status: "ready",
        events_url: "/x",
        meta: backend.state.meta,
      });
    backend.release("field");
    await opening;
    await vi.waitFor(() => expect(store.getState().cube.status).toBe("ready"));

    expect(store.getState().fieldId).toBe(BARNARD_ID);
    expect(backend.requests("plane").filter((call) => call.path.includes(WISE_ID))).toHaveLength(1);
    expect(Object.keys(store.getState().planes)).toHaveLength(18);
    expect(store.getState().planes[planeKey(1, 3)]?.plane.saturated.length).toBeGreaterThan(0);
  });

  it("close cancela todo y deja el estado inicial", async () => {
    const { backend, store, stream, play } = await openNewField();
    play(7);
    await vi.waitFor(() => expect(timelineStates(store)).toHaveLength(3));
    backend.hold("plane");
    play(8);
    await vi.waitFor(() => expect(backend.heldCount("plane")).toBe(1));

    store.getState().close();

    expect(stream.aborted).toBe(true);
    expect(backend.requests("plane")[0]?.aborted).toBe(true);
    expect(store.getState()).toMatchObject({
      phase: "idle",
      request: null,
      fieldId: null,
      meta: null,
      error: null,
    });
    expect(store.getState().planes).toEqual({});
  });

  it("rechaza un plano de otro tamano y no lo vuelve a pedir solo", async () => {
    silenceWarnings();
    const { backend, store } = setup();
    backend.hold("cube");
    const plane = backend.handlers.plane;
    backend.handlers.plane = (call, epoch, detector) =>
      epoch === 2 ? binaryResponse(new Float32Array(10)) : plane(call, epoch, detector);

    await store.getState().openField(WISE);
    await vi.waitFor(() => expect(store.getState().planeErrors[planeKey(2, 3)]).toBeDefined());
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([2, 2]));

    expect(store.getState().planeErrors[planeKey(2, 3)]).toEqual({
      rev: 2,
      code: "invalid_response",
    });
    expect(store.getState().planes[planeKey(2, 3)]).toBeUndefined();
    expect(timelineStates(store)).toEqual(["loaded", "unloaded", "loaded"]);
    // El campo sigue abierto: es un plano que falta, no un error del campo.
    expect(store.getState().phase).toBe("ready");
    expect(store.getState().error).toBeNull();
    expect(backend.requests("plane", "/plane/2/3")).toHaveLength(1);

    // Con el backend arreglado, reintentar las descargas lo trae.
    backend.handlers.plane = plane;
    store.getState().retryDownloads();
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([2, 2, 2]));
    expect(store.getState().planeErrors).toEqual({});
    expect(backend.requests("plane", "/plane/2/3")).toHaveLength(2);
    backend.release("cube");
  });

  it("rechaza un cubo de otro tamano; las otras bandas se bajan al cambiar de banda", async () => {
    silenceWarnings();
    const { backend, store } = setup();
    const cube = backend.handlers.cube;
    backend.handlers.cube = () => binaryResponse(new Float32Array(195 * 195));

    await store.getState().openField(WISE);
    await vi.waitFor(() => expect(store.getState().cube.status).toBe("error"));
    expect(store.getState().cube.error).toBe("invalid_response");
    expect(Object.keys(store.getState().planes)).toHaveLength(3);

    store.getState().setBand(4);
    await vi.waitFor(() => expect(loadedRevs(store, 4)).toEqual([2, 2, 2]));
    expect(backend.requests("cube")).toHaveLength(1);

    backend.handlers.cube = cube;
    store.getState().retryDownloads();
    await vi.waitFor(() => expect(store.getState().cube.status).toBe("ready"));
    expect(Object.keys(store.getState().planes)).toHaveLength(18);
  });

  it("reintenta una descarga que fallo por algo pasajero", async () => {
    const { backend, store } = setup();
    backend.hold("cube");
    const plane = backend.handlers.plane;
    let failures = 0;
    backend.handlers.plane = (call, epoch, detector) => {
      if (epoch === 1 && failures < 2) {
        failures += 1;
        return errorResponse("upstream_unavailable", 503, { retryable: true });
      }
      return plane(call, epoch, detector);
    };

    await store.getState().openField(WISE);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([2, 2, 2]));

    expect(backend.requests("plane", "/plane/1/3")).toHaveLength(3);
    expect(store.getState().planeErrors).toEqual({});
    backend.release("cube");
  });

  it("si los reintentos se agotan, el plano queda con su error", async () => {
    silenceWarnings();
    const { backend, store } = setup("wise0855", { downloadRetries: 1 });
    backend.hold("cube");
    const plane = backend.handlers.plane;
    backend.handlers.plane = (call, epoch, detector) =>
      epoch === 3 ? Promise.reject(new TypeError("fetch failed")) : plane(call, epoch, detector);

    await store.getState().openField(WISE);
    await vi.waitFor(() =>
      expect(store.getState().planeErrors[planeKey(3, 3)]).toEqual({ rev: 2, code: "network" }),
    );
    expect(backend.requests("plane", "/plane/3/3")).toHaveLength(2);
    backend.release("cube");
  });
});

describe("capa de flags", () => {
  it("baja /aux a pedido y lo separa en flags y cobertura", async () => {
    const { backend, store } = setup();
    await store.getState().openField(WISE);
    await vi.waitFor(() => expect(store.getState().cube.status).toBe("ready"));
    expect(backend.requests("aux")).toHaveLength(0);

    await store.getState().loadAux(2);

    const entry = store.getState().aux[planeKey(2, 3)];
    expect(entry?.status).toBe("ready");
    expect(entry?.rev).toBe(2);
    expect(entry?.layers?.flags).toBeInstanceOf(Uint32Array);
    expect(entry?.layers?.coverage).toBeInstanceOf(Uint16Array);
    expect(entry?.layers?.flags).toHaveLength(195 * 195);
    expect(entry?.layers?.flags[0]).toBe(1 << 3);
    expect(entry?.layers?.coverage[0]).toBe(2);
    // La lista de flags ya estaba: no hizo falta /meta.
    expect(backend.requests("meta")).toHaveLength(0);

    // Lo que ya esta no se vuelve a pedir; otra banda se puede pedir sin estar mirandola.
    await store.getState().loadAux(2);
    await store.getState().loadAux(1, 6);
    expect(backend.requests("aux").map((call) => call.path.split("/aux/")[1])).toEqual([
      "2/3",
      "1/6",
    ]);
    expect(store.getState().aux[planeKey(1, 6)]?.layers?.flags[0]).toBe(1 << 6);
  });

  it("mientras el campo carga flags esta vacio: pide /meta antes y toma solo los flags", async () => {
    const { backend, store, play } = await openNewField();
    play(13);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([1, 1, 1]));
    expect(store.getState().meta?.flags).toEqual([]);

    // Como el backend real: con el primer archivo /meta ya trae los bits, y un
    // documento que quedo viejo en todo lo demas.
    const flags = fixture<{ flags: unknown[] }>("meta-wise0855.json").flags;
    const stale = { ...(backend.state.meta as object), flags, status: "listing" };
    backend.handlers.meta = () => jsonResponse(stale);

    await Promise.all([store.getState().loadAux(1), store.getState().loadAux(1)]);

    const order = backend.calls.map((call) => call.path.split("/").at(3));
    expect(order.filter((name) => name === "meta")).toHaveLength(1);
    expect(order.filter((name) => name === "aux")).toHaveLength(1);
    expect(order.indexOf("meta")).toBeLessThan(order.indexOf("aux"));
    expect(store.getState().meta?.flags).toHaveLength(flags.length);
    // El resto del documento sigue siendo el que armaron los eventos.
    expect(store.getState().meta?.status).toBe("downloading");
    expect(store.getState().aux[planeKey(1, 3)]).toMatchObject({ status: "ready", rev: 1 });
  });

  it("cuando el plano cambia de revision las capas pedidas se renuevan solas", async () => {
    const { backend, store, play } = await openNewField();
    serveAuxWithRevision(backend);
    play(13);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([1, 1, 1]));
    await store.getState().loadAux(1);
    const first = store.getState().aux[planeKey(1, 3)]?.layers;
    expect(first?.coverage[0]).toBe(1);
    expect(store.getState().aux[planeKey(1, 3)]).toMatchObject({ rev: 1, layersRev: 1 });
    expect(selectAuxLayers(store.getState(), 1)).toBe(first);

    // Llega la definitiva de ese plano. Nadie vuelve a llamar a loadAux.
    backend.hold("aux");
    play(14);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([2, 1, 1]));
    await vi.waitFor(() => expect(backend.heldCount("aux")).toBe(1));
    // Mientras llegan las nuevas quedan guardadas las de la revision anterior,
    // pero no son las de la imagen que se ve: no se entregan.
    expect(store.getState().aux[planeKey(1, 3)]).toMatchObject({
      status: "loading",
      rev: 2,
      layersRev: 1,
    });
    expect(store.getState().aux[planeKey(1, 3)]?.layers).toBe(first);
    expect(selectAuxLayers(store.getState(), 1)).toBeNull();

    backend.release("aux");
    await vi.waitFor(() => expect(store.getState().aux[planeKey(1, 3)]?.status).toBe("ready"));
    expect(store.getState().aux[planeKey(1, 3)]).toMatchObject({ rev: 2, layersRev: 2 });
    expect(backend.requests("aux")).toHaveLength(2);
    // Las capas vigentes son las que el servidor tiene para la revision 2.
    expect(selectAuxLayers(store.getState(), 1)?.coverage[0]).toBe(2);

    // Pedirlas otra vez a mano no repite nada, y otro evento tampoco.
    await store.getState().loadAux(1);
    play(18);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([2, 2, 2]));
    expect(backend.requests("aux")).toHaveLength(2);
  });

  it("las capas de una banda que se dejo de mirar se renuevan al volver a ella", async () => {
    const { backend, store, play } = await openNewField();
    serveAuxWithRevision(backend);
    play(13);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([1, 1, 1]));
    await store.getState().loadAux(1);

    store.getState().setBand(6);
    play(14);
    await vi.waitFor(() =>
      expect(store.getState().meta?.planes?.find((plane) => plane.detector === 3)?.rev).toBe(2),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nadie esta mirando la banda 3: ni el plano ni sus capas se bajan de nuevo.
    expect(backend.requests("aux")).toHaveLength(1);
    expect(store.getState().aux[planeKey(1, 3)]).toMatchObject({ status: "ready", rev: 1 });

    store.getState().setBand(3);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([2, 1, 1]));
    await vi.waitFor(() => expect(selectAuxLayers(store.getState(), 1)?.coverage[0]).toBe(2));
    expect(backend.requests("aux")).toHaveLength(2);
  });

  it("unas capas que fallaron no se vuelven a pedir solas para la misma revision", async () => {
    silenceWarnings();
    const { backend, store, play } = await openNewField();
    play(13);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([1, 1, 1]));
    backend.handlers.aux = () => binaryResponse(new Uint8Array(12));
    await store.getState().loadAux(2);
    expect(store.getState().aux[planeKey(2, 3)]).toMatchObject({ status: "error", rev: 1 });

    // Otros eventos y otra banda no insisten.
    play(14);
    await vi.waitFor(() => expect(loadedRevs(store, 3)).toEqual([2, 1, 1]));
    store.getState().setBand(6);
    store.getState().setBand(3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backend.requests("aux")).toHaveLength(1);
    expect(selectAuxLayers(store.getState(), 2)).toBeNull();
  });

  it("no pide capas de un plano sin binario, y un fallo queda con su codigo", async () => {
    silenceWarnings();
    const { backend, store } = setup("epsindb");
    await store.getState().openField({ ...EPSINDB, band: 1 });

    await store.getState().loadAux(4);
    await store.getState().loadAux(9);
    expect(backend.requests("aux")).toHaveLength(0);
    expect(store.getState().aux).toEqual({});

    backend.handlers.aux = () => binaryResponse(new Uint8Array(12));
    await store.getState().loadAux(1);
    expect(store.getState().aux[planeKey(1, 1)]).toEqual({
      status: "error",
      rev: 2,
      layers: null,
      layersRev: null,
      error: "invalid_response",
    });

    // Un pedido que fallo se puede repetir.
    backend.handlers.aux = () => binaryResponse(new Uint8Array(6 * 195 * 195));
    await store.getState().loadAux(1);
    expect(store.getState().aux[planeKey(1, 1)]?.status).toBe("ready");
  });
});

describe("objeto buscado", () => {
  const track = fixture<{ positions: Array<{ epoch: number; x: number; y: number }> }>(
    "barnard/track_name-barnard-s-star.json",
  );

  function setupBarnard() {
    const context = setup("barnard");
    context.backend.handlers.resolve = () => jsonResponse(resolveBarnard());
    context.backend.handlers.track = () => jsonResponse(track);
    return context;
  }

  it("con name en la URL pide /resolve y /track para ese campo", async () => {
    const { backend, store } = setupBarnard();
    store.getState().syncWithUrl({
      ...DEFAULT_URL_STATE,
      ra: BARNARD.ra,
      dec: BARNARD.dec,
      name: "Barnard's Star",
    });

    await vi.waitFor(() => expect(store.getState().target.trackStatus).toBe("ready"));
    await vi.waitFor(() => expect(store.getState().target.resolveStatus).toBe("ready"));

    expect(backend.requests("field")[0]?.body).toEqual({ ...BARNARD });
    expect(backend.requests("resolve").map((call) => call.query.get("name"))).toEqual([
      "Barnard's Star",
    ]);
    const trackCalls = backend.requests("track");
    expect(trackCalls).toHaveLength(1);
    expect(trackCalls[0]?.path).toBe(`/field/${BARNARD_ID}/track`);
    expect(trackCalls[0]?.query.get("name")).toBe("Barnard's Star");

    const { target } = store.getState();
    expect(target.name).toBe("Barnard's Star");
    expect(target.resolved?.motion?.per_year_arcsec).toBe(10.39);
    expect(target.track?.positions).toHaveLength(3);
    expect(selectTargetPosition(store.getState(), 2)).toMatchObject({
      x: track.positions[1]?.x,
      y: track.positions[1]?.y,
      source: "track",
    });

    // Otro cambio de la URL que no toca el campo ni el nombre no pide nada.
    const before = backend.calls.length;
    store.getState().syncWithUrl({
      ...DEFAULT_URL_STATE,
      ra: BARNARD.ra,
      dec: BARNARD.dec,
      name: "Barnard's Star",
      mode: "difference",
      epoch: 2,
    });
    expect(backend.calls).toHaveLength(before);
  });

  it("la trayectoria se pide recien cuando el campo tiene epocas", async () => {
    const { backend, store, play } = await openNewField();
    // Un objeto sin movimiento propio, en el centro del campo de WISE 0855.
    backend.handlers.resolve = () => jsonResponse(resolveCoordinates());
    store.getState().setTarget("133.7598 -7.2422");
    play(4);
    await vi.waitFor(() => expect(store.getState().target.resolveStatus).toBe("ready"));
    expect(backend.requests("track")).toHaveLength(0);
    expect(store.getState().target.trackStatus).toBe("idle");
    expect(selectTargetPosition(store.getState(), 1)).toBeNull();

    play(5);
    await vi.waitFor(() => expect(store.getState().target.trackStatus).toBe("ready"));
    expect(backend.requests("track")).toHaveLength(1);
    // Sin trayectoria guardada `positions` viene vacio: la mira va en field_center.
    expect(store.getState().target.track?.positions).toEqual([]);
    const position = selectTargetPosition(store.getState(), 1);
    expect(position?.source).toBe("field_center");
    expect(position?.inField).toBe(true);
    expect(position?.x).toBeCloseTo(97, 0);
  });

  it("al cambiar de campo conserva lo resuelto y pide la trayectoria del campo nuevo", async () => {
    const { backend, store } = setupBarnard();
    store.getState().setTarget("Barnard's Star");
    await store.getState().openField(BARNARD);
    await vi.waitFor(() => expect(store.getState().target.trackStatus).toBe("ready"));
    await vi.waitFor(() => expect(store.getState().target.resolveStatus).toBe("ready"));

    backend.handlers.field = () => errorResponse("no_coverage", 404);
    await store.getState().openField({ ...BARNARD, dec: 5 });
    expect(store.getState().target).toMatchObject({
      name: "Barnard's Star",
      resolveStatus: "ready",
      trackStatus: "idle",
      track: null,
    });
    expect(backend.requests("resolve")).toHaveLength(1);
  });

  it("un nombre que Sesame no conoce deja not_resolved y el campo se abre igual", async () => {
    const { backend, store } = setup("barnard");
    store.getState().syncWithUrl({
      ...DEFAULT_URL_STATE,
      ra: BARNARD.ra,
      dec: BARNARD.dec,
      name: "no existe",
    });

    await vi.waitFor(() => expect(store.getState().target.resolveStatus).toBe("error"));
    await vi.waitFor(() => expect(store.getState().cube.status).toBe("ready"));

    expect(store.getState().target.resolveError).toBe("not_resolved");
    expect(store.getState().phase).toBe("ready");
    expect(store.getState().error).toBeNull();
    expect(backend.requests("track")).toHaveLength(1);
    expect(selectTargetPosition(store.getState(), 1)).toBeNull();
  });

  it("quitar el nombre limpia el objeto y cancela lo que estaba en camino", async () => {
    const { backend, store } = setupBarnard();
    backend.hold("resolve");
    await store.getState().openField(BARNARD);
    store.getState().setTarget("Barnard's Star");
    await vi.waitFor(() => expect(backend.heldCount("resolve")).toBe(1));

    store.getState().setTarget(null);
    backend.release("resolve");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(backend.requests("resolve")[0]?.aborted).toBe(true);
    expect(store.getState().target).toMatchObject({
      name: null,
      resolveStatus: "idle",
      resolved: null,
      track: null,
    });
  });

  it("sin campo en la URL cierra el campo abierto", async () => {
    const { store } = setupBarnard();
    await store.getState().openField(BARNARD);
    store.getState().syncWithUrl(DEFAULT_URL_STATE);

    expect(store.getState().phase).toBe("idle");
    expect(store.getState().request).toBeNull();
  });
});

describe("errores al pedir el campo", () => {
  it("queue_full deja el codigo y la espera de Retry-After, y se puede reintentar", async () => {
    const { backend, store } = setup();
    const field = backend.handlers.field;
    backend.handlers.field = () =>
      errorResponse("queue_full", 429, { retryable: true, headers: { "Retry-After": "5" } });

    await store.getState().openField(WISE);

    expect(store.getState().phase).toBe("error");
    expect(store.getState().error).toEqual({
      code: "queue_full",
      source: "request",
      retryable: true,
      retryAfterS: 5,
      retryAt: NOW + 5000,
      message: "queue_full simulado",
    });
    expect(selectErrorCode(store.getState())).toBe("queue_full");
    expect(store.getState().meta).toBeNull();
    expect(store.getState().fieldId).toBeNull();
    // El campo pedido queda, para saber que reintentar.
    expect(store.getState().request).toEqual({ ra: 133.7598, dec: -7.2422, fov: 0.1667 });
    expect(backend.streams).toHaveLength(0);

    // Volver a sincronizar la misma URL no insiste solo.
    await store.getState().openField(WISE);
    expect(backend.requests("field")).toHaveLength(1);

    backend.handlers.field = field;
    await store.getState().retry();
    expect(backend.requests("field")).toHaveLength(2);
    expect(store.getState().phase).toBe("ready");
    expect(store.getState().error).toBeNull();
  });

  it.each([
    ["no_coverage", 404, false],
    ["upstream_unavailable", 503, true],
    ["invalid_request", 422, false],
  ] as const)("%s deja su codigo", async (code, status, retryable) => {
    const { backend, store } = setup();
    backend.handlers.field = () => errorResponse(code, status, { retryable });

    await store.getState().openField(WISE);

    expect(store.getState().phase).toBe("error");
    expect(store.getState().error).toMatchObject({
      code,
      source: "request",
      retryable,
      retryAfterS: null,
      retryAt: null,
    });
    expect(selectErrorCode(store.getState())).toBe(code);
  });

  it("con la red caida deja network, reintentable", async () => {
    const { backend, store } = setup();
    const field = backend.handlers.field;
    backend.handlers.field = () => Promise.reject(new TypeError("fetch failed"));

    await store.getState().openField(WISE);
    expect(store.getState().error).toMatchObject({
      code: "network",
      source: "request",
      retryable: true,
    });

    backend.handlers.field = field;
    await store.getState().retry();
    expect(store.getState().phase).toBe("ready");
  });

  it("una respuesta que no cumple el contrato deja invalid_response", async () => {
    const { backend, store } = setup();
    backend.handlers.field = () => jsonResponse({ id: "no es un id" });

    await store.getState().openField(WISE);
    expect(selectErrorCode(store.getState())).toBe("invalid_response");
  });

  it("si se abre otro campo antes de la respuesta, la respuesta vieja se descarta", async () => {
    const { backend, store } = setup();
    backend.hold("field");
    const first = store.getState().openField(WISE);
    const second = store.getState().openField(BARNARD);

    expect(backend.requests("field")[0]?.aborted).toBe(true);
    backend.handlers.field = () => errorResponse("no_coverage", 404);
    backend.release("field");
    await Promise.all([first, second]);

    expect(store.getState().request?.ra).toBe(BARNARD.ra);
    expect(selectErrorCode(store.getState())).toBe("no_coverage");
  });

  it("retry sin campo pedido no hace nada", async () => {
    const { backend, store } = setup();
    await store.getState().retry();
    expect(backend.calls).toHaveLength(0);
    expect(store.getState().phase).toBe("idle");
  });
});
