// Constelaciones: a cual pertenece un punto del cielo y como se llama.
//
// Los limites de las 88 constelaciones los fijo la IAU en 1930 como arcos de
// ascension recta y declinacion constantes en el equinoccio B1875. El metodo
// es el de Nancy Roman (1987, "Identification of a constellation from a
// position", PASP 99, 695; catalogo VI/42 del CDS): se lleva la posicion a
// B1875 y se recorre una tabla de 357 renglones ordenada de norte a sur; el
// primero que la contiene da la constelacion.
//
// De donde salen la tabla y los nombres: assets/FUENTES.md, "Constelaciones".

import limits from "./assets/constelaciones/limites.json";
import names from "./assets/constelaciones/nombres.json";
import { DEG, type SkyPosition, wrapDegrees } from "./skyMath";

/** Renglon de la tabla: RA minima y maxima en horas, Dec minima en grados y abreviatura. */
type Limit = readonly [raLow: number, raHigh: number, decLow: number, abbreviation: string];

const LIMITS = limits as unknown as readonly Limit[];

export interface ConstellationNames {
  /** Nombre oficial de la IAU, en latin. */
  readonly la: string;
  readonly es: string;
  readonly en: string;
}

/** Nombres por abreviatura de la IAU ("Oph", "UMa"). Son 88. */
export const CONSTELLATION_NAMES: Readonly<Record<string, ConstellationNames>> = names;

/**
 * Siglos julianos de J2000,0 a B1875,0. El comienzo del ano beseliano 1875 es
 * el dia juliano 2405889,25855 (Meeus, "Astronomical Algorithms", cap. 21).
 */
const B1875_CENTURIES = (2_405_889.258_55 - 2_451_545.0) / 36_525;

const ARCSEC = DEG / 3600;

/**
 * Angulos de la precesion de J2000,0 a B1875,0, en radianes (IAU 1976; Meeus,
 * ecuacion 21.2 con T = 0).
 */
const PRECESSION = (() => {
  const t = B1875_CENTURIES;
  return {
    zeta: (2306.2181 * t + 0.30188 * t ** 2 + 0.017998 * t ** 3) * ARCSEC,
    z: (2306.2181 * t + 1.09468 * t ** 2 + 0.018203 * t ** 3) * ARCSEC,
    theta: (2004.3109 * t - 0.42665 * t ** 2 - 0.041833 * t ** 3) * ARCSEC,
  };
})();

/**
 * Lleva una posicion J2000 (ICRS) al equinoccio B1875, el de los limites.
 * Meeus, ecuacion 21.4. La diferencia entre ICRS, FK5 y FK4 es de menos de un
 * segundo de arco: solo importa pegado a un limite.
 */
export function precessToB1875(position: SkyPosition): SkyPosition {
  const ra = position.ra * DEG;
  const dec = position.dec * DEG;
  const { zeta, z, theta } = PRECESSION;
  const a = Math.cos(dec) * Math.sin(ra + zeta);
  const b = Math.cos(theta) * Math.cos(dec) * Math.cos(ra + zeta) - Math.sin(theta) * Math.sin(dec);
  const c = Math.sin(theta) * Math.cos(dec) * Math.cos(ra + zeta) + Math.cos(theta) * Math.sin(dec);
  return {
    ra: wrapDegrees((Math.atan2(a, b) + z) / DEG),
    dec: Math.asin(Math.min(1, Math.max(-1, c))) / DEG,
  };
}

/** Abreviatura de la IAU de la constelacion que contiene a un punto (ICRS, grados). */
export function constellationAt(position: SkyPosition): string {
  const old = precessToB1875(position);
  const hours = old.ra / 15;
  for (const [raLow, raHigh, decLow, abbreviation] of LIMITS) {
    if (old.dec >= decLow && hours >= raLow && hours < raHigh) return abbreviation;
  }
  // El ultimo renglon cubre todo hasta el polo sur: solo se llega aca con un dato que no es un numero.
  return "Oct";
}

/**
 * Nombre de una constelacion para mostrar: en el idioma pedido y, si es
 * distinto, el nombre en latin entre parentesis ("Ofiuco (Ophiuchus)").
 */
export function constellationLabel(abbreviation: string, language: "es" | "en"): string {
  const entry = CONSTELLATION_NAMES[abbreviation];
  if (entry === undefined) return abbreviation;
  const local = entry[language];
  return local === entry.la ? local : `${local} (${entry.la})`;
}

// ---- Figuras ---------------------------------------------------------------

/** Figura de una constelacion: donde va el nombre y los tramos que la dibujan. */
export interface ConstellationFigure {
  /** Unico por figura: Serpens son dos ("Ser" y "Ser-2"). */
  readonly id: string;
  /** Abreviatura de la IAU, clave de `CONSTELLATION_NAMES`. */
  readonly abbr: string;
  /** Posicion del nombre: [RA, Dec] en grados. */
  readonly label: readonly [number, number];
  /** Tramos: cada uno es una lista plana RA, Dec, RA, Dec... en grados. */
  readonly lines: readonly (readonly number[])[];
}

/**
 * Las figuras de las 88 constelaciones. Se piden recien al prender la capa:
 * no entran en la carga inicial.
 */
export async function loadConstellationFigures(): Promise<readonly ConstellationFigure[]> {
  const module = await import("./assets/constelaciones/lineas.json");
  return module.default as unknown as readonly ConstellationFigure[];
}
