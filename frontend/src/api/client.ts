// Cliente de la API del backend (docs/contrato-cubo.md, seccion 4).
//
// - El JSON se valida con los esquemas de schema.ts antes de entregarlo.
// - Los binarios se entregan como ArrayBuffer despues de comprobar que su
//   tamano es el que corresponde a grid.shape; una respuesta de otro tamano
//   se rechaza (seccion 6).
// - Todo fallo sale como ApiError con `code`. La cancelacion con
//   AbortController pasa sin envolver (error con name "AbortError").

import { z } from "zod";
import { auxByteLength, cubeByteLength, type GridShape, planeByteLength } from "./binary";
import { ApiError, errorFromResponse, networkError } from "./errors";
import {
  fieldMetaSchema,
  fieldRequestSchema,
  fieldResponseSchema,
  priorityRequestSchema,
  resolveResponseSchema,
  trackResponseSchema,
} from "./schema";
import type {
  FieldMeta,
  FieldRequest,
  FieldResponse,
  Plane,
  ResolveResponse,
  TrackResponse,
} from "./types";

/** Prefijo de la API. En desarrollo Vite lo redirige al backend (vite.config.ts). */
export const API_BASE = "/api";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientConfig {
  /** Prefijo de las rutas. Por defecto "/api". */
  baseUrl?: string;
  /** Reemplazo de fetch, para los tests. */
  fetch?: FetchLike;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface RevisionOptions extends RequestOptions {
  /**
   * Revision que se pide. Con `rev` la respuesta se puede guardar en cache para
   * siempre, porque una revision no cambia nunca.
   */
  rev?: number;
}

/** Lo que hace falta para saber cuanto pesa /cube. */
export interface CubeLayout {
  shape: GridShape;
  planes: readonly Pick<Plane, "status">[];
}

export interface ApiClient {
  /** GET /api/resolve?name= */
  resolve(name: string, options?: RequestOptions): Promise<ResolveResponse>;
  /** POST /api/field. Responde 200 (campo terminado) o 202 (en cola o en curso). */
  requestField(request: FieldRequest, options?: RequestOptions): Promise<FieldResponse>;
  /** GET /api/field/{id}/meta */
  getMeta(id: string, options?: RequestOptions): Promise<FieldMeta>;
  /** GET /api/field/{id}/plane/{epoch}/{detector}: Float32, 4 * ny * nx bytes. */
  getPlane(
    id: string,
    epoch: number,
    detector: number,
    shape: GridShape,
    options?: RevisionOptions,
  ): Promise<ArrayBuffer>;
  /** GET /api/field/{id}/cube: los planos ready y partial, en el orden de `planes`. */
  getCube(id: string, layout: CubeLayout, options?: RevisionOptions): Promise<ArrayBuffer>;
  /** GET /api/field/{id}/aux/{epoch}/{detector}: flags Uint32 y cobertura Uint16. */
  getAux(
    id: string,
    epoch: number,
    detector: number,
    shape: GridShape,
    options?: RequestOptions,
  ): Promise<ArrayBuffer>;
  /** GET /api/field/{id}/preview: vista provisoria de WISE, Float32. */
  getPreview(id: string, shape: GridShape, options?: RequestOptions): Promise<ArrayBuffer>;
  /** GET /api/field/{id}/track?name= */
  getTrack(id: string, name: string, options?: RequestOptions): Promise<TrackResponse>;
  /** POST /api/field/{id}/priority. Responde 204. */
  setPriority(id: string, band: number, options?: RequestOptions): Promise<void>;
  /** URL de GET /api/field/{id}/events, para sse.ts. */
  eventsUrl(id: string): string;
}

const JSON_ACCEPT = { Accept: "application/json" };
const BINARY_ACCEPT = { Accept: "application/octet-stream" };

function fieldPath(id: string, rest = ""): string {
  return `/field/${encodeURIComponent(id)}${rest}`;
}

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const text = query.toString();
  return text === "" ? path : `${path}?${text}`;
}

function invalidResponse(status: number, message: string, cause?: unknown): ApiError {
  return new ApiError({ code: "invalid_response", status, retryable: false, message, cause });
}

function invalidRequest(what: string, error: z.ZodError): ApiError {
  // Mismo codigo que daria el backend, sin gastar un pedido.
  return new ApiError({
    code: "invalid_request",
    status: 0,
    retryable: false,
    message: `${what}: pedido invalido\n${z.prettifyError(error)}`,
    cause: error,
  });
}

export function createApiClient(config: ApiClientConfig = {}): ApiClient {
  const baseUrl = config.baseUrl ?? API_BASE;
  // Se resuelve en cada llamada para que un test pueda reemplazar el fetch global.
  const doFetch: FetchLike = config.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function send(
    path: string,
    init: RequestInit,
    options: RequestOptions | undefined,
  ): Promise<Response> {
    const url = `${baseUrl}${path}`;
    const requestInit: RequestInit = options?.signal ? { ...init, signal: options.signal } : init;

    let response: Response;
    try {
      response = await doFetch(url, requestInit);
    } catch (cause) {
      throw networkError(cause, url);
    }
    if (!response.ok) throw await errorFromResponse(response);
    return response;
  }

  async function readJson<Schema extends z.ZodType>(
    response: Response,
    schema: Schema,
    path: string,
  ): Promise<z.output<Schema>> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw invalidResponse(response.status, `${path}: la respuesta no es JSON`, cause);
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw invalidResponse(
        response.status,
        `${path}: la respuesta no cumple el contrato\n${z.prettifyError(parsed.error)}`,
        parsed.error,
      );
    }
    return parsed.data;
  }

  async function getJson<Schema extends z.ZodType>(
    path: string,
    schema: Schema,
    options: RequestOptions | undefined,
  ): Promise<z.output<Schema>> {
    const response = await send(path, { headers: JSON_ACCEPT }, options);
    return readJson(response, schema, path);
  }

  function postJson(
    path: string,
    body: unknown,
    options: RequestOptions | undefined,
  ): Promise<Response> {
    return send(
      path,
      {
        method: "POST",
        headers: { ...JSON_ACCEPT, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      options,
    );
  }

  async function getBinary(
    path: string,
    expectedBytes: number,
    options: RequestOptions | undefined,
  ): Promise<ArrayBuffer> {
    const response = await send(path, { headers: BINARY_ACCEPT }, options);

    let buffer: ArrayBuffer;
    try {
      buffer = await response.arrayBuffer();
    } catch (cause) {
      throw networkError(cause, path);
    }
    if (buffer.byteLength !== expectedBytes) {
      throw invalidResponse(
        response.status,
        `${path}: se esperaban ${expectedBytes} bytes y llegaron ${buffer.byteLength}`,
      );
    }
    return buffer;
  }

  return {
    resolve(name, options) {
      return getJson(withQuery("/resolve", { name }), resolveResponseSchema, options);
    },

    async requestField(request, options) {
      const body = fieldRequestSchema.safeParse(request);
      if (!body.success) throw invalidRequest("POST /field", body.error);
      const response = await postJson("/field", body.data, options);
      return readJson(response, fieldResponseSchema, "/field");
    },

    getMeta(id, options) {
      return getJson(fieldPath(id, "/meta"), fieldMetaSchema, options);
    },

    getPlane(id, epoch, detector, shape, options) {
      const path = withQuery(fieldPath(id, `/plane/${epoch}/${detector}`), { rev: options?.rev });
      return getBinary(path, planeByteLength(shape), options);
    },

    getCube(id, layout, options) {
      const path = withQuery(fieldPath(id, "/cube"), { rev: options?.rev });
      return getBinary(path, cubeByteLength(layout.shape, layout.planes), options);
    },

    getAux(id, epoch, detector, shape, options) {
      return getBinary(fieldPath(id, `/aux/${epoch}/${detector}`), auxByteLength(shape), options);
    },

    getPreview(id, shape, options) {
      return getBinary(fieldPath(id, "/preview"), planeByteLength(shape), options);
    },

    getTrack(id, name, options) {
      return getJson(withQuery(fieldPath(id, "/track"), { name }), trackResponseSchema, options);
    },

    async setPriority(id, band, options) {
      const body = priorityRequestSchema.safeParse({ band });
      if (!body.success) throw invalidRequest("POST /field/{id}/priority", body.error);
      await postJson(fieldPath(id, "/priority"), body.data, options);
    },

    eventsUrl(id) {
      return `${baseUrl}${fieldPath(id, "/events")}`;
    },
  };
}

/** Cliente por defecto: mismo origen, prefijo /api. */
export const api: ApiClient = createApiClient();
