// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  errorBody,
  FIELD_ID,
  queuedMeta,
  readyMeta,
  resolveBarnard,
  trackBarnard,
} from "@/test/contractExamples";
import { createApiClient, type FetchLike } from "./client";
import { ApiError, isAbortError, parseRetryAfter } from "./errors";

const SHAPE = [3, 4] as const;
const PIXELS = 12;

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** Cliente con un fetch falso que responde lo que se le indique y anota los pedidos. */
function clientWith(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return respond(call);
  };
  return { api: createApiClient({ fetch }), calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function binary(bytes: number, status = 200): Response {
  return new Response(new ArrayBuffer(bytes), {
    status,
    headers: { "Content-Type": "application/octet-stream" },
  });
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw new Error(`se esperaba un ApiError y llego ${String(error)}`);
  }
  throw new Error("se esperaba un ApiError y la promesa se resolvio");
}

describe("resolve", () => {
  it("pide /api/resolve con el nombre codificado y valida la respuesta", async () => {
    const { api, calls } = clientWith(() => json(resolveBarnard()));
    const resolved = await api.resolve("Barnard's Star");

    expect(calls[0]?.url).toBe("/api/resolve?name=Barnard%27s+Star");
    expect(resolved.field_center).toEqual({ ra: 269.4463, dec: 4.7683, epoch: 2026.0 });
    expect(resolved.motion?.per_year_arcsec).toBe(10.39);
  });

  it("convierte el 404 not_resolved en ApiError", async () => {
    const { api } = clientWith(() => json(errorBody("not_resolved"), 404));
    const error = await rejection(api.resolve("no existe"));

    expect(error.code).toBe("not_resolved");
    expect(error.status).toBe(404);
    expect(error.retryable).toBe(false);
    expect(error.message).toBe("detalle para el log");
  });
});

describe("requestField", () => {
  it("manda el pedido como JSON y acepta el 200 de un campo terminado", async () => {
    const { api, calls } = clientWith(() =>
      json({
        id: FIELD_ID,
        status: "ready",
        events_url: `/api/field/${FIELD_ID}/events`,
        meta: readyMeta(),
      }),
    );
    const response = await api.requestField({ ra: 269.4463, dec: 4.7683, fov: 0.1667, band: 3 });

    expect(calls[0]?.url).toBe("/api/field");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      ra: 269.4463,
      dec: 4.7683,
      fov: 0.1667,
      band: 3,
    });
    expect(response.status).toBe("ready");
    expect(response.meta.grid?.shape).toEqual([195, 195]);
  });

  it("acepta el 202 de un campo nuevo", async () => {
    const { api } = clientWith(() =>
      json(
        {
          id: FIELD_ID,
          status: "queued",
          events_url: `/api/field/${FIELD_ID}/events`,
          meta: queuedMeta(),
        },
        202,
      ),
    );
    const response = await api.requestField({ ra: 269.4463, dec: 4.7683 });

    expect(response.status).toBe("queued");
    expect(response.meta.progress.queue_position).toBe(1);
  });

  it("rechaza un pedido invalido sin llamar al backend", async () => {
    const { api, calls } = clientWith(() => json({}));
    const error = await rejection(api.requestField({ ra: 10, dec: 120 }));

    expect(error.code).toBe("invalid_request");
    expect(calls).toHaveLength(0);
  });

  it("entrega queue_full con el Retry-After", async () => {
    const { api } = clientWith(() =>
      json(errorBody("queue_full", true), 429, { "Retry-After": "12" }),
    );
    const error = await rejection(api.requestField({ ra: 10, dec: 20 }));

    expect(error.code).toBe("queue_full");
    expect(error.status).toBe(429);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterS).toBe(12);
  });

  it("rechaza una respuesta que no cumple el contrato", async () => {
    const { api } = clientWith(() => json({ id: FIELD_ID, status: "ready" }));
    const error = await rejection(api.requestField({ ra: 10, dec: 20 }));

    expect(error.code).toBe("invalid_response");
    expect(error.status).toBe(200);
    expect(error.message).toContain("no cumple el contrato");
  });
});

describe("getMeta", () => {
  it("pide /meta del campo", async () => {
    const { api, calls } = clientWith(() => json(readyMeta()));
    const meta = await api.getMeta(FIELD_ID);

    expect(calls[0]?.url).toBe(`/api/field/${FIELD_ID}/meta`);
    expect(meta.status).toBe("ready");
  });

  it("rechaza un cuerpo que no es JSON", async () => {
    const { api } = clientWith(() => new Response("<html>", { status: 200 }));
    const error = await rejection(api.getMeta(FIELD_ID));

    expect(error.code).toBe("invalid_response");
    expect(error.message).toContain("no es JSON");
  });
});

describe("binarios", () => {
  it("getPlane entrega el ArrayBuffer si el tamano coincide con grid.shape", async () => {
    const { api, calls } = clientWith(() => binary(4 * PIXELS));
    const buffer = await api.getPlane(FIELD_ID, 2, 6, SHAPE);

    expect(calls[0]?.url).toBe(`/api/field/${FIELD_ID}/plane/2/6`);
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(buffer.byteLength).toBe(48);
  });

  it("getPlane agrega la revision cuando se pide", async () => {
    const { api, calls } = clientWith(() => binary(4 * PIXELS));
    await api.getPlane(FIELD_ID, 1, 3, SHAPE, { rev: 2 });

    expect(calls[0]?.url).toBe(`/api/field/${FIELD_ID}/plane/1/3?rev=2`);
  });

  it("getPlane rechaza una respuesta de otro tamano", async () => {
    const { api } = clientWith(() => binary(4 * PIXELS - 4));
    const error = await rejection(api.getPlane(FIELD_ID, 1, 3, SHAPE));

    expect(error.code).toBe("invalid_response");
    expect(error.message).toContain("se esperaban 48 bytes y llegaron 44");
  });

  it("getPlane entrega not_ready para un plano pendiente", async () => {
    const { api } = clientWith(() => json(errorBody("not_ready", true), 409));
    const error = await rejection(api.getPlane(FIELD_ID, 1, 3, SHAPE));

    expect(error.code).toBe("not_ready");
    expect(error.status).toBe(409);
  });

  it("getCube espera solo los planos ready y partial", async () => {
    const planes = [
      { status: "ready" },
      { status: "empty" },
      { status: "partial" },
      { status: "ready" },
    ] as const;
    const { api, calls } = clientWith(() => binary(3 * 4 * PIXELS));
    const cube = await api.getCube(FIELD_ID, { shape: SHAPE, planes }, { rev: 1 });

    expect(calls[0]?.url).toBe(`/api/field/${FIELD_ID}/cube?rev=1`);
    expect(cube.byteLength).toBe(144);
  });

  it("getCube rechaza un cubo al que le falta un plano", async () => {
    const planes = [{ status: "ready" }, { status: "ready" }] as const;
    const { api } = clientWith(() => binary(4 * PIXELS));
    const error = await rejection(api.getCube(FIELD_ID, { shape: SHAPE, planes }));

    expect(error.code).toBe("invalid_response");
  });

  it("getAux espera 6 bytes por pixel", async () => {
    const { api, calls } = clientWith(() => binary(6 * PIXELS));
    const buffer = await api.getAux(FIELD_ID, 3, 1, SHAPE);

    expect(calls[0]?.url).toBe(`/api/field/${FIELD_ID}/aux/3/1`);
    expect(buffer.byteLength).toBe(72);

    const wrong = clientWith(() => binary(4 * PIXELS));
    expect((await rejection(wrong.api.getAux(FIELD_ID, 3, 1, SHAPE))).code).toBe(
      "invalid_response",
    );
  });

  it("getPreview espera lo mismo que un plano", async () => {
    const { api, calls } = clientWith(() => binary(4 * PIXELS));
    const buffer = await api.getPreview(FIELD_ID, SHAPE);

    expect(calls[0]?.url).toBe(`/api/field/${FIELD_ID}/preview`);
    expect(buffer.byteLength).toBe(48);
  });
});

describe("getTrack y setPriority", () => {
  it("getTrack pide la trayectoria por nombre", async () => {
    const { api, calls } = clientWith(() => json(trackBarnard()));
    const track = await api.getTrack(FIELD_ID, "NAME Barnard's star");

    expect(calls[0]?.url).toBe(`/api/field/${FIELD_ID}/track?name=NAME+Barnard%27s+star`);
    expect(track.positions).toHaveLength(2);
  });

  it("setPriority manda la banda y acepta el 204", async () => {
    const { api, calls } = clientWith(() => new Response(null, { status: 204 }));
    await expect(api.setPriority(FIELD_ID, 6)).resolves.toBeUndefined();

    expect(calls[0]?.url).toBe(`/api/field/${FIELD_ID}/priority`);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ band: 6 });
  });

  it("setPriority rechaza una banda invalida sin llamar al backend", async () => {
    const { api, calls } = clientWith(() => new Response(null, { status: 204 }));
    const error = await rejection(api.setPriority(FIELD_ID, 9));

    expect(error.code).toBe("invalid_request");
    expect(calls).toHaveLength(0);
  });
});

describe("errores", () => {
  it("un fallo de red sale como ApiError network reintentable", async () => {
    const { api } = clientWith(() => {
      throw new TypeError("fetch failed");
    });
    const error = await rejection(api.getMeta(FIELD_ID));

    expect(error.code).toBe("network");
    expect(error.status).toBe(0);
    expect(error.retryable).toBe(true);
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("una respuesta de error sin el cuerpo del contrato sale como unknown", async () => {
    const { api } = clientWith(() => new Response("Bad Gateway", { status: 502 }));
    const error = await rejection(api.getMeta(FIELD_ID));

    expect(error.code).toBe("unknown");
    expect(error.status).toBe(502);
    expect(error.retryable).toBe(true);
  });

  it("un 4xx sin cuerpo del contrato no es reintentable", async () => {
    const { api } = clientWith(() => json({ detail: "Not Found" }, 404));
    const error = await rejection(api.getMeta(FIELD_ID));

    expect(error.code).toBe("unknown");
    expect(error.retryable).toBe(false);
  });

  it("la cancelacion pasa sin envolver", async () => {
    const controller = new AbortController();
    const { api, calls } = clientWith((call) => {
      const signal = call.init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    });

    const pending = api.getMeta(FIELD_ID, { signal: controller.signal });
    controller.abort();

    const error = await pending.catch((caught: unknown) => caught);
    expect(calls[0]?.init?.signal).toBe(controller.signal);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(isAbortError(error)).toBe(true);
  });

  it("usa el fetch global si no se le pasa uno", async () => {
    const fetchMock = vi.fn(async () => json(readyMeta()));
    vi.stubGlobal("fetch", fetchMock);

    const meta = await createApiClient().getMeta(FIELD_ID);

    expect(meta.id).toBe(FIELD_ID);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("eventsUrl apunta al flujo de eventos del campo", () => {
    expect(createApiClient().eventsUrl(FIELD_ID)).toBe(`/api/field/${FIELD_ID}/events`);
    expect(createApiClient({ baseUrl: "http://localhost:8000/api" }).eventsUrl(FIELD_ID)).toBe(
      `http://localhost:8000/api/field/${FIELD_ID}/events`,
    );
  });
});

describe("parseRetryAfter", () => {
  it("lee segundos", () => {
    expect(parseRetryAfter("5")).toBe(5);
    expect(parseRetryAfter(" 12 ")).toBe(12);
  });

  it("lee una fecha HTTP", () => {
    const now = Date.parse("2026-11-15T06:00:00Z");
    expect(parseRetryAfter("Sun, 15 Nov 2026 06:00:30 GMT", now)).toBe(30);
    expect(parseRetryAfter("Sun, 15 Nov 2026 05:00:00 GMT", now)).toBe(0);
  });

  it("devuelve null si falta o no se entiende", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("pronto")).toBeNull();
  });
});
