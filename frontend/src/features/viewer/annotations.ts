// Geometria de lo que se dibuja sobre la imagen (DESIGN.md, "Sobre la
// imagen"): donde va cada anotacion, cuanto mide la barra de escala y que
// posiciones forman el rastro. Funciones puras; el dibujo esta en
// ImageAnnotations.tsx.
//
// Todo va en pixeles CSS del visor, con el origen arriba a la izquierda, que
// es lo que entrega `ViewerOverlay`.

import type { EpochTargetPosition } from "@/data/selectors";
import type { Language } from "@/i18n/languages";
import { formatArcminutes, formatArcseconds } from "@/lib/format";
import type { ImageSize } from "@/viewer/compose";
import { imageScreenRect, type ScreenRect, type ViewTransform } from "@/viewer/view";

/**
 * Parte de la imagen que se ve dentro de la zona libre del visor: la
 * interseccion entre el rectangulo de la imagen y `frame`. Las anotaciones que
 * van pegadas a un borde (escala, rosa, rotulo) se ubican contra este
 * rectangulo, asi siguen a la imagen cuando es mas chica que la zona libre y
 * se quedan a la vista cuando, acercada, la desborda. null si no se ve nada.
 */
export function visibleImageRect(
  transform: ViewTransform,
  image: ImageSize,
  frame: ScreenRect,
): ScreenRect | null {
  const full = imageScreenRect(transform, image);
  const left = Math.max(full.left, frame.left);
  const top = Math.max(full.top, frame.top);
  const right = Math.min(full.left + full.width, frame.left + frame.width);
  const bottom = Math.min(full.top + full.height, frame.top + frame.height);
  if (!(right > left) || !(bottom > top)) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/** Dice si un punto de pantalla cae dentro de un rectangulo. */
export function isInsideRect(rect: ScreenRect, x: number, y: number): boolean {
  return (
    x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height
  );
}

// ---- Barra de escala -------------------------------------------------------

/** Largos que puede marcar la barra, en segundos de arco: de 1" a 30'. */
export const SCALE_STEPS_ARCSEC = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800] as const;

/** Largo maximo de la barra, en pixeles CSS. */
export const SCALE_MAX_PX = 160;

/** La barra no ocupa mas que esta fraccion del ancho de imagen que se ve. */
export const SCALE_MAX_FRACTION = 0.3;

export interface ScaleBar {
  /** Lo que mide la barra en el cielo, en segundos de arco. */
  readonly arcsec: number;
  /** Largo de la barra en pixeles CSS. */
  readonly lengthPx: number;
}

/**
 * Elige la barra de escala: el largo redondo mas grande que entra en
 * `SCALE_MAX_PX` y en la fraccion del ancho disponible. Si ni el mas chico
 * entra, va el mas chico. null si falta algun dato.
 *
 * @param pixelScaleArcsec segundos de arco por pixel de imagen (`grid.pixel_scale_arcsec`)
 * @param scale pixeles CSS por pixel de imagen (`ViewTransform.scale`)
 * @param availablePx ancho de imagen que se ve, en pixeles CSS
 */
export function chooseScaleBar(
  pixelScaleArcsec: number,
  scale: number,
  availablePx: number,
): ScaleBar | null {
  if (!(pixelScaleArcsec > 0) || !(scale > 0) || !(availablePx > 0)) return null;
  const pxPerArcsec = scale / pixelScaleArcsec;
  if (!Number.isFinite(pxPerArcsec)) return null;
  const limit = Math.min(SCALE_MAX_PX, availablePx * SCALE_MAX_FRACTION);
  let chosen: number = SCALE_STEPS_ARCSEC[0];
  for (const step of SCALE_STEPS_ARCSEC) {
    if (step * pxPerArcsec <= limit) chosen = step;
  }
  return { arcsec: chosen, lengthPx: chosen * pxPerArcsec };
}

/** Rotulo de la barra: segundos de arco por debajo de un minuto y minutos desde ahi. */
export function formatScaleLabel(arcsec: number, language: Language): string {
  if (arcsec < 60) return formatArcseconds(arcsec, language, 0);
  // Los pasos de un minuto o mas son minutos enteros.
  return formatArcminutes(arcsec / 3600, language, 0);
}

// ---- Rastro ----------------------------------------------------------------

/** Opacidad del anillo mas reciente y del mas viejo que se distingue. */
const TRAIL_OPACITY_MAX = 0.8;
const TRAIL_OPACITY_MIN = 0.35;
const TRAIL_OPACITY_STEP = 0.225;

/**
 * Opacidad de un anillo del rastro segun cuantas epocas atras esta de la que
 * se ve: 0,8 la anterior, 0,575 la que sigue y 0,35 de ahi en mas. Crece hacia
 * el presente (DESIGN.md, "Rastro").
 */
export function trailOpacity(stepsBack: number): number {
  const steps = Math.max(1, Math.round(stepsBack));
  return Math.max(TRAIL_OPACITY_MIN, TRAIL_OPACITY_MAX - TRAIL_OPACITY_STEP * (steps - 1));
}

export interface TrailPoint {
  readonly epoch: number;
  /** Pixel de la grilla, con fracciones. */
  readonly x: number;
  readonly y: number;
  readonly opacity: number;
}

/**
 * Posiciones del rastro: las del objeto en las epocas anteriores a la que se
 * ve, de la mas vieja a la mas reciente. Solo las que salen de /track y caen
 * dentro del campo: un objeto sin trayectoria no se mueve y no deja rastro.
 */
export function trailPoints(
  trail: readonly EpochTargetPosition[],
  shownEpoch: number | null,
): TrailPoint[] {
  if (shownEpoch === null) return [];
  const earlier = trail.filter(
    (item) => item.epoch < shownEpoch && item.position.source === "track" && item.position.inField,
  );
  return earlier.map((item, index) => ({
    epoch: item.epoch,
    x: item.position.x,
    y: item.position.y,
    opacity: trailOpacity(earlier.length - index),
  }));
}
