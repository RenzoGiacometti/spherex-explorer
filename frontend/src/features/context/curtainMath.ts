// Posicion de la cortina visible/infrarrojo. Funciones puras.
//
// La posicion es la fraccion del ancho de la imagen donde esta el divisor: 0 es
// el borde izquierdo (se ve solo la imagen de la derecha) y 1, el derecho.

/** Pasos del control nativo que mueve la cortina: milesimas del ancho. */
export const CURTAIN_STEPS = 1000;

/** Posicion de partida: la cortina a la mitad. */
export const DEFAULT_CURTAIN = 0.5;

/** Lleva una posicion a [0, 1]. Lo que no es un numero vuelve a la mitad. */
export function clampCurtain(position: number): number {
  if (Number.isNaN(position)) return DEFAULT_CURTAIN;
  return Math.min(1, Math.max(0, position));
}

/** Valor del control nativo (entero de 0 a `CURTAIN_STEPS`) para una posicion. */
export function curtainToValue(position: number): number {
  return Math.round(clampCurtain(position) * CURTAIN_STEPS);
}

/** Posicion para un valor del control nativo. */
export function curtainFromValue(value: number): number {
  return clampCurtain(value / CURTAIN_STEPS);
}

/** Cuanto mueve la cortina una flecha del teclado, y cuanto con Mayus apretada. */
export const CURTAIN_KEY_STEP = 0.02;
export const CURTAIN_KEY_STEP_LARGE = 0.1;

/**
 * Posicion nueva despues de una tecla de flecha, o null si la tecla no es una
 * flecha (esas las atiende el control nativo). Derecha y arriba agrandan el
 * lado izquierdo; izquierda y abajo lo achican.
 */
export function curtainKeyStep(position: number, key: string, shift = false): number | null {
  const step = shift ? CURTAIN_KEY_STEP_LARGE : CURTAIN_KEY_STEP;
  if (key === "ArrowRight" || key === "ArrowUp") return clampCurtain(clampCurtain(position) + step);
  if (key === "ArrowLeft" || key === "ArrowDown")
    return clampCurtain(clampCurtain(position) - step);
  return null;
}

/** Posicion como porcentaje entero, para el nombre accesible. */
export function curtainPercent(position: number): number {
  return Math.round(clampCurtain(position) * 100);
}
