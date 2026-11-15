// Esquemas zod del JSON de docs/contrato-cubo.md (version 1), secciones 2, 4 y 5.
// Los nombres de los campos son los del contrato, en snake_case.
//
// Criterios:
// - Las claves que el contrato no nombra se descartan sin error (z.object), para
//   que el backend pueda sumar campos sin romper el frontend.
// - Lo que el backend manda siempre es obligatorio y tiene una sola forma, la de
//   sus modelos (backend/app/contract.py). Una desviacion tiene que fallar aca en
//   vez de pasar, y los tipos inferidos no obligan a manejar ausencias que no
//   ocurren.
// - Lo que el contrato dice que "no trae" en ciertos estados se acepta ausente
//   o en null y se entrega como undefined (ver `absent`).
// - Los null con significado propio (cube_offset, motion, name) quedan en null.
// - Los numeros son finitos: el JSON no transporta NaN ni infinito. Los pixeles
//   NaN e +Infinity viajan solo en los binarios (seccion 6).

import { z } from "zod";

/**
 * Campo que el contrato describe como ausente en ciertos estados. Se acepta
 * tambien null, que es lo que emite pydantic si no excluye los None, y se
 * normaliza a undefined para que el resto del codigo compruebe una sola cosa.
 */
function absent<T extends z.ZodType>(schema: T) {
  return schema
    .nullish()
    .transform((value) => value ?? undefined)
    .optional();
}

/** Campo que vale null cuando no hay dato; si falta, tambien queda en null. */
function nullable<T extends z.ZodType>(schema: T) {
  return schema.nullish().transform((value) => value ?? null);
}

/** Lista que puede faltar o venir en null: se entrega vacia. */
function listOrEmpty<T extends z.ZodType>(item: T) {
  return z
    .array(item)
    .nullish()
    .transform((items) => items ?? []);
}

/** Texto que puede faltar o venir en null: se entrega vacio. */
const textOrEmpty = z
  .string()
  .nullish()
  .transform((text) => text ?? "");

/** Booleano que puede faltar o venir en null: se entrega en false. */
const flagOrFalse = z
  .boolean()
  .nullish()
  .transform((flag) => flag ?? false);

const count = z.number().int().nonnegative();

// ---- Seccion 2: convenciones --------------------------------------------

/** Detector de SPHEREx, de 1 a 6. La interfaz lo muestra como B1 a B6. */
export const detectorNumberSchema = z.number().int().min(1).max(6);

/** Epoca, de 1 a N en orden temporal. */
export const epochNumberSchema = z.number().int().min(1);

/** Fecha como texto ISO "AAAA-MM-DD". */
const isoDateSchema = z.iso.date();

/**
 * Instante UTC como texto ISO 8601. El contrato lo escribe con "Z"; se acepta
 * tambien con desplazamiento ("+00:00") o sin zona, que es como lo deja Python
 * segun como se arme la fecha.
 */
const isoDateTimeSchema = z.iso.datetime({ offset: true, local: true });

export const errorCodeSchema = z.enum([
  "invalid_request",
  "not_resolved",
  "not_found",
  "not_ready",
  "no_coverage",
  "queue_full",
  "upstream_unavailable",
]);

/** Objeto de error. `message` es para el log; el texto visible sale de `code`. */
export const errorObjectSchema = z.object({
  code: errorCodeSchema,
  message: textOrEmpty,
  retryable: flagOrFalse,
});

/** Cuerpo de una respuesta de error: {"error": {...}}. */
export const errorBodySchema = z.object({
  error: errorObjectSchema,
});

// ---- Seccion 5: documento de metadatos ----------------------------------

export const fieldStatusSchema = z.enum([
  "queued",
  "listing",
  "downloading",
  "ready",
  "partial",
  "failed",
]);

/** Pedido ya normalizado por el backend. */
export const normalizedRequestSchema = z.object({
  ra: z.number().min(0).max(360),
  dec: z.number().min(-90).max(90),
  fov: z.number().positive(),
});

/** Grilla de salida: WCS con las convenciones de FITS y forma [ny, nx]. */
export const gridSchema = z.object({
  projection: z.literal("TAN"),
  crval: z.tuple([z.number(), z.number()]),
  crpix: z.tuple([z.number(), z.number()]),
  cdelt: z.tuple([z.number(), z.number()]),
  shape: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  fov: z.number().positive(),
  pixel_scale_arcsec: z.number().positive(),
  native_pixel_scale_arcsec: z.number().positive(),
});

/** Escala de contraste: el control se mueve entre vmin y vmax. */
export const displaySchema = z.object({
  vmin: z.number(),
  vmax: z.number(),
  median: z.number(),
  sigma: z.number(),
});

/** Escala de un detector, como llega en el evento `plane`. */
export const detectorDisplaySchema = displaySchema.extend({
  detector: detectorNumberSchema,
});

export const detectorSchema = z.object({
  detector: detectorNumberSchema,
  wave_min_um: z.number().positive(),
  wave_max_um: z.number().positive(),
  /** Ausente hasta que el detector tiene algun plano listo. */
  display: absent(displaySchema),
});

export const epochSchema = z.object({
  epoch: epochNumberSchema,
  start: isoDateSchema,
  end: isoDateSchema,
  mjd_start: z.number(),
  mjd_end: z.number(),
  mjd_mean: z.number(),
  n_exposures: count,
});

export const planeStatusSchema = z.enum(["pending", "building", "ready", "partial", "empty"]);

/** Estadisticas sobre los pixeles finitos del plano. */
export const planeStatsSchema = z.object({
  min: z.number(),
  max: z.number(),
  median: z.number(),
  sigma: z.number(),
  p01: z.number(),
  p99: z.number(),
  p997: z.number(),
  valid_fraction: z.number().min(0).max(1),
  saturated_fraction: z.number().min(0).max(1),
});

/** Region saturada: centro en pixeles desde 0, radio equivalente y cantidad de pixeles. */
export const saturatedRegionSchema = z.object({
  x: z.number(),
  y: z.number(),
  radius_px: z.number().nonnegative(),
  n_pixels: count,
});

export const planeSchema = z.object({
  epoch: epochNumberSchema,
  detector: detectorNumberSchema,
  status: planeStatusSchema,
  rev: count,
  n_exposures: count,
  n_used: count,
  n_failed: count,
  /** null mientras el plano no tiene exposiciones usadas (pending, empty). */
  mjd_mean: nullable(z.number()),
  /** null mientras el plano no tiene pixeles (pending, empty). */
  stats: nullable(planeStatsSchema),
  saturated: listOrEmpty(saturatedRegionSchema),
  /** null mientras el trabajo no termina y en planos `empty`. */
  cube_offset: nullable(count),
});

export const flagSchema = z.object({
  bit: z.number().int().min(0).max(31),
  name: z.string().min(1),
  description: textOrEmpty,
  masked: z.boolean(),
  saturation: z.boolean(),
});

export const progressPhaseSchema = z.enum([
  "queued",
  "listing",
  "downloading",
  "finishing",
  "done",
]);

/**
 * Avance. El backend manda siempre todos los contadores, en cero mientras no
 * aplican, asi que al salir de aca son numeros y no hay ausencias que manejar.
 *
 * Los ejemplos de la seccion 4.2 omiten algunos (`queue_position` en el evento
 * `progress`, el resto en el `state` de un trabajo en cola): un contador que
 * falta vale 0, igual que en el modelo del backend. null no se acepta.
 */
export const progressSchema = z.object({
  phase: progressPhaseSchema,
  queue_position: count.default(0),
  cutouts_total: count.default(0),
  cutouts_done: count.default(0),
  cutouts_failed: count.default(0),
  cutouts_cached: count.default(0),
  planes_total: count.default(0),
  planes_ready: count.default(0),
  elapsed_s: z.number().nonnegative().default(0),
});

/**
 * Referencia a un plano dentro de un aviso (`cutouts_failed.planes`). La tabla
 * de avisos del contrato no dice que forma tiene; el backend manda objetos
 * {epoch, detector} y es la unica que se acepta.
 */
export const planeRefSchema = z.object({
  epoch: epochNumberSchema,
  detector: detectorNumberSchema,
});

/** Avisos de calidad: union discriminada por `code`. La frase la arma el frontend. */
export const warningSchema = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("saturated_source"),
    ra: z.number(),
    dec: z.number(),
    radius_arcsec: z.number().nonnegative(),
    epochs: z.array(epochNumberSchema),
    detectors: z.array(detectorNumberSchema),
  }),
  z.object({
    code: z.literal("plane_empty"),
    epoch: epochNumberSchema,
    detector: detectorNumberSchema,
  }),
  z.object({
    code: z.literal("few_exposures"),
    epoch: epochNumberSchema,
    detector: detectorNumberSchema,
    n: count,
  }),
  z.object({
    code: z.literal("low_coverage"),
    epoch: epochNumberSchema,
    detector: detectorNumberSchema,
    valid_fraction: z.number().min(0).max(1),
  }),
  z.object({
    code: z.literal("cutouts_failed"),
    n: count,
    planes: z.array(planeRefSchema),
  }),
  z.object({
    code: z.literal("stale_exposure_list"),
    listed_at: isoDateTimeSchema,
  }),
  z.object({
    code: z.literal("full_download"),
    reason: z.string(),
  }),
]);

export const previewStatusSchema = z.enum(["pending", "ready", "unavailable"]);

/** Banda de WISE de la vista provisoria: W1 (3,4 um), o W2 (4,6 um) si se pidio la banda 5 o 6. */
export const previewBandSchema = z.enum(["W1", "W2"]);

/**
 * Vista provisoria de WISE (seccion 4.10). El relevamiento y la banda estan
 * desde el primer `state`, porque la vista se rotula con ellos (seccion 8).
 * Solo `display` puede faltar: no hay escala hasta que `status` es `ready`.
 */
export const previewSchema = z.object({
  status: previewStatusSchema,
  survey: z.string().min(1),
  band: previewBandSchema,
  wave_um: z.number().positive(),
  hips: z.string(),
  display: absent(displaySchema),
});

export const downloadModeSchema = z.enum(["truncated", "full", "mixed"]);

/** Origen de los datos. `download_mode` y `built_at` faltan hasta que se conocen. */
export const provenanceSchema = z.object({
  source: z.string(),
  collections: z.array(z.string()),
  listed_at: isoDateTimeSchema,
  list_stale: flagOrFalse,
  download_mode: absent(downloadModeSchema),
  built_at: absent(isoDateTimeSchema),
});

/**
 * Documento de metadatos. Es el mismo objeto en POST /api/field, en
 * GET .../meta y en los eventos `state` y `listed`.
 *
 * `id`, `pipeline`, `status`, `rev`, `request`, `progress`, `warnings` y
 * `preview` estan siempre, tambien en un trabajo que recien entra en la cola
 * (seccion 5: `preview` "esta presente desde el primer `state`"). Antes de
 * `listed` no trae grid, detectors, epochs, planes, flags ni provenance.
 */
export const fieldMetaSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/),
  pipeline: z.string().min(1),
  status: fieldStatusSchema,
  /** Vale 0 hasta que el trabajo termina. */
  rev: count.nullish().transform((rev) => rev ?? 0),
  request: normalizedRequestSchema,
  grid: absent(gridSchema),
  detectors: absent(z.array(detectorSchema)),
  epochs: absent(z.array(epochSchema)),
  planes: absent(z.array(planeSchema)),
  flags: absent(z.array(flagSchema)),
  progress: progressSchema,
  warnings: listOrEmpty(warningSchema),
  preview: previewSchema,
  provenance: absent(provenanceSchema),
});

// ---- Seccion 4.1: POST /api/field ---------------------------------------

/** Cuerpo de POST /api/field. */
export const fieldRequestSchema = z.object({
  ra: z.number(),
  dec: z.number().min(-90).max(90),
  fov: z.number().min(0.02).max(0.5).optional(),
  band: detectorNumberSchema.optional(),
  refresh: z.boolean().optional(),
});

/** Respuesta de POST /api/field: 200 si el campo esta terminado, 202 si no. */
export const fieldResponseSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/),
  status: fieldStatusSchema,
  events_url: z.string().min(1),
  meta: fieldMetaSchema,
});

// ---- Seccion 4.7: POST /api/field/{id}/priority -------------------------

export const priorityRequestSchema = z.object({
  band: detectorNumberSchema,
});

// ---- Seccion 4.2: datos de cada evento SSE ------------------------------

export const queuedEventSchema = z.object({
  position: count,
});

export const planeEventSchema = z.object({
  plane: planeSchema,
  /** Ausente si el plano quedo sin pixeles y el detector todavia no tiene escala. */
  detector_display: absent(detectorDisplaySchema),
});

export const doneEventSchema = z.object({
  status: z.enum(["ready", "partial"]),
  rev: count,
  elapsed_s: z.number().nonnegative(),
});

/**
 * Evento `error`. El contrato dice "objeto de error (seccion 2)" y el backend
 * manda el cuerpo completo de esa seccion, {"error": {...}}: es la unica forma
 * que se acepta. Se entrega el objeto de adentro; uno suelto, sin la clave
 * `error`, se rechaza.
 */
export const errorEventSchema = errorBodySchema.transform((body) => body.error);

/** Esquema de `data` para cada nombre de evento. */
export const fieldEventSchemas = {
  state: fieldMetaSchema,
  queued: queuedEventSchema,
  preview: previewSchema,
  listed: fieldMetaSchema,
  progress: progressSchema,
  plane: planeEventSchema,
  warning: warningSchema,
  done: doneEventSchema,
  error: errorEventSchema,
} as const;

// ---- Seccion 4.8: GET /api/resolve --------------------------------------

export const skyPositionSchema = z.object({
  ra: z.number(),
  dec: z.number(),
});

/** Movimiento propio en mas/anio (pm_ra incluye cos(dec)), paralaje en mas y velocidad radial en km/s. */
export const motionSchema = z.object({
  pm_ra: z.number(),
  pm_dec: z.number(),
  parallax: nullable(z.number()),
  radial_velocity: nullable(z.number()),
  per_year_arcsec: z.number().nonnegative(),
});

export const resolveResponseSchema = z.object({
  query: z.string(),
  /** null cuando el texto buscado eran coordenadas. */
  name: nullable(z.string()),
  source: z.enum(["sesame", "coordinates"]),
  object_type: nullable(z.string()),
  /** Posicion de catalogo, en la epoca 2000,0. */
  j2000: skyPositionSchema,
  /** null si el catalogo no trae movimiento propio. */
  motion: nullable(motionSchema),
  /** Donde centrar el campo: la posicion propagada a una epoca fija. */
  field_center: skyPositionSchema.extend({ epoch: z.number() }),
  moved_arcsec: z.number().nonnegative(),
});

// ---- Seccion 4.9: GET /api/field/{id}/track -----------------------------

export const trackPositionSchema = z.object({
  epoch: epochNumberSchema,
  mjd: z.number(),
  ra: z.number(),
  dec: z.number(),
  x: z.number(),
  y: z.number(),
  in_field: z.boolean(),
});

/** `positions` viene vacio si el objeto no tiene movimiento propio. */
export const trackResponseSchema = z.object({
  name: z.string(),
  positions: z.array(trackPositionSchema),
});
