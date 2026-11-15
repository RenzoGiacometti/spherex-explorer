// Cliente de las rutas de contexto del backend (backend/app/context/api.py):
//
//   GET /api/context?ra=&dec=&fov=            documento de contexto
//   GET /api/context/gaia?ra=&dec=&fov=       fuentes de Gaia DR3, por columnas
//   GET /api/context/index                    campos con contexto guardado
//   GET /api/survey?ra=&dec=&fov=&layer=      una capa en Float32
//
// Mismas reglas que src/api/client.ts: el JSON se valida antes de entregarlo,
// un binario de otro tamano se rechaza y todo fallo sale como ApiError con
// `code`. Un campo sin contexto guardado responde `not_found`.

import type { z } from "zod";
import { type GridShape, planeByteLength, planeView } from "@/api/binary";
import { API_BASE, type FetchLike, type RequestOptions } from "@/api/client";
import { ApiError, errorFromResponse, networkError } from "@/api/errors";
import {
  type ContextDocument,
  type ContextIndex,
  contextDocumentSchema,
  contextIndexSchema,
  type GaiaCatalog,
  gaiaCatalogSchema,
} from "./schema";

/** Geometria de un campo, con los mismos valores que se le mandan a `POST /api/field`. */
export interface FieldGeometry {
  readonly ra: number;
  readonly dec: number;
  readonly fov?: number | undefined;
}

export interface ContextApi {
  getContext(field: FieldGeometry, options?: RequestOptions): Promise<ContextDocument>;
  getGaia(field: FieldGeometry, options?: RequestOptions): Promise<GaiaCatalog>;
  getIndex(options?: RequestOptions): Promise<ContextIndex>;
  /** Una capa de otra mision, con el formato de un plano: fila 0 = sur, NaN sin datos. */
  getLayer(
    field: FieldGeometry,
    layer: string,
    shape: GridShape,
    options?: RequestOptions,
  ): Promise<Float32Array>;
}

export interface ContextApiConfig {
  baseUrl?: string;
  fetch?: FetchLike;
}

function query(field: FieldGeometry, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ ra: String(field.ra), dec: String(field.dec) });
  if (field.fov !== undefined) params.set("fov", String(field.fov));
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return params.toString();
}

export function createContextApi(config: ContextApiConfig = {}): ContextApi {
  const baseUrl = config.baseUrl ?? API_BASE;
  const doFetch: FetchLike = config.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function send(path: string, accept: string, options?: RequestOptions): Promise<Response> {
    const init: RequestInit = { headers: { Accept: accept } };
    if (options?.signal) init.signal = options.signal;
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, init);
    } catch (cause) {
      throw networkError(cause, path);
    }
    if (!response.ok) throw await errorFromResponse(response);
    return response;
  }

  async function getJson<Schema extends z.ZodType>(
    path: string,
    schema: Schema,
    options?: RequestOptions,
  ): Promise<z.infer<Schema>> {
    const response = await send(path, "application/json", options);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new ApiError({
        code: "invalid_response",
        status: response.status,
        retryable: false,
        message: `${path}: la respuesta no es JSON`,
        cause,
      });
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError({
        code: "invalid_response",
        status: response.status,
        retryable: false,
        message: `${path}: la respuesta no cumple el formato del contexto`,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  return {
    getContext: (field, options) =>
      getJson(`/context?${query(field)}`, contextDocumentSchema, options),
    getGaia: (field, options) =>
      getJson(`/context/gaia?${query(field)}`, gaiaCatalogSchema, options),
    getIndex: (options) => getJson("/context/index", contextIndexSchema, options),
    async getLayer(field, layer, shape, options) {
      const path = `/survey?${query(field, { layer })}`;
      const response = await send(path, "application/octet-stream", options);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== planeByteLength(shape)) {
        throw new ApiError({
          code: "invalid_response",
          status: response.status,
          retryable: false,
          message: `${path}: la capa mide ${buffer.byteLength} bytes y la grilla pide ${planeByteLength(shape)}`,
        });
      }
      return planeView(buffer, shape);
    },
  };
}

export const contextApi: ContextApi = createContextApi();
