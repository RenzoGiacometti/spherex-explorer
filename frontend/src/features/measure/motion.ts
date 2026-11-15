// Movimiento propio a partir de las posiciones marcadas en dos o mas epocas.
//
// Las posiciones se llevan a un plano tangente centrado en la primera marca
// (este y norte, en segundos de arco) y en cada eje se ajusta, por minimos
// cuadrados ponderados,
//
//   posicion(t) = p0 + mu * t                         modelo `linear`
//   posicion(t) = p0 + mu * t + s * cos(2 pi t)       modelo `seasonal`
//
// con t en anios desde la primera marca. `mu` es el movimiento propio.
//
// El termino estacional existe porque SPHEREx vuelve a cada zona cada seis
// meses, y entre una pasada y la siguiente cambian de signo dos cosas que no
// son movimiento propio:
//
// - La paralaje: 0,55 segundos de arco en Barnard y 0,44 en WISE 0855. Corre
//   la posicion hasta ese valor hacia un lado en una pasada y hacia el otro en
//   la siguiente.
// - En las fuentes saturadas, el centro de las alas respecto del nucleo.
//   Medido sobre Barnard, R Draconis y RW Aurigae, el centro ajustado salta de
//   1,2 a 3,5 segundos de arco entre pasadas consecutivas, en el mismo sentido
//   en todas las bandas de cada estrella, y vuelve a su lugar un anio despues
//   (`WINGS_SEASONAL_JUMP_ARCSEC` en marks.ts y docs/alas-saturadas.md). La
//   explicacion mas probable, sin comprobar: las alas no son simetricas y el
//   detector queda girado 180 grados entre pasadas.
//
// Con tres epocas o mas que cubran las dos estaciones, `s` absorbe las dos
// cosas y `mu` sale de comparar epocas de la misma estacion. Con dos epocas no
// se puede separar: si son de estaciones opuestas, `seasonUnresolved` avisa que
// el resultado las lleva adentro.
//
// La comparacion con el catalogo (`compareWithTrack`) aplica esta misma cuenta
// a las posiciones de /track, que ya traen la paralaje: asi lo medido y lo
// esperado se calculan igual.

import type { TrackPosition } from "@/api/types";
import { type SkyPosition, separationArcsec } from "@/lib/wcs";
import { solveLinearSystem } from "./solver";

const DEG = Math.PI / 180;
const ARCSEC_PER_RAD = 3600 / DEG;
/** Dias de un anio juliano, la unidad del movimiento propio. */
export const DAYS_PER_YEAR = 365.25;
/** A cuantos anios de la ultima marca se predice la posicion. */
export const PREDICTION_YEARS = 5;
/** Dos marcas con menos separacion en el tiempo que esta no dan un movimiento propio. */
export const MIN_BASELINE_DAYS = 1;
/**
 * Diferencia minima entre el mayor y el menor cos(2 pi t) de las marcas para
 * decir que cubren las dos estaciones: 1 es un cuarto de anio de desfase.
 */
export const SEASON_SPREAD_MIN = 1;

/** Una posicion medida, con su fecha y su error. */
export interface MotionPoint {
  readonly mjd: number;
  readonly ra: number;
  readonly dec: number;
  /** Error de cada coordenada, en segundos de arco. */
  readonly sigmaArcsec: number;
  /**
   * Corrimiento sistematico de esta posicion que cambia de signo entre
   * estaciones opuestas, en segundos de arco (el salto de las alas de una
   * fuente saturada). Solo cuenta cuando el ajuste no puede separarlo.
   */
  readonly seasonalArcsec?: number;
}

/** Un vector en el cielo: componentes hacia el este y el norte, modulo y angulo de posicion. */
export interface SkyVector {
  readonly east: number;
  readonly north: number;
  readonly total: number;
  /** Angulo de posicion en grados, desde el norte hacia el este, en [0, 360). */
  readonly positionAngle: number;
}

export type MotionModel = "linear" | "seasonal";

export interface DatedPosition extends SkyPosition {
  readonly mjd: number;
}

export interface MotionFit {
  /** Cantidad de posiciones usadas. */
  readonly count: number;
  readonly model: MotionModel;
  /**
   * Las marcas son de estaciones opuestas y no alcanzan para separar el
   * termino estacional: el movimiento propio lleva adentro la paralaje y, en
   * una fuente saturada, la asimetria de las alas.
   */
  readonly seasonUnresolved: boolean;
  /** Tiempo entre la primera y la ultima, en anios julianos. */
  readonly baselineYears: number;
  /** Desplazamiento entre la primera y la ultima posicion marcada, en segundos de arco. */
  readonly displacement: SkyVector;
  /** Error del desplazamiento, en segundos de arco (de cada componente y del modulo). */
  readonly displacementSigma: number;
  /** Movimiento propio, en segundos de arco por anio. */
  readonly motion: SkyVector;
  /** Error del movimiento propio, en segundos de arco por anio (de cada componente y del modulo). */
  readonly motionSigma: number;
  /**
   * Factor por el que se agrando el error porque las posiciones no caen sobre
   * el modelo dentro de su error (raiz del chi cuadrado reducido). 1 cuando no
   * sobran datos o cuando el modelo alcanza.
   */
  readonly scatterFactor: number;
  /** Posicion del ajuste, sin el termino estacional, en la fecha de la primera marca. */
  readonly start: DatedPosition;
  /** Lo mismo en la fecha de la ultima marca. */
  readonly end: DatedPosition;
  /** Posicion predicha `PREDICTION_YEARS` anios despues de la ultima marca. */
  readonly prediction: DatedPosition & {
    /** Error de cada coordenada, en segundos de arco. */
    readonly sigmaArcsec: number;
  };
}

export interface MotionOptions {
  /** Obliga a usar un modelo. Por defecto se elige segun las fechas de las marcas. */
  readonly model?: MotionModel;
}

function normalizeRa(raDeg: number): number {
  return ((raDeg % 360) + 360) % 360;
}

/** Este y norte de `point` en el plano tangente centrado en `origin`, en segundos de arco. */
export function tangentOffset(
  origin: SkyPosition,
  point: SkyPosition,
): { east: number; north: number } {
  const dec0 = origin.dec * DEG;
  const dec = point.dec * DEG;
  const deltaRa = (point.ra - origin.ra) * DEG;
  const cosC = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(deltaRa);
  return {
    east: ((Math.cos(dec) * Math.sin(deltaRa)) / cosC) * ARCSEC_PER_RAD,
    north:
      ((Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(deltaRa)) /
        cosC) *
      ARCSEC_PER_RAD,
  };
}

/** Inversa de `tangentOffset`: la posicion en el cielo de un punto del plano tangente. */
export function tangentToSky(origin: SkyPosition, east: number, north: number): SkyPosition {
  const xi = east / ARCSEC_PER_RAD;
  const eta = north / ARCSEC_PER_RAD;
  const dec0 = origin.dec * DEG;
  const denominator = Math.cos(dec0) - eta * Math.sin(dec0);
  const deltaRa = Math.atan2(xi, denominator);
  const dec = Math.atan2(eta * Math.cos(dec0) + Math.sin(dec0), Math.hypot(xi, denominator));
  return { ra: normalizeRa(origin.ra + deltaRa / DEG), dec: dec / DEG };
}

function skyVector(east: number, north: number): SkyVector {
  const angle = Math.atan2(east, north) / DEG;
  return { east, north, total: Math.hypot(east, north), positionAngle: (angle + 360) % 360 };
}

interface Row {
  readonly t: number;
  readonly east: number;
  readonly north: number;
  readonly weight: number;
  /** cos(2 pi t): la fase de la estacion respecto de la primera marca. */
  readonly season: number;
}

interface Solution {
  /** Parametros por eje, en el orden [p0, mu, s]; `s` solo en el modelo estacional. */
  readonly east: Float64Array;
  readonly north: Float64Array;
  /** Covarianza de los parametros (la misma para los dos ejes), fila por fila. */
  readonly covariance: Float64Array;
  readonly size: number;
  readonly chi2: number;
}

/** Minimos cuadrados ponderados de las dos coordenadas contra las columnas del modelo. */
function solve(rows: readonly Row[], model: MotionModel): Solution | null {
  const size = model === "seasonal" ? 3 : 2;
  const column = (row: Row, index: number): number =>
    index === 0 ? 1 : index === 1 ? row.t : row.season;

  const normal = new Float64Array(size * size);
  const rightEast = new Float64Array(size);
  const rightNorth = new Float64Array(size);
  for (const row of rows) {
    for (let j = 0; j < size; j += 1) {
      const cj = row.weight * column(row, j);
      rightEast[j] = (rightEast[j] as number) + cj * row.east;
      rightNorth[j] = (rightNorth[j] as number) + cj * row.north;
      for (let k = 0; k < size; k += 1) {
        normal[j * size + k] = (normal[j * size + k] as number) + cj * column(row, k);
      }
    }
  }
  const east = solveLinearSystem(normal, rightEast, size);
  const north = solveLinearSystem(normal, rightNorth, size);
  if (east === null || north === null) return null;

  const covariance = new Float64Array(size * size);
  const unit = new Float64Array(size);
  for (let j = 0; j < size; j += 1) {
    unit.fill(0);
    unit[j] = 1;
    const solved = solveLinearSystem(normal, unit, size);
    if (solved === null) return null;
    for (let k = 0; k < size; k += 1) covariance[k * size + j] = solved[k] as number;
  }
  for (let j = 0; j < size; j += 1) {
    const variance = covariance[j * size + j] as number;
    if (!(variance > 0) || !Number.isFinite(variance)) return null;
  }

  let chi2 = 0;
  for (const row of rows) {
    let fitEast = 0;
    let fitNorth = 0;
    for (let j = 0; j < size; j += 1) {
      fitEast += (east[j] as number) * column(row, j);
      fitNorth += (north[j] as number) * column(row, j);
    }
    chi2 += row.weight * ((row.east - fitEast) ** 2 + (row.north - fitNorth) ** 2);
  }
  return { east, north, covariance, size, chi2 };
}

/**
 * Ajusta el movimiento propio. Devuelve null si hay menos de dos posiciones o
 * si la primera y la ultima estan a menos de `MIN_BASELINE_DAYS`.
 */
export function fitMotion(
  points: readonly MotionPoint[],
  options: MotionOptions = {},
): MotionFit | null {
  const sorted = [...points]
    .filter(
      (point) =>
        Number.isFinite(point.mjd) &&
        Number.isFinite(point.ra) &&
        Number.isFinite(point.dec) &&
        point.sigmaArcsec > 0,
    )
    .sort((a, b) => a.mjd - b.mjd);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (first === undefined || last === undefined || sorted.length < 2) return null;
  if (last.mjd - first.mjd < MIN_BASELINE_DAYS) return null;

  const origin: SkyPosition = { ra: first.ra, dec: first.dec };
  const rows: Row[] = sorted.map((point) => {
    const t = (point.mjd - first.mjd) / DAYS_PER_YEAR;
    return {
      ...tangentOffset(origin, point),
      t,
      weight: 1 / (point.sigmaArcsec * point.sigmaArcsec),
      season: Math.cos(2 * Math.PI * t),
    };
  });

  let seasonMin = 1;
  let seasonMax = -1;
  for (const row of rows) {
    seasonMin = Math.min(seasonMin, row.season);
    seasonMax = Math.max(seasonMax, row.season);
  }
  const coversSeasons = seasonMax - seasonMin >= SEASON_SPREAD_MIN;

  const linear = solve(rows, "linear");
  if (linear === null) return null;
  let model: MotionModel = "linear";
  let solution = linear;
  const wanted = options.model ?? (coversSeasons && rows.length >= 3 ? "seasonal" : "linear");
  if (wanted === "seasonal" && rows.length >= 3) {
    // Si las fechas no alcanzan para separar el termino (sistema singular), queda la recta.
    const seasonal = solve(rows, "seasonal");
    if (seasonal !== null) {
      model = "seasonal";
      solution = seasonal;
    }
  }

  // Si sobran datos y no caen sobre el modelo dentro de su error, el error se
  // agranda con la raiz del chi cuadrado reducido.
  const freedom = 2 * (rows.length - solution.size);
  const scatterFactor = freedom > 0 ? Math.max(1, Math.sqrt(solution.chi2 / freedom)) : 1;

  const { covariance, size } = solution;
  const varPosition = covariance[0] as number;
  const covPositionMotion = covariance[1] as number;
  const varMotion = covariance[size + 1] as number;
  let motionSigma = scatterFactor * Math.sqrt(varMotion);

  const lastRow = rows.at(-1);
  const baselineYears = lastRow?.t ?? 0;
  const seasonUnresolved = model === "linear" && coversSeasons;
  if (seasonUnresolved) {
    // El salto entre estaciones entra entero en el desplazamiento: se suma al
    // error en proporcion a cuan opuestas son las estaciones de las marcas.
    const jump = Math.max(...sorted.map((point) => point.seasonalArcsec ?? 0));
    const opposition = (seasonMax - seasonMin) / 2;
    motionSigma = Math.hypot(motionSigma, (jump * opposition) / baselineYears);
  }

  const p0East = solution.east[0] as number;
  const p0North = solution.north[0] as number;
  const muEast = solution.east[1] as number;
  const muNorth = solution.north[1] as number;
  const at = (t: number): SkyPosition =>
    tangentToSky(origin, p0East + muEast * t, p0North + muNorth * t);

  const predictionT = baselineYears + PREDICTION_YEARS;
  // La parte del error del movimiento propio que no sale de la covarianza (el
  // salto entre estaciones) tambien arrastra a la prediccion.
  const extraMotionVariance = Math.max(motionSigma ** 2 - scatterFactor ** 2 * varMotion, 0);
  const predictionVariance =
    scatterFactor ** 2 *
      (varPosition + 2 * predictionT * covPositionMotion + predictionT * predictionT * varMotion) +
    predictionT * predictionT * extraMotionVariance;

  return {
    count: rows.length,
    model,
    seasonUnresolved,
    baselineYears,
    displacement: skyVector(lastRow?.east ?? 0, lastRow?.north ?? 0),
    displacementSigma: Math.hypot(first.sigmaArcsec, last.sigmaArcsec),
    motion: skyVector(muEast, muNorth),
    motionSigma,
    scatterFactor,
    start: { ...at(0), mjd: first.mjd },
    end: { ...at(baselineYears), mjd: last.mjd },
    prediction: {
      ...at(predictionT),
      mjd: last.mjd + PREDICTION_YEARS * DAYS_PER_YEAR,
      sigmaArcsec: Math.sqrt(Math.max(predictionVariance, 0)),
    },
  };
}

// ---- Comparacion con el catalogo ---------------------------------------------

/** Una marca basta para saber de que epoca es y donde esta. */
export interface EpochPoint extends MotionPoint {
  readonly epoch: number;
}

/**
 * Hasta que distancia de la posicion esperada una marca cuenta como el objeto
 * del catalogo, en segundos de arco: algo mas de dos pixeles nativos. Mas
 * lejos, lo marcado es otra cosa y la comparacion no dice nada.
 */
export const CATALOG_MATCH_ARCSEC = 15;

export type CatalogComparison =
  | {
      readonly status: "compared";
      /** Desplazamiento y movimiento propio que da el catalogo entre las mismas epocas. */
      readonly displacement: SkyVector;
      readonly motion: SkyVector;
      /** Modulo de la diferencia vectorial entre lo medido y el catalogo, en segundos de arco por anio. */
      readonly difference: number;
      /** Esa diferencia en errores de la medicion. */
      readonly differenceSigmas: number;
      /** Mayor distancia entre una marca y la posicion esperada en su epoca, en segundos de arco. */
      readonly maxOffsetArcsec: number;
    }
  | {
      /** Lo marcado esta lejos de donde el catalogo pone al objeto: no es el. */
      readonly status: "mismatch";
      readonly maxOffsetArcsec: number;
    };

/**
 * Compara una medicion con la trayectoria de catalogo de /track. Toma las
 * posiciones esperadas en las mismas epocas que se marcaron y les aplica la
 * misma cuenta, con el mismo modelo, asi la paralaje pesa igual de los dos
 * lados. Devuelve null si el catalogo no trae todas las epocas marcadas.
 */
export function compareWithTrack(
  marks: readonly EpochPoint[],
  fit: MotionFit,
  track: readonly TrackPosition[],
): CatalogComparison | null {
  const expected: MotionPoint[] = [];
  let maxOffsetArcsec = 0;
  for (const mark of marks) {
    const position = track.find((candidate) => candidate.epoch === mark.epoch);
    if (position === undefined) continue;
    expected.push({ mjd: position.mjd, ra: position.ra, dec: position.dec, sigmaArcsec: 1 });
    maxOffsetArcsec = Math.max(maxOffsetArcsec, separationArcsec(mark, position));
  }
  if (expected.length < 2 || expected.length < marks.length) return null;
  const catalog = fitMotion(expected, { model: fit.model });
  if (catalog === null || catalog.model !== fit.model) return null;
  if (maxOffsetArcsec > CATALOG_MATCH_ARCSEC) return { status: "mismatch", maxOffsetArcsec };

  const difference = Math.hypot(
    fit.motion.east - catalog.motion.east,
    fit.motion.north - catalog.motion.north,
  );
  return {
    status: "compared",
    displacement: catalog.displacement,
    motion: catalog.motion,
    difference,
    differenceSigmas: difference / fit.motionSigma,
    maxOffsetArcsec,
  };
}
