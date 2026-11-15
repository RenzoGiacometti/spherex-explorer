// Geometria del grafico de curva de luz. Funciones puras.
//
// El eje del tiempo va cortado: las pasadas del relevamiento duran de un dia a
// tres meses y estan separadas por medio anio, asi que en un eje continuo casi
// todo seria hueco. Cada pasada tiene su tramo, con un ancho que crece con su
// duracion pero nunca baja de un minimo, y entre tramos queda una separacion.

import type { LightcurveBin, LightcurveEpoch } from "./types";

export interface LinearScale {
  (value: number): number;
  invert(pixel: number): number;
}

export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): LinearScale {
  const span = domain[1] - domain[0] || 1;
  const scale = ((value: number) =>
    range[0] + ((value - domain[0]) / span) * (range[1] - range[0])) as LinearScale;
  scale.invert = (pixel: number) =>
    domain[0] + ((pixel - range[0]) / (range[1] - range[0] || 1)) * span;
  return scale;
}

export interface TimeSegment {
  readonly epoch: number;
  /** Fechas de los bordes del tramo, MJD: la pasada mas un margen. */
  readonly mjdStart: number;
  readonly mjdEnd: number;
  /** Bordes del tramo en pixeles. */
  readonly left: number;
  readonly right: number;
  /** Texto ISO del primer y del ultimo dia de la pasada. */
  readonly start: string;
  readonly end: string;
}

/** Separacion entre tramos, px. */
export const SEGMENT_GAP_PX = 14;
/** Peso minimo de una pasada al repartir el ancho, en dias: una pasada de un dia igual se ve. */
const MIN_WEIGHT_DAYS = 25;
/** Margen de tiempo a cada lado de una pasada, como fraccion de su duracion (y nunca menos de un dia). */
const PAD_FRACTION = 0.06;

/** Reparte el ancho `[left, right]` entre las pasadas. */
export function layoutSegments(
  epochs: readonly LightcurveEpoch[],
  left: number,
  right: number,
): TimeSegment[] {
  if (epochs.length === 0) return [];
  const usable = Math.max(0, right - left - SEGMENT_GAP_PX * (epochs.length - 1));
  const weights = epochs.map((epoch) => Math.max(MIN_WEIGHT_DAYS, epoch.mjd_end - epoch.mjd_start));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const segments: TimeSegment[] = [];
  let cursor = left;
  epochs.forEach((epoch, index) => {
    const width = (usable * (weights[index] ?? 0)) / total;
    const pad = Math.max(1, (epoch.mjd_end - epoch.mjd_start) * PAD_FRACTION);
    segments.push({
      epoch: epoch.epoch,
      mjdStart: epoch.mjd_start - pad,
      mjdEnd: epoch.mjd_end + pad,
      left: cursor,
      right: cursor + width,
      start: epoch.start,
      end: epoch.end,
    });
    cursor += width + SEGMENT_GAP_PX;
  });
  return segments;
}

/** Posicion horizontal de una fecha de la pasada `epoch`, o null si esa pasada no tiene tramo. */
export function timeToX(
  segments: readonly TimeSegment[],
  epoch: number,
  mjd: number,
): number | null {
  const segment = segments.find((item) => item.epoch === epoch);
  if (segment === undefined) return null;
  const span = segment.mjdEnd - segment.mjdStart || 1;
  const fraction = Math.min(1, Math.max(0, (mjd - segment.mjdStart) / span));
  return segment.left + fraction * (segment.right - segment.left);
}

/**
 * Rango del eje Y: cubre las tandas y las pasadas con sus barras de error, y
 * siempre incluye el 1. Las exposiciones sueltas que se salgan quedan
 * recortadas: una medida disparada no aplasta la curva.
 */
export function valueDomain(marks: readonly LightcurveBin[]): [number, number] {
  let low = 1;
  let high = 1;
  for (const mark of marks) {
    if (!Number.isFinite(mark.value)) continue;
    const error = Number.isFinite(mark.error) ? mark.error : 0;
    low = Math.min(low, mark.value - error);
    high = Math.max(high, mark.value + error);
  }
  // Una curva plana igual necesita aire: al menos 10 % a cada lado del 1.
  low = Math.min(low, 0.9);
  high = Math.max(high, 1.1);
  const pad = (high - low) * 0.1;
  return [Math.max(0, low - pad), high + pad];
}

/** Marcas "redondas" (1, 2 o 5 por una potencia de diez) dentro de un rango. */
export function niceTicks(domain: readonly [number, number], target = 5): number[] {
  const span = domain[1] - domain[0];
  if (!(span > 0)) return [domain[0]];
  const raw = span / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const ratio = raw / magnitude;
  const step = (ratio >= 5 ? 10 : ratio >= 2 ? 5 : ratio >= 1 ? 2 : 1) * magnitude;
  const ticks: number[] = [];
  const first = Math.ceil(domain[0] / step - 1e-9) * step;
  for (let value = first; value <= domain[1] + step * 1e-9; value += step) {
    ticks.push(Number((Math.abs(value) < step * 1e-9 ? 0 : value).toPrecision(12)));
  }
  return ticks;
}

/** Decimales para escribir las marcas de un eje con ese paso. */
export function tickDecimals(ticks: readonly number[]): number {
  if (ticks.length < 2) return 1;
  const step = Math.abs((ticks[1] ?? 0) - (ticks[0] ?? 0));
  if (!(step > 0)) return 1;
  return Math.min(4, Math.max(1, -Math.floor(Math.log10(step) + 1e-9)));
}

/** Indice de la marca mas cercana a una posicion horizontal, o -1 si no hay marcas. */
export function nearestMark(positions: readonly (number | null)[], x: number): number {
  let best = -1;
  let distance = Number.POSITIVE_INFINITY;
  positions.forEach((position, index) => {
    if (position === null) return;
    const d = Math.abs(position - x);
    if (d < distance) {
      distance = d;
      best = index;
    }
  });
  return best;
}

/** Lo que se lee con el cursor: las tandas cortas si las hay; si no, las pasadas. */
export function readableMarks(
  bins: readonly LightcurveBin[],
  epochs: readonly LightcurveBin[],
): readonly LightcurveBin[] {
  return bins.length > 0 ? bins : epochs;
}
