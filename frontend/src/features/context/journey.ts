// Viaje entre misiones: los cuadros que recorre el control, en orden de fecha.
//
// Un cuadro es una imagen del mismo campo en la misma grilla: una placa del
// Digitized Sky Survey (optical.ts), un recorte de 2MASS o de WISE (capas del
// contexto) o una epoca de SPHEREx (un plano del cubo). Funciones puras, sin
// DOM ni red.

import type { GridShape } from "@/api/binary";
import type { Display, Epoch } from "@/api/types";
import type { SurveyLayer } from "./schema";

export const MISSIONS = ["DSS", "2MASS", "WISE", "SPHEREx"] as const;
export type Mission = (typeof MISSIONS)[number];

/** Imagen de un cuadro: un plano Float32 (fila 0 = sur, NaN sin datos) y su escala de contraste. */
export interface FrameImage {
  readonly values: Float32Array;
  readonly shape: GridShape;
  readonly display: Display;
}

/** Posicion de un objeto en pixeles de la grilla (indices desde 0; x al oeste, y al norte). */
export interface FramePoint {
  readonly x: number;
  readonly y: number;
}

export interface JourneyFrame {
  /** Identificador unico dentro del viaje: "twomass_ks", "spherex-2". */
  readonly id: string;
  readonly mission: Mission;
  /** Banda como se muestra: "Ks", "W2", "B3". Es un nombre propio: no se traduce. */
  readonly band: string;
  /** Longitud de onda en micrometros: una (2MASS, WISE) o el rango del detector (SPHEREx). */
  readonly waveUm: readonly [number] | readonly [number, number];
  /** Fecha de observacion: MJD (UTC) y anio juliano con decimales. */
  readonly mjd: number;
  readonly year: number;
  /** Fecha ISO de la observacion, y el intervalo que abarca la imagen. */
  readonly date: string;
  readonly dateStart: string;
  readonly dateEnd: string;
  /** null mientras la imagen no esta cargada o si no existe. */
  readonly image: FrameImage | null;
  /** Donde se espera al objeto en esa fecha, si tiene movimiento propio. */
  readonly target: FramePoint | null;
  /**
   * true si la capa se guardo sin la posicion del objeto del campo (UGPS J0722).
   * No es lo mismo que un objeto que en esa fecha caia fuera del campo.
   */
  readonly positionMissing?: boolean;
}

const MJD_J2000 = 51544.5;
const DAYS_PER_JULIAN_YEAR = 365.25;

/** Anio juliano con decimales de una fecha juliana modificada: 51544,5 es 2000,0. */
export function mjdToYear(mjd: number): number {
  return 2000 + (mjd - MJD_J2000) / DAYS_PER_JULIAN_YEAR;
}

/** Cuadro de una capa del contexto (2MASS o WISE). `values` es null si todavia no se bajo. */
export function surveyFrame(
  layer: SurveyLayer,
  shape: GridShape,
  values: Float32Array | null,
): JourneyFrame {
  return {
    id: layer.key,
    mission: layer.survey,
    band: layer.band,
    waveUm: [layer.wave_um],
    mjd: layer.mjd,
    year: layer.year,
    date: layer.date,
    dateStart: layer.date_start,
    dateEnd: layer.date_end,
    image:
      values !== null && layer.display !== null ? { values, shape, display: layer.display } : null,
    target: layer.target?.in_field ? { x: layer.target.x, y: layer.target.y } : null,
    positionMissing: (layer.target ?? null) === null,
  };
}

export interface SpherexFrameInput {
  readonly epoch: Epoch;
  readonly detector: number;
  /** Rango del detector en micrometros (`detectors[].wave_*_um`). */
  readonly waveRangeUm: readonly [number, number];
  /** Escala comun a todas las epocas del detector (`detectors[].display`). */
  readonly display: Display | null;
  readonly shape: GridShape;
  readonly values: Float32Array | null;
  /** Posicion esperada del objeto en la epoca (`/track`), en pixeles. */
  readonly target?: FramePoint | null;
}

/** Cuadro de una epoca de SPHEREx en un detector. */
export function spherexFrame(input: SpherexFrameInput): JourneyFrame {
  const { epoch, display, values } = input;
  return {
    id: `spherex-${epoch.epoch}`,
    mission: "SPHEREx",
    band: `B${input.detector}`,
    waveUm: input.waveRangeUm,
    mjd: epoch.mjd_mean,
    year: mjdToYear(epoch.mjd_mean),
    date: epoch.start,
    dateStart: epoch.start,
    dateEnd: epoch.end,
    image: values !== null && display !== null ? { values, shape: input.shape, display } : null,
    target: input.target ?? null,
  };
}

/** Los cuadros en orden de fecha. No modifica la lista recibida. */
export function orderFrames(frames: readonly JourneyFrame[]): JourneyFrame[] {
  return [...frames].sort((a, b) => a.mjd - b.mjd || a.id.localeCompare(b.id));
}

/**
 * Identificador del cuadro que esta `delta` pasos despues del actual, dando la
 * vuelta al llegar a una punta. Sin cuadro actual arranca por el primero (o
 * por el ultimo, si `delta` es negativo). null si no hay cuadros.
 */
export function stepFrame(
  ordered: readonly JourneyFrame[],
  currentId: string | null,
  delta: number,
): string | null {
  const count = ordered.length;
  if (count === 0) return null;
  const index = ordered.findIndex((frame) => frame.id === currentId);
  if (index < 0) return (delta < 0 ? ordered[count - 1] : ordered[0])?.id ?? null;
  const next = (((index + delta) % count) + count) % count;
  return ordered[next]?.id ?? null;
}

export interface MissionGroup {
  readonly mission: Mission;
  /** Indices, dentro de la lista ordenada, del primer y del ultimo cuadro del grupo. */
  readonly first: number;
  readonly last: number;
}

/** Tramos seguidos de una misma mision en la lista ordenada: 2MASS, WISE y las epocas de SPHEREx. */
export function missionGroups(ordered: readonly JourneyFrame[]): MissionGroup[] {
  const groups: MissionGroup[] = [];
  ordered.forEach((frame, index) => {
    const open = groups[groups.length - 1];
    if (open !== undefined && open.mission === frame.mission) {
      groups[groups.length - 1] = { ...open, last: index };
    } else {
      groups.push({ mission: frame.mission, first: index, last: index });
    }
  });
  return groups;
}

/**
 * Lo que se lee debajo de cada marca: el anio, o anio y mes cuando otro cuadro
 * comparte el anio (dos pasadas de SPHEREx en 2026).
 */
export function stopLabels(ordered: readonly JourneyFrame[]): string[] {
  const perYear = new Map<string, number>();
  for (const frame of ordered) {
    const year = frame.date.slice(0, 4);
    perYear.set(year, (perYear.get(year) ?? 0) + 1);
  }
  return ordered.map((frame) => {
    const year = frame.date.slice(0, 4);
    return (perYear.get(year) ?? 0) > 1 ? frame.date.slice(0, 7) : year;
  });
}

/** Anios entre el primer y el ultimo cuadro: lo que abarca el viaje. */
export function journeySpanYears(ordered: readonly JourneyFrame[]): number {
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  return first === undefined || last === undefined ? 0 : last.year - first.year;
}
