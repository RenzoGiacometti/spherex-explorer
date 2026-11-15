// Imagenes sinteticas para los tests del centroide y del ajuste por las alas.
// Solo para tests: nada de la aplicacion importa este archivo.

import { type PlaneImage, toPlaneImage } from "@/viewer/planeImage";

/** Generador de numeros al azar con semilla (mulberry32), para que los tests den siempre lo mismo. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Numeros con distribucion normal de media 0 y desvio 1 (Box-Muller). */
export function seededNormal(seed: number): () => number {
  const random = seededRandom(seed);
  return () => {
    const u = Math.max(random(), 1e-12);
    const v = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export interface Canvas {
  readonly width: number;
  readonly height: number;
  /** Valores fila por fila; `NaN` es sin datos y `Infinity` es saturado, como en el contrato. */
  readonly data: Float32Array;
}

export function blankCanvas(width: number, height: number, level = 0): Canvas {
  return { width, height, data: new Float32Array(width * height).fill(level) };
}

/** Suma una fuente gaussiana de pico `peak` y desvio `sigma` centrada en (x, y). */
export function addGaussian(
  canvas: Canvas,
  x: number,
  y: number,
  peak: number,
  sigma: number,
): void {
  for (let row = 0; row < canvas.height; row += 1) {
    for (let column = 0; column < canvas.width; column += 1) {
      const d2 = (column - x) ** 2 + (row - y) ** 2;
      const index = row * canvas.width + column;
      canvas.data[index] =
        (canvas.data[index] as number) + peak * Math.exp(-d2 / (2 * sigma * sigma));
    }
  }
}

/** Suma un perfil de Moffat: `peak * (1 + r^2 / width^2) ^ -beta`. */
export function addMoffat(
  canvas: Canvas,
  x: number,
  y: number,
  peak: number,
  width: number,
  beta: number,
): void {
  for (let row = 0; row < canvas.height; row += 1) {
    for (let column = 0; column < canvas.width; column += 1) {
      const r2 = (column - x) ** 2 + (row - y) ** 2;
      const index = row * canvas.width + column;
      canvas.data[index] =
        (canvas.data[index] as number) + peak * (1 + r2 / (width * width)) ** -beta;
    }
  }
}

/** Suma ruido gaussiano independiente en cada pixel. */
export function addNoise(canvas: Canvas, sigma: number, seed: number): void {
  const normal = seededNormal(seed);
  for (let index = 0; index < canvas.data.length; index += 1) {
    canvas.data[index] = (canvas.data[index] as number) + sigma * normal();
  }
}

/** Reemplaza por `value` los pixeles a menos de `radius` de (x, y). */
export function fillDisk(
  canvas: Canvas,
  x: number,
  y: number,
  radius: number,
  value: number,
): void {
  for (let row = 0; row < canvas.height; row += 1) {
    for (let column = 0; column < canvas.width; column += 1) {
      if ((column - x) ** 2 + (row - y) ** 2 <= radius * radius) {
        canvas.data[row * canvas.width + column] = value;
      }
    }
  }
}

/** Satura (pone en +Infinity) todo pixel finito que supere `threshold`, como hace el detector. */
export function saturateAbove(canvas: Canvas, threshold: number): number {
  let count = 0;
  for (let index = 0; index < canvas.data.length; index += 1) {
    const value = canvas.data[index] as number;
    if (Number.isFinite(value) && value > threshold) {
      canvas.data[index] = Number.POSITIVE_INFINITY;
      count += 1;
    }
  }
  return count;
}

export function toImage(canvas: Canvas): PlaneImage {
  return toPlaneImage(canvas.data, [canvas.height, canvas.width]);
}
