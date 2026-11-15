// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type GridWcs, isInsideGrid, pixelToSky, separationArcsec, skyToPixel } from "./wcs";

// Grilla del ejemplo de docs/contrato-cubo.md (seccion 5): campo base de 10'
// centrado en Barnard, 195 x 195 px a 3,075"/px.
const BARNARD: GridWcs = {
  crval: [269.4463, 4.7683],
  crpix: [98.0, 98.0],
  cdelt: [-0.000854167, 0.000854167],
};

const PIXEL_ARCSEC = 0.000854167 * 3600;

function project(grid: GridWcs, ra: number, dec: number): { x: number; y: number } {
  const pixel = skyToPixel(grid, ra, dec);
  if (pixel === null) throw new Error("el punto no se puede proyectar");
  return pixel;
}

describe("pixelToSky", () => {
  it("el pixel de referencia (crpix - 1, desde 0) cae en crval", () => {
    const sky = pixelToSky(BARNARD, 97, 97);
    expect(sky.ra).toBeCloseTo(269.4463, 10);
    expect(sky.dec).toBeCloseTo(4.7683, 10);
  });

  it("x crece hacia el oeste: la ascension recta baja", () => {
    const center = pixelToSky(BARNARD, 97, 97);
    const right = pixelToSky(BARNARD, 107, 97);
    expect(right.ra).toBeLessThan(center.ra);
  });

  it("y crece hacia el norte: la declinacion sube", () => {
    const center = pixelToSky(BARNARD, 97, 97);
    const up = pixelToSky(BARNARD, 97, 107);
    expect(up.dec).toBeGreaterThan(center.dec);
    expect(up.dec - center.dec).toBeCloseTo(10 * 0.000854167, 8);
  });

  it("un pixel mide la escala de la grilla en las dos direcciones", () => {
    const center = pixelToSky(BARNARD, 97, 97);
    expect(separationArcsec(center, pixelToSky(BARNARD, 98, 97))).toBeCloseTo(PIXEL_ARCSEC, 6);
    expect(separationArcsec(center, pixelToSky(BARNARD, 97, 98))).toBeCloseTo(PIXEL_ARCSEC, 6);
  });

  it("la fila 0 es el borde sur y la columna 0 el borde este", () => {
    const southEast = pixelToSky(BARNARD, 0, 0);
    const northWest = pixelToSky(BARNARD, 194, 194);
    expect(southEast.dec).toBeLessThan(northWest.dec);
    expect(southEast.ra).toBeGreaterThan(northWest.ra);
  });

  it("devuelve la ascension recta en [0, 360) al cruzar el origen", () => {
    const grid: GridWcs = {
      crval: [0.001, 10],
      crpix: [98, 98],
      cdelt: [-0.000854167, 0.000854167],
    };
    const west = pixelToSky(grid, 150, 97);
    expect(west.ra).toBeGreaterThan(359.9);
    expect(west.ra).toBeLessThan(360);
  });
});

describe("skyToPixel", () => {
  it("crval cae en el pixel de referencia", () => {
    const pixel = project(BARNARD, 269.4463, 4.7683);
    expect(pixel.x).toBeCloseTo(97, 9);
    expect(pixel.y).toBeCloseTo(97, 9);
  });

  it("reproduce las posiciones del ejemplo de /track del contrato", () => {
    // Los valores del ejemplo estan redondeados a un decimal: se compara a 0,1 px.
    // {"ra": 269.44604, "dec": 4.76740, "x": 97.3, "y": 96.0}
    const first = project(BARNARD, 269.44604, 4.7674);
    expect(Math.abs(first.x - 97.3)).toBeLessThan(0.1);
    expect(Math.abs(first.y - 96.0)).toBeLessThan(0.1);

    // {"ra": 269.44661, "dec": 4.76896, "x": 96.6, "y": 97.8}
    const second = project(BARNARD, 269.44661, 4.76896);
    expect(Math.abs(second.x - 96.6)).toBeLessThan(0.1);
    expect(Math.abs(second.y - 97.8)).toBeLessThan(0.1);
  });

  it("es la inversa de pixelToSky en toda la grilla", () => {
    for (const [x, y] of [
      [0, 0],
      [194, 0],
      [0, 194],
      [194, 194],
      [12.25, 180.75],
      [97, 97],
    ] as const) {
      const sky = pixelToSky(BARNARD, x, y);
      const pixel = project(BARNARD, sky.ra, sky.dec);
      expect(pixel.x).toBeCloseTo(x, 7);
      expect(pixel.y).toBeCloseTo(y, 7);
    }
  });

  it("es la inversa tambien cerca del polo y en el campo amplio", () => {
    // R Draconis esta cerca del polo ecliptico, a declinacion alta.
    const grid: GridWcs = {
      crval: [248.1, 66.75],
      crpix: [147, 147],
      cdelt: [-0.00170833, 0.00170833],
    };
    for (const [x, y] of [
      [0, 0],
      [292, 292],
      [40.5, 250.25],
    ] as const) {
      const sky = pixelToSky(grid, x, y);
      const pixel = project(grid, sky.ra, sky.dec);
      expect(pixel.x).toBeCloseTo(x, 7);
      expect(pixel.y).toBeCloseTo(y, 7);
    }
  });

  it("acepta la ascension recta del otro lado del origen", () => {
    const grid: GridWcs = {
      crval: [0.001, 10],
      crpix: [98, 98],
      cdelt: [-0.000854167, 0.000854167],
    };
    const sky = pixelToSky(grid, 150, 97);
    const pixel = project(grid, sky.ra, sky.dec);
    expect(pixel.x).toBeCloseTo(150, 7);
    expect(pixel.y).toBeCloseTo(97, 7);
  });

  it("devuelve null para un punto del hemisferio opuesto", () => {
    expect(skyToPixel(BARNARD, 269.4463 + 180, -4.7683)).toBeNull();
    expect(skyToPixel(BARNARD, 269.4463 + 90, 0)).toBeNull();
  });
});

describe("isInsideGrid", () => {
  it("cuenta el pixel entero, desde su borde", () => {
    expect(isInsideGrid([195, 195], 0, 0)).toBe(true);
    expect(isInsideGrid([195, 195], -0.5, -0.5)).toBe(true);
    expect(isInsideGrid([195, 195], 194.49, 194.49)).toBe(true);
    expect(isInsideGrid([195, 195], 194.5, 97)).toBe(false);
    expect(isInsideGrid([195, 195], 97, -0.51)).toBe(false);
  });

  it("usa la forma como [ny, nx]", () => {
    expect(isInsideGrid([10, 20], 15, 5)).toBe(true);
    expect(isInsideGrid([10, 20], 5, 15)).toBe(false);
  });
});

describe("separationArcsec", () => {
  it("mide un grado sobre el ecuador y sobre un meridiano", () => {
    expect(separationArcsec({ ra: 10, dec: 0 }, { ra: 11, dec: 0 })).toBeCloseTo(3600, 6);
    expect(separationArcsec({ ra: 10, dec: 20 }, { ra: 10, dec: 21 })).toBeCloseTo(3600, 6);
  });

  it("vale cero para el mismo punto", () => {
    expect(separationArcsec({ ra: 269.4463, dec: 4.7683 }, { ra: 269.4463, dec: 4.7683 })).toBe(0);
  });

  it("da el desplazamiento de Barnard entre las dos epocas del ejemplo", () => {
    const moved = separationArcsec({ ra: 269.44604, dec: 4.7674 }, { ra: 269.44661, dec: 4.76896 });
    // 5,6" en declinacion y 2,0" en ascension recta: cerca de 6".
    expect(moved).toBeGreaterThan(5.5);
    expect(moved).toBeLessThan(6.5);
  });
});
