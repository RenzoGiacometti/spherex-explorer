// Documento de la curva de luz que devuelve GET /api/lightcurve
// (backend/app/lightcurve/service.py).
//
// Claves en snake_case, como el contrato del cubo. Los valores de la curva son
// relativos y sin unidad: 1 es el brillo tipico del periodo observado. Fechas
// como MJD (UTC) y texto ISO. El JSON se valida antes de usarlo.

import { z } from "zod";

const curvePointSchema = z.object({
  mjd: z.number(),
  date: z.string(),
  epoch: z.number().int(),
  value: z.number(),
  error: z.number(),
});

const pointSchema = curvePointSchema.extend({
  wavelength_um: z.number(),
  channel: z.number().int(),
});

const binSchema = curvePointSchema.extend({ n: z.number().int() });

const seriesSchema = z.object({
  detector: z.number().int(),
  method: z.enum(["aperture", "wings"]),
  /** La serie que hay que mostrar para ese detector. */
  preferred: z.boolean(),
  status: z.enum(["ok", "insufficient", "unstable", "blended"]),
  /** Las alas solo dan variacion relativa: no hay flujo absoluto detras. */
  relative_only: z.boolean(),
  wave_min_um: z.number(),
  wave_max_um: z.number(),
  reference_mjy: z.number().nullable(),
  annulus: z
    .object({
      inner_px: z.number(),
      outer_px: z.number(),
      sky_inner_px: z.number(),
      sky_outer_px: z.number(),
    })
    .nullable(),
  n_exposures: z.number().int(),
  n_measured: z.number().int(),
  n_points: z.number().int(),
  n_channels: z.number().int(),
  rejected: z.record(z.string(), z.number()),
  scatter: z
    .object({
      points: z.number().nullable(),
      residual: z.number().nullable(),
      formal: z.number().nullable(),
      excess: z.number().nullable(),
    })
    .nullable(),
  control: z
    .object({
      name: z.string(),
      validated: z.boolean(),
      epoch_floor: z.number(),
      point_floor: z.number(),
    })
    .nullable(),
  variability: z
    .object({
      verdict: z.enum(["variable", "marginal", "constant"]),
      amplitude: z.number(),
      amplitude_error: z.number(),
      significance: z.number(),
      brightest_epoch: z.number().int(),
      faintest_epoch: z.number().int(),
    })
    .nullable(),
  offset_arcsec: z.number().optional(),
  /** Brillo relativo de cada pasada del relevamiento. */
  epochs: z.array(binSchema),
  /** Las medidas agrupadas en tandas de pocos dias. */
  bins: z.array(binSchema),
  /** Cada exposicion. */
  points: z.array(pointSchema),
});

const epochSchema = z.object({
  epoch: z.number().int(),
  start: z.string(),
  end: z.string(),
  mjd_start: z.number(),
  mjd_end: z.number(),
  mjd_mean: z.number(),
  n_exposures: z.number().int(),
});

// Un aviso lleva `code` y los parametros de ese codigo. Los codigos que esta
// interfaz no conoce pasan igual y se ignoran al mostrarlos.
const warningSchema = z.object({
  code: z.string(),
  detectors: z.array(z.number().int()).optional(),
  scatter: z.number().optional(),
  offset_arcsec: z.number().optional(),
});

export const lightcurveSchema = z.object({
  version: z.number().int(),
  status: z.enum(["ok", "empty"]),
  source: z.enum(["precomputed", "computed"]).optional(),
  variability: z.object({
    verdict: z.enum(["variable", "marginal", "constant", "undetermined"]),
    detectors: z.array(z.number().int()),
    marginal_detectors: z.array(z.number().int()),
    amplitude: z.number().nullable(),
  }),
  target: z.object({
    name: z.string().nullable(),
    ra: z.number(),
    dec: z.number(),
    epoch: z.number(),
    motion: z
      .object({
        pm_ra: z.number().nullable(),
        pm_dec: z.number().nullable(),
        parallax: z.number().nullable(),
      })
      .nullable(),
    track: z.array(
      z.object({ epoch: z.number().int(), mjd: z.number(), ra: z.number(), dec: z.number() }),
    ),
  }),
  field: z.string().nullable(),
  epochs: z.array(epochSchema),
  series: z.array(seriesSchema),
  warnings: z.array(warningSchema),
  provenance: z.object({
    source: z.string(),
    n_exposures: z.number().int(),
    n_unreadable: z.number().int(),
    processing: z.array(z.string()),
    channels_per_detector: z.number().int().optional(),
    computed_at: z.string().optional(),
  }),
});

export type LightcurveDocument = z.infer<typeof lightcurveSchema>;
export type LightcurveSeries = z.infer<typeof seriesSchema>;
export type LightcurvePoint = z.infer<typeof pointSchema>;
export type LightcurveBin = z.infer<typeof binSchema>;
export type LightcurveEpoch = z.infer<typeof epochSchema>;
export type LightcurveWarning = z.infer<typeof warningSchema>;
export type LightcurveMethod = LightcurveSeries["method"];
export type LightcurveVerdict = LightcurveDocument["variability"]["verdict"];

/** Valida un documento de curva de luz. Lanza `ZodError` si no cumple el formato. */
export function parseLightcurve(value: unknown): LightcurveDocument {
  return lightcurveSchema.parse(value);
}

/** Series de un detector, la preferida primero. */
export function seriesOf(document: LightcurveDocument, detector: number): LightcurveSeries[] {
  return document.series
    .filter((series) => series.detector === detector)
    .sort((a, b) => Number(b.preferred) - Number(a.preferred));
}

/** Detectores con alguna serie, en orden. */
export function detectorsOf(document: LightcurveDocument): number[] {
  return [...new Set(document.series.map((series) => series.detector))].sort((a, b) => a - b);
}
