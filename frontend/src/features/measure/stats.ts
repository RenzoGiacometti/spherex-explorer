// Estadistica robusta sobre los pixeles de un plano: fondo y ruido locales.

import { MASK_VALID, type PlaneImage } from "@/viewer/planeImage";

/** Mediana de una lista (la ordena en el lugar). NaN si esta vacia. */
export function medianInPlace(values: number[]): number {
  const count = values.length;
  if (count === 0) return Number.NaN;
  values.sort((a, b) => a - b);
  const middle = count >> 1;
  return count % 2 === 1
    ? (values[middle] as number)
    : ((values[middle - 1] as number) + (values[middle] as number)) / 2;
}

export interface LocalBackground {
  /** Mediana de los pixeles del anillo. */
  readonly level: number;
  /** Ruido por pixel: 1,4826 por la mediana de los desvios absolutos (MAD). */
  readonly noise: number;
  /** Cuantos pixeles validos tenia el anillo. */
  readonly count: number;
}

/**
 * Fondo y ruido en un anillo alrededor de un punto: los pixeles validos cuya
 * distancia al centro esta entre `inner` (inclusive) y `outer` (exclusive).
 * La mediana y la MAD aguantan que en el anillo haya estrellas vecinas.
 */
export function ringBackground(
  image: PlaneImage,
  centerX: number,
  centerY: number,
  inner: number,
  outer: number,
): LocalBackground {
  const { width, height, values, mask } = image;
  const x0 = Math.max(0, Math.ceil(centerX - outer));
  const x1 = Math.min(width - 1, Math.floor(centerX + outer));
  const y0 = Math.max(0, Math.ceil(centerY - outer));
  const y1 = Math.min(height - 1, Math.floor(centerY + outer));
  const inner2 = inner * inner;
  const outer2 = outer * outer;

  const ring: number[] = [];
  for (let y = y0; y <= y1; y += 1) {
    const dy = y - centerY;
    for (let x = x0; x <= x1; x += 1) {
      const dx = x - centerX;
      const d2 = dx * dx + dy * dy;
      if (d2 < inner2 || d2 >= outer2) continue;
      const index = y * width + x;
      if (mask[index] === MASK_VALID) ring.push(values[index] as number);
    }
  }
  if (ring.length === 0) return { level: Number.NaN, noise: Number.NaN, count: 0 };

  const count = ring.length;
  const level = medianInPlace(ring);
  for (let index = 0; index < count; index += 1) {
    ring[index] = Math.abs((ring[index] as number) - level);
  }
  return { level, noise: 1.4826 * medianInPlace(ring), count };
}
