// Del clic a la posicion de la fuente: centroide local o, si la fuente esta
// saturada, ajuste por las alas.

import type { PlaneImage } from "@/viewer/planeImage";
import { type PixelPoint, windowedCentroid } from "./centroid";
import { fitWings, nearestSaturatedPixel, SATURATION_REACH_NATIVE } from "./wingsFit";

/** Como se obtuvo la posicion. */
export type SnapMethod = "centroid" | "wings";

/**
 * Por que un clic no dio una posicion:
 * - `outside`: cayo fuera de la imagen.
 * - `no-data`: ahi no hay datos suficientes.
 * - `no-source`: no hay una fuente que se distinga del ruido.
 * - `no-fit`: la fuente esta saturada y las alas no alcanzaron para ubicarla.
 */
export type SnapFailure = "outside" | "no-data" | "no-source" | "no-fit";

export type SnapResult =
  | {
      readonly ok: true;
      readonly method: SnapMethod;
      /** Posicion en pixeles de la grilla, desde 0 y con fracciones. */
      readonly x: number;
      readonly y: number;
      /** Error formal por coordenada, en pixeles de la grilla (promedio cuadratico de x e y). */
      readonly sigmaPx: number;
      /** Relacion senal/ruido; null en el ajuste por las alas, donde no limita. */
      readonly snr: number | null;
      /** Pixeles saturados del nucleo; 0 si la fuente no satura. */
      readonly saturatedPixels: number;
      /** En el ajuste por las alas, si se uso la capa de cobertura. false en el centroide. */
      readonly coverageUsed: boolean;
    }
  | { readonly ok: false; readonly reason: SnapFailure };

export interface SnapOptions {
  /** Pixeles de la grilla por pixel nativo: `native_pixel_scale_arcsec / pixel_scale_arcsec`. */
  readonly oversample?: number;
  /** Capa de cobertura del plano, si ya se bajo: mejora el ajuste por las alas. */
  readonly coverage?: Uint16Array | null | undefined;
}

function meanSigma(sigmaX: number, sigmaY: number): number {
  return Math.sqrt((sigmaX * sigmaX + sigmaY * sigmaY) / 2);
}

function snapToWings(
  image: PlaneImage,
  point: PixelPoint,
  oversample: number,
  coverage: Uint16Array | null | undefined,
): SnapResult {
  const fit = fitWings(image, point, { oversample, coverage });
  if (!fit.ok) {
    return { ok: false, reason: fit.reason === "no-data" ? "no-data" : "no-fit" };
  }
  return {
    ok: true,
    method: "wings",
    x: fit.x,
    y: fit.y,
    sigmaPx: meanSigma(fit.sigmaX, fit.sigmaY),
    snr: null,
    saturatedPixels: fit.core.pixels,
    coverageUsed: fit.coverageUsed,
  };
}

/**
 * Lleva un clic al centro de la fuente que hay debajo. Con pixeles saturados
 * al alcance del clic, o si el centroide los encuentra al acercarse a la
 * fuente, ajusta las alas; si no, es el centroide local.
 */
export function snapToSource(
  image: PlaneImage,
  click: PixelPoint,
  options: SnapOptions = {},
): SnapResult {
  const oversample = options.oversample ?? 2;

  if (nearestSaturatedPixel(image, click, SATURATION_REACH_NATIVE * oversample) !== null) {
    return snapToWings(image, click, oversample, options.coverage);
  }

  const centroid = windowedCentroid(image, click, { oversample });
  if (centroid.ok) {
    return {
      ok: true,
      method: "centroid",
      x: centroid.x,
      y: centroid.y,
      sigmaPx: meanSigma(centroid.sigmaX, centroid.sigmaY),
      snr: centroid.snr,
      saturatedPixels: 0,
      coverageUsed: false,
    };
  }
  if (centroid.reason === "saturated" && centroid.at !== undefined) {
    return snapToWings(image, centroid.at, oversample, options.coverage);
  }
  if (centroid.reason === "outside" || centroid.reason === "no-data") {
    return { ok: false, reason: centroid.reason };
  }
  // `lost` es lo que pasa al hacer clic en cielo vacio: la posicion vaga sin asentarse.
  return { ok: false, reason: "no-source" };
}
