// Campo guardado mas cercano a un punto del cielo: la salida que ofrece el
// visor cuando un campo nuevo no se pudo armar (FieldErrorNotice.tsx). Los
// campos guardados abren sin pasar por el archivo de datos.

import { separationArcsec } from "@/lib/wcs";

export interface SkyCenter {
  readonly ra: number;
  readonly dec: number;
}

export interface NearestField<T extends SkyCenter> {
  readonly field: T;
  /** Separacion angular entre el punto y el centro del campo, en grados. */
  readonly distanceDeg: number;
}

/**
 * Separacion por debajo de la cual el campo guardado es el mismo que se pidio:
 * medio segundo de arco, que cubre el redondeo a 4 decimales de los centros.
 * Ese no se ofrece: es el que acaba de fallar.
 */
export const SAME_FIELD_ARCSEC = 0.5;

/** Separacion angular entre dos puntos del cielo, en grados. */
export function angularDistanceDeg(a: SkyCenter, b: SkyCenter): number {
  return separationArcsec(a, b) / 3600;
}

/**
 * El campo de la lista mas cercano a `center`, sin contar el que tiene ese
 * mismo centro. null si no queda ninguno.
 */
export function nearestField<T extends SkyCenter>(
  center: SkyCenter,
  fields: readonly T[],
): NearestField<T> | null {
  let best: NearestField<T> | null = null;
  for (const field of fields) {
    const arcsec = separationArcsec(center, field);
    if (!Number.isFinite(arcsec) || arcsec <= SAME_FIELD_ARCSEC) continue;
    const distanceDeg = arcsec / 3600;
    if (best === null || distanceDeg < best.distanceDeg) best = { field, distanceDeg };
  }
  return best;
}
