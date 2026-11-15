// Centroide local: lleva un clic al centro de la fuente que hay debajo.
//
// Es el centroide con ventana gaussiana iterado (el `XWIN_IMAGE` de
// SExtractor; Bertin, "SExtractor User's Manual", seccion "Windowed
// positions"): en cada paso se calcula el primer momento de la imagen, sin el
// fondo, pesada con una gaussiana centrada en la posicion vigente, y la
// posicion se corre el doble de ese momento. El punto fijo es el maximo de la
// imagen suavizada con la ventana: no depende de donde cayo el clic.
//
// Limite del metodo: una ventana angosta le da poco peso a una vecina, pero no
// la saca. Dos fuentes a 12 segundos de arco ya se montan (el pixel nativo
// mide 6): si son igual de brillantes, el centro de una queda corrido un
// tercio de pixel de la grilla hacia la otra (centroid.test.ts). WISE 0855
// tiene una estrella de fondo a 4 segundos de arco en mayo de 2026; por eso se
// mide en B6, donde la estrella casi no se ve.
//
// Los tamanos van en pixeles nativos de SPHEREx (6,15 segundos de arco) y se
// pasan a pixeles de la grilla con `oversample` (2 en el cubo base, 1 en el
// amplio). La ventana se eligio con un prototipo sobre los planos
// precalculados de WISE 0855 (B5 y B6): entre 0,5 y 0,8 px nativos el centro
// cambia unas decimas de segundo de arco, y la mas ancha se deja llevar mas
// por la vecina. El cubo amplio no se probo: no hay ninguno precalculado.
//
// Este modulo no sabe de saturacion: si en la ventana hay pixeles saturados
// devuelve `saturated` y snap.ts pasa al ajuste por las alas (wingsFit.ts).

import { MASK_SATURATED, MASK_VALID, type PlaneImage } from "@/viewer/planeImage";
import { ringBackground } from "./stats";

export interface PixelPoint {
  /** Columna de la grilla, desde 0 y con fracciones; crece hacia el oeste. */
  readonly x: number;
  /** Fila de la grilla, desde 0 y con fracciones; crece hacia el norte. */
  readonly y: number;
}

export interface CentroidOptions {
  /** Pixeles de la grilla por pixel nativo: `native_pixel_scale_arcsec / pixel_scale_arcsec`. */
  readonly oversample?: number;
}

/**
 * Por que no hay centroide:
 * - `outside`: el punto de partida esta fuera de la imagen.
 * - `no-data`: faltan datos en la ventana o en el anillo de fondo.
 * - `saturated`: en la ventana hay pixeles saturados (`at` dice cual).
 * - `no-source`: no hay una fuente que se distinga del ruido.
 * - `lost`: la posicion se fue lejos del punto de partida sin asentarse.
 */
export type CentroidFailure = "outside" | "no-data" | "saturated" | "no-source" | "lost";

export type CentroidResult =
  | {
      readonly ok: true;
      readonly x: number;
      readonly y: number;
      /** Error formal de cada coordenada, en pixeles de la grilla. */
      readonly sigmaX: number;
      readonly sigmaY: number;
      /** Relacion senal/ruido del flujo dentro de la ventana. */
      readonly snr: number;
      readonly background: number;
      readonly noise: number;
      readonly iterations: number;
    }
  | {
      readonly ok: false;
      readonly reason: CentroidFailure;
      /** Con `saturated`, el pixel saturado mas cercano a la posicion vigente. */
      readonly at?: PixelPoint;
    };

/** Sigma de la ventana gaussiana, en pixeles nativos, y su minimo en pixeles de la grilla. */
export const WINDOW_SIGMA_NATIVE = 0.6;
export const WINDOW_SIGMA_MIN_PX = 0.8;
/**
 * La ventana se corta a este multiplo de su sigma. Al peso se le resta su
 * valor en el borde, asi llega a cero sin escalon: con un corte seco, un pixel
 * que entra o sale de la ventana mueve el centro y la iteracion puede quedar
 * saltando entre dos posiciones.
 */
export const WINDOW_RADIUS_SIGMAS = 3;
/** Anillo del fondo, en pixeles nativos desde el punto de partida. */
export const BACKGROUND_INNER_NATIVE = 3;
export const BACKGROUND_OUTER_NATIVE = 5;
/** Pixeles validos que tiene que tener el anillo. */
const MIN_BACKGROUND_PIXELS = 20;
/** Fraccion del peso de la ventana que puede caer sobre pixeles sin datos. */
export const MAX_MISSING_WEIGHT = 0.2;
/** La posicion no se aleja mas que esto del punto de partida, en pixeles nativos. */
export const MAX_SHIFT_NATIVE = 2;
/**
 * Por debajo de esta relacion senal/ruido no se da una posicion. Con 3 entra
 * WISE 0855 en la primera epoca de B6, armada con solo 3 exposiciones.
 */
export const MIN_SNR = 3;

const MAX_ITERATIONS = 60;
const CONVERGED_PX = 1e-3;
/** Si al agotar las iteraciones el paso ya es menor que esto, la posicion vale igual. */
const SETTLED_PX = 0.02;

/**
 * El ruido de pixeles vecinos no es independiente: el coadd reproyecta cada
 * exposicion con interpolacion bilineal a una grilla dos veces mas fina, y un
 * pixel nativo reparte su ruido entre varios pixeles de la grilla. La cuenta
 * del error supone pixeles independientes, asi que se corrige por este factor.
 *
 * Medido el 15 de noviembre de 2026 sobre el campo precalculado de WISE 0855
 * (cubo base), con la misma estrella de campo en dos epocas: 858 pares con
 * relacion senal/ruido sin corregir de 8 a 40. La dispersion robusta del
 * corrimiento entre epocas es de 2,0 a 2,3 veces el error formal sin
 * corregir, segun el tramo de senal/ruido. En el campo de Barnard, muy
 * poblado, el cociente va de 0,5 a 1,1: ahi el ruido medido en el anillo ya
 * viene inflado por las estrellas vecinas, y con el factor el error queda
 * sobrestimado. En el cubo amplio (sin sobremuestreo) no se midio: se supone
 * que el ruido de pixeles vecinos es casi independiente.
 */
export function noiseCorrelationFactor(oversample: number): number {
  return oversample >= 1.5 ? 2 : 1;
}

/**
 * Centroide con ventana gaussiana desde `start`. Los indices de pixel son los
 * del contrato: enteros en el centro de cada pixel, desde 0.
 */
export function windowedCentroid(
  image: PlaneImage,
  start: PixelPoint,
  options: CentroidOptions = {},
): CentroidResult {
  const oversample = options.oversample ?? 2;
  const { width, height, values, mask } = image;

  if (
    !Number.isFinite(start.x) ||
    !Number.isFinite(start.y) ||
    start.x < -0.5 ||
    start.y < -0.5 ||
    start.x >= width - 0.5 ||
    start.y >= height - 0.5
  ) {
    return { ok: false, reason: "outside" };
  }

  const sigma = Math.max(WINDOW_SIGMA_NATIVE * oversample, WINDOW_SIGMA_MIN_PX);
  const radius = WINDOW_RADIUS_SIGMAS * sigma;
  const radius2 = radius * radius;
  const edgeWeight = Math.exp(-0.5 * WINDOW_RADIUS_SIGMAS ** 2);
  // Peso total de la ventana entera: la integral de la gaussiana menos su borde.
  const fullWeight =
    2 * Math.PI * sigma * sigma * (1 - edgeWeight) - Math.PI * radius2 * edgeWeight;
  const maxShift = MAX_SHIFT_NATIVE * oversample;

  const background = ringBackground(
    image,
    start.x,
    start.y,
    BACKGROUND_INNER_NATIVE * oversample,
    BACKGROUND_OUTER_NATIVE * oversample,
  );
  if (background.count < MIN_BACKGROUND_PIXELS || !(background.noise > 0)) {
    return { ok: false, reason: "no-data" };
  }

  let cx = start.x;
  let cy = start.y;
  let iterations = 0;
  // Sumas de la ultima pasada, para el error y la relacion senal/ruido.
  let flux = 0;
  let weightSquares = 0;
  let momentSquaresX = 0;
  let momentSquaresY = 0;

  for (;;) {
    iterations += 1;
    const x0 = Math.max(0, Math.ceil(cx - radius));
    const x1 = Math.min(width - 1, Math.floor(cx + radius));
    const y0 = Math.max(0, Math.ceil(cy - radius));
    const y1 = Math.min(height - 1, Math.floor(cy + radius));

    let totalWeight = 0;
    let missingWeight = 0;
    let saturatedAt: PixelPoint | null = null;
    let saturatedDistance2 = Number.POSITIVE_INFINITY;
    let sumX = 0;
    let sumY = 0;
    flux = 0;
    weightSquares = 0;
    momentSquaresX = 0;
    momentSquaresY = 0;

    for (let y = y0; y <= y1; y += 1) {
      const dy = y - cy;
      for (let x = x0; x <= x1; x += 1) {
        const dx = x - cx;
        const d2 = dx * dx + dy * dy;
        if (d2 > radius2) continue;
        const weight = Math.exp((-0.5 * d2) / (sigma * sigma)) - edgeWeight;
        totalWeight += weight;
        const index = y * width + x;
        const state = mask[index];
        if (state !== MASK_VALID) {
          missingWeight += weight;
          if (state === MASK_SATURATED && d2 < saturatedDistance2) {
            saturatedDistance2 = d2;
            saturatedAt = { x, y };
          }
          continue;
        }
        const value = (values[index] as number) - background.level;
        flux += weight * value;
        sumX += weight * value * dx;
        sumY += weight * value * dy;
        weightSquares += weight * weight;
        momentSquaresX += weight * weight * dx * dx;
        momentSquaresY += weight * weight * dy * dy;
      }
    }

    if (saturatedAt !== null) return { ok: false, reason: "saturated", at: saturatedAt };
    // La parte de la ventana que cae fuera de la imagen tambien es peso que falta.
    const missing = Math.max(
      missingWeight / Math.max(totalWeight, 1e-12),
      1 - totalWeight / fullWeight,
    );
    if (missing > MAX_MISSING_WEIGHT) return { ok: false, reason: "no-data" };
    if (!(flux > 0)) return { ok: false, reason: "no-source" };

    const stepX = (2 * sumX) / flux;
    const stepY = (2 * sumY) / flux;
    cx += stepX;
    cy += stepY;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return { ok: false, reason: "lost" };
    if (Math.hypot(cx - start.x, cy - start.y) > maxShift) return { ok: false, reason: "lost" };
    const step = Math.hypot(stepX, stepY);
    if (step < CONVERGED_PX) break;
    if (iterations >= MAX_ITERATIONS) {
      if (step < SETTLED_PX) break;
      return { ok: false, reason: "lost" };
    }
  }

  const correlation = noiseCorrelationFactor(oversample);
  const noise = background.noise * correlation;
  const snr = flux / (noise * Math.sqrt(weightSquares));
  if (!(snr >= MIN_SNR)) return { ok: false, reason: "no-source" };

  // Propagacion del ruido al punto fijo de la iteracion: el paso es
  // 2 * sum(w v d) / sum(w v), asi que la varianza de la posicion es
  // 4 * ruido^2 * sum(w^2 d^2) / sum(w v)^2. El 2 es exacto cuando la ventana
  // tiene el ancho de la fuente, que es como se eligio.
  return {
    ok: true,
    x: cx,
    y: cy,
    sigmaX: (2 * noise * Math.sqrt(momentSquaresX)) / flux,
    sigmaY: (2 * noise * Math.sqrt(momentSquaresY)) / flux,
    snr,
    background: background.level,
    noise: background.noise,
    iterations,
  };
}
