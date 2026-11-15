// Proyeccion gnomonica (TAN) entre pixeles de la grilla del campo y el cielo.
//
// Contrato (docs/contrato-cubo.md, secciones 2, 5 y 12):
// - grid.crval, crpix y cdelt siguen las convenciones de FITS: crpix cuenta
//   desde 1 y cdelt[0] es negativo.
// - Las coordenadas de pixel de la API y de este modulo son enteros desde 0 en
//   el centro del primer pixel. x crece hacia el oeste y y hacia el norte.
// - La grilla no tiene rotacion ni distorsion: alcanza con crval, crpix y cdelt.
//
// Formulas: proyeccion TAN de Calabretta y Greisen (2002), "Representations of
// celestial coordinates in FITS" (A&A 395, 1077), con matriz PC identidad.

import type { Grid } from "@/api/types";

/** Lo que hace falta de la grilla para proyectar. */
export type GridWcs = Pick<Grid, "crval" | "crpix" | "cdelt">;

export interface SkyPosition {
  /** Ascension recta en grados ICRS, en [0, 360). */
  ra: number;
  /** Declinacion en grados ICRS. */
  dec: number;
}

export interface PixelPosition {
  /** Columna desde 0; crece hacia el oeste. */
  x: number;
  /** Fila desde 0; crece hacia el norte. */
  y: number;
}

const DEG = Math.PI / 180;

function normalizeRa(raDeg: number): number {
  return ((raDeg % 360) + 360) % 360;
}

/**
 * Posicion en el cielo de un pixel (indices desde 0; admite fracciones).
 */
export function pixelToSky(grid: GridWcs, x: number, y: number): SkyPosition {
  const [ra0Deg, dec0Deg] = grid.crval;
  const [crpix1, crpix2] = grid.crpix;
  const [cdelt1, cdelt2] = grid.cdelt;

  // Coordenadas intermedias en el plano tangente, en radianes. El +1 pasa del
  // indice desde 0 al pixel de FITS, que cuenta desde 1.
  const xi = cdelt1 * (x + 1 - crpix1) * DEG;
  const eta = cdelt2 * (y + 1 - crpix2) * DEG;

  const dec0 = dec0Deg * DEG;
  const denominator = Math.cos(dec0) - eta * Math.sin(dec0);
  const deltaRa = Math.atan2(xi, denominator);
  const dec = Math.atan2(eta * Math.cos(dec0) + Math.sin(dec0), Math.hypot(xi, denominator));

  return { ra: normalizeRa(ra0Deg + deltaRa / DEG), dec: dec / DEG };
}

/**
 * Pixel (indices desde 0, con fracciones) de una posicion en el cielo.
 * Devuelve null si el punto esta a 90 grados o mas del centro de la grilla,
 * donde la proyeccion gnomonica no existe.
 */
export function skyToPixel(grid: GridWcs, raDeg: number, decDeg: number): PixelPosition | null {
  const [ra0Deg, dec0Deg] = grid.crval;
  const [crpix1, crpix2] = grid.crpix;
  const [cdelt1, cdelt2] = grid.cdelt;

  const dec0 = dec0Deg * DEG;
  const dec = decDeg * DEG;
  const deltaRa = (raDeg - ra0Deg) * DEG;

  const cosC = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(deltaRa);
  if (cosC <= 1e-12) return null;

  const xi = (Math.cos(dec) * Math.sin(deltaRa)) / cosC;
  const eta =
    (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(deltaRa)) / cosC;

  return {
    x: crpix1 + xi / DEG / cdelt1 - 1,
    y: crpix2 + eta / DEG / cdelt2 - 1,
  };
}

/** Dice si un pixel (indices desde 0) cae dentro de una grilla de forma [ny, nx]. */
export function isInsideGrid(shape: readonly [number, number], x: number, y: number): boolean {
  const [ny, nx] = shape;
  return x >= -0.5 && x < nx - 0.5 && y >= -0.5 && y < ny - 0.5;
}

/** Separacion angular entre dos posiciones, en segundos de arco (formula de Vincenty). */
export function separationArcsec(a: SkyPosition, b: SkyPosition): number {
  const dec1 = a.dec * DEG;
  const dec2 = b.dec * DEG;
  const deltaRa = (b.ra - a.ra) * DEG;

  const numerator = Math.hypot(
    Math.cos(dec2) * Math.sin(deltaRa),
    Math.cos(dec1) * Math.sin(dec2) - Math.sin(dec1) * Math.cos(dec2) * Math.cos(deltaRa),
  );
  const denominator =
    Math.sin(dec1) * Math.sin(dec2) + Math.cos(dec1) * Math.cos(dec2) * Math.cos(deltaRa);

  return (Math.atan2(numerator, denominator) / DEG) * 3600;
}
