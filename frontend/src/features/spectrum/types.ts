// Documento del espectro que devuelve GET /api/spectrum (backend/app/spectrum/service.py).
//
// Claves en snake_case, como el contrato del cubo. Longitudes de onda en
// micrometros, flujos en mJy, fechas como MJD (UTC) y texto ISO. El JSON se
// valida antes de usarlo: `parseSpectrum` lanza si no cumple el formato.

import { z } from "zod";

const pointSchema = z.object({
  wavelength_um: z.number(),
  bandwidth_um: z.number(),
  flux_mjy: z.number(),
  error_mjy: z.number(),
  mjd: z.number(),
  date: z.string(),
  epoch: z.number().int(),
  detector: z.number().int(),
  flags: z.array(z.string()),
  exposure: z.string(),
});

const binSchema = z.object({
  wavelength_um: z.number(),
  wave_min_um: z.number(),
  wave_max_um: z.number(),
  flux_mjy: z.number(),
  error_mjy: z.number(),
  n: z.number().int(),
  detector: z.number().int(),
});

const detectorSchema = z.object({
  detector: z.number().int(),
  wave_min_um: z.number(),
  wave_max_um: z.number(),
  n_exposures: z.number().int(),
  n_points: z.number().int(),
  n_saturated: z.number().int(),
  n_masked: z.number().int(),
  n_edge: z.number().int(),
  offset_arcsec: z.object({ east: z.number(), north: z.number(), total: z.number() }).nullable(),
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
  epochs: z.array(z.number().int()).optional(),
  n_exposures: z.number().optional(),
  n_total: z.number().optional(),
  offset_arcsec: z.number().optional(),
});

const range = z.tuple([z.number(), z.number()]);

export const spectrumSchema = z.object({
  version: z.number().int(),
  status: z.enum(["ok", "partial", "saturated", "empty"]),
  source: z.enum(["precomputed", "computed"]).optional(),
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
  units: z.object({ wavelength: z.string(), flux: z.string() }),
  aperture: z.object({
    radius_px: z.number(),
    radius_arcsec: z.number(),
    annulus_in_px: z.number(),
    annulus_out_px: z.number(),
    correction: z.string(),
    psf_fwhm_arcsec: range.nullable(),
    enclosed_fraction_gaussian: range.nullable(),
  }),
  epochs: z.array(epochSchema),
  detectors: z.array(detectorSchema),
  points: z.array(pointSchema),
  binned: z.array(binSchema),
  warnings: z.array(warningSchema),
  provenance: z.object({
    source: z.string(),
    n_exposures: z.number().int(),
    n_points: z.number().int(),
    n_unreadable: z.number().int(),
    processing: z.array(z.string()),
    wave_table: z.string().nullable(),
    computed_at: z.string().optional(),
  }),
});

export type SpectrumDocument = z.infer<typeof spectrumSchema>;
export type SpectrumPoint = z.infer<typeof pointSchema>;
export type SpectrumBin = z.infer<typeof binSchema>;
export type SpectrumDetector = z.infer<typeof detectorSchema>;
export type SpectrumWarning = z.infer<typeof warningSchema>;
export type SpectrumStatus = SpectrumDocument["status"];

/** Valida un documento de espectro. Lanza `ZodError` si no cumple el formato. */
export function parseSpectrum(value: unknown): SpectrumDocument {
  return spectrumSchema.parse(value);
}
