// Backend simulado para los tests del estado del campo: un `fetch` que
// responde las rutas del contrato (docs/contrato-cubo.md, seccion 4) a partir
// de un documento de metadatos, anota cada pedido y deja al test manejar el
// flujo de eventos y demorar respuestas. No usa la red. Solo lo importan los tests.

import type { FetchLike } from "@/api/client";

type Shape = readonly [number, number];

export interface RecordedCall {
  method: string;
  /** Ruta sin el prefijo /api: "/field/<id>/plane/1/3". */
  path: string;
  query: URLSearchParams;
  /** Cuerpo JSON del pedido, o null. */
  body: unknown;
  /** Se cancelo con su AbortSignal antes de responder. */
  aborted: boolean;
}

/** Una conexion abierta a /events, manejada por el test. */
export interface EventStream {
  aborted: boolean;
  /** Manda un evento con el formato del contrato. */
  event(name: string, data: unknown, id?: number): void;
  /** El servidor cierra el flujo. */
  end(): void;
  /** La conexion se corta con un error de red. */
  drop(): void;
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

/** Respuestas que el test puede reemplazar; por defecto sirven el documento de `meta`. */
export interface Handlers {
  field: Responder;
  meta: Responder;
  plane: (call: RecordedCall, epoch: number, detector: number) => Response | Promise<Response>;
  cube: Responder;
  preview: Responder;
  aux: (call: RecordedCall, epoch: number, detector: number) => Response | Promise<Response>;
  track: Responder;
  priority: Responder;
  resolve: Responder;
}

export type RouteKind = keyof Handlers;

/** Lo que el backend simulado necesita leer de un plano del documento. */
export interface RawPlane {
  epoch: number;
  detector: number;
  status: string;
  rev: number;
}

/** Lo que el backend simulado necesita leer del documento; el resto pasa tal cual. */
export interface RawMeta {
  id: string;
  status: string;
  grid?: { shape: Shape } | undefined;
  planes?: RawPlane[] | undefined;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function binaryResponse(bytes: ArrayBufferView | ArrayBuffer, status = 200): Response {
  const buffer = bytes instanceof ArrayBuffer ? bytes : bytes.buffer;
  return new Response(buffer as ArrayBuffer, {
    status,
    headers: { "Content-Type": "application/octet-stream" },
  });
}

/** Cuerpo de error del contrato (seccion 2). */
export function errorResponse(
  code: string,
  status: number,
  options: { retryable?: boolean; headers?: Record<string, string> } = {},
): Response {
  return jsonResponse(
    { error: { code, message: `${code} simulado`, retryable: options.retryable ?? false } },
    status,
    options.headers,
  );
}

/** Valor con el que se llena un plano simulado: distinto por epoca, detector y revision. */
export function planeFill(epoch: number, detector: number, rev: number): number {
  return epoch * 100 + detector * 10 + rev;
}

/**
 * Plano simulado: todo con `planeFill`, salvo el primer pixel, que va sin datos
 * (NaN), y el segundo, saturado (+Infinity).
 */
export function planeValues(
  shape: Shape,
  epoch: number,
  detector: number,
  rev: number,
): Float32Array {
  const values = new Float32Array(shape[0] * shape[1]).fill(planeFill(epoch, detector, rev));
  values[0] = Number.NaN;
  values[1] = Number.POSITIVE_INFINITY;
  return values;
}

/** Valor de todos los pixeles de la vista provisoria simulada. */
export const PREVIEW_FILL = 7;

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export function createFakeBackend(initialMeta: unknown) {
  const calls: RecordedCall[] = [];
  const streams: EventStream[] = [];
  const held = new Map<RouteKind, Array<() => void>>();
  const encoder = new TextEncoder();
  const state = {
    /** Documento que sirven /meta, /plane y /cube. El test lo puede cambiar. */
    meta: initialMeta as RawMeta,
    /** Forma de la grilla mientras el documento todavia no la trae (antes de `listed`). */
    fallbackShape: null as Shape | null,
    /** Si esta, responde GET /events en vez de abrir un flujo. */
    eventsOverride: null as Responder | null,
    /** Pedidos de binarios sin responder en este momento, y el maximo que hubo. */
    inFlight: 0,
    maxInFlight: 0,
  };

  function shape(): Shape {
    const known = state.meta.grid?.shape ?? state.fallbackShape;
    if (!known) throw new Error("el documento simulado no tiene grilla");
    return known;
  }

  function rawPlane(epoch: number, detector: number): RawPlane | undefined {
    return state.meta.planes?.find((plane) => plane.epoch === epoch && plane.detector === detector);
  }

  function inCube(plane: RawPlane): boolean {
    return plane.status === "ready" || plane.status === "partial";
  }

  const handlers: Handlers = {
    field: () =>
      jsonResponse({
        id: state.meta.id,
        status: state.meta.status,
        events_url: `/api/field/${state.meta.id}/events`,
        meta: state.meta,
      }),
    meta: () => jsonResponse(state.meta),
    plane: (_call, epoch, detector) => {
      const plane = rawPlane(epoch, detector);
      if (!plane) return errorResponse("not_found", 404);
      if (plane.status === "pending") return errorResponse("not_ready", 409, { retryable: true });
      if (plane.status === "empty") return errorResponse("not_found", 404);
      // Como el backend: siempre la revision vigente, se pida la que se pida.
      return binaryResponse(planeValues(shape(), epoch, detector, plane.rev));
    },
    cube: () => {
      const planes = (state.meta.planes ?? []).filter(inCube);
      const size = shape()[0] * shape()[1];
      const cube = new Float32Array(size * planes.length);
      for (const [index, plane] of planes.entries()) {
        cube.set(planeValues(shape(), plane.epoch, plane.detector, plane.rev), index * size);
      }
      return binaryResponse(cube);
    },
    preview: () => binaryResponse(new Float32Array(shape()[0] * shape()[1]).fill(PREVIEW_FILL)),
    aux: (_call, epoch, detector) => {
      const size = shape()[0] * shape()[1];
      const bytes = new ArrayBuffer(6 * size);
      // Un bit de flags y una cobertura reconocibles en el primer pixel.
      new Uint32Array(bytes, 0, size)[0] = 1 << detector;
      new Uint16Array(bytes, 4 * size, size)[0] = epoch;
      return binaryResponse(bytes);
    },
    track: (call) => jsonResponse({ name: call.query.get("name") ?? "", positions: [] }),
    priority: () => new Response(null, { status: 204 }),
    resolve: () => errorResponse("not_resolved", 404),
  };

  function openStream(signal: AbortSignal | undefined): Response {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });
    const safely = (action: () => void) => {
      try {
        action();
      } catch {
        // El flujo ya estaba cerrado o cancelado.
      }
    };
    const stream: EventStream = {
      aborted: false,
      event(name, data, id) {
        const idLine = id === undefined ? "" : `id: ${id}\n`;
        const text = `event: ${name}\n${idLine}data: ${JSON.stringify(data)}\n\n`;
        safely(() => controller?.enqueue(encoder.encode(text)));
      },
      end() {
        safely(() => controller?.close());
      },
      drop() {
        safely(() => controller?.error(new TypeError("network error")));
      },
    };
    signal?.addEventListener("abort", () => {
      stream.aborted = true;
      safely(() => controller?.error(signal.reason));
    });
    streams.push(stream);
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    });
  }

  /** Espera a que el test libere las respuestas de esa ruta, si las esta reteniendo. */
  function waitForRelease(kind: RouteKind, signal: AbortSignal | undefined): Promise<void> {
    const waiting = held.get(kind);
    if (!waiting) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      waiting.push(resolve);
      signal?.addEventListener(
        "abort",
        () => {
          const index = waiting.indexOf(resolve);
          if (index >= 0) waiting.splice(index, 1);
          reject(abortError());
        },
        { once: true },
      );
    });
  }

  function route(
    call: RecordedCall,
  ): { kind: RouteKind; respond: () => Response | Promise<Response> } | "events" | null {
    const { method, path } = call;
    if (method === "POST" && path === "/field") {
      return { kind: "field", respond: () => handlers.field(call) };
    }
    if (method === "GET" && path === "/resolve") {
      return { kind: "resolve", respond: () => handlers.resolve(call) };
    }
    const match = /^\/field\/[0-9a-f]+\/(\w+)(?:\/(\d+)\/(\d+))?$/.exec(path);
    if (!match) return null;
    const [, resource, epochText, detectorText] = match;
    const epoch = Number(epochText);
    const detector = Number(detectorText);
    if (method === "POST") {
      return resource === "priority"
        ? { kind: "priority", respond: () => handlers.priority(call) }
        : null;
    }
    switch (resource) {
      case "events":
        return "events";
      case "meta":
        return { kind: "meta", respond: () => handlers.meta(call) };
      case "plane":
        return { kind: "plane", respond: () => handlers.plane(call, epoch, detector) };
      case "cube":
        return { kind: "cube", respond: () => handlers.cube(call) };
      case "preview":
        return { kind: "preview", respond: () => handlers.preview(call) };
      case "aux":
        return { kind: "aux", respond: () => handlers.aux(call, epoch, detector) };
      case "track":
        return { kind: "track", respond: () => handlers.track(call) };
      default:
        return null;
    }
  }

  const BINARY: ReadonlySet<RouteKind> = new Set(["plane", "cube", "preview", "aux"]);

  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input, "http://backend.test");
    const signal = init?.signal ?? undefined;
    const call: RecordedCall = {
      method: init?.method ?? "GET",
      path: url.pathname.replace(/^\/api/, ""),
      query: url.searchParams,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      aborted: false,
    };
    calls.push(call);
    signal?.addEventListener("abort", () => {
      call.aborted = true;
    });
    if (signal?.aborted) throw abortError();

    const target = route(call);
    if (target === null) return errorResponse("not_found", 404);
    if (target === "events") {
      return state.eventsOverride ? state.eventsOverride(call) : openStream(signal);
    }

    const binary = BINARY.has(target.kind);
    if (binary) {
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    }
    try {
      await waitForRelease(target.kind, signal);
      return await target.respond();
    } finally {
      if (binary) state.inFlight -= 1;
    }
  };

  return {
    fetch,
    /** Todos los pedidos, en orden. */
    calls,
    /** Conexiones a /events, en orden. */
    streams,
    handlers,
    state,

    /** Pedidos de una ruta: `requests("plane")`, o de un plano: `requests("plane", "/plane/1/3")`. */
    requests(kind: RouteKind, suffix = ""): RecordedCall[] {
      return calls.filter((call) => {
        if (kind === "field") return call.method === "POST" && call.path === "/field";
        if (kind === "resolve") return call.path === "/resolve";
        return call.path.includes(`/${kind}`) && call.path.endsWith(suffix);
      });
    },

    /** Desde ahora las respuestas de esa ruta esperan a `release`. */
    hold(kind: RouteKind): void {
      if (!held.has(kind)) held.set(kind, []);
    },

    /** Cuantas respuestas de esa ruta estan esperando. */
    heldCount(kind: RouteKind): number {
      return held.get(kind)?.length ?? 0;
    },

    /** Libera las respuestas retenidas de esa ruta; con `count`, solo las primeras. */
    release(kind: RouteKind, count = Number.POSITIVE_INFINITY): void {
      const waiting = held.get(kind);
      if (!waiting) return;
      if (count === Number.POSITIVE_INFINITY) held.delete(kind);
      for (const resolve of waiting.splice(0, count)) resolve();
    },
  };
}

export type FakeBackend = ReturnType<typeof createFakeBackend>;
