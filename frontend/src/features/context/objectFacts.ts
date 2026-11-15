// Ficha del objeto: las cuentas que convierten una fila de Gaia en frases.
// Funciones puras, sin DOM ni textos; los tests estan en objectFacts.test.ts.
//
// De Gaia DR3 llegan la paralaje (mas), el movimiento propio (mas/anio, con
// `pmra` ya multiplicado por el coseno de la declinacion) y la magnitud G.
//
// La distancia sale de invertir la paralaje, y eso solo vale cuando la
// paralaje esta bien medida. `gaia.json` no trae el error de cada fuente, asi
// que se usa el error tipico de Gaia para su magnitud (ver
// `typicalParallaxError`): alcanza para decidir si la distancia se puede decir
// con confianza, a grandes rasgos, o no se puede decir.

import type { GridWcs } from "@/lib/wcs";
import { pixelToSky, separationArcsec } from "@/lib/wcs";
import { gaiaPositionAt, gaiaTotalMotion } from "./gaia";
import type { GaiaCatalog } from "./schema";

/** Anios luz en un parsec: 648000/pi unidades astronomicas sobre la distancia que recorre la luz en un anio juliano. */
export const LIGHT_YEARS_PER_PARSEC = 3.2615637769;

/** Factor de la velocidad transversal: km/s por (segundo de arco por anio) y por parsec. */
export const KM_S_PER_ARCSEC_YEAR_PARSEC = 4.740470464;

/** Ancho de la Luna llena, medio grado, en segundos de arco. Sirve de vara para el movimiento propio. */
export const MOON_WIDTH_ARCSEC = 1800;

/**
 * Radio dentro del cual una fuente de Gaia cuenta como "la del clic": un pixel
 * de la grilla base, medio pixel nativo de SPHEREx. Con un radio mas generoso
 * la ficha de WISE 0855 mostraba una fuente de fondo de magnitud 21 que esta a
 * 6" y no tiene nada que ver.
 */
export const DEFAULT_SEARCH_RADIUS_ARCSEC = 3.075;

/**
 * Radio dentro del cual se avisa que hay otra fuente cerca, aunque no sea la
 * del clic: tres pixeles de la grilla. Cubre un clic dado sobre el borde de una
 * estrella en vez de sobre su centro.
 */
export const NEARBY_RADIUS_ARCSEC = 3 * DEFAULT_SEARCH_RADIUS_ARCSEC;

// ---- Distancia ---------------------------------------------------------------

/** Distancia en parsecs de una paralaje en milisegundos de arco. null si la paralaje no es positiva. */
export function parsecsFromParallax(parallaxMas: number): number | null {
  return parallaxMas > 0 ? 1000 / parallaxMas : null;
}

/** Distancia en anios luz de una paralaje en milisegundos de arco. null si la paralaje no es positiva. */
export function lightYearsFromParallax(parallaxMas: number): number | null {
  const parsecs = parsecsFromParallax(parallaxMas);
  return parsecs === null ? null : parsecs * LIGHT_YEARS_PER_PARSEC;
}

/**
 * Error tipico de la paralaje de Gaia (E)DR3 segun la magnitud G, en
 * milisegundos de arco: 0,02 a 0,03 hasta G = 15; 0,07 en G = 17; 0,5 en
 * G = 20 y 1,3 en G = 21 (Gaia Collaboration, Brown et al. 2021, A&A 649, A1,
 * resumen de contenidos de EDR3; DR3 usa la misma astrometria). Entre esos
 * puntos se interpola en escala logaritmica; fuera, vale el del extremo.
 */
const PARALLAX_ERROR_POINTS: ReadonlyArray<readonly [gMag: number, errorMas: number]> = [
  [15, 0.03],
  [17, 0.07],
  [20, 0.5],
  [21, 1.3],
];

export function typicalParallaxError(gMag: number | null): number {
  const first = PARALLAX_ERROR_POINTS[0] as readonly [number, number];
  const last = PARALLAX_ERROR_POINTS[PARALLAX_ERROR_POINTS.length - 1] as readonly [number, number];
  // Sin magnitud se supone la peor: una fuente que Gaia apenas ve.
  if (gMag === null || !Number.isFinite(gMag) || gMag >= last[0]) return last[1];
  if (gMag <= first[0]) return first[1];
  for (let index = 1; index < PARALLAX_ERROR_POINTS.length; index += 1) {
    const [g1, e1] = PARALLAX_ERROR_POINTS[index - 1] as readonly [number, number];
    const [g2, e2] = PARALLAX_ERROR_POINTS[index] as readonly [number, number];
    if (gMag <= g2) {
      const fraction = (gMag - g1) / (g2 - g1);
      return Math.exp(Math.log(e1) + fraction * (Math.log(e2) - Math.log(e1)));
    }
  }
  return last[1];
}

/** Cuantas veces su error tipico tiene que valer la paralaje para decir la distancia sin reparos. */
export const MEASURED_PARALLAX_SIGMAS = 5;
/** Y para decirla "a grandes rasgos". Por debajo, la distancia no se dice. */
export const ROUGH_PARALLAX_SIGMAS = 3;

export type DistanceEstimate =
  /** Gaia no midio paralaje para esta fuente. */
  | { readonly kind: "none" }
  /** Paralaje bien medida: la distancia se dice tal cual. */
  | { readonly kind: "measured"; readonly lightYears: number; readonly parsecs: number }
  /** Paralaje apenas medida: la distancia es orientativa. */
  | { readonly kind: "rough"; readonly lightYears: number; readonly parsecs: number }
  /** Paralaje indistinguible de cero: solo se sabe que esta mas lejos que `beyondLightYears`. */
  | { readonly kind: "far"; readonly beyondLightYears: number };

/**
 * Lo que se puede decir de la distancia de una fuente con su paralaje y su
 * magnitud G. Si la paralaje no llega a `ROUGH_PARALLAX_SIGMAS` veces su error
 * tipico, lo unico cierto es un piso: la distancia que corresponde a la
 * paralaje mas grande todavia compatible con lo medido (el valor mas tres
 * veces el error).
 */
export function estimateDistance(
  parallaxMas: number | null,
  gMag: number | null,
): DistanceEstimate {
  if (parallaxMas === null || !Number.isFinite(parallaxMas)) return { kind: "none" };
  const error = typicalParallaxError(gMag);
  const significance = parallaxMas / error;
  const parsecs = parsecsFromParallax(parallaxMas);
  if (parsecs !== null && significance >= ROUGH_PARALLAX_SIGMAS) {
    const lightYears = parsecs * LIGHT_YEARS_PER_PARSEC;
    return significance >= MEASURED_PARALLAX_SIGMAS
      ? { kind: "measured", lightYears, parsecs }
      : { kind: "rough", lightYears, parsecs };
  }
  const largest = Math.max(parallaxMas, 0) + ROUGH_PARALLAX_SIGMAS * error;
  return { kind: "far", beyondLightYears: (1000 / largest) * LIGHT_YEARS_PER_PARSEC };
}

// ---- Movimiento --------------------------------------------------------------

export const COMPASS_POINTS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
export type CompassPoint = (typeof COMPASS_POINTS)[number];

/**
 * Hacia donde se mueve una fuente, en ocho rumbos. `east` y `north` son las dos
 * componentes del movimiento propio (`pmra` y `pmdec`). En el cielo el este
 * queda a la izquierda cuando el norte esta arriba.
 */
export function compassPoint(east: number, north: number): CompassPoint | null {
  if (!(Math.hypot(east, north) > 0)) return null;
  // Angulo de posicion: 0 al norte, 90 al este.
  const angle = (Math.atan2(east, north) * 180) / Math.PI;
  const sector = Math.round((((angle % 360) + 360) % 360) / 45) % COMPASS_POINTS.length;
  return COMPASS_POINTS[sector] as CompassPoint;
}

/**
 * Si un movimiento propio total (mas/anio) se distingue de cero para una fuente
 * de esa magnitud. El error tipico del movimiento propio de Gaia, en mas/anio,
 * vale casi lo mismo que el de la paralaje en mas (0,02 a 0,03 hasta G = 15,
 * 0,07 en G = 17, 0,5 en G = 20 y 1,4 en G = 21, misma referencia), asi que se
 * usa esa curva: se pide que el movimiento sea al menos tres veces el error.
 */
export function isMotionSignificant(masPerYear: number, gMag: number | null): boolean {
  return masPerYear >= ROUGH_PARALLAX_SIGMAS * typicalParallaxError(gMag);
}

/** Anios que tarda en recorrer el ancho de la Luna llena una fuente que se mueve `masPerYear`. null si no se mueve. */
export function yearsToCrossMoon(masPerYear: number): number | null {
  return masPerYear > 0 ? MOON_WIDTH_ARCSEC / (masPerYear / 1000) : null;
}

/** Velocidad a traves del cielo, en km/s, de un movimiento propio (mas/anio) a una distancia (parsecs). */
export function transverseVelocity(masPerYear: number, parsecs: number): number {
  return KM_S_PER_ARCSEC_YEAR_PARSEC * (masPerYear / 1000) * parsecs;
}

// ---- Brillo ------------------------------------------------------------------

export const VISIBILITY_LEVELS = [
  "nakedEye",
  "binoculars",
  "smallTelescope",
  "largeTelescope",
] as const;
export type Visibility = (typeof VISIBILITY_LEVELS)[number];

/**
 * Con que se llega a ver una fuente de magnitud G en luz visible. Son los
 * limites de uso corriente: 6 a simple vista con cielo oscuro, 10 con
 * binoculares, 14 con un telescopio de aficionado.
 */
export function visibility(gMag: number): Visibility {
  if (gMag <= 6) return "nakedEye";
  if (gMag <= 10) return "binoculars";
  if (gMag <= 14) return "smallTelescope";
  return "largeTelescope";
}

// ---- Redondeo ----------------------------------------------------------------

/** Un numero positivo redondeado a `digits` cifras significativas: 173 con 2 da 170. */
export function roundSignificant(value: number, digits: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const exponent = digits - 1 - Math.floor(Math.log10(Math.abs(value)));
  // Siempre se opera con una potencia entera de 10: multiplicar por 0,0001 deja 360000,00000000006.
  if (exponent >= 0) {
    const scale = 10 ** exponent;
    return Math.round(value * scale) / scale;
  }
  const step = 10 ** -exponent;
  return Math.round(value / step) * step;
}

// ---- Fuente mas cercana a un clic --------------------------------------------

export interface NearestSource {
  /** Indice de la fuente en el catalogo. */
  readonly index: number;
  /** Distancia en el cielo entre el clic y la fuente, en segundos de arco. */
  readonly separationArcsec: number;
}

/**
 * La fuente de Gaia mas cercana a un pixel de la grilla, con las fuentes
 * llevadas a `year` (la fecha de la imagen sobre la que se hizo clic). Devuelve
 * null si ninguna esta a menos de `maxArcsec`.
 */
export function nearestSource(
  catalog: GaiaCatalog,
  grid: GridWcs,
  x: number,
  y: number,
  year: number,
  maxArcsec: number = DEFAULT_SEARCH_RADIUS_ARCSEC,
): NearestSource | null {
  const click = pixelToSky(grid, x, y);
  let best: NearestSource | null = null;
  for (let index = 0; index < catalog.count; index += 1) {
    const separation = separationArcsec(click, gaiaPositionAt(catalog, index, year));
    if (separation <= maxArcsec && (best === null || separation < best.separationArcsec)) {
      best = { index, separationArcsec: separation };
    }
  }
  return best;
}

// ---- Todo junto --------------------------------------------------------------

export interface ObjectFacts {
  readonly sourceId: string;
  readonly gMag: number | null;
  readonly parallaxMas: number | null;
  /** Movimiento propio: componentes este y norte y total, en mas/anio. null si no esta medido. */
  readonly motion: {
    readonly east: number;
    readonly north: number;
    readonly total: number;
    readonly direction: CompassPoint | null;
    /** null si el movimiento es cero. */
    readonly yearsToCrossMoon: number | null;
    /** Falso si el movimiento no se distingue de cero para una fuente de esa magnitud. */
    readonly significant: boolean;
  } | null;
  readonly distance: DistanceEstimate;
  /** Velocidad a traves del cielo en km/s; solo con distancia bien medida y movimiento medido. */
  readonly transverseKmS: number | null;
  readonly visibility: Visibility | null;
}

/** Los datos de la ficha para la fuente `index` del catalogo. */
export function objectFacts(catalog: GaiaCatalog, index: number): ObjectFacts {
  const gMag = catalog.g_mag[index] ?? null;
  const parallaxMas = catalog.parallax[index] ?? null;
  const east = catalog.pmra[index] ?? null;
  const north = catalog.pmdec[index] ?? null;
  const total = gaiaTotalMotion(catalog, index);
  const distance = estimateDistance(parallaxMas, gMag);
  const motion =
    east === null || north === null || total === null
      ? null
      : {
          east,
          north,
          total,
          direction: compassPoint(east, north),
          yearsToCrossMoon: yearsToCrossMoon(total),
          significant: isMotionSignificant(total, gMag),
        };
  return {
    sourceId: catalog.source_id[index] as string,
    gMag,
    parallaxMas,
    motion,
    distance,
    transverseKmS:
      distance.kind === "measured" && motion !== null
        ? transverseVelocity(motion.total, distance.parsecs)
        : null,
    visibility: gMag === null ? null : visibility(gMag),
  };
}
