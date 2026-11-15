// Ejemplos de docs/contrato-cubo.md copiados a mano, para los tests del frontend.
// Son JSON tal como viaja (sin tipar): los tests los pasan por los esquemas.
// Si el contrato cambia, se actualizan aca en el mismo cambio.

export const FIELD_ID = "f3a91c0e52d47b18";

/** Seccion 5: documento de metadatos completo de un campo terminado. */
export function readyMeta(): Record<string, unknown> {
  return {
    id: FIELD_ID,
    pipeline: "1",
    status: "ready",
    rev: 1,
    request: { ra: 269.4463, dec: 4.7683, fov: 0.1667 },
    grid: {
      projection: "TAN",
      crval: [269.4463, 4.7683],
      crpix: [98.0, 98.0],
      cdelt: [-0.000854167, 0.000854167],
      shape: [195, 195],
      fov: 0.1667,
      pixel_scale_arcsec: 3.075,
      native_pixel_scale_arcsec: 6.15,
    },
    detectors: [
      {
        detector: 1,
        wave_min_um: 0.75,
        wave_max_um: 1.12,
        display: { vmin: -0.21, vmax: 14.6, median: 0.004, sigma: 0.105 },
      },
    ],
    epochs: [
      {
        epoch: 1,
        start: "2025-08-15",
        end: "2025-10-01",
        mjd_start: 60902.86,
        mjd_end: 60949.31,
        mjd_mean: 60914.9,
        n_exposures: 118,
      },
    ],
    planes: [
      {
        epoch: 1,
        detector: 1,
        status: "ready",
        rev: 1,
        n_exposures: 24,
        n_used: 24,
        n_failed: 0,
        mjd_mean: 60923.9988,
        stats: {
          min: -0.31,
          max: 187.4,
          median: 0.004,
          sigma: 0.098,
          p01: -0.19,
          p99: 3.4,
          p997: 14.6,
          valid_fraction: 0.972,
          saturated_fraction: 0.0045,
        },
        saturated: [{ x: 97.3, y: 96.0, radius_px: 4.6, n_pixels: 67 }],
        cube_offset: 0,
      },
    ],
    flags: [
      {
        bit: 1,
        name: "OVERFLOW",
        description: "Overflow detected during SUR",
        masked: true,
        saturation: true,
      },
    ],
    progress: {
      phase: "done",
      queue_position: 0,
      cutouts_total: 358,
      cutouts_done: 358,
      cutouts_failed: 0,
      cutouts_cached: 0,
      planes_total: 18,
      planes_ready: 18,
      elapsed_s: 155.4,
    },
    warnings: [
      {
        code: "saturated_source",
        ra: 269.44604,
        dec: 4.7674,
        radius_arcsec: 14.1,
        epochs: [1, 2, 3],
        detectors: [1, 2, 3, 4, 5, 6],
      },
    ],
    preview: {
      status: "ready",
      survey: "WISE",
      band: "W1",
      wave_um: 3.4,
      hips: "identificador HiPS usado",
      display: { vmin: 1.2, vmax: 38.5, median: 2.1, sigma: 0.4 },
    },
    provenance: {
      source: "SPHEREx / IRSA",
      collections: ["spherex_dr1", "spherex_qr3"],
      listed_at: "2026-11-15T06:21:10Z",
      list_stale: false,
      download_mode: "truncated",
      built_at: "2026-11-15T06:23:34Z",
    },
  };
}

/**
 * Seccion 5: objeto `preview` de un trabajo nuevo. Esta desde el primer `state`,
 * con el relevamiento y la banda ya definidos y sin escala hasta que queda lista.
 */
export function pendingPreview(): Record<string, unknown> {
  return {
    status: "pending",
    survey: "WISE",
    band: "W1",
    wave_um: 3.4,
    hips: "identificador HiPS usado",
    display: null,
  };
}

/**
 * Secciones 4.1 y 5: documento de un trabajo que recien entra en la cola, como
 * lo manda el backend. Trae id, pipeline, status, rev, request, progress,
 * warnings y preview; todavia no trae grid, detectors, epochs, planes, flags
 * ni provenance.
 */
export function queuedMeta(): Record<string, unknown> {
  return {
    id: FIELD_ID,
    pipeline: "1",
    status: "queued",
    rev: 0,
    request: { ra: 269.4463, dec: 4.7683, fov: 0.1667 },
    progress: {
      phase: "queued",
      queue_position: 1,
      cutouts_total: 0,
      cutouts_done: 0,
      cutouts_failed: 0,
      cutouts_cached: 0,
      planes_total: 0,
      planes_ready: 0,
      elapsed_s: 0,
    },
    warnings: [],
    preview: pendingPreview(),
  };
}

/**
 * Seccion 4.1, al pie de la letra: "trae solo id, status, request y progress".
 * El backend no produce esta forma (le faltan pipeline y preview, que la
 * seccion 5 da por presentes) y el esquema la rechaza.
 */
export function minimalQueuedMeta(): Record<string, unknown> {
  return {
    id: FIELD_ID,
    status: "queued",
    request: { ra: 269.4463, dec: 4.7683, fov: 0.1667 },
    progress: { phase: "queued", queue_position: 1 },
  };
}

/** Seccion 4.2: plano que acompana al evento `plane` del ejemplo, completado con el de la seccion 5. */
export function planeEventData(): Record<string, unknown> {
  return {
    plane: {
      epoch: 1,
      detector: 3,
      status: "ready",
      rev: 1,
      n_exposures: 21,
      n_used: 21,
      n_failed: 0,
      mjd_mean: 60923.9988,
      stats: {
        min: -0.31,
        max: 187.4,
        median: 0.004,
        sigma: 0.098,
        p01: -0.19,
        p99: 3.4,
        p997: 14.6,
        valid_fraction: 0.972,
        saturated_fraction: 0.0045,
      },
      saturated: [],
      cube_offset: null,
    },
    detector_display: { detector: 3, vmin: -0.08, vmax: 9.8, median: 0.002, sigma: 0.041 },
  };
}

/** Seccion 4.2: evento `progress` del ejemplo. */
export function progressEventData(): Record<string, unknown> {
  return {
    phase: "downloading",
    cutouts_total: 358,
    cutouts_done: 21,
    cutouts_failed: 0,
    cutouts_cached: 0,
    planes_total: 18,
    planes_ready: 0,
    elapsed_s: 11.8,
  };
}

/** Seccion 4.2: evento `done` del ejemplo. */
export function doneEventData(): Record<string, unknown> {
  return { status: "ready", rev: 1, elapsed_s: 155.4 };
}

/** Seccion 4.8: respuesta de /api/resolve para Barnard. */
export function resolveBarnard(): Record<string, unknown> {
  return {
    query: "Barnard's Star",
    name: "NAME Barnard's star",
    source: "sesame",
    object_type: "BY*",
    j2000: { ra: 269.452077, dec: 4.693365 },
    motion: {
      pm_ra: -801.551,
      pm_dec: 10362.394,
      parallax: 546.976,
      radial_velocity: -110.11,
      per_year_arcsec: 10.39,
    },
    field_center: { ra: 269.4463, dec: 4.7683, epoch: 2026.0 },
    moved_arcsec: 270.4,
  };
}

/** Seccion 4.8: el texto buscado eran coordenadas. */
export function resolveCoordinates(): Record<string, unknown> {
  return {
    query: "133.7598 -7.2422",
    name: null,
    source: "coordinates",
    object_type: null,
    j2000: { ra: 133.7598, dec: -7.2422 },
    motion: null,
    field_center: { ra: 133.7598, dec: -7.2422, epoch: 2026.0 },
    moved_arcsec: 0,
  };
}

/** Seccion 4.9: respuesta de /track. */
export function trackBarnard(): Record<string, unknown> {
  return {
    name: "NAME Barnard's star",
    positions: [
      {
        epoch: 1,
        mjd: 60913.7,
        ra: 269.44604,
        dec: 4.7674,
        x: 97.3,
        y: 96.0,
        in_field: true,
      },
      {
        epoch: 2,
        mjd: 61116.2,
        ra: 269.44661,
        dec: 4.76896,
        x: 96.6,
        y: 97.8,
        in_field: true,
      },
    ],
  };
}

/** Seccion 2: cuerpo de error. */
export function errorBody(
  code: string,
  retryable = false,
  message = "detalle para el log",
): Record<string, unknown> {
  return { error: { code, message, retryable } };
}
