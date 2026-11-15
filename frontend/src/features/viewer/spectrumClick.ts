// De un clic sobre la imagen al pedido del espectro (GET /api/spectrum).
//
// El clic llega en pixeles de imagen, que son los de la grilla del campo
// (docs/contrato-cubo.md, seccion 3: proyeccion TAN, fila 0 al sur y columna 0
// al este). `pixelToSky` (lib/wcs.ts) los pasa a ascension recta y declinacion.
//
// Si el clic cae sobre la mira del objeto buscado no se pide ese punto del
// cielo sino el objeto: su posicion de /api/resolve con el movimiento propio,
// para que la apertura lo siga a la fecha de cada exposicion.

import type { ResolveResponse } from "@/api/types";
import type { TargetPosition } from "@/data/selectors";
import type { SpectrumQuery } from "@/features/spectrum";
import { type GridWcs, pixelToSky } from "@/lib/wcs";

/**
 * Hasta donde un clic cuenta como hecho sobre la mira: 24 px de pantalla (el
 * circulo de la mira mide 15 de radio) o, con la imagen muy alejada, un pixel
 * y medio de imagen, que es la apertura con la que se mide.
 */
export const TARGET_CLICK_RADIUS_SCREEN_PX = 24;
export const TARGET_CLICK_RADIUS_IMAGE_PX = 1.5;

export interface SpectrumClickInput {
  /** Pixel de imagen donde cayo el clic, con fracciones. */
  readonly x: number;
  readonly y: number;
  /** Pixeles CSS por pixel de imagen en ese momento. */
  readonly scale: number;
  readonly grid: GridWcs;
  /** `id` del campo abierto. */
  readonly fieldId: string;
  /** Nombre del objeto buscado (`name` de la URL), si hay. */
  readonly name: string | null;
  /** Donde esta la mira en la epoca que se ve; null si no se dibuja. */
  readonly target: Pick<TargetPosition, "x" | "y" | "inField"> | null;
  /** Respuesta de /api/resolve para ese nombre, si ya llego. */
  readonly resolved: Pick<ResolveResponse, "field_center" | "motion"> | null;
}

/** Lo que se pide para un clic. */
export interface SpectrumPoint {
  readonly query: SpectrumQuery;
  /** Nombre del objeto si el clic cayo sobre su mira; null para un punto suelto. */
  readonly name: string | null;
  /** Pixel de imagen del clic, para marcarlo; null si es el objeto, que ya tiene su mira. */
  readonly pixel: { readonly x: number; readonly y: number } | null;
}

/** Dice si un clic cayo sobre la mira del objeto buscado. */
export function isOnTarget(
  click: Pick<SpectrumClickInput, "x" | "y" | "scale">,
  target: Pick<TargetPosition, "x" | "y" | "inField"> | null,
): boolean {
  if (target === null || !target.inField) return false;
  const distance = Math.hypot(click.x - target.x, click.y - target.y);
  return (
    distance <= TARGET_CLICK_RADIUS_IMAGE_PX ||
    distance * click.scale <= TARGET_CLICK_RADIUS_SCREEN_PX
  );
}

/** Pedido de espectro que corresponde a un clic sobre la imagen. */
export function spectrumPointForClick(input: SpectrumClickInput): SpectrumPoint {
  const { resolved } = input;
  if (resolved !== null && isOnTarget(input, input.target)) {
    const { field_center: center, motion } = resolved;
    return {
      query: {
        ra: center.ra,
        dec: center.dec,
        field: input.fieldId,
        // Con movimiento propio la apertura sigue al objeto desde la epoca de `field_center`.
        ...(motion === null
          ? {}
          : { pmRa: motion.pm_ra, pmDec: motion.pm_dec, epoch: center.epoch }),
      },
      name: input.name,
      pixel: null,
    };
  }
  const sky = pixelToSky(input.grid, input.x, input.y);
  return {
    query: { ra: sky.ra, dec: sky.dec, field: input.fieldId },
    name: null,
    pixel: { x: input.x, y: input.y },
  };
}
