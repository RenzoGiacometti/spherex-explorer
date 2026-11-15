// De un clic sobre la imagen al pedido del espectro (GET /api/spectrum).
//
// El clic llega en pixeles de imagen, que son los de la grilla del campo
// (docs/contrato-cubo.md, seccion 3: proyeccion TAN, fila 0 al sur y columna 0
// al este). `pixelToSky` (lib/wcs.ts) los pasa a ascension recta y declinacion.
//
// Si el clic cae sobre la mira del objeto buscado no se pide ese punto del
// cielo sino el objeto: su posicion de /api/resolve con el movimiento propio,
// para que la apertura lo siga a la fecha de cada exposicion.
//
// En un campo precalculado el backend ajusta el clic a la fuente guardada mas
// cercana (aviso `snapped_source`): el anillo que marca el punto medido pasa a
// la posicion de esa fuente (`snapPointToSource`).

import type { ResolveResponse } from "@/api/types";
import type { TargetPosition } from "@/data/selectors";
import type { SpectrumQuery } from "@/features/spectrum";
import { type GridWcs, pixelToSky, skyToPixel } from "@/lib/wcs";

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
  /**
   * Pixel de imagen que se marca con el anillo: el del clic o, si el espectro
   * se ajusto a una fuente guardada, el de esa fuente. null si es el objeto
   * buscado, que ya tiene su mira.
   */
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

/**
 * Pedido de espectro de una posicion del cielo ya conocida: la fuente guardada
 * mas cercana que ofrece el estado `no_source`.
 */
export function spectrumPointForSky(input: {
  readonly ra: number;
  readonly dec: number;
  readonly grid: GridWcs;
  readonly fieldId: string;
}): SpectrumPoint {
  return {
    query: { ra: input.ra, dec: input.dec, field: input.fieldId },
    name: null,
    pixel: skyToPixel(input.grid, input.ra, input.dec),
  };
}

/**
 * Pedido del objeto del campo sin que medie un clic (la oferta de la curva de
 * luz de una variable del desafio, LightcurveOffer.tsx). Si el objeto buscado
 * ya esta resuelto, es el mismo pedido que un clic sobre su mira: su posicion
 * con el movimiento propio. Si no, la posicion de catalogo que se pasa.
 */
export function spectrumPointForObject(input: {
  readonly name: string;
  readonly ra: number;
  readonly dec: number;
  readonly grid: GridWcs;
  readonly fieldId: string;
  /** Nombre del objeto buscado (`name` de la URL), si hay. */
  readonly targetName: string | null;
  /** Respuesta de /api/resolve para ese nombre, si ya llego. */
  readonly resolved: Pick<ResolveResponse, "field_center" | "motion"> | null;
}): SpectrumPoint {
  const { resolved } = input;
  if (resolved !== null && input.targetName !== null) {
    const { field_center: center, motion } = resolved;
    return {
      query: {
        ra: center.ra,
        dec: center.dec,
        field: input.fieldId,
        ...(motion === null
          ? {}
          : { pmRa: motion.pm_ra, pmDec: motion.pm_dec, epoch: center.epoch }),
      },
      name: input.targetName,
      pixel: null,
    };
  }
  return {
    query: { ra: input.ra, dec: input.dec, field: input.fieldId },
    name: input.name,
    pixel: skyToPixel(input.grid, input.ra, input.dec),
  };
}

/**
 * El punto a marcar una vez que llego el espectro. Si el backend ajusto el
 * clic a una fuente guardada (aviso `snapped_source`), el anillo va sobre la
 * fuente y no sobre el clic. En cualquier otro caso el punto queda como estaba.
 *
 * La posicion de la fuente es `ra` y `dec` del aviso, que en una fuente fija
 * son los de `target`. En el objeto del campo, que se mueve, el aviso trae su
 * posicion en la epoca que quedo mas cerca del clic (backend/app/spectrum/saved.py).
 */
export function snapPointToSource(
  point: SpectrumPoint,
  spectrum: {
    readonly target: { readonly ra: number; readonly dec: number };
    readonly warnings: ReadonlyArray<{
      readonly code: string;
      readonly ra?: number | undefined;
      readonly dec?: number | undefined;
    }>;
  },
  grid: GridWcs | null,
): SpectrumPoint {
  if (point.pixel === null || grid === null) return point;
  const snapped = spectrum.warnings.find((warning) => warning.code === "snapped_source");
  if (snapped === undefined) return point;
  const pixel = skyToPixel(
    grid,
    snapped.ra ?? spectrum.target.ra,
    snapped.dec ?? spectrum.target.dec,
  );
  return pixel === null ? point : { ...point, pixel };
}
