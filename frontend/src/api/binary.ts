// Disposicion binaria (docs/contrato-cubo.md, seccion 6): todo en little-endian,
// sin encabezado, fila por fila desde la fila 0 (sur) y dentro de cada fila
// desde la columna 0 (este).
//
//   /plane/{e}/{d}  ny * nx Float32                       4 * ny * nx bytes
//   /preview        ny * nx Float32                       4 * ny * nx bytes
//   /cube           planos ready y partial, en el orden   4 * ny * nx * cantidad
//                   de `planes`, uno detras de otro
//   /aux/{e}/{d}    ny * nx Uint32 de flags y despues     6 * ny * nx bytes
//                   ny * nx Uint16 de cobertura
//
// Los arreglos tipados leen con el orden de bytes de la maquina. Todas las
// plataformas donde corre un navegador actual son little-endian, igual que el
// contrato, asi que no se convierte nada.

import type { Plane } from "./types";

/** Forma de la grilla, [ny, nx], como en `grid.shape`. */
export type GridShape = readonly [ny: number, nx: number];

const FLOAT32_BYTES = 4;
const UINT32_BYTES = 4;
const UINT16_BYTES = 2;

export function pixelCount(shape: GridShape): number {
  return shape[0] * shape[1];
}

/** Bytes de un plano o de la vista provisoria. */
export function planeByteLength(shape: GridShape): number {
  return FLOAT32_BYTES * pixelCount(shape);
}

/** Bytes de las capas auxiliares de un plano. */
export function auxByteLength(shape: GridShape): number {
  return (UINT32_BYTES + UINT16_BYTES) * pixelCount(shape);
}

/** Dice si un plano tiene binario dentro de /cube. */
export function isInCube(plane: Pick<Plane, "status">): boolean {
  return plane.status === "ready" || plane.status === "partial";
}

/** Bytes de /cube para una lista de planos: solo cuentan los ready y partial. */
export function cubeByteLength(shape: GridShape, planes: readonly Pick<Plane, "status">[]): number {
  return planeByteLength(shape) * planes.filter(isInCube).length;
}

/**
 * Vista Float32 de un plano dentro de un buffer, sin copiar. `byteOffset` es
 * `cube_offset` cuando el buffer es el cubo.
 */
export function planeView(buffer: ArrayBuffer, shape: GridShape, byteOffset = 0): Float32Array {
  const length = pixelCount(shape);
  const end = byteOffset + length * FLOAT32_BYTES;
  if (byteOffset < 0 || byteOffset % FLOAT32_BYTES !== 0 || end > buffer.byteLength) {
    throw new RangeError(
      `plano fuera del buffer: desde ${byteOffset} hasta ${end} en ${buffer.byteLength} bytes`,
    );
  }
  return new Float32Array(buffer, byteOffset, length);
}

/**
 * Vista de un plano dentro del cubo, o null si el plano no tiene lugar en el
 * cubo (`cube_offset` en null: plano vacio o trabajo sin terminar).
 */
export function cubePlaneView(
  cube: ArrayBuffer,
  shape: GridShape,
  plane: Pick<Plane, "cube_offset">,
): Float32Array | null {
  if (plane.cube_offset === null) return null;
  return planeView(cube, shape, plane.cube_offset);
}

export interface AuxLayers {
  /** Bits de `flags[]` encendidos en al menos la mitad de las exposiciones del pixel. */
  flags: Uint32Array;
  /** Exposiciones que aportaron un valor valido al pixel. */
  coverage: Uint16Array;
}

/** Separa la respuesta de /aux en sus dos capas, sin copiar. */
export function splitAux(buffer: ArrayBuffer, shape: GridShape): AuxLayers {
  const length = pixelCount(shape);
  if (buffer.byteLength !== auxByteLength(shape)) {
    throw new RangeError(
      `capas auxiliares: se esperaban ${auxByteLength(shape)} bytes y hay ${buffer.byteLength}`,
    );
  }
  return {
    flags: new Uint32Array(buffer, 0, length),
    coverage: new Uint16Array(buffer, length * UINT32_BYTES, length),
  };
}
