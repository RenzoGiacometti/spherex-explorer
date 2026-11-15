// Ajuste por las alas: el centro de una fuente saturada.
//
// Una estrella brillante llega al plano con el nucleo en +Infinity (contrato,
// seccion 7): en Barnard son de 32 a 246 pixeles segun la banda, rodeados por
// un anillo fino sin datos. Ahi no hay centroide posible. Lo que queda son las
// alas, y alcanzan: se les ajusta un perfil de Moffat de simetria circular con
// el centro libre,
//
//   I(r) = fondo + amplitud * (1 + r^2 / ancho^2) ^ (-beta)
//
// - El ancho va fijo (1,5 px nativos). Sin nucleo, amplitud y ancho son
//   degenerados (en las alas solo importa su producto) y el ajuste no converge
//   si los dos quedan libres. Es lo que ya hacia `fit_profile` en
//   spike/field.py, con el que se midio a Barnard en la Etapa 0.
// - La perdida es robusta (solver.ts): en las alas hay estrellas vecinas.
// - Con la capa de cobertura del plano (contrato, seccion 6) se usan solo los
//   pixeles a los que aportaron casi todas las exposiciones. Alrededor del
//   nucleo hay una franja de 2 a 11 pixeles de la grilla donde cada exposicion
//   enmascaro una zona distinta, y el coadd promedia ahi solo una parte de las
//   exposiciones. Esa franja no es simetrica y corre el centro. Sin la capa se
//   ajusta todo lo valido pegado al nucleo, con un error mayor
//   (docs/alas-saturadas.md).
//
// La precision medida con los campos precalculados esta en marks.ts, junto a
// los pisos de error. Se probaron tambien una ley de potencias en logaritmos y
// un centro de simetria puntual sin modelo: dan lo mismo que el perfil.

import { MASK_SATURATED, MASK_VALID, type PlaneImage } from "@/viewer/planeImage";
import type { PixelPoint } from "./centroid";
import { type LeastSquaresProblem, leastSquares } from "./solver";
import { medianInPlace, ringBackground } from "./stats";

export interface WingsOptions {
  /** Pixeles de la grilla por pixel nativo: `native_pixel_scale_arcsec / pixel_scale_arcsec`. */
  readonly oversample?: number;
  /**
   * Capa de cobertura del plano (`/aux`): exposiciones que aportaron a cada
   * pixel. Con ella el ajuste descarta la franja de cobertura parcial.
   */
  readonly coverage?: Uint16Array | null | undefined;
}

/**
 * Por que no hay ajuste:
 * - `not-saturated`: no hay pixeles saturados cerca del punto.
 * - `no-data`: quedan muy pocos pixeles validos alrededor del nucleo.
 * - `no-fit`: el ajuste no convergio o el centro se fue contra su limite.
 */
export type WingsFailure = "not-saturated" | "no-data" | "no-fit";

/** Region saturada conexa: sus pixeles, su centro geometrico y su radio equivalente. */
export interface SaturatedCore {
  readonly pixels: number;
  readonly x: number;
  readonly y: number;
  /** Radio del circulo de igual area, en pixeles de la grilla. */
  readonly radius: number;
}

export type WingsResult =
  | {
      readonly ok: true;
      readonly x: number;
      readonly y: number;
      /** Error formal de cada coordenada, en pixeles de la grilla. */
      readonly sigmaX: number;
      readonly sigmaY: number;
      /** Exponente del perfil ajustado. */
      readonly beta: number;
      /** Pixeles de las alas que entraron al ajuste. */
      readonly pixels: number;
      /** Si se pudo descartar la franja de cobertura parcial. */
      readonly coverageUsed: boolean;
      readonly core: SaturatedCore;
      readonly iterations: number;
    }
  | { readonly ok: false; readonly reason: WingsFailure };

/** Ancho fijo del perfil de Moffat, en pixeles nativos. */
export const MOFFAT_WIDTH_NATIVE = 1.5;
/** Sin capa de cobertura se ajustan los pixeles validos hasta esta distancia del borde del nucleo, en pixeles nativos. */
export const WINGS_RING_NATIVE = 3;
/** Con capa de cobertura, ancho del anillo que se ajusta desde donde la cobertura ya es completa. */
export const COVERED_RING_NATIVE = 4;
/** Un pixel tiene cobertura completa si le aporto al menos esta fraccion de las exposiciones de referencia. */
export const FULL_COVERAGE_FRACTION = 0.85;
/** La cobertura de referencia es la mediana de un anillo a esta distancia del borde del nucleo, en pixeles nativos. */
export const COVERAGE_REFERENCE_NATIVE: readonly [number, number] = [7, 12];
/** Hasta donde se busca la franja de cobertura parcial desde el borde del nucleo, en pixeles nativos. */
export const PARTIAL_REACH_NATIVE = 6;
/** El ruido se mide en un anillo de este ancho por fuera de las alas, en pixeles nativos. */
export const NOISE_RING_NATIVE = 3;
/** Hasta donde se busca un pixel saturado alrededor del punto, en pixeles nativos. */
export const SATURATION_REACH_NATIVE = 1.5;
/** Con menos pixeles validos que estos no se ajusta. */
const MIN_WING_PIXELS = 30;
const BETA_START = 1.5;
const BETA_MIN = 0.3;
const BETA_MAX = 8;

/**
 * Pixel saturado mas cercano a un punto, hasta `reach` pixeles de la grilla.
 * null si no hay ninguno.
 */
export function nearestSaturatedPixel(
  image: PlaneImage,
  point: PixelPoint,
  reach: number,
): PixelPoint | null {
  const { width, height, mask } = image;
  if (image.saturatedCount === 0) return null;
  const x0 = Math.max(0, Math.ceil(point.x - reach));
  const x1 = Math.min(width - 1, Math.floor(point.x + reach));
  const y0 = Math.max(0, Math.ceil(point.y - reach));
  const y1 = Math.min(height - 1, Math.floor(point.y + reach));
  let best: PixelPoint | null = null;
  let bestDistance2 = reach * reach;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (mask[y * width + x] !== MASK_SATURATED) continue;
      const d2 = (x - point.x) ** 2 + (y - point.y) ** 2;
      if (d2 <= bestDistance2) {
        bestDistance2 = d2;
        best = { x, y };
      }
    }
  }
  return best;
}

/**
 * Region saturada conexa (vecindad de 8) que contiene al pixel `seed`, que
 * tiene que estar saturado. Dos estrellas saturadas que no se tocan son dos
 * regiones.
 */
export function saturatedCore(image: PlaneImage, seed: PixelPoint): SaturatedCore | null {
  const { width, height, mask } = image;
  const seedX = Math.round(seed.x);
  const seedY = Math.round(seed.y);
  if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return null;
  if (mask[seedY * width + seedX] !== MASK_SATURATED) return null;

  const seen = new Uint8Array(width * height);
  const stack = [seedY * width + seedX];
  seen[seedY * width + seedX] = 1;
  let pixels = 0;
  let sumX = 0;
  let sumY = 0;
  while (stack.length > 0) {
    const index = stack.pop() as number;
    const x = index % width;
    const y = (index - x) / width;
    pixels += 1;
    sumX += x;
    sumY += y;
    for (let dy = -1; dy <= 1; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const neighbor = ny * width + nx;
        if (seen[neighbor] === 1 || mask[neighbor] !== MASK_SATURATED) continue;
        seen[neighbor] = 1;
        stack.push(neighbor);
      }
    }
  }
  return { pixels, x: sumX / pixels, y: sumY / pixels, radius: Math.sqrt(pixels / Math.PI) };
}

/** Recorre los pixeles validos cuya distancia al centro del nucleo esta en (from, to]. */
function forEachValidPixel(
  image: PlaneImage,
  core: SaturatedCore,
  from: number,
  to: number,
  visit: (index: number, x: number, y: number, distance: number) => void,
): void {
  const { width, height, mask } = image;
  const x0 = Math.max(0, Math.ceil(core.x - to));
  const x1 = Math.min(width - 1, Math.floor(core.x + to));
  const y0 = Math.max(0, Math.ceil(core.y - to));
  const y1 = Math.min(height - 1, Math.floor(core.y + to));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const distance = Math.hypot(x - core.x, y - core.y);
      if (distance <= from || distance > to) continue;
      const index = y * width + x;
      if (mask[index] === MASK_VALID) visit(index, x, y, distance);
    }
  }
}

/** Cobertura tipica lejos de la estrella: la mediana de un anillo. 0 si el anillo casi no tiene datos. */
function referenceCoverage(
  image: PlaneImage,
  coverage: Uint16Array,
  core: SaturatedCore,
  oversample: number,
): number {
  const found: number[] = [];
  forEachValidPixel(
    image,
    core,
    core.radius + COVERAGE_REFERENCE_NATIVE[0] * oversample,
    core.radius + COVERAGE_REFERENCE_NATIVE[1] * oversample,
    (index) => {
      found.push(coverage[index] as number);
    },
  );
  return found.length < MIN_WING_PIXELS ? 0 : medianInPlace(found);
}

/**
 * Hasta donde llega la franja de cobertura parcial: el percentil 90 de la
 * distancia al centro de los pixeles validos con menos cobertura que
 * `minimum`. 0 si casi no hay.
 */
function partialCoverageRadius(
  image: PlaneImage,
  coverage: Uint16Array,
  core: SaturatedCore,
  minimum: number,
  reach: number,
): number {
  const distances: number[] = [];
  forEachValidPixel(image, core, -1, reach, (index, _x, _y, distance) => {
    if ((coverage[index] as number) < minimum) distances.push(distance);
  });
  if (distances.length <= 5) return 0;
  distances.sort((a, b) => a - b);
  return distances[Math.min(distances.length - 1, Math.floor(0.9 * distances.length))] as number;
}

/**
 * Centro de la fuente saturada que esta en `point` o pegada a el. `point`
 * puede ser el clic: se toma la region saturada mas cercana, hasta 1,5 px
 * nativos.
 */
export function fitWings(
  image: PlaneImage,
  point: PixelPoint,
  options: WingsOptions = {},
): WingsResult {
  const oversample = options.oversample ?? 2;
  const { width, height, values } = image;

  const seed = nearestSaturatedPixel(image, point, SATURATION_REACH_NATIVE * oversample);
  const core = seed === null ? null : saturatedCore(image, seed);
  if (core === null) return { ok: false, reason: "not-saturated" };

  // ---- Cobertura completa ------------------------------------------------------

  const coverage =
    options.coverage && options.coverage.length === width * height ? options.coverage : null;
  /** Cobertura minima de un pixel para entrar al ajuste; 0 si no hay capa. */
  let minimumCoverage = 0;
  /** Radio desde el que se ajusta: el del nucleo o, con capa, donde termina la franja parcial. */
  let inner = core.radius;
  if (coverage !== null) {
    const reference = referenceCoverage(image, coverage, core, oversample);
    if (reference > 0) {
      minimumCoverage = FULL_COVERAGE_FRACTION * reference;
      inner = Math.max(
        core.radius,
        partialCoverageRadius(
          image,
          coverage,
          core,
          minimumCoverage,
          core.radius + PARTIAL_REACH_NATIVE * oversample,
        ),
      );
    }
  }
  const coverageUsed = coverage !== null && minimumCoverage > 0;
  const ring = (coverageUsed ? COVERED_RING_NATIVE : WINGS_RING_NATIVE) * oversample;

  // ---- Pixeles de las alas ---------------------------------------------------

  const reach = inner + ring;
  const xs: number[] = [];
  const ys: number[] = [];
  const data: number[] = [];
  forEachValidPixel(image, core, -1, reach, (index, x, y) => {
    if (coverageUsed && (coverage[index] as number) < minimumCoverage) return;
    xs.push(x);
    ys.push(y);
    data.push(values[index] as number);
  });
  const count = data.length;
  if (count < MIN_WING_PIXELS) return { ok: false, reason: "no-data" };

  // ---- Ruido -----------------------------------------------------------------

  const outside = ringBackground(
    image,
    core.x,
    core.y,
    reach,
    reach + NOISE_RING_NATIVE * oversample,
  );
  let noise = outside.noise;
  if (!(outside.count >= MIN_WING_PIXELS) || !(noise > 0)) {
    // La estrella esta contra un borde: sirve la dispersion de las propias alas.
    const median = medianInPlace([...data]);
    noise = 1.4826 * medianInPlace(data.map((value) => Math.abs(value - median)));
  }
  if (!(noise > 0)) return { ok: false, reason: "no-data" };

  // ---- Ajuste ----------------------------------------------------------------

  const moffatWidth = MOFFAT_WIDTH_NATIVE * oversample;
  const width2 = moffatWidth * moffatWidth;

  // Parametros: [x0, y0, amplitud, beta, fondo].
  const problem: LeastSquaresProblem = {
    count,
    evaluate(params, residuals, jacobian) {
      const centerX = params[0] as number;
      const centerY = params[1] as number;
      const amplitude = params[2] as number;
      const beta = params[3] as number;
      const level = params[4] as number;
      for (let index = 0; index < count; index += 1) {
        const dx = (xs[index] as number) - centerX;
        const dy = (ys[index] as number) - centerY;
        const u = 1 + (dx * dx + dy * dy) / width2;
        const profile = u ** -beta;
        residuals[index] = level + amplitude * profile - (data[index] as number);
        if (jacobian !== null) {
          const base = index * 5;
          const slope = (2 * amplitude * beta * profile) / (u * width2);
          jacobian[base] = slope * dx;
          jacobian[base + 1] = slope * dy;
          jacobian[base + 2] = profile;
          jacobian[base + 3] = -amplitude * profile * Math.log(u);
          jacobian[base + 4] = 1;
        }
      }
    },
  };

  // Amplitud de partida: la que deja el perfil a la altura de la mediana de las alas en su radio medio.
  const middle = inner + ring / 2;
  const typical = Math.max(medianInPlace([...data]), noise);
  const amplitudeStart = typical * (1 + (middle * middle) / width2) ** BETA_START;
  // El centro no puede salir de la region saturada mas un margen: mas lejos ya es otra fuente.
  const limit = core.radius + oversample;

  const fit = leastSquares(problem, [core.x, core.y, amplitudeStart, BETA_START, 0], {
    lossScale: noise,
    lower: [core.x - limit, core.y - limit, 0, BETA_MIN, Number.NEGATIVE_INFINITY],
    upper: [
      core.x + limit,
      core.y + limit,
      Number.POSITIVE_INFINITY,
      BETA_MAX,
      Number.POSITIVE_INFINITY,
    ],
  });

  const x = fit.params[0] as number;
  const y = fit.params[1] as number;
  const atLimit = Math.abs(x - core.x) > 0.98 * limit || Math.abs(y - core.y) > 0.98 * limit;
  if (!fit.converged || fit.covariance === null || atLimit) return { ok: false, reason: "no-fit" };
  const sigmaX = Math.sqrt(fit.covariance[0] as number);
  const sigmaY = Math.sqrt(fit.covariance[6] as number);
  if (!Number.isFinite(sigmaX) || !Number.isFinite(sigmaY)) return { ok: false, reason: "no-fit" };

  return {
    ok: true,
    x,
    y,
    sigmaX,
    sigmaY,
    beta: fit.params[3] as number,
    pixels: count,
    coverageUsed,
    core,
    iterations: fit.iterations,
  };
}
