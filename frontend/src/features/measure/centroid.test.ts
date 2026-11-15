// @vitest-environment node
//
// Centroide local: el clic se lleva al centro de la fuente. Imagenes
// sinteticas con el centro conocido y, al final, un plano real de WISE 0855
// (src/test/fixtures, generado por el backend con datos de IRSA).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fieldMetaSchema, trackResponseSchema } from "@/api/schema";
import { isListed } from "@/api/types";
import { FRONTEND_DIR } from "@/test/sourceFiles";
import { toPlaneImage } from "@/viewer/planeImage";
import { MIN_SNR, noiseCorrelationFactor, windowedCentroid } from "./centroid";
import { measureMark } from "./marks";
import { snapToSource } from "./snap";
import {
  addGaussian,
  addNoise,
  blankCanvas,
  fillDisk,
  saturateAbove,
  seededRandom,
  toImage,
} from "./testSupport";

/** Desvio de una fuente puntual en el cubo base: unos 1,3 pixeles de la grilla. */
const SOURCE_SIGMA = 1.3;
const SIZE = 61;

function star(x: number, y: number, peak = 100, noise = 0, seed = 1) {
  const canvas = blankCanvas(SIZE, SIZE, 0.5);
  addGaussian(canvas, x, y, peak, SOURCE_SIGMA);
  // Un ruido minimo siempre: el fondo se mide con la dispersion del anillo.
  addNoise(canvas, noise > 0 ? noise : 1e-3, seed);
  return canvas;
}

describe("windowedCentroid: fuente aislada", () => {
  it.each([
    [30, 30],
    [30.5, 30.5],
    [29.27, 31.64],
    [31.9, 28.1],
  ])("encuentra el centro (%f, %f) con el clic justo encima", (x, y) => {
    const result = windowedCentroid(toImage(star(x, y)), { x: Math.round(x), y: Math.round(y) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.x).toBeCloseTo(x, 2);
    expect(result.y).toBeCloseTo(y, 2);
  });

  it.each([
    [1.5, 0],
    [0, -1.5],
    [1.4, 1.4],
    [-2, 1],
    [2.5, -1.5],
  ])("no depende de donde cae el clic: corrido (%f, %f) pixeles da el mismo centro", (dx, dy) => {
    const image = toImage(star(30.31, 29.78));
    const result = windowedCentroid(image, { x: 30.31 + dx, y: 29.78 + dy });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.x).toBeCloseTo(30.31, 2);
    expect(result.y).toBeCloseTo(29.78, 2);
  });

  it("no se deja llevar por un fondo alto y parejo", () => {
    const canvas = blankCanvas(SIZE, SIZE, 250);
    addGaussian(canvas, 30.4, 30.2, 20, SOURCE_SIGMA);
    addNoise(canvas, 0.01, 3);
    const result = windowedCentroid(toImage(canvas), { x: 31, y: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.x).toBeCloseTo(30.4, 2);
    expect(result.y).toBeCloseTo(30.2, 2);
    expect(result.background).toBeCloseTo(250, 1);
  });

  it("se queda con la fuente del clic si a 4 pixeles hay una vecina mas debil", () => {
    const canvas = star(30, 30, 50);
    addGaussian(canvas, 34, 31, 25, SOURCE_SIGMA);
    const result = windowedCentroid(toImage(canvas), { x: 30, y: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // La vecina tira del centro, pero poco: menos de un sexto de pixel.
    expect(Math.hypot(result.x - 30, result.y - 30)).toBeLessThan(0.17);
  });

  it("una vecina igual de brillante a 4 pixeles corre el centro: es el limite del metodo", () => {
    // A 12 segundos de arco dos fuentes ya se montan (el pixel nativo mide 6):
    // el centroide de una queda corrido hacia la otra.
    const canvas = star(30, 30, 50);
    addGaussian(canvas, 34, 31, 50, SOURCE_SIGMA);
    const result = windowedCentroid(toImage(canvas), { x: 30, y: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pull = Math.hypot(result.x - 30, result.y - 30);
    expect(pull).toBeGreaterThan(0.15);
    expect(pull).toBeLessThan(0.6);
    // Corrido hacia la vecina, no hacia otro lado.
    expect(result.x).toBeGreaterThan(30);
  });

  it("usa una ventana mas chica en el cubo amplio, que no esta sobremuestreado", () => {
    const canvas = blankCanvas(SIZE, SIZE, 0);
    addGaussian(canvas, 30.3, 29.6, 100, 0.75);
    addNoise(canvas, 1e-3, 5);
    const result = windowedCentroid(toImage(canvas), { x: 30, y: 30 }, { oversample: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.x).toBeCloseTo(30.3, 1);
    expect(result.y).toBeCloseTo(29.6, 1);
  });
});

describe("windowedCentroid: ruido y error", () => {
  it("el error informado coincide con la dispersion real de la posicion", () => {
    const random = seededRandom(11);
    const noise = 1;
    const errorsX: number[] = [];
    const errorsY: number[] = [];
    const formal: number[] = [];
    for (let trial = 0; trial < 150; trial += 1) {
      const x = 30 + random() - 0.5;
      const y = 30 + random() - 0.5;
      // Pico de 12 veces el ruido: una fuente debil pero clara.
      const result = windowedCentroid(toImage(star(x, y, 12, noise, 100 + trial)), { x, y });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      errorsX.push(result.x - x);
      errorsY.push(result.y - y);
      formal.push(result.sigmaX, result.sigmaY);
    }
    const rms = (values: number[]) =>
      Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
    const scatter = rms([...errorsX, ...errorsY]);
    // El ruido de este test es independiente entre pixeles: el error formal
    // lleva el factor por ruido correlacionado del coadd, que aca no hay.
    const predicted = rms(formal) / noiseCorrelationFactor(2);
    expect(scatter).toBeGreaterThan(0.05);
    expect(scatter / predicted).toBeGreaterThan(0.75);
    expect(scatter / predicted).toBeLessThan(1.35);
    // Sin sesgo: la media del error es chica frente a su dispersion.
    const mean = errorsX.reduce((sum, value) => sum + value, 0) / errorsX.length;
    expect(Math.abs(mean)).toBeLessThan((3 * scatter) / Math.sqrt(errorsX.length));
  });

  it("el error baja cuando la fuente es mas brillante", () => {
    const faint = windowedCentroid(toImage(star(30.2, 30.1, 10, 1, 7)), { x: 30, y: 30 });
    const bright = windowedCentroid(toImage(star(30.2, 30.1, 100, 1, 7)), { x: 30, y: 30 });
    expect(faint.ok && bright.ok).toBe(true);
    if (!faint.ok || !bright.ok) return;
    expect(bright.sigmaX).toBeLessThan(faint.sigmaX / 5);
    expect(bright.snr).toBeGreaterThan(faint.snr * 5);
  });
});

describe("windowedCentroid: cuando no hay posicion", () => {
  it("fuera de la imagen", () => {
    const image = toImage(star(30, 30));
    expect(windowedCentroid(image, { x: -3, y: 30 })).toEqual({ ok: false, reason: "outside" });
    expect(windowedCentroid(image, { x: 30, y: SIZE + 2 })).toEqual({
      ok: false,
      reason: "outside",
    });
    expect(windowedCentroid(image, { x: Number.NaN, y: 30 })).toEqual({
      ok: false,
      reason: "outside",
    });
  });

  it("en cielo vacio no inventa una fuente", () => {
    const canvas = blankCanvas(SIZE, SIZE, 0);
    addNoise(canvas, 1, 21);
    const image = toImage(canvas);
    let found = 0;
    for (let y = 12; y <= 48; y += 6) {
      for (let x = 12; x <= 48; x += 6) {
        const result = windowedCentroid(image, { x, y });
        if (result.ok) {
          found += 1;
          expect(result.snr).toBeGreaterThanOrEqual(MIN_SNR);
        } else {
          expect(["no-source", "lost"]).toContain(result.reason);
        }
      }
    }
    // 49 clics sobre ruido puro: a lo sumo alguno cae sobre un pico de 3 sigma.
    expect(found).toBeLessThanOrEqual(3);
  });

  it("sin datos bajo el clic", () => {
    const canvas = star(30, 30);
    fillDisk(canvas, 30, 30, 4, Number.NaN);
    expect(windowedCentroid(toImage(canvas), { x: 30, y: 30 })).toEqual({
      ok: false,
      reason: "no-data",
    });
  });

  it("sin datos alrededor: no hay con que medir el fondo", () => {
    const canvas = blankCanvas(SIZE, SIZE, Number.NaN);
    fillDisk(canvas, 30, 30, 4, 1);
    expect(windowedCentroid(toImage(canvas), { x: 30, y: 30 })).toEqual({
      ok: false,
      reason: "no-data",
    });
  });

  it("avisa si en la ventana hay pixeles saturados, y dice donde", () => {
    const canvas = star(30, 30, 1000);
    expect(saturateAbove(canvas, 600)).toBeGreaterThan(0);
    const result = windowedCentroid(toImage(canvas), { x: 31, y: 30 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("saturated");
    expect(Math.hypot((result.at?.x ?? 0) - 30, (result.at?.y ?? 0) - 30)).toBeLessThanOrEqual(2);
  });
});

describe("snapToSource: del clic a la fuente", () => {
  it("sin saturacion usa el centroide", () => {
    const result = snapToSource(toImage(star(30.4, 29.7)), { x: 31, y: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.method).toBe("centroid");
    expect(result.saturatedPixels).toBe(0);
    expect(result.x).toBeCloseTo(30.4, 2);
    expect(result.y).toBeCloseTo(29.7, 2);
  });

  it("con el nucleo saturado pasa al ajuste por las alas", () => {
    const canvas = star(30.4, 29.7, 5000);
    const saturated = saturateAbove(canvas, 600);
    const result = snapToSource(toImage(canvas), { x: 30, y: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.method).toBe("wings");
    expect(result.saturatedPixels).toBe(saturated);
    expect(result.snr).toBeNull();
  });

  it("tambien cuando el clic cae en las alas y el centroide llega despues a lo saturado", () => {
    const canvas = star(30.4, 29.7, 5000);
    saturateAbove(canvas, 600);
    // A 5 pixeles del centro no hay nada saturado al alcance del clic.
    const result = snapToSource(toImage(canvas), { x: 35.4, y: 29.7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.method).toBe("wings");
  });

  it("un clic en cielo vacio no da posicion", () => {
    const canvas = blankCanvas(SIZE, SIZE, 0);
    addNoise(canvas, 1, 33);
    // Un punto del ruido que no llega a 3 sigma: el clic no encuentra fuente.
    const image = toImage(canvas);
    const results = [
      snapToSource(image, { x: 20, y: 20 }),
      snapToSource(image, { x: 40, y: 22 }),
      snapToSource(image, { x: 25, y: 41 }),
    ];
    expect(results.some((result) => !result.ok && result.reason === "no-source")).toBe(true);
  });
});

describe("datos reales: WISE 0855, epoca 2, banda 6", () => {
  const folder = join(FRONTEND_DIR, "src", "test", "fixtures", "wise0855");
  const meta = fieldMetaSchema.parse(JSON.parse(readFileSync(join(folder, "meta.json"), "utf8")));
  const track = trackResponseSchema.parse(
    JSON.parse(readFileSync(join(folder, "track_wisea-j085510-74-071442-5.json"), "utf8")),
  );
  const bytes = readFileSync(join(folder, "plane_e2_d6.f32"));
  const floats = new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );

  it("el clic sobre la posicion de catalogo queda a menos de 1,5 segundos de arco de ella", () => {
    expect(isListed(meta)).toBe(true);
    if (!isListed(meta)) return;
    const expected = track.positions.find((position) => position.epoch === 2);
    const plane = meta.planes.find((item) => item.epoch === 2 && item.detector === 6);
    expect(expected).toBeDefined();
    expect(plane?.mjd_mean).not.toBeNull();
    if (!expected || !plane || plane.mjd_mean === null) return;

    const image = toPlaneImage(floats, meta.grid.shape as [number, number]);
    for (const [dx, dy] of [
      [0, 0],
      [0.9, -0.6],
      [-1.1, 0.8],
    ] as const) {
      const result = measureMark({
        image,
        grid: meta.grid,
        epoch: 2,
        detector: 6,
        rev: plane.rev,
        mjd: plane.mjd_mean,
        click: { x: expected.x + dx, y: expected.y + dy },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const { mark } = result;
      expect(mark.method).toBe("centroid");
      const offsetArcsec =
        Math.hypot(mark.x - expected.x, mark.y - expected.y) * meta.grid.pixel_scale_arcsec;
      expect(offsetArcsec).toBeLessThan(1.5);
      // 21 exposiciones: una deteccion clara, con un error de unas decimas.
      expect(mark.snr).toBeGreaterThan(10);
      expect(mark.sigmaArcsec).toBeGreaterThan(0.2);
      expect(mark.sigmaArcsec).toBeLessThan(0.6);
    }
  });
});
