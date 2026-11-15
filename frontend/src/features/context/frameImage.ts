// De un cuadro (Float32, fila 0 = sur) a los pixeles RGBA de un canvas (fila 0 = arriba).
//
// Es un dibujo simple en CPU, suficiente para una imagen de 195 x 195: el visor
// principal (src/viewer) compone en WebGL. Usa el mismo estirado y los mismos
// cortes que el visor (src/viewer/stretch.ts), asi un cuadro se ve igual en los
// dos lados.

import { type Rgb, toRgb } from "@/viewer/colors";
import { type Cuts, type StretchKind, stretchValue, toByte } from "@/viewer/stretch";
import type { FrameImage } from "./journey";

/** Negro: lo que se usa si no se puede leer `--color-void`. */
export const FALLBACK_NO_DATA: Rgb = toRgb([0, 0, 0, 1]);

/**
 * Pixeles RGBA del cuadro, con el norte arriba y el este a la izquierda.
 *
 * - Un valor finito va en gris segun los cortes y el estirado.
 * - `NaN` (sin datos) va en `noData`.
 * - `+Infinity` (saturado, solo en planos de SPHEREx) va en el blanco maximo.
 */
export function frameToRgba(
  image: FrameImage,
  cuts: Cuts,
  stretch: StretchKind,
  noData: Rgb = FALLBACK_NO_DATA,
): Uint8ClampedArray<ArrayBuffer> {
  const [ny, nx] = image.shape;
  const pixels = new Uint8ClampedArray(nx * ny * 4);
  const empty = [toByte(noData[0]), toByte(noData[1]), toByte(noData[2])] as const;
  for (let row = 0; row < ny; row += 1) {
    // La fila 0 del plano es el sur: en el canvas va abajo.
    const source = (ny - 1 - row) * nx;
    const target = row * nx * 4;
    for (let column = 0; column < nx; column += 1) {
      const value = image.values[source + column] as number;
      const offset = target + column * 4;
      if (Number.isNaN(value)) {
        pixels[offset] = empty[0];
        pixels[offset + 1] = empty[1];
        pixels[offset + 2] = empty[2];
      } else {
        const level =
          value === Number.POSITIVE_INFINITY ? 255 : toByte(stretchValue(value, cuts, stretch));
        pixels[offset] = level;
        pixels[offset + 1] = level;
        pixels[offset + 2] = level;
      }
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}
