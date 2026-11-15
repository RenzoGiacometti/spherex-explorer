// @vitest-environment node
//
// Prueba de punta a punta del estado del campo contra el servidor falso del
// backend (backend/app/fake.py), con pedidos HTTP y flujo SSE de verdad. Se
// corre a mano; sin SPHEREX_FAKE_URL se saltea, porque los tests no usan la red.
//
//   desde backend/   $env:SPHEREX_FAKE_SECONDS = "6"; uv run uvicorn app.fake:app --port 8011
//   desde frontend/  $env:SPHEREX_FAKE_URL = "http://127.0.0.1:8011"
//                    pnpm exec vitest run src/state/fieldStore.fake-server.test.ts
//
// Con SPHEREX_E2E_REPORT=<archivo> deja ahi, en JSON, lo que vio en cada
// escenario: los pedidos que salieron y como fue cambiando el estado.

import { writeFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createApiClient, type FetchLike } from "@/api/client";
import type { FieldState } from "@/data/fieldState";
import { createNameResolver, errorCodeOf, resolveQuery } from "@/data/nameResolver";
import { planeKey } from "@/data/planeKey";
import {
  selectBandInfo,
  selectErrorCode,
  selectLoadProgress,
  selectPreview,
  selectQueuePosition,
  selectSaturatedRegions,
  selectTargetPosition,
  selectTimeline,
  selectWarningGroups,
} from "@/data/selectors";
import { createFieldStore, type OpenFieldRequest } from "./fieldStore";
import { DEFAULT_URL_STATE } from "./urlState";

const FAKE_URL = process.env.SPHEREX_FAKE_URL;
const REPORT_FILE = process.env.SPHEREX_E2E_REPORT;
/** Duracion de un campo nuevo simulado, para los tiempos de espera. */
const FAKE_SECONDS = Number(process.env.SPHEREX_FAKE_SECONDS ?? "25");
const TIMEOUT_MS = (FAKE_SECONDS * 3 + 20) * 1000;

// Centros de las muestras del servidor falso (backend/README.md, "Campos de muestra").
const WISE: OpenFieldRequest = { ra: 133.7598, dec: -7.2422, fov: 0.1667, band: 3 };
const EPSINDB: OpenFieldRequest = { ra: 331.0966, dec: -56.8006, fov: 0.1667, band: 3 };

interface RequestLog {
  ms: number;
  method: string;
  path: string;
  status: number | string;
}

const report: Record<string, unknown> = {};

type Store = ReturnType<typeof createFieldStore>;

const open: Store[] = [];

afterEach(() => {
  for (const store of open.splice(0)) store.getState().close();
});

afterAll(() => {
  if (REPORT_FILE) writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), "utf8");
});

/** Resumen de una linea del estado, para ver como cambia. */
function snapshot(state: FieldState): string {
  const timeline = selectTimeline(state)
    .map((entry) => entry.state[0])
    .join("");
  const preview = selectPreview(state);
  const progress = selectLoadProgress(state);
  return [
    `fase=${state.phase}`,
    `status=${state.meta?.status ?? "-"}`,
    `etapa=${progress?.phase ?? "-"}`,
    `cola=${selectQueuePosition(state) ?? "-"}`,
    `banda=${state.band}`,
    `linea=${timeline || "-"}`,
    `vista=${preview ? preview.band : "-"}`,
    `planos=${Object.keys(state.planes).length}`,
    `cubo=${state.cube.status}`,
    `flujo=${state.stream ?? "-"}`,
    `error=${selectErrorCode(state) ?? "-"}`,
  ].join(" ");
}

/**
 * Store contra el servidor falso. `scenario` se agrega como `?scenario=` al
 * POST /api/field (asi fuerza cada caso el servidor falso) y se puede cambiar
 * entre un pedido y otro.
 */
function connect() {
  const started = Date.now();
  const requests: RequestLog[] = [];
  const trace: string[] = [];
  const control = { scenario: null as string | null };

  const fetchWithScenario: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const isFieldPost = method === "POST" && url.endsWith("/api/field");
    const target = isFieldPost && control.scenario ? `${url}?scenario=${control.scenario}` : url;
    const entry: RequestLog = {
      ms: Date.now() - started,
      method,
      path: target.replace(FAKE_URL ?? "", ""),
      status: "sin respuesta",
    };
    requests.push(entry);
    try {
      const response = await fetch(target, init);
      entry.status = response.status;
      return response;
    } catch (error) {
      entry.status = error instanceof Error ? error.name : "error";
      throw error;
    }
  };

  const api = createApiClient({ baseUrl: `${FAKE_URL}/api`, fetch: fetchWithScenario });
  const resolver = createNameResolver(api);
  const store = createFieldStore({ api, resolver, eventsOptions: { fetch: fetchWithScenario } });
  open.push(store);

  let last = "";
  store.subscribe((state) => {
    const line = snapshot(state);
    if (line === last) return;
    last = line;
    trace.push(`${String(Date.now() - started).padStart(6)} ms  ${line}`);
  });

  /** Espera a que el estado cumpla una condicion; devuelve los ms que tardo. */
  function until(what: string, condition: (state: FieldState) => boolean): Promise<number> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!condition(store.getState())) return false;
        clearTimeout(timer);
        unsubscribe();
        resolve(Date.now() - started);
        return true;
      };
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`no se llego a "${what}". Estado: ${snapshot(store.getState())}`));
      }, TIMEOUT_MS - 5000);
      const unsubscribe = store.subscribe(() => void check());
      check();
    });
  }

  return { store, api, resolver, control, requests, trace, until, started };
}

function loadedOfBand(state: FieldState, band: number): number {
  return Object.values(state.planes).filter((plane) => plane.detector === band).length;
}

function paths(requests: RequestLog[], fragment: string): string[] {
  return requests.filter((entry) => entry.path.includes(fragment)).map((entry) => entry.path);
}

describe.skipIf(!FAKE_URL)("estado del campo contra el servidor falso", () => {
  it(
    "new: campo nuevo, de la cola a done",
    async () => {
      const { store, control, requests, trace, until } = connect();
      control.scenario = "new";
      await store.getState().openField(WISE);

      expect(store.getState().phase).toBe("loading");
      expect(store.getState().meta?.status).toBe("queued");
      const previewMs = await until("vista provisoria", (state) => selectPreview(state) !== null);
      const preview = selectPreview(store.getState());
      const listedMs = await until("listed", (state) => selectTimeline(state).length > 0);
      const firstPlaneMs = await until("primer plano", (state) => loadedOfBand(state, 3) > 0);
      const firstPlane = Object.values(store.getState().planes)[0];
      expect(selectPreview(store.getState())).toBeNull();
      const blinkMs = await until("todas las epocas de la banda", (state) =>
        selectTimeline(state).every((entry) => entry.state !== "unloaded"),
      );
      const bandDoneMs = await until("banda definitiva", (state) =>
        selectTimeline(state).every((entry) => entry.state === "loaded"),
      );
      const planesBeforeDone = paths(requests, "/plane/").length;
      const doneMs = await until("done", (state) => state.phase === "ready");
      const cubeMs = await until("cubo", (state) => state.cube.status === "ready");

      const state = store.getState();
      expect(state.stream).toBe("closed");
      expect(state.meta?.status).toBe("partial");
      expect(Object.keys(state.planes)).toHaveLength(18);
      expect(paths(requests, "/cube")).toHaveLength(1);
      expect(paths(requests, "/events")).toHaveLength(1);
      // Solo la banda pedida se bajo plano por plano; el resto llego con el cubo.
      expect(paths(requests, "/plane/").every((path) => /\/plane\/\d+\/3\?/.test(path))).toBe(true);
      expect(firstPlane?.status).toBe("building");
      expect(preview?.band).toBe("W1");

      report.new = {
        ms: { previewMs, listedMs, firstPlaneMs, blinkMs, bandDoneMs, doneMs, cubeMs },
        preview: preview && {
          band: preview.band,
          waveUm: preview.waveUm,
          display: preview.display,
        },
        firstPlane: firstPlane && {
          status: firstPlane.status,
          rev: firstPlane.rev,
          nUsed: firstPlane.plane.n_used,
          nExposures: firstPlane.plane.n_exposures,
        },
        planeRequests: paths(requests, "/plane/"),
        planesBeforeDone,
        metaRequests: paths(requests, "/meta").length,
        warnings: selectWarningGroups(state).map((group) => `${group.code} x${group.count}`),
        band: selectBandInfo(state),
        trace,
      };
    },
    TIMEOUT_MS,
  );

  it(
    "cached: campo ya terminado, sin SSE",
    async () => {
      const { store, control, requests, trace, until } = connect();
      control.scenario = "cached";
      await store.getState().openField({ ...WISE, band: 6 });

      expect(store.getState().phase).toBe("ready");
      const bandMs = await until("banda actual", (state) => loadedOfBand(state, 6) === 3);
      const cubeMs = await until("cubo", (state) => state.cube.status === "ready");

      expect(paths(requests, "/events")).toHaveLength(0);
      expect(paths(requests, "/preview")).toHaveLength(0);
      expect(paths(requests, "/plane/")).toHaveLength(3);
      expect(Object.keys(store.getState().planes)).toHaveLength(18);
      // Objetivo del contrato (seccion 11): menos de 2 s hasta la primera imagen.
      expect(bandMs).toBeLessThan(2000);

      report.cached = {
        ms: { bandMs, cubeMs },
        requests: requests.map(
          (entry) => `${entry.ms} ms ${entry.method} ${entry.path} ${entry.status}`,
        ),
        trace,
      };
    },
    TIMEOUT_MS,
  );

  it(
    "queued: espera en la cola con la posicion bajando",
    async () => {
      const { store, control, trace, until } = connect();
      control.scenario = "queued";
      await store.getState().openField(WISE);

      const positions: number[] = [];
      const unsubscribe = store.subscribe((state) => {
        const position = selectQueuePosition(state);
        if (position !== null && positions.at(-1) !== position) positions.push(position);
      });
      const first = selectQueuePosition(store.getState());
      if (first !== null) positions.unshift(first);
      await until("sale de la cola", (state) => state.meta?.progress.phase !== "queued");
      unsubscribe();
      expect(selectQueuePosition(store.getState())).toBeNull();
      const doneMs = await until("done", (state) => state.phase === "ready");

      expect([...new Set(positions)]).toEqual([3, 2, 1]);
      report.queued = { positions, doneMs, trace };
    },
    TIMEOUT_MS,
  );

  it(
    "error: el trabajo falla despues de las primeras imagenes, y se puede reintentar",
    async () => {
      const { store, control, requests, trace, until } = connect();
      control.scenario = "error";
      await store.getState().openField(EPSINDB);

      const errorMs = await until("error", (state) => state.phase === "error");
      const failed = store.getState();
      expect(failed.error).toMatchObject({ code: "upstream_unavailable", source: "job" });
      expect(failed.meta?.status).toBe("failed");
      expect(failed.stream).toBe("closed");
      const kept = Object.values(failed.planes).map(
        (plane) => `${plane.epoch}:${plane.detector} ${plane.status} rev${plane.rev}`,
      );
      expect(kept.length).toBeGreaterThan(0);
      const timeline = selectTimeline(failed).map((entry) => entry.state);

      // Otro POST vuelve a intentar el campo.
      control.scenario = null;
      const retried = store.getState().retry();
      expect(store.getState().phase).toBe("requesting");
      await retried;
      expect(store.getState().phase).toBe("loading");
      const doneMs = await until("done tras reintentar", (state) => state.phase === "ready");
      await until("cubo", (state) => state.cube.status === "ready");
      expect(Object.keys(store.getState().planes)).toHaveLength(22);

      report.error = {
        errorMs,
        error: failed.error,
        planesKept: kept,
        timelineAtError: timeline,
        retryDoneMs: doneMs,
        fieldPosts: paths(requests, "/api/field").filter((path) => !path.includes("/field/")),
        trace,
      };
    },
    TIMEOUT_MS,
  );

  it(
    "queue_full: 429 con Retry-After, y reintento",
    async () => {
      const { store, control, requests, trace } = connect();
      control.scenario = "queue_full";
      const before = Date.now();
      await store.getState().openField(WISE);

      const { error } = store.getState();
      expect(store.getState().phase).toBe("error");
      expect(error).toMatchObject({
        code: "queue_full",
        source: "request",
        retryable: true,
        retryAfterS: 5,
      });
      expect(error?.retryAt).toBeGreaterThanOrEqual(before + 5000);
      expect(store.getState().meta).toBeNull();

      control.scenario = "cached";
      await store.getState().retry();
      expect(store.getState().phase).toBe("ready");
      expect(store.getState().error).toBeNull();

      report.queue_full = {
        error,
        requests: requests.map((entry) => `${entry.method} ${entry.path} ${entry.status}`),
        trace,
      };
    },
    TIMEOUT_MS,
  );

  it(
    "no_coverage y upstream_unavailable: el error queda claro y nada mas se pide",
    async () => {
      const { store, control, requests, trace } = connect();
      control.scenario = "no_coverage";
      await store.getState().openField(WISE);
      const noCoverage = store.getState().error;
      expect(noCoverage).toMatchObject({
        code: "no_coverage",
        source: "request",
        retryable: false,
      });

      // El servidor falso no tiene muestra del escalon amplio: la vista de 30 minutos tampoco.
      control.scenario = null;
      await store.getState().openField({ ...WISE, fov: 0.5 });
      const wide = store.getState().error;
      expect(wide?.code).toBe("no_coverage");
      expect(store.getState().request?.fov).toBe(0.5);

      control.scenario = "upstream_unavailable";
      await store.getState().retry();
      const upstream = store.getState().error;
      expect(upstream).toMatchObject({ code: "upstream_unavailable", source: "request" });

      expect(requests.every((entry) => entry.method === "POST")).toBe(true);
      report.no_coverage = {
        noCoverage,
        wide,
        upstream,
        requests: requests.map((entry) => `${entry.method} ${entry.path} ${entry.status}`),
        trace,
      };
    },
    TIMEOUT_MS,
  );

  it(
    "red caida: network, reintentable",
    async () => {
      const api = createApiClient({ baseUrl: "http://127.0.0.1:9/api" });
      const store = createFieldStore({ api });
      open.push(store);
      await store.getState().openField(WISE);

      expect(store.getState().phase).toBe("error");
      expect(store.getState().error).toMatchObject({
        code: "network",
        source: "request",
        retryable: true,
      });
      report.network = { error: store.getState().error };
    },
    TIMEOUT_MS,
  );

  it(
    "cambio de banda a mitad de carga: POST /priority y la banda nueva llega antes",
    async () => {
      const { store, control, requests, trace, until } = connect();
      control.scenario = "new";
      await store.getState().openField(WISE);
      await until("primer plano de la banda 3", (state) => loadedOfBand(state, 3) > 0);

      store.getState().setBand(6);
      const previewAgain = selectPreview(store.getState());
      const changedAt = requests.length;
      await until("POST /priority", () => paths(requests, "/priority").length === 1);
      const firstMs = await until(
        "primer plano de la banda 6",
        (state) => loadedOfBand(state, 6) > 0,
      );
      expect(selectPreview(store.getState())).toBeNull();
      const band3Loaded = loadedOfBand(store.getState(), 3);
      await until("banda 6 definitiva", (state) =>
        selectTimeline(state).every((entry) => entry.state === "loaded"),
      );
      // Mientras tanto el backend no termino las otras bandas.
      const readyWhenBand6Done = store.getState().meta?.progress.planes_ready;
      await until("cubo", (state) => state.cube.status === "ready");

      const priority = requests.find((entry) => entry.path.includes("/priority"));
      expect(priority?.status).toBe(204);
      expect(previewAgain?.band).toBe("W1");
      expect(Object.keys(store.getState().planes)).toHaveLength(18);
      const after = requests.slice(changedAt).filter((entry) => entry.path.includes("/plane/"));
      expect(after.every((entry) => /\/plane\/\d+\/6\?/.test(entry.path))).toBe(true);

      report.band_change = {
        firstBand6PlaneMs: firstMs,
        band3LoadedWhenBand6Arrived: band3Loaded,
        planesReadyWhenBand6Done: readyWhenBand6Done,
        previewWhileWaiting: previewAgain && { band: previewAgain.band },
        planeRequests: paths(requests, "/plane/"),
        priority,
        trace,
      };
    },
    TIMEOUT_MS,
  );

  it(
    "campo pedido con la banda 5: la vista provisoria es W2",
    async () => {
      const { store, control, requests, trace, until } = connect();
      control.scenario = "new";
      await store.getState().openField({ ...WISE, band: 5 });

      await until("vista provisoria", (state) => selectPreview(state) !== null);
      const preview = selectPreview(store.getState());
      expect(preview?.band).toBe("W2");
      expect(preview?.waveUm).toBe(4.6);
      expect(preview?.image.width).toBe(195);
      await until("primer plano de la banda 5", (state) => loadedOfBand(state, 5) > 0);
      expect(selectPreview(store.getState())).toBeNull();
      // El rotulo no cambia aunque despues se mire otra banda.
      expect(store.getState().meta?.preview.band).toBe("W2");
      await until("done", (state) => state.phase === "ready");

      report.band5 = {
        preview: preview && {
          band: preview.band,
          waveUm: preview.waveUm,
          survey: preview.survey,
          display: preview.display,
        },
        previewRequests: paths(requests, "/preview").length,
        firstPlaneRequests: paths(requests, "/plane/").slice(0, 3),
        trace,
      };
    },
    TIMEOUT_MS,
  );

  it(
    "nombre con trayectoria: Barnard's Star",
    async () => {
      const { store, control, resolver, requests, trace, until } = connect();

      // La entrada: resolver el texto y armar la URL del campo.
      const { resolved, url } = await resolveQuery("Barnard's Star", { resolver });
      expect(url).toEqual({ ra: 269.4463, dec: 4.7683, name: "NAME Barnard's star", epoch: null });
      expect(resolved.moved_arcsec).toBeGreaterThan(200);

      // El visor: abrir esa URL.
      control.scenario = "new";
      store.getState().syncWithUrl({ ...DEFAULT_URL_STATE, ...url });
      await until("listed", (state) => selectTimeline(state).length > 0);
      await until("trayectoria", (state) => state.target.trackStatus === "ready");
      await until("done", (state) => state.phase === "ready");
      await until("cubo", (state) => state.cube.status === "ready");

      const state = store.getState();
      expect(state.target.resolved?.name).toBe("NAME Barnard's star");
      expect(state.target.track?.positions).toHaveLength(3);
      const positions = [1, 2, 3].map((epoch) => selectTargetPosition(state, epoch));
      expect(positions.every((position) => position?.source === "track" && position.inField)).toBe(
        true,
      );
      // Se mueve unos 10 segundos de arco por anio: mas de un pixel entre epocas.
      expect((positions[2]?.y ?? 0) - (positions[0]?.y ?? 0)).toBeGreaterThan(1);
      // El nombre ya estaba resuelto por la entrada: el visor no lo vuelve a pedir.
      expect(paths(requests, "/resolve")).toHaveLength(1);
      expect(paths(requests, "/track")).toHaveLength(1);

      // Nucleo saturado: +Infinity en la imagen, region para el contorno y aviso.
      const plane = state.planes[planeKey(1, 3)];
      const regions = selectSaturatedRegions(state, 1);
      expect(plane?.image.saturatedCount).toBeGreaterThan(0);
      expect(regions.length).toBeGreaterThan(0);
      const groups = selectWarningGroups(state).map((group) => `${group.code} x${group.count}`);
      expect(groups).toContain("saturated_source x1");

      // Capa de flags del mismo plano.
      await store.getState().loadAux(1);
      const aux = store.getState().aux[planeKey(1, 3)];
      expect(aux?.status).toBe("ready");
      const saturationBits = (store.getState().meta?.flags ?? [])
        .filter((flag) => flag.saturation)
        .reduce((bits, flag) => bits | (1 << flag.bit), 0);
      const flagged = aux?.layers?.flags.filter((value) => (value & saturationBits) !== 0).length;
      expect(flagged).toBeGreaterThan(0);

      // Un nombre que el catalogo guardado no conoce.
      let notResolved: unknown;
      try {
        await resolveQuery("WISE 0855", { resolver });
      } catch (error) {
        notResolved = error;
      }
      expect(errorCodeOf(notResolved)).toBe("not_resolved");

      report.barnard = {
        url,
        movedArcsec: resolved.moved_arcsec,
        motion: resolved.motion,
        positions,
        saturated: { pixels: plane?.image.saturatedCount, regions },
        warnings: groups,
        aux: { flaggedPixels: flagged, saturationBits },
        notResolved: errorCodeOf(notResolved),
        requests: requests
          .filter((entry) => !entry.path.includes("/plane/"))
          .map((entry) => `${entry.ms} ms ${entry.method} ${entry.path} ${entry.status}`),
        trace,
      };
    },
    TIMEOUT_MS,
  );
});
