// Ajuste no lineal por minimos cuadrados, chico y sin dependencias: lo usa el
// ajuste por las alas (wingsFit.ts), que tiene cinco parametros y unos cientos
// de pixeles.
//
// Metodo: Levenberg-Marquardt con el amortiguamiento de Marquardt (la diagonal
// de J^T J), limites por parametro (se recorta el paso) y perdida robusta
// "soft L1", la misma de `scipy.optimize.least_squares(loss="soft_l1")`:
//
//   costo = 1/2 * sum( rho(z_i) * f^2 ),  z_i = (r_i / f)^2,  rho(z) = 2 (sqrt(1 + z) - 1)
//
// Para residuos chicos frente a `f` es minimos cuadrados; para los grandes
// crece como |r|, asi que una estrella vecina metida en las alas no arrastra
// el centro. En cada paso se pondera cada fila con sqrt(rho'(z)), que es la
// aproximacion de Gauss-Newton para una perdida robusta (Triggs et al. 2000,
// "Bundle adjustment: a modern synthesis", seccion 4.3, sin el termino de
// segundo orden).

/** Lo que se ajusta: residuos (modelo menos dato) y sus derivadas. */
export interface LeastSquaresProblem {
  /** Cantidad de residuos. */
  readonly count: number;
  /**
   * Escribe en `residuals` los `count` residuos para `params`. Si `jacobian`
   * no es null, escribe ademas las derivadas, fila por fila:
   * `jacobian[i * n + j]` es la derivada del residuo `i` respecto del parametro `j`.
   */
  evaluate(params: Float64Array, residuals: Float64Array, jacobian: Float64Array | null): void;
}

export interface LeastSquaresOptions {
  /**
   * Escala `f` de la perdida robusta, en las unidades de los residuos: mas o
   * menos el ruido de un dato. `Infinity` es minimos cuadrados comunes.
   */
  readonly lossScale?: number;
  /** Limites por parametro; `-Infinity` e `Infinity` dejan el parametro libre. */
  readonly lower?: readonly number[];
  readonly upper?: readonly number[];
  readonly maxIterations?: number;
}

export interface LeastSquaresResult {
  readonly params: Float64Array;
  /** Costo robusto final. */
  readonly cost: number;
  readonly iterations: number;
  /** false si se llego a `maxIterations` sin que el paso o el costo dejaran de cambiar. */
  readonly converged: boolean;
  /**
   * Covarianza formal de los parametros, (J^T W J)^-1 por la varianza de los
   * residuos ponderados, fila por fila. null si la matriz es singular.
   */
  readonly covariance: Float64Array | null;
}

const DEFAULT_MAX_ITERATIONS = 200;
/** El ajuste termina cuando el costo baja menos que esta fraccion en un paso aceptado. */
const COST_TOLERANCE = 1e-10;
/** O cuando el paso es menor que esta fraccion del tamano de los parametros. */
const STEP_TOLERANCE = 1e-9;
const INITIAL_DAMPING = 1e-3;
const MAX_DAMPING = 1e12;

/**
 * Resuelve `a x = b` para una matriz simetrica chica por eliminacion de Gauss
 * con pivoteo parcial. `a` va fila por fila y no se modifica. Devuelve null si
 * la matriz es singular.
 */
export function solveLinearSystem(
  a: Float64Array,
  b: Float64Array,
  size: number,
): Float64Array | null {
  const m = Float64Array.from(a);
  const x = Float64Array.from(b);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    let best = Math.abs(m[column * size + column] as number);
    for (let row = column + 1; row < size; row += 1) {
      const value = Math.abs(m[row * size + column] as number);
      if (value > best) {
        best = value;
        pivot = row;
      }
    }
    if (!(best > 1e-300)) return null;
    if (pivot !== column) {
      for (let k = 0; k < size; k += 1) {
        const swap = m[column * size + k] as number;
        m[column * size + k] = m[pivot * size + k] as number;
        m[pivot * size + k] = swap;
      }
      const swap = x[column] as number;
      x[column] = x[pivot] as number;
      x[pivot] = swap;
    }
    const diagonal = m[column * size + column] as number;
    for (let row = column + 1; row < size; row += 1) {
      const factor = (m[row * size + column] as number) / diagonal;
      if (factor === 0) continue;
      for (let k = column; k < size; k += 1) {
        m[row * size + k] =
          (m[row * size + k] as number) - factor * (m[column * size + k] as number);
      }
      x[row] = (x[row] as number) - factor * (x[column] as number);
    }
  }
  for (let row = size - 1; row >= 0; row -= 1) {
    let sum = x[row] as number;
    for (let k = row + 1; k < size; k += 1) {
      sum -= (m[row * size + k] as number) * (x[k] as number);
    }
    x[row] = sum / (m[row * size + row] as number);
  }
  for (let index = 0; index < size; index += 1) {
    if (!Number.isFinite(x[index] as number)) return null;
  }
  return x;
}

/** Inversa de una matriz simetrica chica, columna por columna. null si es singular. */
function invert(a: Float64Array, size: number): Float64Array | null {
  const inverse = new Float64Array(size * size);
  const unit = new Float64Array(size);
  for (let column = 0; column < size; column += 1) {
    unit.fill(0);
    unit[column] = 1;
    const solved = solveLinearSystem(a, unit, size);
    if (solved === null) return null;
    for (let row = 0; row < size; row += 1) {
      inverse[row * size + column] = solved[row] as number;
    }
  }
  return inverse;
}

function clampToBounds(
  params: Float64Array,
  lower: readonly number[] | undefined,
  upper: readonly number[] | undefined,
): void {
  for (let index = 0; index < params.length; index += 1) {
    const low = lower?.[index] ?? Number.NEGATIVE_INFINITY;
    const high = upper?.[index] ?? Number.POSITIVE_INFINITY;
    const value = params[index] as number;
    if (value < low) params[index] = low;
    else if (value > high) params[index] = high;
  }
}

/** Costo robusto de un vector de residuos. */
function robustCost(residuals: Float64Array, lossScale: number): number {
  let cost = 0;
  if (!Number.isFinite(lossScale)) {
    for (let index = 0; index < residuals.length; index += 1) {
      const r = residuals[index] as number;
      cost += 0.5 * r * r;
    }
    return cost;
  }
  const f2 = lossScale * lossScale;
  for (let index = 0; index < residuals.length; index += 1) {
    const r = residuals[index] as number;
    cost += f2 * (Math.sqrt(1 + (r * r) / f2) - 1);
  }
  return cost;
}

/**
 * Ajusta `problem` desde `initial`. No lanza: si el sistema es singular o el
 * costo no baja, devuelve lo mejor que encontro con `converged` en false.
 */
export function leastSquares(
  problem: LeastSquaresProblem,
  initial: readonly number[],
  options: LeastSquaresOptions = {},
): LeastSquaresResult {
  const size = initial.length;
  const count = problem.count;
  const lossScale = options.lossScale ?? Number.POSITIVE_INFINITY;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const robust = Number.isFinite(lossScale);
  const f2 = lossScale * lossScale;

  let params = Float64Array.from(initial);
  clampToBounds(params, options.lower, options.upper);
  let residuals = new Float64Array(count);
  let trialResiduals = new Float64Array(count);
  const jacobian = new Float64Array(count * size);
  const normal = new Float64Array(size * size);
  const damped = new Float64Array(size * size);
  const gradient = new Float64Array(size);

  problem.evaluate(params, residuals, jacobian);
  let cost = robustCost(residuals, lossScale);
  let damping = INITIAL_DAMPING;
  let converged = false;
  let iterations = 0;

  /** Arma J^T W J y J^T W r con los pesos de la perdida en `residuals`. */
  const buildNormal = (): void => {
    normal.fill(0);
    gradient.fill(0);
    for (let row = 0; row < count; row += 1) {
      const r = residuals[row] as number;
      const weight = robust ? 1 / Math.sqrt(1 + (r * r) / f2) : 1;
      const base = row * size;
      for (let j = 0; j < size; j += 1) {
        const scaled = weight * (jacobian[base + j] as number);
        if (scaled === 0) continue;
        gradient[j] = (gradient[j] as number) + scaled * r;
        for (let k = j; k < size; k += 1) {
          normal[j * size + k] =
            (normal[j * size + k] as number) + scaled * (jacobian[base + k] as number);
        }
      }
    }
    for (let j = 0; j < size; j += 1) {
      for (let k = 0; k < j; k += 1) normal[j * size + k] = normal[k * size + j] as number;
    }
  };

  buildNormal();

  while (iterations < maxIterations && Number.isFinite(cost)) {
    iterations += 1;
    let accepted = false;

    while (damping <= MAX_DAMPING) {
      damped.set(normal);
      for (let j = 0; j < size; j += 1) {
        const diagonal = normal[j * size + j] as number;
        // Un parametro sin efecto (derivada nula) queda quieto en vez de volver singular el sistema.
        damped[j * size + j] = diagonal + damping * (diagonal > 0 ? diagonal : 1);
      }
      const step = solveLinearSystem(damped, gradient, size);
      if (step === null) {
        damping *= 10;
        continue;
      }
      const trial = new Float64Array(size);
      for (let j = 0; j < size; j += 1) trial[j] = (params[j] as number) - (step[j] as number);
      clampToBounds(trial, options.lower, options.upper);
      problem.evaluate(trial, trialResiduals, null);
      const trialCost = robustCost(trialResiduals, lossScale);

      if (Number.isFinite(trialCost) && trialCost <= cost) {
        let moved = 0;
        let scale = 0;
        for (let j = 0; j < size; j += 1) {
          moved = Math.max(moved, Math.abs((trial[j] as number) - (params[j] as number)));
          scale = Math.max(scale, Math.abs(trial[j] as number));
        }
        const gain = cost - trialCost;
        params = trial;
        const swap = residuals;
        residuals = trialResiduals;
        trialResiduals = swap;
        const previous = cost;
        cost = trialCost;
        damping = Math.max(damping / 10, 1e-12);
        accepted = true;
        if (
          gain <= COST_TOLERANCE * Math.max(previous, 1e-300) ||
          moved <= STEP_TOLERANCE * (scale + STEP_TOLERANCE)
        ) {
          converged = true;
        }
        break;
      }
      damping *= 10;
    }

    if (!accepted) {
      // Ningun paso baja el costo: se esta en un minimo (o contra un limite).
      converged = true;
      break;
    }
    // Las derivadas del punto nuevo hacen falta para el paso siguiente y para la covarianza.
    problem.evaluate(params, residuals, jacobian);
    buildNormal();
    if (converged) break;
  }

  let covariance: Float64Array | null = null;
  const inverse = invert(normal, size);
  if (inverse !== null && count > size) {
    let weighted = 0;
    for (let row = 0; row < count; row += 1) {
      const r = residuals[row] as number;
      const weight = robust ? 1 / Math.sqrt(1 + (r * r) / f2) : 1;
      weighted += weight * r * r;
    }
    const variance = weighted / (count - size);
    covariance = inverse.map((value) => value * variance);
  }

  return { params, cost, iterations, converged, covariance };
}
