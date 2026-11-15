// Capa de Gaia: donde esta cada fuente en una fecha y como es su flecha de
// movimiento propio. Funciones puras, sin DOM.
//
// El catalogo (`gaia.json`, backend/app/context/store.py) trae la posicion
// ICRS en la epoca de referencia de Gaia DR3 (2016,0) y el movimiento propio en
// milisegundos de arco por anio; `pmra` ya incluye el coseno de la declinacion.
// La posicion en otra fecha se calcula con movimiento lineal, que para dibujar
// alcanza: en las tres decadas del viaje la diferencia con la propagacion
// rigurosa es de milesimas de segundo de arco. La paralaje no se aplica.

import { type GridWcs, skyToPixel } from "@/lib/wcs";
import type { GaiaCatalog } from "./schema";

const MAS_PER_DEGREE = 3.6e6;
const DEG = Math.PI / 180;

export interface GaiaMarker {
  /** Indice de la fuente en el catalogo. */
  readonly index: number;
  readonly sourceId: string;
  /** Posicion en pixeles de la grilla en la fecha pedida (x al oeste, y al norte). */
  readonly x: number;
  readonly y: number;
  /**
   * Punta de la flecha: donde estaria la fuente `arrowYears` despues. null si
   * la fuente no tiene movimiento propio medido.
   */
  readonly tip: { readonly x: number; readonly y: number } | null;
  /** Movimiento propio total, en milisegundos de arco por anio; null si no esta medido. */
  readonly pmTotal: number | null;
  readonly gMag: number | null;
}

/** Posicion (grados) de la fuente `index` en `year`, con movimiento propio lineal. */
export function gaiaPositionAt(
  catalog: GaiaCatalog,
  index: number,
  year: number,
): { ra: number; dec: number } {
  const ra = catalog.ra[index] as number;
  const dec = catalog.dec[index] as number;
  const pmra = catalog.pmra[index] ?? 0;
  const pmdec = catalog.pmdec[index] ?? 0;
  const years = year - catalog.ref_epoch;
  return {
    ra: ra + (pmra * years) / MAS_PER_DEGREE / Math.cos(dec * DEG),
    dec: dec + (pmdec * years) / MAS_PER_DEGREE,
  };
}

/** Movimiento propio total de la fuente `index` en mas/anio, o null si no esta medido. */
export function gaiaTotalMotion(catalog: GaiaCatalog, index: number): number | null {
  const pmra = catalog.pmra[index];
  const pmdec = catalog.pmdec[index];
  if (pmra === null || pmra === undefined || pmdec === null || pmdec === undefined) return null;
  return Math.hypot(pmra, pmdec);
}

export interface GaiaMarkerOptions {
  /** Fecha en la que se dibujan las fuentes: la del cuadro que se esta mirando. */
  readonly year: number;
  /** Largo de la flecha, en anios de movimiento. */
  readonly arrowYears: number;
  /** Magnitud G mas debil que se dibuja. Sin limite si es null. */
  readonly maxGMag?: number | null;
  /** Como mucho esta cantidad de fuentes, las mas brillantes. */
  readonly limit?: number;
}

/**
 * Marcas de las fuentes que caen dentro de la grilla en `year`, de la mas
 * brillante a la mas debil (el orden del catalogo).
 */
export function gaiaMarkers(
  catalog: GaiaCatalog,
  grid: GridWcs & { readonly shape: readonly [number, number] },
  options: GaiaMarkerOptions,
): GaiaMarker[] {
  const { year, arrowYears, maxGMag = null, limit = Number.POSITIVE_INFINITY } = options;
  const [ny, nx] = grid.shape;
  const markers: GaiaMarker[] = [];
  for (let index = 0; index < catalog.count && markers.length < limit; index += 1) {
    const gMag = catalog.g_mag[index] ?? null;
    if (maxGMag !== null) {
      // El catalogo esta ordenado por brillo: pasado el limite, no hay mas que mirar.
      if (gMag === null) continue;
      if (gMag > maxGMag) break;
    }
    const position = gaiaPositionAt(catalog, index, year);
    const pixel = skyToPixel(grid, position.ra, position.dec);
    if (pixel === null) continue;
    if (pixel.x < -0.5 || pixel.x >= nx - 0.5 || pixel.y < -0.5 || pixel.y >= ny - 0.5) continue;

    const pmTotal = gaiaTotalMotion(catalog, index);
    let tip: GaiaMarker["tip"] = null;
    if (pmTotal !== null && pmTotal > 0) {
      const later = gaiaPositionAt(catalog, index, year + arrowYears);
      tip = skyToPixel(grid, later.ra, later.dec);
    }
    markers.push({
      index,
      sourceId: catalog.source_id[index] as string,
      x: pixel.x,
      y: pixel.y,
      tip,
      pmTotal,
      gMag,
    });
  }
  return markers;
}

/** Indice de la fuente con mayor movimiento propio, o null si ninguna lo tiene medido. */
export function fastestSource(catalog: GaiaCatalog): number | null {
  let best: number | null = null;
  let bestMotion = 0;
  for (let index = 0; index < catalog.count; index += 1) {
    const motion = gaiaTotalMotion(catalog, index);
    if (motion !== null && motion > bestMotion) {
      best = index;
      bestMotion = motion;
    }
  }
  return best;
}

// ---- Escala de las flechas ---------------------------------------------------

/**
 * Largos de flecha que ofrece el control, en anios de movimiento. Van de a
 * saltos de mas o menos el triple porque los movimientos propios cubren cuatro
 * ordenes de magnitud: Barnard hace 10" por anio y una estrella comun del
 * campo, 0,005". Con un recorrido lineal una sola de las dos se veria.
 */
export const ARROW_YEAR_STEPS = [1, 3, 10, 30, 100, 300, 1000, 3000, 10000] as const;

/** Paso por defecto: 100 anios. Una estrella comun (5 mas/anio) da medio segundo de arco. */
export const DEFAULT_ARROW_STEP = 4;

/** Anios de movimiento del paso `step` del control (se acota al recorrido). */
export function arrowYearsForStep(step: number): number {
  const index = Math.min(ARROW_YEAR_STEPS.length - 1, Math.max(0, Math.round(step)));
  return ARROW_YEAR_STEPS[index] as number;
}

/**
 * Geometria de una flecha en pantalla: el tramo y los dos trazos de la punta.
 * `from` y `to` van en pixeles de pantalla. Devuelve null si la flecha mide
 * menos que `minLength`: no se distinguiria de la marca.
 */
export function arrowPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  headSize = 5,
  minLength = 3,
): string | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!(length >= minLength)) return null;
  const ux = dx / length;
  const uy = dy / length;
  const head = Math.min(headSize, length / 2);
  // Dos trazos a 30 grados del eje, hacia atras desde la punta.
  const cos = Math.cos(Math.PI / 6);
  const sin = Math.sin(Math.PI / 6);
  const left = { x: to.x - head * (ux * cos - uy * sin), y: to.y - head * (uy * cos + ux * sin) };
  const right = { x: to.x - head * (ux * cos + uy * sin), y: to.y - head * (uy * cos - ux * sin) };
  const point = (p: { x: number; y: number }): string => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  return `M${point(from)}L${point(to)}M${point(left)}L${point(to)}L${point(right)}`;
}
