// @vitest-environment node
//
// Fuente vecina: imagenes sinteticas con una o dos fuentes y, al final, el
// plano real de WISE 0855 de src/test/fixtures.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fieldMetaSchema, trackResponseSchema } from "@/api/schema";
import { isListed } from "@/api/types";
import { FRONTEND_DIR } from "@/test/sourceFiles";
import { toPlaneImage } from "@/viewer/planeImage";
import { windowedCentroid } from "./centroid";
import { measureMark } from "./marks";
import { findNeighbor, NEIGHBOR_RADIUS_ARCSEC } from "./neighbor";
import { addGaussian, addNoise, blankCanvas, type Canvas, toImage } from "./testSupport";

/** Desvio de una fuente puntual en el cubo base, en pixeles de la grilla (como en centroid.test.ts). */
const SOURCE_SIGMA = 1.3;
const SIZE = 61;
/** Pixel de la grilla del cubo base, en segundos de arco. */
const PIXEL_ARCSEC = 3.075;
const RADIUS_PX = NEIGHBOR_RADIUS_ARCSEC / PIXEL_ARCSEC;
const CENTER = { x: 30, y: 30 };

function field(peak: number, noise: number, seed: number): Canvas {
  const canvas = blankCanvas(SIZE, SIZE, 0.5);
  addGaussian(canvas, CENTER.x, CENTER.y, peak, SOURCE_SIGMA);
  return withNoise(canvas, noise, seed);
}

function withNoise(canvas: Canvas, noise: number, seed: number): Canvas {
  addNoise(canvas, noise, seed);
  return canvas;
}

/** La posicion que mediria el centroide, que es desde donde se busca la vecina. */
function measured(canvas: Canvas) {
  const image = toImage(canvas);
  const centroid = windowedCentroid(image, CENTER);
  expect(centroid.ok).toBe(true);
  if (!centroid.ok) throw new Error("sin centroide");
  return { image, center: { x: centroid.x, y: centroid.y } };
}

describe("findNeighbor", () => {
  it.each([
    [200, 1],
    [30, 1],
    [8, 1],
  ])("una fuente sola no tiene vecina (pico %d, ruido %d)", (peak, noise) => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const { image, center } = measured(field(peak, noise, seed));
      expect(findNeighbor(image, center, { radiusPx: RADIUS_PX }), `semilla ${seed}`).toBeNull();
    }
  });

  it("encuentra una vecina con la mitad del brillo a 9,7 segundos de arco, aunque no forme un maximo aparte", () => {
    const canvas = blankCanvas(SIZE, SIZE, 0.5);
    addGaussian(canvas, CENTER.x, CENTER.y, 200, SOURCE_SIGMA);
    // A (3, 1) pixeles: 3,16 pixeles, 9,7 segundos de arco.
    addGaussian(canvas, CENTER.x + 3, CENTER.y + 1, 100, SOURCE_SIGMA);
    const { image, center } = measured(withNoise(canvas, 1, 7));

    // La vecina es un hombro: el pixel de al lado, hacia la fuente, vale mas que su pico.
    const at = (x: number, y: number) => canvas.data[y * SIZE + x] as number;
    expect(at(CENTER.x + 2, CENTER.y + 1)).toBeGreaterThan(at(CENTER.x + 3, CENTER.y + 1));

    const neighbor = findNeighbor(image, center, { radiusPx: RADIUS_PX });
    expect(neighbor).not.toBeNull();
    if (neighbor === null) return;
    expect(
      Math.hypot(neighbor.x - (CENTER.x + 3), neighbor.y - (CENTER.y + 1)),
    ).toBeLessThanOrEqual(1.5);
    expect(neighbor.distancePx * PIXEL_ARCSEC).toBeLessThan(NEIGHBOR_RADIUS_ARCSEC);
    expect(neighbor.ratio).toBeGreaterThan(0.3);
    expect(neighbor.ratio).toBeLessThan(0.6);
  });

  it("encuentra una vecina igual de brillante a 11 segundos de arco", () => {
    const canvas = blankCanvas(SIZE, SIZE, 0.5);
    addGaussian(canvas, CENTER.x, CENTER.y, 60, SOURCE_SIGMA);
    addGaussian(canvas, CENTER.x - 2, CENTER.y + 3, 60, SOURCE_SIGMA);
    const { image, center } = measured(withNoise(canvas, 1, 3));
    const neighbor = findNeighbor(image, center, { radiusPx: RADIUS_PX });
    expect(neighbor).not.toBeNull();
    expect(neighbor?.ratio).toBeGreaterThan(0.5);
  });

  it("no avisa por una vecina que esta a mas de 12 segundos de arco", () => {
    const canvas = blankCanvas(SIZE, SIZE, 0.5);
    addGaussian(canvas, CENTER.x, CENTER.y, 200, SOURCE_SIGMA);
    // A 7 pixeles: 21,5 segundos de arco.
    addGaussian(canvas, CENTER.x + 7, CENTER.y, 200, SOURCE_SIGMA);
    const { image, center } = measured(withNoise(canvas, 1, 5));
    expect(findNeighbor(image, center, { radiusPx: RADIUS_PX })).toBeNull();
  });

  it("no avisa por una vecina diez veces mas debil", () => {
    const canvas = blankCanvas(SIZE, SIZE, 0.5);
    addGaussian(canvas, CENTER.x, CENTER.y, 200, SOURCE_SIGMA);
    addGaussian(canvas, CENTER.x + 3, CENTER.y + 1, 20, SOURCE_SIGMA);
    const { image, center } = measured(withNoise(canvas, 1, 9));
    expect(findNeighbor(image, center, { radiusPx: RADIUS_PX })).toBeNull();
  });

  it("un pixel saturado a menos de 12 segundos de arco es una vecina", () => {
    const canvas = field(200, 1, 11);
    canvas.data[(CENTER.y + 2) * SIZE + (CENTER.x + 3)] = Number.POSITIVE_INFINITY;
    const neighbor = findNeighbor(toImage(canvas), CENTER, { radiusPx: RADIUS_PX });
    expect(neighbor).toMatchObject({ x: CENTER.x + 3, y: CENTER.y + 2 });
    expect(neighbor?.ratio).toBe(Number.POSITIVE_INFINITY);
  });

  it("sin datos para medir el fondo no dice nada", () => {
    const canvas = blankCanvas(SIZE, SIZE, Number.NaN);
    canvas.data[CENTER.y * SIZE + CENTER.x] = 10;
    expect(findNeighbor(toImage(canvas), CENTER, { radiusPx: RADIUS_PX })).toBeNull();
  });
});

describe("measureMark: distancia a la vecina", () => {
  const fixtures = join(FRONTEND_DIR, "src", "test", "fixtures", "wise0855");
  const meta = fieldMetaSchema.parse(JSON.parse(readFileSync(join(fixtures, "meta.json"), "utf8")));
  if (!isListed(meta)) throw new Error("fixture sin grilla");
  const grid = meta.grid;

  function mark(canvas: Canvas) {
    const [height, width] = grid.shape;
    expect([canvas.height, canvas.width]).toEqual([height, width]);
    const result = measureMark({
      image: toImage(canvas),
      grid,
      epoch: 1,
      detector: 3,
      rev: 1,
      mjd: 61000,
      click: { x: 100.4, y: 99.7 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("sin marca");
    return result.mark;
  }

  function canvasOfGrid(): Canvas {
    const [height, width] = grid.shape;
    return blankCanvas(width, height, 0.5);
  }

  it("una marca aislada no tiene vecina", () => {
    const canvas = canvasOfGrid();
    addGaussian(canvas, 100, 100, 200, SOURCE_SIGMA);
    expect(mark(withNoise(canvas, 1, 2)).neighborArcsec).toBeNull();
  });

  it("una marca con otra fuente a 3 pixeles lleva la distancia en segundos de arco", () => {
    const canvas = canvasOfGrid();
    addGaussian(canvas, 100, 100, 200, SOURCE_SIGMA);
    addGaussian(canvas, 103, 100, 120, SOURCE_SIGMA);
    const { neighborArcsec } = mark(withNoise(canvas, 1, 2));
    expect(neighborArcsec).not.toBeNull();
    expect(neighborArcsec ?? 0).toBeGreaterThan(5);
    expect(neighborArcsec ?? 99).toBeLessThan(NEIGHBOR_RADIUS_ARCSEC);
  });

  it("WISE 0855 en B6, epoca 2: la marca real no tiene vecina", () => {
    const bytes = readFileSync(join(fixtures, "plane_e2_d6.f32"));
    const floats = new Float32Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    const track = trackResponseSchema.parse(
      JSON.parse(readFileSync(join(fixtures, "track_wisea-j085510-74-071442-5.json"), "utf8")),
    );
    const expected = track.positions.find((position) => position.epoch === 2);
    const plane = meta.planes.find((item) => item.epoch === 2 && item.detector === 6);
    if (!expected || !plane || plane.mjd_mean === null) throw new Error("fixture incompleto");
    const result = measureMark({
      image: toPlaneImage(floats, grid.shape as [number, number]),
      grid,
      epoch: 2,
      detector: 6,
      rev: plane.rev,
      mjd: plane.mjd_mean,
      click: { x: expected.x, y: expected.y },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mark.neighborArcsec).toBeNull();
  });
});
