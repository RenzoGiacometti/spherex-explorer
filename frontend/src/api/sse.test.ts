// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  doneEventData,
  errorBody,
  FIELD_ID,
  pendingPreview,
  planeEventData,
  progressEventData,
  queuedMeta,
  readyMeta,
} from "@/test/contractExamples";
import type { FetchLike } from "./client";
import type { ApiError } from "./errors";
import {
  type FieldEventsOptions,
  type FieldEventsSubscription,
  type InvalidEvent,
  type StreamStatus,
  subscribeFieldEvents,
} from "./sse";
import type { FieldEvent } from "./types";

const EVENTS_URL = `/api/field/${FIELD_ID}/events`;

/** Una conexion abierta contra el servidor falso. */
interface Connection {
  url: string;
  headers: Headers;
  aborted: boolean;
  /** Manda texto por el flujo. */
  push(text: string): void;
  /** Manda un evento con el formato del contrato. */
  event(name: string, data: unknown, id?: number): void;
  /** El servidor cierra el flujo. */
  end(): void;
  /** La conexion se corta con un error de red. */
  drop(): void;
}

/** Respuesta preparada para el proximo fetch; recibe las opciones del pedido. */
type PlannedResponse = (init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * Servidor falso: cada fetch abre una conexion nueva con un flujo que el test
 * controla. `plan` permite que el proximo fetch falle o responda otra cosa.
 */
function fakeServer() {
  const connections: Connection[] = [];
  const planned: PlannedResponse[] = [];
  const encoder = new TextEncoder();

  const fetch: FetchLike = async (url, init) => {
    const next = planned.shift();
    if (next) return next(init);

    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });

    const connection: Connection = {
      url,
      headers: new Headers(init?.headers),
      aborted: false,
      push(text) {
        try {
          controller?.enqueue(encoder.encode(text));
        } catch {
          // El flujo ya estaba cerrado o cancelado: el texto se pierde, como en la red.
        }
      },
      event(name, data, id) {
        const idLine = id === undefined ? "" : `id: ${id}\n`;
        this.push(`event: ${name}\n${idLine}data: ${JSON.stringify(data)}\n\n`);
      },
      end() {
        try {
          controller?.close();
        } catch {
          // El flujo ya estaba cerrado o cancelado.
        }
      },
      drop() {
        try {
          controller?.error(new TypeError("network error"));
        } catch {
          // El flujo ya estaba cerrado o cancelado.
        }
      },
    };

    // Como el fetch real: al cancelar, la lectura pendiente falla con AbortError.
    const signal = init?.signal;
    signal?.addEventListener("abort", () => {
      connection.aborted = true;
      try {
        controller?.error(signal.reason);
      } catch {
        // El flujo ya estaba cerrado.
      }
    });

    connections.push(connection);
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    });
  };

  return {
    fetch,
    connections,
    /** El proximo fetch usa esta respuesta en vez de abrir un flujo. */
    plan(response: PlannedResponse) {
      planned.push(response);
    },
    /** Espera a que exista la conexion numero `index` (desde 0). */
    async connection(index: number): Promise<Connection> {
      await vi.waitFor(() => {
        expect(connections.length).toBeGreaterThan(index);
      });
      const connection = connections[index];
      if (!connection) throw new Error(`no hay conexion ${index}`);
      return connection;
    },
  };
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Suscripcion con reintentos inmediatos y todo lo que llega anotado. */
function subscribe(
  server: ReturnType<typeof fakeServer>,
  options: Partial<FieldEventsOptions> = {},
) {
  const events: FieldEvent[] = [];
  const statuses: StreamStatus[] = [];
  const failures: ApiError[] = [];
  const invalid: InvalidEvent[] = [];

  const subscription = subscribeFieldEvents(EVENTS_URL, {
    fetch: server.fetch,
    retryDelayMs: () => 0,
    onEvent: (event) => events.push(event),
    onStatus: (status) => statuses.push(status),
    onFailure: (error) => failures.push(error),
    onInvalidEvent: (event) => invalid.push(event),
    ...options,
  });
  subscriptions.push(subscription);

  return { subscription, events, statuses, failures, invalid };
}

const subscriptions: FieldEventsSubscription[] = [];

afterEach(() => {
  for (const subscription of subscriptions.splice(0)) subscription.close();
});

/** Deja correr las tareas pendientes, para comprobar que algo NO paso. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("subscribeFieldEvents", () => {
  it("pide el flujo con Accept text/event-stream", async () => {
    const server = fakeServer();
    subscribe(server);
    const connection = await server.connection(0);

    expect(connection.url).toBe(EVENTS_URL);
    expect(connection.headers.get("Accept")).toBe("text/event-stream");
  });

  it("entrega los eventos validados, en orden, como union discriminada", async () => {
    const server = fakeServer();
    const { events } = subscribe(server);
    const connection = await server.connection(0);

    connection.event("state", queuedMeta(), 1);
    connection.event("queued", { position: 1 }, 2);
    connection.event("preview", pendingPreview(), 3);
    connection.event("listed", readyMeta(), 4);
    connection.event("progress", progressEventData(), 9);
    connection.event("plane", planeEventData(), 10);
    connection.event("warning", { code: "plane_empty", epoch: 4, detector: 1 }, 11);

    await vi.waitFor(() => expect(events).toHaveLength(7));

    expect(events.map((event) => event.type)).toEqual([
      "state",
      "queued",
      "preview",
      "listed",
      "progress",
      "plane",
      "warning",
    ]);
    expect(events.map((event) => event.id)).toEqual([1, 2, 3, 4, 9, 10, 11]);

    const [state, queued, preview, , progress, plane, warning] = events;
    // El tipo se estrecha con `type`: estas lecturas no compilan sin la union discriminada.
    expect(state?.type === "state" && state.data.status).toBe("queued");
    expect(state?.type === "state" && state.data.preview.status).toBe("pending");
    expect(queued?.type === "queued" && queued.data.position).toBe(1);
    expect(preview?.type === "preview" && preview.data.band).toBe("W1");
    expect(progress?.type === "progress" && progress.data.cutouts_done).toBe(21);
    expect(plane?.type === "plane" && plane.data.plane.detector).toBe(3);
    expect(plane?.type === "plane" && plane.data.detector_display?.vmax).toBe(9.8);
    expect(warning?.type === "warning" && warning.data.code).toBe("plane_empty");
  });

  it("ignora los ping y junta los eventos que llegan partidos", async () => {
    const server = fakeServer();
    const { events } = subscribe(server);
    const connection = await server.connection(0);

    const text = `: ping\n\nevent: queued\nid: 5\ndata: ${JSON.stringify({ position: 3 })}\n\n`;
    connection.push(text.slice(0, 25));
    await settle();
    expect(events).toHaveLength(0);

    connection.push(text.slice(25));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({ type: "queued", id: 5, data: { position: 3 } });
  });

  it("cierra despues de done y no vuelve a conectar", async () => {
    const server = fakeServer();
    const { events, statuses, failures } = subscribe(server);
    const connection = await server.connection(0);

    connection.event("state", readyMeta(), 1);
    connection.event("done", doneEventData(), 2);
    // El servidor cierra el flujo despues de done.
    connection.end();

    await vi.waitFor(() => expect(statuses.at(-1)).toBe("closed"));
    await settle();

    expect(events.map((event) => event.type)).toEqual(["state", "done"]);
    expect(events[1]).toEqual({ type: "done", id: 2, data: doneEventData() });
    expect(statuses).toEqual(["connecting", "open", "closed"]);
    expect(connection.aborted).toBe(true);
    expect(server.connections).toHaveLength(1);
    expect(failures).toHaveLength(0);
  });

  it("no entrega lo que llegue despues de done", async () => {
    const server = fakeServer();
    const { events } = subscribe(server);
    const connection = await server.connection(0);

    connection.push(
      `event: done\ndata: ${JSON.stringify(doneEventData())}\n\n` +
        `event: queued\ndata: ${JSON.stringify({ position: 1 })}\n\n`,
    );

    await vi.waitFor(() => expect(events).toHaveLength(1));
    await settle();
    expect(events.map((event) => event.type)).toEqual(["done"]);
  });

  it("cierra despues de un evento error del servidor, sin reintentar", async () => {
    const server = fakeServer();
    const { events, statuses, failures } = subscribe(server);
    const connection = await server.connection(0);

    connection.event("state", queuedMeta(), 1);
    // El evento lleva el cuerpo de error de la seccion 2, envuelto en {error: ...}.
    connection.event("error", errorBody("no_coverage", false, "sin exposiciones"), 2);
    connection.end();

    await vi.waitFor(() => expect(statuses.at(-1)).toBe("closed"));
    await settle();

    // Quien consume recibe el objeto de adentro.
    expect(events.at(-1)).toEqual({
      type: "error",
      id: 2,
      data: { code: "no_coverage", message: "sin exposiciones", retryable: false },
    });
    expect(server.connections).toHaveLength(1);
    // El error del trabajo ya llego como evento: no es una falla de la suscripcion.
    expect(failures).toHaveLength(0);
  });

  it("descarta un evento error suelto, sin la clave error, y no cierra por el", async () => {
    const server = fakeServer();
    const { events, invalid, statuses } = subscribe(server);
    const connection = await server.connection(0);

    connection.event("error", { code: "upstream_unavailable", message: "IRSA", retryable: true });
    await vi.waitFor(() => expect(invalid).toHaveLength(1));

    expect(invalid[0]?.event).toBe("error");
    expect(invalid[0]?.reason).toBe("invalid_data");
    expect(events).toHaveLength(0);
    expect(statuses.at(-1)).toBe("open");

    // El mismo error con la forma del contrato si llega, y cierra la suscripcion.
    connection.event("error", errorBody("upstream_unavailable", true, "IRSA no responde"));
    await vi.waitFor(() => expect(statuses.at(-1)).toBe("closed"));
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toEqual({
      code: "upstream_unavailable",
      message: "IRSA no responde",
      retryable: true,
    });
  });

  it("reconecta si el flujo se corta sin done, y el state nuevo llega como cualquier otro", async () => {
    const server = fakeServer();
    const { events, statuses } = subscribe(server);

    const first = await server.connection(0);
    first.event("state", queuedMeta(), 1);
    first.event("progress", progressEventData(), 2);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    first.end();

    const second = await server.connection(1);
    second.event("state", readyMeta(), 1);
    second.event("done", doneEventData(), 2);

    await vi.waitFor(() => expect(statuses.at(-1)).toBe("closed"));
    expect(events.map((event) => event.type)).toEqual(["state", "progress", "state", "done"]);
    // El segundo state trae el documento completo: reemplaza al primero.
    const replacement = events[2];
    expect(replacement?.type === "state" && replacement.data.status).toBe("ready");
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "open", "closed"]);
  });

  it("reconecta si la conexion se corta con un error de red", async () => {
    const server = fakeServer();
    const { events, statuses } = subscribe(server);

    const first = await server.connection(0);
    first.event("state", queuedMeta(), 1);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    first.drop();

    const second = await server.connection(1);
    second.event("state", queuedMeta(), 1);
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "open"]);
  });

  it("reintenta si el backend no responde y se rinde al agotar los reintentos", async () => {
    const server = fakeServer();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      server.plan(() => Promise.reject(new TypeError("fetch failed")));
    }
    const { failures, statuses, events } = subscribe(server, { maxRetries: 2 });

    await vi.waitFor(() => expect(failures).toHaveLength(1));

    expect(failures[0]?.code).toBe("network");
    expect(failures[0]?.retryable).toBe(true);
    expect(statuses).toEqual(["connecting", "reconnecting", "closed"]);
    expect(events).toHaveLength(0);
    expect(server.connections).toHaveLength(0);
  });

  it("vuelve a contar los reintentos desde cero cuando llega un evento valido", async () => {
    const server = fakeServer();
    const { events, failures } = subscribe(server, { maxRetries: 1 });

    // Tres cortes seguidos, pero cada conexion entrego un evento: nunca se rinde.
    for (let index = 0; index < 3; index += 1) {
      const connection = await server.connection(index);
      connection.event("state", queuedMeta(), 1);
      await vi.waitFor(() => expect(events).toHaveLength(index + 1));
      connection.end();
    }

    await server.connection(3);
    expect(failures).toHaveLength(0);
  });

  it("no reintenta un 404: avisa por onFailure con el codigo del contrato", async () => {
    const server = fakeServer();
    server.plan(() => json(errorBody("not_found"), 404));
    const { failures, statuses, events } = subscribe(server);

    await vi.waitFor(() => expect(failures).toHaveLength(1));
    await settle();

    expect(failures[0]?.code).toBe("not_found");
    expect(failures[0]?.status).toBe(404);
    expect(statuses).toEqual(["connecting", "closed"]);
    expect(events).toHaveLength(0);
    expect(server.connections).toHaveLength(0);
  });

  it("reintenta una respuesta de error reintentable", async () => {
    const server = fakeServer();
    server.plan(() => json(errorBody("upstream_unavailable", true), 503));
    const { events, failures } = subscribe(server);

    const connection = await server.connection(0);
    connection.event("state", queuedMeta(), 1);

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(failures).toHaveLength(0);
  });

  it("espera lo que pide Retry-After antes de reintentar", async () => {
    const server = fakeServer();
    server.plan(() => json(errorBody("queue_full", true), 429, { "Retry-After": "0.05" }));
    const retryDelayMs = vi.fn(() => 0);
    subscribe(server, { retryDelayMs });

    const started = Date.now();
    await server.connection(0);

    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(retryDelayMs).not.toHaveBeenCalled();
  });

  it("rechaza una respuesta que no es un flujo de eventos", async () => {
    const server = fakeServer();
    server.plan(
      () =>
        new Response("<html></html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    );
    const { failures } = subscribe(server);

    await vi.waitFor(() => expect(failures).toHaveLength(1));
    expect(failures[0]?.code).toBe("invalid_response");
  });

  it("descarta los eventos que no cumplen el contrato y avisa", async () => {
    const server = fakeServer();
    const { events, invalid } = subscribe(server);
    const connection = await server.connection(0);

    connection.event("heartbeat", { ok: true });
    connection.push("event: progress\ndata: {esto no es json\n\n");
    connection.event("progress", { phase: "volando" });
    connection.event("queued", { position: "segundo" });
    connection.event("queued", { position: 2 });

    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(events[0]).toEqual({ type: "queued", id: null, data: { position: 2 } });
    expect(invalid.map((event) => [event.event, event.reason])).toEqual([
      ["heartbeat", "unknown_event"],
      ["progress", "invalid_json"],
      ["progress", "invalid_data"],
      ["queued", "invalid_data"],
    ]);
  });

  it("por defecto anota en la consola los eventos descartados", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = fakeServer();
    const events: FieldEvent[] = [];
    subscriptions.push(
      subscribeFieldEvents(EVENTS_URL, {
        fetch: server.fetch,
        onEvent: (event) => events.push(event),
      }),
    );
    const connection = await server.connection(0);

    connection.event("progress", { phase: "volando" });
    connection.event("queued", { position: 2 });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(warn).toHaveBeenCalledOnce();
  });

  it("sigue leyendo aunque el manejador de eventos falle", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const server = fakeServer();
    const seen: string[] = [];
    subscribe(server, {
      onEvent: (event) => {
        seen.push(event.type);
        if (event.type === "queued") throw new Error("fallo de quien consume");
      },
    });
    const connection = await server.connection(0);

    connection.event("queued", { position: 2 });
    connection.event("progress", progressEventData());

    await vi.waitFor(() => expect(seen).toEqual(["queued", "progress"]));
    expect(error).toHaveBeenCalledOnce();
    expect(server.connections).toHaveLength(1);
  });

  it("close corta la conexion y no avisa ni reintenta", async () => {
    const server = fakeServer();
    const { subscription, events, statuses, failures } = subscribe(server);
    const connection = await server.connection(0);

    connection.event("state", queuedMeta(), 1);
    await vi.waitFor(() => expect(events).toHaveLength(1));

    subscription.close();
    connection.push(`event: queued\ndata: ${JSON.stringify({ position: 1 })}\n\n`);
    await settle();

    expect(connection.aborted).toBe(true);
    expect(statuses.at(-1)).toBe("closed");
    expect(events).toHaveLength(1);
    expect(failures).toHaveLength(0);
    expect(server.connections).toHaveLength(1);
  });

  it("close durante la espera de un reintento cancela el reintento", async () => {
    const server = fakeServer();
    server.plan(() => Promise.reject(new TypeError("fetch failed")));
    // La espera es larga a proposito: el cierre tiene que llegar antes del reintento.
    const { subscription, statuses } = subscribe(server, { retryDelayMs: () => 150 });

    await vi.waitFor(() => expect(statuses).toContain("reconnecting"));
    subscription.close();
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(server.connections).toHaveLength(0);
    expect(statuses.at(-1)).toBe("closed");
  });

  it("reconecta si pasa el tiempo de espera sin recibir nada", async () => {
    const server = fakeServer();
    const { events, statuses } = subscribe(server, { idleTimeoutMs: 60 });

    const first = await server.connection(0);
    first.event("state", queuedMeta(), 1);
    await vi.waitFor(() => expect(events).toHaveLength(1));

    // Silencio: ni eventos ni ping. La conexion se da por muerta y se abre otra.
    await server.connection(1);

    expect(first.aborted).toBe(true);
    expect(statuses.slice(0, 3)).toEqual(["connecting", "open", "reconnecting"]);
    expect(events).toHaveLength(1);
  });

  it("reconecta si el backend acepta la conexion y no contesta", async () => {
    const server = fakeServer();
    // Un fetch que no se resuelve nunca y solo termina cuando lo cancelan.
    server.plan(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const { statuses } = subscribe(server, { idleTimeoutMs: 60 });

    await server.connection(0);
    expect(statuses.slice(0, 3)).toEqual(["connecting", "reconnecting", "open"]);
  });

  it("no espera mas de un minuto aunque Retry-After pida mas", async () => {
    vi.useFakeTimers();
    try {
      const server = fakeServer();
      server.plan(() => json(errorBody("queue_full", true), 429, { "Retry-After": "3600" }));
      subscribe(server);

      await vi.advanceTimersByTimeAsync(59_000);
      expect(server.connections).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(server.connections).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("un ping mantiene viva la conexion", async () => {
    const server = fakeServer();
    subscribe(server, { idleTimeoutMs: 200 });
    const connection = await server.connection(0);

    // 280 ms en total, mas que el tiempo de espera: sin los ping se habria cortado.
    for (let index = 0; index < 7; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      connection.push(": ping\n\n");
    }

    expect(connection.aborted).toBe(false);
    expect(server.connections).toHaveLength(1);
  });
});
