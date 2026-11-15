// Fuente vecina: avisa si cerca de una posicion medida hay otra fuente que la
// puede haber corrido.
//
// El centroide con ventana (centroid.ts) le da poco peso a una vecina, pero no
// la saca: dos fuentes a 12 segundos de arco ya se montan, y si son igual de
// brillantes el centro de una queda corrido un tercio de pixel de la grilla
// (1 segundo de arco) hacia la otra. El corrimiento es proporcional al brillo
// de la vecina: con un cuarto del pico queda en 0,25 segundos de arco, lo que
// vale el piso del error del centroide (marks.ts). De ahi el umbral.
//
// Como se busca. Una fuente sola es simetrica alrededor de su centro: cada
// pixel vale lo mismo que el punto opuesto. Una vecina rompe esa simetria, y
// lo hace aunque este tan cerca que no llegue a formar un maximo aparte (a
// menos de unos 11 segundos de arco, una vecina con la mitad del brillo es
// solo un hombro en el perfil). Entonces:
//
//   hay vecina si, a menos de 12 segundos de arco de la posicion medida, algun
//   pixel supera a su punto opuesto en al menos un cuarto del pico de la
//   fuente marcada y en varias veces el ruido; o si a esa distancia hay un
//   pixel saturado.
//
// Limites. Una vecina a menos de unos 5 segundos de arco queda fundida con el
// nucleo y no se busca ahi (es el caso de la estrella de fondo de WISE 0855 en
// mayo de 2026). Dos vecinas iguales y opuestas se cancelan. Y solo se aplica
// a las marcas del centroide: en una fuente saturada el nucleo no tiene valor
// y sus alas tapan cualquier vecina a esa distancia.

import { MASK_SATURATED, MASK_VALID, type PlaneImage } from "@/viewer/planeImage";
import { BACKGROUND_INNER_NATIVE, BACKGROUND_OUTER_NATIVE, type PixelPoint } from "./centroid";
import { ringBackground } from "./stats";

/** Hasta que distancia de la marca una vecina la contamina, en segundos de arco. */
export const NEIGHBOR_RADIUS_ARCSEC = 12;
/** Exceso sobre el punto opuesto, como fraccion del pico de la fuente marcada, desde el que se avisa. */
export const NEIGHBOR_MIN_RATIO = 0.25;
/** Ese exceso tiene que ser ademas esta cantidad de veces el ruido de un pixel. */
export const NEIGHBOR_MIN_SNR = 5;
/** Hasta donde llega el nucleo de la propia fuente desde la posicion medida, en pixeles nativos. */
export const OWN_PEAK_REACH_NATIVE = 0.75;
/** Pixeles validos que tiene que tener el anillo del fondo (como en centroid.ts). */
const MIN_BACKGROUND_PIXELS = 20;

export interface Neighbor {
  /** Pixel de la grilla donde el exceso es mayor (o el pixel saturado mas cercano). */
  readonly x: number;
  readonly y: number;
  /** Distancia a la posicion medida, en pixeles de la grilla. */
  readonly distancePx: number;
  /** Exceso sobre el pico de la fuente marcada; Infinity si la vecina satura. */
  readonly ratio: number;
}

export interface NeighborOptions {
  /** Radio de busqueda, en pixeles de la grilla: `NEIGHBOR_RADIUS_ARCSEC / pixel_scale_arcsec`. */
  readonly radiusPx: number;
  /** Pixeles de la grilla por pixel nativo. */
  readonly oversample?: number;
}

/** Valor del plano en un punto con fracciones (bilineal); null si le falta algun pixel. */
function sample(image: PlaneImage, x: number, y: number): number | null {
  const { width, height, values, mask } = image;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) return null;
  const fx = x - x0;
  const fy = y - y0;
  let total = 0;
  for (let dy = 0; dy <= 1; dy += 1) {
    for (let dx = 0; dx <= 1; dx += 1) {
      const index = (y0 + dy) * width + (x0 + dx);
      if (mask[index] !== MASK_VALID) return null;
      total += (dx === 0 ? 1 - fx : fx) * (dy === 0 ? 1 - fy : fy) * (values[index] as number);
    }
  }
  return total;
}

/**
 * Busca otra fuente cerca de `center`, la posicion ya medida de una fuente.
 * Devuelve donde esta el mayor exceso, o null si no hay vecina (o si no hay
 * datos para decidir).
 */
export function findNeighbor(
  image: PlaneImage,
  center: PixelPoint,
  options: NeighborOptions,
): Neighbor | null {
  const oversample = options.oversample ?? 2;
  const { width, height, values, mask } = image;
  const radius = options.radiusPx;
  if (!(radius > 0) || !Number.isFinite(center.x) || !Number.isFinite(center.y)) return null;

  const background = ringBackground(
    image,
    center.x,
    center.y,
    BACKGROUND_INNER_NATIVE * oversample,
    BACKGROUND_OUTER_NATIVE * oversample,
  );
  if (background.count < MIN_BACKGROUND_PIXELS || !(background.noise > 0)) return null;

  const ownReach = Math.max(OWN_PEAK_REACH_NATIVE * oversample, 1);
  const x0 = Math.max(0, Math.ceil(center.x - radius));
  const x1 = Math.min(width - 1, Math.floor(center.x + radius));
  const y0 = Math.max(0, Math.ceil(center.y - radius));
  const y1 = Math.min(height - 1, Math.floor(center.y + radius));

  // Pico de la propia fuente: el pixel mas alto pegado a la posicion medida.
  let ownPeak = Number.NEGATIVE_INFINITY;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (Math.hypot(x - center.x, y - center.y) > ownReach) continue;
      const index = y * width + x;
      if (mask[index] !== MASK_VALID) continue;
      ownPeak = Math.max(ownPeak, (values[index] as number) - background.level);
    }
  }
  if (!(ownPeak > 0)) return null;

  const threshold = Math.max(NEIGHBOR_MIN_RATIO * ownPeak, NEIGHBOR_MIN_SNR * background.noise);
  let saturated: Neighbor | null = null;
  let found: Neighbor | null = null;
  let foundExcess = threshold;

  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const distancePx = Math.hypot(x - center.x, y - center.y);
      if (distancePx <= ownReach || distancePx > radius) continue;
      const index = y * width + x;
      const state = mask[index];
      if (state === MASK_SATURATED) {
        // Una fuente que satura a esa distancia es mas brillante que la marcada.
        if (saturated === null || distancePx < saturated.distancePx) {
          saturated = { x, y, distancePx, ratio: Number.POSITIVE_INFINITY };
        }
        continue;
      }
      if (state !== MASK_VALID) continue;
      const opposite = sample(image, 2 * center.x - x, 2 * center.y - y);
      if (opposite === null) continue;
      const excess = (values[index] as number) - opposite;
      if (excess < foundExcess) continue;
      foundExcess = excess;
      found = { x, y, distancePx, ratio: excess / ownPeak };
    }
  }
  return saturated ?? found;
}
