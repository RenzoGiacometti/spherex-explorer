// Esquemas del contexto de un campo (backend/app/context/store.py): el
// documento de contexto y el catalogo de Gaia por columnas.

import { z } from "zod";
import { displaySchema, gridSchema } from "@/api/schema";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const layerTargetSchema = z.object({
  ra: z.number(),
  dec: z.number(),
  x: z.number(),
  y: z.number(),
  in_field: z.boolean(),
});

export const layerImageSchema = z.object({
  obs_id: z.string(),
  url: z.string(),
  mjd: z.number(),
  date: isoDate,
  coverage: z.number(),
});

export const surveyNameSchema = z.enum(["2MASS", "WISE"]);

/** Un recorte de otra mision, reproyectado a la grilla del campo. */
export const surveyLayerSchema = z.object({
  key: z.string().min(1),
  survey: surveyNameSchema,
  band: z.string().min(1),
  wave_um: z.number().positive(),
  file: z.string(),
  mjd: z.number(),
  date: isoDate,
  year: z.number(),
  mjd_start: z.number(),
  mjd_end: z.number(),
  date_start: isoDate,
  date_end: isoDate,
  unit: z.string(),
  native_pixel_scale_arcsec: z.number().positive(),
  display: displaySchema.nullable(),
  valid_fraction: z.number(),
  collection: z.string(),
  images: z.array(layerImageSchema),
  target: layerTargetSchema.nullish().transform((value) => value ?? null),
});

export const gaiaInfoSchema = z.object({
  file: z.string(),
  catalog: z.string(),
  ref_epoch: z.number(),
  n_sources: z.number().int().nonnegative(),
  radius_arcsec: z.number().positive(),
  g_mag_min: z.number().nullable(),
  g_mag_max: z.number().nullable(),
});

export const contextObjectSchema = z.object({
  alias: z.string(),
  query: z.string(),
  name: z.string().nullable(),
});

export const contextDocumentSchema = z.object({
  version: z.number().int(),
  key: z.string(),
  field_id: z.string(),
  pipeline: z.string(),
  object: contextObjectSchema.nullable(),
  request: z.object({ ra: z.number(), dec: z.number(), fov: z.number() }),
  grid: gridSchema,
  surveys: z.array(surveyLayerSchema),
  gaia: gaiaInfoSchema.nullable(),
  generated_at: z.string(),
});

const nullableNumbers = z.array(z.number().nullable());

/** Fuentes de Gaia por columnas: la fuente `i` es el elemento `i` de cada lista. */
export const gaiaCatalogSchema = z
  .object({
    catalog: z.string(),
    ref_epoch: z.number(),
    count: z.number().int().nonnegative(),
    source_id: z.array(z.string()),
    ra: z.array(z.number()),
    dec: z.array(z.number()),
    pmra: nullableNumbers,
    pmdec: nullableNumbers,
    parallax: nullableNumbers,
    g_mag: nullableNumbers,
  })
  .refine(
    (catalog) =>
      [
        catalog.source_id,
        catalog.ra,
        catalog.dec,
        catalog.pmra,
        catalog.pmdec,
        catalog.parallax,
        catalog.g_mag,
      ].every((column) => column.length === catalog.count),
    { message: "las columnas no miden lo mismo que `count`" },
  );

export const contextIndexSchema = z.object({
  version: z.number().int(),
  fields: z.array(
    z.object({
      key: z.string(),
      field_id: z.string(),
      alias: z.string().nullable(),
      name: z.string().nullable(),
      ra: z.number(),
      dec: z.number(),
      fov: z.number(),
      layers: z.array(z.string()),
      gaia_sources: z.number().int().nonnegative(),
    }),
  ),
});

export type LayerTarget = z.infer<typeof layerTargetSchema>;
export type SurveyName = z.infer<typeof surveyNameSchema>;
export type SurveyLayer = z.infer<typeof surveyLayerSchema>;
export type GaiaInfo = z.infer<typeof gaiaInfoSchema>;
export type ContextDocument = z.infer<typeof contextDocumentSchema>;
export type GaiaCatalog = z.infer<typeof gaiaCatalogSchema>;
export type ContextIndex = z.infer<typeof contextIndexSchema>;
