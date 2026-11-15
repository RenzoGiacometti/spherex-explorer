// @vitest-environment node
//
// Ajuste por las alas: el centro de una fuente con el nucleo saturado. Primero
// el solver, despues estrellas sinteticas con el centro conocido y, al final,
// un plano real de Barnard (src/test/fixtures, generado por el backend con
// datos de IRSA).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { splitAux } from "@/api/binary";
import { fieldMetaSchema, trackResponseSchema } from "@/api/schema";
import { isListed } from "@/api/types";
import { FRONTEND_DIR } from "@/test/sourceFiles";
import { toPlaneImage } from "@/viewer/planeImage";
import { measureMark } from "./marks";
import { type LeastSquaresProblem, leastSquares, solveLinearSystem } from "./solver";
import {
  addGaussian,
  addMoffat,
  addNoise,
  blankCanvas,
  type Canvas,
  fillDisk,
  saturateAbove,
  seededNormal,
  toImage,
} from "./testSupport";
import { fitWings, nearestSaturatedPixel, saturatedCore } from "./wingsFit";

// ---- Solver ------------------------------------------------------------------

/** Recta y = a + b x sobre unos puntos, como problema de minimos cuadrados. */
function lineProblem(xs: readonly number[], ys: readonly number[]): LeastSquaresProblem {
  return {
    count: xs.length,
    evaluate(params, residuals, jacobian) {
      for (let index = 0; index < xs.length; index += 1) {
        const x = xs[index] as number;
        residuals[index] =
          (params[0] as number) + (params[1] as number) * x - (ys[index] as number);
        if (jacobian !== null) {
          jacobian[index * 2] = 1;
          jacobian[index * 2 + 1] = x;
        }
      }
    },
  };
}

describe("solveLinearSystem", () => {
  it("resuelve un sistema de 3 por 3", () => {
    const a = Float64Array.from([4, 1, 2, 1, 5, 3, 2, 3, 6]);
    const solved = solveLinearSystem(a, Float64Array.from([4, 1, 2]), 3);
    expect(solved).not.toBeNull();
    // Se comprueba volviendo a multiplicar.
    const product = [0, 1, 2].map((row) =>
      [0, 1, 2].reduce((sum, k) => sum + (a[row * 3 + k] as number) * (solved?.[k] ?? 0), 0),
    );
    expect(product[0]).toBeCloseTo(4, 10);
    expect(product[1]).toBeCloseTo(1, 10);
    expect(product[2]).toBeCloseTo(2, 10);
  });

  it("necesita pivoteo cuando el primer elemento es cero", () => {
    const solved = solveLinearSystem(Float64Array.from([0, 2, 3, 1]), Float64Array.from([4, 5]), 2);
    expect(solved?.[0]).toBeCloseTo(1, 12);
    expect(solved?.[1]).toBeCloseTo(2, 12);
  });

  it("devuelve null si la matriz es singular", () => {
    expect(
      solveLinearSystem(Float64Array.from([1, 2, 2, 4]), Float64Array.from([1, 2]), 2),
    ).toBeNull();
  });
});

describe("leastSquares", () => {
  const xs = Array.from({ length: 21 }, (_unused, index) => index - 10);

  it("ajusta una recta exacta desde lejos", () => {
    const ys = xs.map((x) => 3 - 0.5 * x);
    const fit = leastSquares(lineProblem(xs, ys), [100, 100]);
    expect(fit.converged).toBe(true);
    expect(fit.params[0]).toBeCloseTo(3, 8);
    expect(fit.params[1]).toBeCloseTo(-0.5, 8);
    expect(fit.cost).toBeLessThan(1e-12);
  });

  it("ajusta un modelo no lineal: una exponencial", () => {
    const truth = [5, -0.3];
    const ys = xs.map((x) => (truth[0] as number) * Math.exp((truth[1] as number) * x));
    const problem: LeastSquaresProblem = {
      count: xs.length,
      evaluate(params, residuals, jacobian) {
        for (let index = 0; index < xs.length; index += 1) {
          const x = xs[index] as number;
          const e = Math.exp((params[1] as number) * x);
          residuals[index] = (params[0] as number) * e - (ys[index] as number);
          if (jacobian !== null) {
            jacobian[index * 2] = e;
            jacobian[index * 2 + 1] = (params[0] as number) * x * e;
          }
        }
      },
    };
    const fit = leastSquares(problem, [1, -0.1]);
    expect(fit.converged).toBe(true);
    expect(fit.params[0]).toBeCloseTo(5, 6);
    expect(fit.params[1]).toBeCloseTo(-0.3, 6);
  });

  it("con la perdida robusta, unos pocos datos disparados no mueven el ajuste", () => {
    const normal = seededNormal(4);
    const ys = xs.map((x) => 3 - 0.5 * x + 0.05 * normal());
    // Tres datos muy por encima, todos del mismo lado.
    ys[17] = 40;
    ys[18] = 55;
    ys[19] = 60;
    const plain = leastSquares(lineProblem(xs, ys), [0, 0]);
    const robust = leastSquares(lineProblem(xs, ys), [0, 0], { lossScale: 0.05 });
    expect(Math.abs((plain.params[1] as number) + 0.5)).toBeGreaterThan(0.5);
    expect(robust.params[0]).toBeCloseTo(3, 1);
    expect(robust.params[1]).toBeCloseTo(-0.5, 1);
  });

  it("respeta los limites de los parametros", () => {
    const ys = xs.map((x) => 3 - 0.5 * x);
    const fit = leastSquares(lineProblem(xs, ys), [0, 0], { lower: [-10, -0.2], upper: [10, 0.2] });
    expect(fit.params[1]).toBeGreaterThanOrEqual(-0.2);
    expect(fit.params[1]).toBeCloseTo(-0.2, 6);
  });

  it("la covarianza formal coincide con la de la recta", () => {
    const normal = seededNormal(9);
    const sigma = 0.2;
    const ys = xs.map((x) => 1 + 2 * x + sigma * normal());
    const fit = leastSquares(lineProblem(xs, ys), [0, 0]);
    // Para x simetricos alrededor de 0: var(a) = s^2 / n, var(b) = s^2 / sum(x^2).
    const sumSquares = xs.reduce((sum, x) => sum + x * x, 0);
    expect(fit.covariance).not.toBeNull();
    const varianceA = fit.covariance?.[0] ?? 0;
    const varianceB = fit.covariance?.[3] ?? 0;
    expect(Math.sqrt(varianceA)).toBeGreaterThan((0.6 * sigma) / Math.sqrt(xs.length));
    expect(Math.sqrt(varianceA)).toBeLessThan((1.5 * sigma) / Math.sqrt(xs.length));
    expect(varianceB / varianceA).toBeCloseTo(xs.length / sumSquares, 6);
  });
});

// ---- Estrellas sinteticas ------------------------------------------------------

const SIZE = 81;
/** Ancho del perfil con el que se arman las estrellas: el mismo que supone el ajuste en el cubo base. */
const WIDTH = 3;

/** Estrella de Moffat con el nucleo saturado por encima de `threshold`. */
function saturatedStar(
  x: number,
  y: number,
  options: { peak?: number; beta?: number; threshold?: number; noise?: number; seed?: number } = {},
): { canvas: Canvas; saturated: number } {
  const canvas = blankCanvas(SIZE, SIZE, 0.2);
  addMoffat(canvas, x, y, options.peak ?? 4000, WIDTH, options.beta ?? 1.6);
  addNoise(canvas, options.noise ?? 0.02, options.seed ?? 1);
  const saturated = saturateAbove(canvas, options.threshold ?? 150);
  return { canvas, saturated };
}

describe("region saturada", () => {
  it("encuentra el pixel saturado mas cercano, hasta el alcance pedido", () => {
    const { canvas } = saturatedStar(40, 40);
    const image = toImage(canvas);
    expect(nearestSaturatedPixel(image, { x: 40, y: 40 }, 3)).toEqual({ x: 40, y: 40 });
    expect(nearestSaturatedPixel(image, { x: 60, y: 60 }, 3)).toBeNull();
    const fromOutside = nearestSaturatedPixel(image, { x: 40, y: 49 }, 3);
    expect(fromOutside).not.toBeNull();
    expect(fromOutside?.x).toBe(40);
  });

  it("mide la region conexa: cantidad de pixeles, centro y radio equivalente", () => {
    const canvas = blankCanvas(SIZE, SIZE, 0);
    fillDisk(canvas, 40, 38, 5, Number.POSITIVE_INFINITY);
    const core = saturatedCore(toImage(canvas), { x: 42, y: 40 });
    expect(core).not.toBeNull();
    expect(core?.pixels).toBe(81);
    expect(core?.x).toBeCloseTo(40, 6);
    expect(core?.y).toBeCloseTo(38, 6);
    expect(core?.radius).toBeCloseTo(Math.sqrt(81 / Math.PI), 6);
  });

  it("dos regiones que no se tocan son dos fuentes", () => {
    const canvas = blankCanvas(SIZE, SIZE, 0);
    fillDisk(canvas, 30, 30, 3, Number.POSITIVE_INFINITY);
    fillDisk(canvas, 50, 30, 2, Number.POSITIVE_INFINITY);
    const image = toImage(canvas);
    expect(saturatedCore(image, { x: 30, y: 30 })?.pixels).toBe(29);
    expect(saturatedCore(image, { x: 50, y: 30 })?.pixels).toBe(13);
    // Un pixel que no esta saturado no es semilla de nada.
    expect(saturatedCore(image, { x: 40, y: 30 })).toBeNull();
  });
});

describe("fitWings: estrella sintetica", () => {
  it.each([
    [40, 40],
    [40.5, 40.5],
    [39.27, 41.64],
    [41.8, 38.3],
  ])("recupera el centro (%f, %f) sin ningun pixel del nucleo", (x, y) => {
    const { canvas, saturated } = saturatedStar(x, y);
    expect(saturated).toBeGreaterThan(60);
    const result = fitWings(toImage(canvas), { x: 40, y: 40 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.x).toBeCloseTo(x, 1);
    expect(result.y).toBeCloseTo(y, 1);
    expect(Math.hypot(result.x - x, result.y - y)).toBeLessThan(0.03);
    expect(result.core.pixels).toBe(saturated);
    expect(result.coverageUsed).toBe(false);
  });

  it.each([
    ["chico", 400, 8],
    ["mediano", 4000, 60],
    ["grande", 40000, 250],
  ])("con un nucleo %s", (_name, peak, minimum) => {
    const { canvas, saturated } = saturatedStar(40.3, 39.6, { peak });
    expect(saturated).toBeGreaterThanOrEqual(minimum);
    const result = fitWings(toImage(canvas), { x: 40, y: 40 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Math.hypot(result.x - 40.3, result.y - 39.6)).toBeLessThan(0.05);
  });

  it("no hace falta que el perfil real tenga el exponente de partida", () => {
    for (const beta of [1.1, 2.4]) {
      const { canvas } = saturatedStar(40.3, 39.6, { beta, peak: 8000 });
      const result = fitWings(toImage(canvas), { x: 40, y: 40 });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(Math.hypot(result.x - 40.3, result.y - 39.6)).toBeLessThan(0.05);
      expect(result.beta).toBeCloseTo(beta, 1);
    }
  });

  it("el centro no depende de donde cae el clic", () => {
    const { canvas } = saturatedStar(40.3, 39.6);
    const image = toImage(canvas);
    const first = fitWings(image, { x: 40, y: 40 });
    const second = fitWings(image, { x: 37.2, y: 42.9 });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.x).toBeCloseTo(first.x, 6);
    expect(second.y).toBeCloseTo(first.y, 6);
  });

  it("aguanta una mascara que no es simetrica alrededor de la estrella", () => {
    const { canvas } = saturatedStar(40.3, 39.6);
    // Como el sangrado: un lobulo saturado mas hacia un lado, y un hueco sin datos al otro.
    fillDisk(canvas, 46, 41, 3.5, Number.POSITIVE_INFINITY);
    fillDisk(canvas, 33, 37, 2.5, Number.NaN);
    const result = fitWings(toImage(canvas), { x: 40, y: 40 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // El centro geometrico de lo saturado queda corrido casi medio pixel; el ajuste no.
    expect(Math.abs(result.core.x - 40.3)).toBeGreaterThan(0.3);
    expect(Math.hypot(result.x - 40.3, result.y - 39.6)).toBeLessThan(0.05);
  });

  it("una estrella vecina metida en las alas no arrastra el centro", () => {
    const { canvas } = saturatedStar(40.3, 39.6);
    addGaussian(canvas, 48, 43, 60, 1.3);
    addGaussian(canvas, 34, 33, 25, 1.3);
    const result = fitWings(toImage(canvas), { x: 40, y: 40 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Math.hypot(result.x - 40.3, result.y - 39.6)).toBeLessThan(0.1);
  });

  it("con ruido, el centro queda dentro de unas centesimas de pixel", () => {
    const errors: number[] = [];
    for (let seed = 1; seed <= 12; seed += 1) {
      const { canvas } = saturatedStar(40.3, 39.6, { noise: 0.5, seed });
      const result = fitWings(toImage(canvas), { x: 40, y: 40 });
      expect(result.ok).toBe(true);
      if (result.ok) errors.push(Math.hypot(result.x - 40.3, result.y - 39.6));
    }
    expect(Math.max(...errors)).toBeLessThan(0.1);
  });

  it("ajusta en el cubo amplio, con el perfil la mitad de ancho", () => {
    const canvas = blankCanvas(SIZE, SIZE, 0.2);
    addMoffat(canvas, 40.3, 39.6, 4000, WIDTH / 2, 1.6);
    addNoise(canvas, 0.02, 2);
    saturateAbove(canvas, 150);
    const result = fitWings(toImage(canvas), { x: 40, y: 40 }, { oversample: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Math.hypot(result.x - 40.3, result.y - 39.6)).toBeLessThan(0.05);
  });
});

describe("fitWings: capa de cobertura", () => {
  /**
   * Una estrella como las del coadd: alrededor del nucleo queda una franja a la
   * que aporto solo una parte de las exposiciones, y ahi el valor sale mas bajo
   * de un lado que del otro.
   */
  function partiallyCovered(): { canvas: Canvas; coverage: Uint16Array } {
    const { canvas } = saturatedStar(40.3, 39.6);
    const coverage = new Uint16Array(SIZE * SIZE).fill(20);
    for (let row = 0; row < SIZE; row += 1) {
      for (let column = 0; column < SIZE; column += 1) {
        const index = row * SIZE + column;
        const distance = Math.hypot(column - 40.3, row - 39.6);
        const value = canvas.data[index] as number;
        if (!Number.isFinite(value)) {
          coverage[index] = 0;
        } else if (distance < 12) {
          coverage[index] = 6;
          // Del lado oeste la franja quedo con las exposiciones mas debiles.
          if (column > 40.3) canvas.data[index] = value * 0.6;
        }
      }
    }
    return { canvas, coverage };
  }

  it("sin la capa, la franja de cobertura parcial corre el centro", () => {
    const { canvas } = partiallyCovered();
    const result = fitWings(toImage(canvas), { x: 40, y: 40 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.coverageUsed).toBe(false);
    expect(Math.hypot(result.x - 40.3, result.y - 39.6)).toBeGreaterThan(0.3);
  });

  it("con la capa se ajusta solo donde la cobertura es completa, y el centro vuelve a su lugar", () => {
    const { canvas, coverage } = partiallyCovered();
    const result = fitWings(toImage(canvas), { x: 40, y: 40 }, { coverage });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.coverageUsed).toBe(true);
    expect(Math.hypot(result.x - 40.3, result.y - 39.6)).toBeLessThan(0.05);
  });

  it("una capa de otro tamano se ignora", () => {
    const { canvas } = partiallyCovered();
    const result = fitWings(toImage(canvas), { x: 40, y: 40 }, { coverage: new Uint16Array(10) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.coverageUsed).toBe(false);
  });
});

describe("fitWings: cuando no hay ajuste", () => {
  it("sin pixeles saturados cerca del punto", () => {
    const canvas = blankCanvas(SIZE, SIZE, 0);
    addGaussian(canvas, 40, 40, 100, 1.3);
    expect(fitWings(toImage(canvas), { x: 40, y: 40 })).toEqual({
      ok: false,
      reason: "not-saturated",
    });
  });

  it("sin datos alrededor del nucleo", () => {
    const canvas = blankCanvas(SIZE, SIZE, Number.NaN);
    fillDisk(canvas, 40, 40, 4, Number.POSITIVE_INFINITY);
    expect(fitWings(toImage(canvas), { x: 40, y: 40 })).toEqual({ ok: false, reason: "no-data" });
  });

  it("una mancha saturada sin alas no es una estrella", () => {
    const canvas = blankCanvas(SIZE, SIZE, 1);
    addNoise(canvas, 0.05, 6);
    fillDisk(canvas, 40, 40, 4, Number.POSITIVE_INFINITY);
    const result = fitWings(toImage(canvas), { x: 40, y: 40 });
    // Sin gradiente no hay centro que ajustar: o no converge, o el error es enorme.
    if (result.ok) expect(Math.max(result.sigmaX, result.sigmaY)).toBeGreaterThan(0.5);
    else expect(result.reason).toBe("no-fit");
  });
});

// ---- Datos reales --------------------------------------------------------------

describe("datos reales: Barnard, epoca 1, banda 3", () => {
  const folder = join(FRONTEND_DIR, "src", "test", "fixtures", "barnard");
  const meta = fieldMetaSchema.parse(JSON.parse(readFileSync(join(folder, "meta.json"), "utf8")));
  const track = trackResponseSchema.parse(
    JSON.parse(readFileSync(join(folder, "track_name-barnard-s-star.json"), "utf8")),
  );
  const planeBytes = readFileSync(join(folder, "plane_e1_d3.f32"));
  const floats = new Float32Array(
    planeBytes.buffer.slice(planeBytes.byteOffset, planeBytes.byteOffset + planeBytes.byteLength),
  );
  const auxBytes = gunzipSync(readFileSync(join(folder, "aux_e1_d3.bin.gz")));
  const auxBuffer = auxBytes.buffer.slice(
    auxBytes.byteOffset,
    auxBytes.byteOffset + auxBytes.byteLength,
  ) as ArrayBuffer;

  it("el nucleo esta saturado y el centro sale de las alas, cerca de la posicion de catalogo", () => {
    expect(isListed(meta)).toBe(true);
    if (!isListed(meta)) return;
    const shape = meta.grid.shape as [number, number];
    const expected = track.positions.find((position) => position.epoch === 1);
    const plane = meta.planes.find((item) => item.epoch === 1 && item.detector === 3);
    expect(expected).toBeDefined();
    if (!expected || !plane || plane.mjd_mean === null) return;

    const image = toPlaneImage(floats, shape);
    const { coverage } = splitAux(auxBuffer, shape);
    const scale = meta.grid.pixel_scale_arcsec;

    const covered = measureMark({
      image,
      grid: meta.grid,
      epoch: 1,
      detector: 3,
      rev: plane.rev,
      mjd: plane.mjd_mean,
      click: { x: expected.x + 2, y: expected.y - 3 },
      coverage,
    });
    expect(covered.ok).toBe(true);
    if (!covered.ok) return;
    expect(covered.mark.method).toBe("wings");
    expect(covered.mark.needsCoverage).toBe(false);
    expect(covered.mark.saturatedPixels).toBe(plane.saturated[0]?.n_pixels);
    // La posicion de catalogo es la de la fecha media de la epoca, una semana
    // despues de la del plano (0,2 segundos de arco de movimiento propio), y
    // las alas tienen su corrimiento estacional (marks.ts).
    const coveredOffset =
      Math.hypot(covered.mark.x - expected.x, covered.mark.y - expected.y) * scale;
    expect(coveredOffset).toBeLessThan(2);
    expect(covered.mark.sigmaArcsec).toBeGreaterThanOrEqual(0.3);
    expect(covered.mark.sigmaArcsec).toBeLessThan(0.5);

    // Sin la capa de cobertura tambien hay posicion, con un error mayor.
    const uncovered = measureMark({
      image,
      grid: meta.grid,
      epoch: 1,
      detector: 3,
      rev: plane.rev,
      mjd: plane.mjd_mean,
      click: { x: expected.x, y: expected.y },
    });
    expect(uncovered.ok).toBe(true);
    if (!uncovered.ok) return;
    expect(uncovered.mark.needsCoverage).toBe(true);
    expect(uncovered.mark.sigmaArcsec).toBeGreaterThan(covered.mark.sigmaArcsec);
    const uncoveredOffset =
      Math.hypot(uncovered.mark.x - expected.x, uncovered.mark.y - expected.y) * scale;
    expect(uncoveredOffset).toBeLessThan(3);
  });
});
