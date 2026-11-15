// Plano listo para dibujar. Es el punto de encuentro entre la capa de datos,
// que baja y decodifica los binarios del contrato, y el visor, que los sube a
// texturas.
//
// docs/contrato-cubo.md, seccion 12: el comportamiento de NaN e infinito
// dentro de un shader no esta garantizado en todos los controladores. Por eso
// los valores no finitos se reemplazan por 0 y su significado va en una
// mascara aparte, de un byte por pixel.

import type { GridShape } from "@/api/binary";

/** El pixel tiene un valor valido en `values`. */
export const MASK_VALID = 0;
/** Sin datos: `NaN` en el plano. */
export const MASK_NO_DATA = 1;
/** Saturado: `+Infinity` en el plano. */
export const MASK_SATURATED = 2;

export type MaskValue = typeof MASK_VALID | typeof MASK_NO_DATA | typeof MASK_SATURATED;

export interface PlaneImage {
  /** Columnas (nx). La columna 0 es el borde este. */
  readonly width: number;
  /** Filas (ny). La fila 0 es el borde sur. */
  readonly height: number;
  /** Valores fila por fila, con los no finitos reemplazados por 0. */
  readonly values: Float32Array;
  /** Un byte por pixel: `MASK_VALID`, `MASK_NO_DATA` o `MASK_SATURATED`. */
  readonly mask: Uint8Array;
  /** Cantidad de pixeles saturados, para no recorrer la mascara al decidir si hay que avisar. */
  readonly saturatedCount: number;
}

/**
 * Arma un `PlaneImage` a partir de los Float32 de un plano del contrato
 * (`/plane`, `/cube` o `/preview`). Copia los valores: la fuente puede ser una
 * vista sobre el buffer del cubo.
 */
export function toPlaneImage(source: Float32Array, shape: GridShape): PlaneImage {
  const [height, width] = shape;
  const length = width * height;
  if (source.length !== length) {
    throw new RangeError(`plano de ${source.length} valores para una grilla de ${length}`);
  }
  const values = new Float32Array(length);
  const mask = new Uint8Array(length);
  let saturatedCount = 0;
  for (let index = 0; index < length; index += 1) {
    const value = source[index] as number;
    if (Number.isFinite(value)) {
      values[index] = value;
    } else if (value === Number.POSITIVE_INFINITY) {
      mask[index] = MASK_SATURATED;
      saturatedCount += 1;
    } else {
      // NaN. El contrato no usa -Infinity; si llegara, se trata como sin datos.
      mask[index] = MASK_NO_DATA;
    }
  }
  return { width, height, values, mask, saturatedCount };
}
