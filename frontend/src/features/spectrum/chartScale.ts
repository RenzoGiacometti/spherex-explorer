// Escalas y marcas de los ejes del grafico de espectro. Funciones puras.

import type { SpectrumBin } from "./types";

/** Eje X fijo (DESIGN.md, "Espectro"): de 0,75 a 5 um, con un margen para los canales del borde. */
export const WAVE_MIN_UM = 0.72;
export const WAVE_MAX_UM = 5.05;

/** Marcas rotuladas del eje X, um. */
export const WAVE_TICKS: readonly number[] = [1, 2, 3, 4, 5];

export interface LinearScale {
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  (value: number): number;
  invert(pixel: number): number;
}

export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): LinearScale {
  const span = domain[1] - domain[0] || 1;
  const scale = ((value: number) =>
    range[0] + ((value - domain[0]) / span) * (range[1] - range[0])) as LinearScale & {
    domain: readonly [number, number];
    range: readonly [number, number];
  };
  scale.domain = domain;
  scale.range = range;
  scale.invert = (pixel: number) =>
    domain[0] + ((pixel - range[0]) / (range[1] - range[0] || 1)) * span;
  return scale;
}

/**
 * Rango del eje Y: cubre los promedios por canal con sus barras de error, y
 * siempre incluye el cero. Las exposiciones sueltas que se salgan quedan
 * recortadas: una medicion disparada no aplasta el espectro.
 */
export function fluxDomain(bins: readonly SpectrumBin[]): [number, number] {
  let low = 0;
  let high = 0;
  for (const bin of bins) {
    if (!Number.isFinite(bin.flux_mjy)) continue;
    const error = Number.isFinite(bin.error_mjy) ? bin.error_mjy : 0;
    low = Math.min(low, bin.flux_mjy - error);
    high = Math.max(high, bin.flux_mjy + error);
  }
  if (high <= low) return [0, 1];
  const pad = (high - low) * 0.08;
  return [low < 0 ? low - pad : 0, high + pad];
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
    // Evita "-0" y restos de coma flotante como 0,30000000000000004.
    ticks.push(Number((Math.abs(value) < step * 1e-9 ? 0 : value).toPrecision(12)));
  }
  return ticks;
}

/** Decimales para escribir las marcas de un eje con ese paso. */
export function tickDecimals(ticks: readonly number[]): number {
  if (ticks.length < 2) return 1;
  const step = Math.abs((ticks[1] ?? 0) - (ticks[0] ?? 0));
  if (!(step > 0)) return 1;
  return Math.min(4, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
}

/** Decimales para escribir un valor con su error: el error queda con dos cifras significativas. */
export function valueDecimals(error: number): number {
  if (!(error > 0) || !Number.isFinite(error)) return 2;
  return Math.min(4, Math.max(0, 1 - Math.floor(Math.log10(error))));
}

/** Indice del canal mas cercano a una longitud de onda, o -1 si no hay canales. */
export function nearestBin(bins: readonly SpectrumBin[], wavelength: number): number {
  let best = -1;
  let distance = Number.POSITIVE_INFINITY;
  bins.forEach((bin, index) => {
    const d = Math.abs(bin.wavelength_um - wavelength);
    if (d < distance) {
      distance = d;
      best = index;
    }
  });
  return best;
}
