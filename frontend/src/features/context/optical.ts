// Capa optica: placas del Digitized Sky Survey en la grilla del campo
// (backend/app/context/optical.py y api_optical.py).
//
//   GET /api/context/optical?ra=&dec=&fov=          documento de capas opticas
//   GET /api/survey/optical?ra=&dec=&fov=&layer=    una capa en Float32
//
// Sirve para dos cosas: una parada mas antigua en el viaje entre misiones
// (`opticalFrames`) y el lado visible de la cortina visible/infrarrojo
// (`Curtain`).
//
// Va en su propio archivo, con su esquema y su cliente, porque `schema.ts`,
// `contextApi.ts` y `journey.ts` ya existen y esta etapa solo agrega archivos.
// Al integrar se pueden juntar: ver la nota de `opticalFrame`.

import { z } from "zod";
import { type GridShape, planeByteLength, planeView } from "@/api/binary";
import { API_BASE, type FetchLike, type RequestOptions } from "@/api/client";
import { ApiError, errorFromResponse, networkError } from "@/api/errors";
import { displaySchema, gridSchema } from "@/api/schema";
import type { FieldGeometry } from "./contextApi";
import type { JourneyFrame, Mission } from "./journey";
import { layerTargetSchema } from "./schema";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Una placa del Digitized Sky Survey reproyectada a la grilla del campo. */
export const opticalLayerSchema = z.object({
  key: z.string().min(1),
  survey: z.literal("DSS"),
  generation: z.enum(["DSS1", "DSS2"]),
  /** "R", "Bj", "V": la banda que da la emulsion de la placa. */
  band: z.string().min(1),
  /** Longitud de onda aproximada, en micrometros. */
  wave_um: z.number().positive(),
  file: z.string(),
  mjd: z.number(),
  date: isoDate,
  year: z.number(),
  unit: z.string(),
  native_pixel_scale_arcsec: z.number().positive(),
  display: displaySchema.nullable(),
  valid_fraction: z.number(),
  /** Numero de placa y relevamiento al que pertenece: "SF04022", "POSSII-F". */
  plate: z.string(),
  plate_survey: z.string(),
  telescope: z.string(),
  emulsion: z.string(),
  filter: z.string(),
  exposure_min: z.number().nullable(),
  /** Titular de los derechos de la placa: hay que mostrarlo junto a la imagen. */
  copyright: z.string(),
  url: z.string(),
  /** Falso si la fecha del encabezado es imposible: la imagen sirve, la fecha no. */
  date_reliable: z.boolean(),
  target: layerTargetSchema.nullish().transform((value) => value ?? null),
});

export const opticalDocumentSchema = z.object({
  version: z.number().int(),
  key: z.string(),
  grid: gridSchema,
  layers: z.array(opticalLayerSchema),
  generated_at: z.string(),
});

export type OpticalLayer = z.infer<typeof opticalLayerSchema>;
export type OpticalDocument = z.infer<typeof opticalDocumentSchema>;

// ---- Cliente -----------------------------------------------------------------

export interface OpticalApi {
  /** Capas opticas guardadas del campo. `not_found` si no tiene ninguna. */
  getOptical(field: FieldGeometry, options?: RequestOptions): Promise<OpticalDocument>;
  /** Una capa, con el formato de un plano: fila 0 = sur, NaN sin datos. */
  getLayer(
    field: FieldGeometry,
    layer: string,
    shape: GridShape,
    options?: RequestOptions,
  ): Promise<Float32Array>;
}

function query(field: FieldGeometry, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ ra: String(field.ra), dec: String(field.dec) });
  if (field.fov !== undefined) params.set("fov", String(field.fov));
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return params.toString();
}

export function createOpticalApi(config: { baseUrl?: string; fetch?: FetchLike } = {}): OpticalApi {
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

  function invalid(response: Response, message: string, cause?: unknown): ApiError {
    return new ApiError({
      code: "invalid_response",
      status: response.status,
      retryable: false,
      message,
      cause,
    });
  }

  return {
    async getOptical(field, options) {
      const path = `/context/optical?${query(field)}`;
      const response = await send(path, "application/json", options);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (cause) {
        throw invalid(response, `${path}: la respuesta no es JSON`, cause);
      }
      const parsed = opticalDocumentSchema.safeParse(payload);
      if (!parsed.success) {
        throw invalid(response, `${path}: no cumple el formato de la capa optica`, parsed.error);
      }
      return parsed.data;
    },
    async getLayer(field, layer, shape, options) {
      const path = `/survey/optical?${query(field, { layer })}`;
      const response = await send(path, "application/octet-stream", options);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== planeByteLength(shape)) {
        throw invalid(
          response,
          `${path}: la capa mide ${buffer.byteLength} bytes y la grilla pide ${planeByteLength(shape)}`,
        );
      }
      return planeView(buffer, shape);
    },
  };
}

export const opticalApi: OpticalApi = createOpticalApi();

// ---- Viaje entre misiones ----------------------------------------------------

/** Nombre de la mision con el que las placas aparecen en el viaje. */
export const DSS_MISSION = "DSS";

/**
 * Cuadro del viaje para una placa del DSS. `values` es null si todavia no se bajo.
 *
 * `JourneyFrame.mission` esta tipado como "2MASS" | "WISE" | "SPHEREx" en
 * journey.ts, que esta etapa no toca: por eso el nombre "DSS" entra con una
 * conversion de tipo. En ejecucion no cambia nada, porque `MissionJourney`
 * solo usa `mission` como texto y para agrupar marcas vecinas. Al integrar:
 * sumar "DSS" a `MISSIONS` en journey.ts y quitar la conversion.
 *
 * La posicion esperada del objeto solo se informa si cae dentro del campo: una
 * estrella rapida puede haber estado afuera (Barnard, en 1950 y en 1991).
 */
export function opticalFrame(
  layer: OpticalLayer,
  shape: GridShape,
  values: Float32Array | null,
): JourneyFrame {
  return {
    id: layer.key,
    mission: DSS_MISSION as Mission,
    band: layer.band,
    waveUm: [layer.wave_um],
    mjd: layer.mjd,
    year: layer.year,
    date: layer.date,
    dateStart: layer.date,
    dateEnd: layer.date,
    image:
      values !== null && layer.display !== null ? { values, shape, display: layer.display } : null,
    target: layer.target?.in_field ? { x: layer.target.x, y: layer.target.y } : null,
  };
}

/**
 * Las capas que pueden ser una parada del viaje: las que tienen una fecha de
 * fiar, de la mas antigua a la mas nueva. Una placa con fecha imposible en su
 * encabezado no se puede ubicar en el tiempo.
 */
export function journeyLayers(document: OpticalDocument): OpticalLayer[] {
  return document.layers
    .filter((layer) => layer.date_reliable)
    .sort((a, b) => a.mjd - b.mjd || a.key.localeCompare(b.key));
}

/**
 * La capa que hace de lado visible en la cortina: la de segunda generacion en
 * rojo (mas profunda y con mejor resolucion) y, si el campo no la tiene, la
 * mas nueva que haya. Aca no importa la fecha. null si no hay ninguna.
 */
export function curtainLayer(document: OpticalDocument): OpticalLayer | null {
  const second = document.layers.find((layer) => layer.generation === "DSS2");
  if (second !== undefined) return second;
  return [...document.layers].sort((a, b) => b.mjd - a.mjd)[0] ?? null;
}

/** True si el objeto del campo tenia posicion en la fecha de la placa y caia fuera del campo. */
export function targetOutsideField(layer: OpticalLayer): boolean {
  return layer.target !== null && !layer.target.in_field;
}

/** Credito de una placa, con sus datos tal como vienen: "SF04022", "POSSII-F", "Caltech/Palomar". */
export interface PlateCredit {
  readonly plate: string;
  readonly survey: string;
  readonly owner: string;
}

export function plateCredit(layer: OpticalLayer): PlateCredit {
  return { plate: layer.plate, survey: layer.plate_survey, owner: layer.copyright };
}
