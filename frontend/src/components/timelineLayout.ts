// Ubicacion de las marcas de la linea de tiempo. DESIGN.md: "las marcas se
// ubican segun su fecha". Funcion pura, sin DOM.

/**
 * Separacion minima entre dos marcas vecinas, como fraccion del ancho de la
 * pista, cuando no se sabe cuanto mide. Con 3 o 4 epocas de un campo real (una
 * pasada cada unos seis meses) no se llega a usar; evita que dos fechas muy
 * cercanas se pisen. En una pista angosta no alcanza: ver `minEpochGap`.
 */
export const MIN_EPOCH_GAP = 0.16;

/**
 * Ancho, en pixeles, de la parada de una epoca: el area que recibe el toque,
 * con la marca arriba y la fecha debajo. La fecha ("2025-06" en `data-sm`) mide
 * 46 px y entra. Timeline.tsx se lo pasa a la hoja de estilos.
 */
export const EPOCH_STOP_WIDTH_PX = 56;

/**
 * Separacion minima entre marcas, como fraccion de una pista de ese ancho en
 * pixeles: nunca menos que el ancho de una parada, para que no se pisen ni las
 * fechas ni las areas que reciben el toque. En el celular el 16 % de la pista
 * son unos 45 px, menos que la fecha.
 *
 * Sin ancho (antes de medir, o donde no hay layout) devuelve `MIN_EPOCH_GAP`.
 */
export function minEpochGap(trackWidthPx: number | null): number {
  if (trackWidthPx === null || !(trackWidthPx > 0)) return MIN_EPOCH_GAP;
  return Math.max(MIN_EPOCH_GAP, EPOCH_STOP_WIDTH_PX / trackWidthPx);
}

/**
 * Posicion de cada epoca sobre la pista, entre 0 (primera fecha) y 1 (ultima),
 * proporcional a su fecha. `times` va en orden creciente y en cualquier unidad
 * (dias julianos modificados, milisegundos).
 *
 * - Una sola epoca queda en el centro.
 * - Si todas las fechas coinciden o alguna no es un numero, se reparten parejo.
 * - Dos marcas nunca quedan a menos de `minGap`; si no hay lugar para eso, se
 *   reparten parejo.
 */
export function layoutEpochs(times: readonly number[], minGap = MIN_EPOCH_GAP): number[] {
  const count = times.length;
  if (count === 0) return [];
  if (count === 1) return [0.5];

  const even = times.map((_, index) => index / (count - 1));
  const first = times[0] as number;
  const last = times[count - 1] as number;
  const span = last - first;
  if (!times.every(Number.isFinite) || !(span > 0)) return even;

  const gap = Math.min(minGap, 1 / (count - 1));
  const positions = times.map((time) => Math.min(1, Math.max(0, (time - first) / span)));

  // Hacia adelante: cada marca, por lo menos a `gap` de la anterior.
  for (let index = 1; index < count; index += 1) {
    const previous = positions[index - 1] as number;
    if ((positions[index] as number) < previous + gap) positions[index] = previous + gap;
  }
  // Hacia atras: lo que se paso del final vuelve a entrar.
  positions[count - 1] = Math.min(1, positions[count - 1] as number);
  for (let index = count - 2; index >= 0; index -= 1) {
    const next = positions[index + 1] as number;
    if ((positions[index] as number) > next - gap) positions[index] = next - gap;
  }
  return positions.map((position) => Math.min(1, Math.max(0, position)));
}
