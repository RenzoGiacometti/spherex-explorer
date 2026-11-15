// Una marca: la posicion del objeto en una epoca, medida sobre el plano de una
// banda a partir de un clic.

import type { Grid } from "@/api/types";
import { pixelToSky } from "@/lib/wcs";
import type { PlaneImage } from "@/viewer/planeImage";
import type { PixelPoint } from "./centroid";
import type { EpochPoint } from "./motion";
import { type SnapFailure, type SnapMethod, snapToSource } from "./snap";

/**
 * Piso del error de una posicion medida con el centroide, por coordenada, en
 * segundos de arco. Es lo que queda aunque la fuente sea brillante: el
 * registro entre epocas del coadd y la forma de la PSF, que cambia con cada
 * conjunto de exposiciones.
 *
 * Medido el 15 de noviembre de 2026 con estrellas de campo brillantes
 * (relacion senal/ruido sin corregir mayor que 200), comparando su posicion en
 * dos epocas: la dispersion robusta del corrimiento es de 0,19 segundos de
 * arco en el campo de Barnard (199 pares) y de 0,24 en el de WISE 0855 (114),
 * o sea 0,14 y 0,17 por epoca.
 */
export const CENTROID_ERROR_FLOOR_ARCSEC = 0.2;

/**
 * Piso del error de una posicion medida por las alas con la capa de cobertura,
 * por coordenada, en segundos de arco. El error formal del ajuste no sirve de
 * guia: las alas tienen senal de sobra y lo que limita es su forma.
 *
 * Medido el 15 de noviembre de 2026 sobre Barnard (contra su posicion de
 * catalogo propagada a la fecha de cada plano), R Draconis y RW Aurigae (que
 * casi no se mueven), comparando las epocas 1 y 3, que son de la misma
 * estacion: 17 pares de planos, 34 diferencias (una por coordenada), 0,33
 * segundos de arco de dispersion, o sea 0,23 por epoca (0,22 en Barnard, 0,26
 * en R Draconis, 0,21 en RW Aurigae). Entre estaciones opuestas hay ademas un
 * salto sistematico: ver `WINGS_SEASONAL_JUMP_ARCSEC`. El detalle esta en
 * docs/alas-saturadas.md.
 */
export const WINGS_ERROR_FLOOR_ARCSEC = 0.3;

/**
 * Lo mismo sin la capa de cobertura (todavia no llego, o no se pudo bajar).
 * La misma medicion da 0,75 segundos de arco por epoca (0,49 en Barnard, 0,60
 * en R Draconis, 1,06 en RW Aurigae). En una fuente saturada a medias puede
 * ser peor: RW Aurigae en B6 queda a 7 segundos de arco de su lugar.
 */
export const WINGS_UNCOVERED_ERROR_FLOOR_ARCSEC = 0.8;

/**
 * Cuanto salta el centro ajustado por las alas entre dos pasadas de estaciones
 * opuestas, en segundos de arco. Medido el 15 de noviembre de 2026, con la
 * capa de cobertura, como la posicion de la epoca 2 respecto del promedio de
 * las epocas 1 y 3: en Barnard va de 1,5 a 3,5 segundos de arco segun la banda
 * (descontada la paralaje), en R Draconis de 1,2 a 3,3 y en RW Aurigae de 1,3
 * a 2,8. Un anio despues el centro vuelve a su lugar. Con tres epocas el
 * ajuste lo absorbe (motion.ts); con dos de estaciones opuestas entra en el
 * error.
 *
 * La causa no esta comprobada. Lo mas probable es que las alas no sean
 * simetricas y que el detector quede girado 180 grados seis meses despues.
 * Ver docs/alas-saturadas.md.
 */
export const WINGS_SEASONAL_JUMP_ARCSEC = 2.5;

export interface Mark extends EpochPoint {
  /** Banda (detector) del plano sobre el que se midio. */
  readonly detector: number;
  /** Revision de ese plano. */
  readonly rev: number;
  /** Donde hizo clic la persona, en pixeles de la grilla. */
  readonly click: PixelPoint;
  /** Posicion medida, en pixeles de la grilla. */
  readonly x: number;
  readonly y: number;
  readonly method: SnapMethod;
  /** Relacion senal/ruido; null si se midio por las alas. */
  readonly snr: number | null;
  /** Pixeles saturados del nucleo; 0 si no satura. */
  readonly saturatedPixels: number;
  /** Medida por las alas sin la capa de cobertura: mejora cuando la capa llega. */
  readonly needsCoverage: boolean;
}

export interface MarkInput {
  readonly image: PlaneImage;
  readonly grid: Grid;
  readonly epoch: number;
  readonly detector: number;
  readonly rev: number;
  /** Fecha media de las exposiciones del plano (`planes[].mjd_mean`). */
  readonly mjd: number;
  readonly click: PixelPoint;
  /** Capa de cobertura de ese plano en esa revision, si ya se bajo. */
  readonly coverage?: Uint16Array | null | undefined;
}

export type MarkResult =
  | { readonly ok: true; readonly mark: Mark }
  | { readonly ok: false; readonly reason: SnapFailure };

/** Pixeles de la grilla por pixel nativo de SPHEREx: 2 en el cubo base y 1 en el amplio. */
export function gridOversample(
  grid: Pick<Grid, "pixel_scale_arcsec" | "native_pixel_scale_arcsec">,
): number {
  const ratio = grid.native_pixel_scale_arcsec / grid.pixel_scale_arcsec;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** Piso del error de una posicion segun como se midio, en segundos de arco. */
export function errorFloorArcsec(method: SnapMethod, coverageUsed: boolean): number {
  if (method === "centroid") return CENTROID_ERROR_FLOOR_ARCSEC;
  return coverageUsed ? WINGS_ERROR_FLOOR_ARCSEC : WINGS_UNCOVERED_ERROR_FLOOR_ARCSEC;
}

/** Mide la posicion del objeto bajo un clic y arma la marca de esa epoca. */
export function measureMark(input: MarkInput): MarkResult {
  const { image, grid, click } = input;
  const snapped = snapToSource(image, click, {
    oversample: gridOversample(grid),
    coverage: input.coverage,
  });
  if (!snapped.ok) return snapped;
  const sky = pixelToSky(grid, snapped.x, snapped.y);
  const formalArcsec = snapped.sigmaPx * grid.pixel_scale_arcsec;
  return {
    ok: true,
    mark: {
      epoch: input.epoch,
      detector: input.detector,
      rev: input.rev,
      mjd: input.mjd,
      click,
      x: snapped.x,
      y: snapped.y,
      ra: sky.ra,
      dec: sky.dec,
      // El error formal y el piso de su metodo, en cuadratura.
      sigmaArcsec: Math.hypot(formalArcsec, errorFloorArcsec(snapped.method, snapped.coverageUsed)),
      seasonalArcsec: snapped.method === "wings" ? WINGS_SEASONAL_JUMP_ARCSEC : 0,
      method: snapped.method,
      snr: snapped.snr,
      saturatedPixels: snapped.saturatedPixels,
      needsCoverage: snapped.method === "wings" && !snapped.coverageUsed,
    },
  };
}
