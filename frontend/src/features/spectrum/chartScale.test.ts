import { describe, expect, it } from "vitest";
import { layoutLabels, linearScale, WAVE_MAX_UM, WAVE_MIN_UM } from "./chartScale";
import { bandCenter, MOLECULE_BANDS } from "./molecules";

/** Centros de las bandas moleculares en un grafico con ese ancho de zona de datos, px. */
function bandCentres(plotWidth: number): number[] {
  const x = linearScale([WAVE_MIN_UM, WAVE_MAX_UM], [52, 52 + plotWidth]);
  return MOLECULE_BANDS.map((band) => x(bandCenter(band)));
}

/** Menor distancia entre dos rotulos dibujados en un mismo renglon. */
function closestInRow(centres: readonly number[], rows: readonly (number | null)[]): number {
  let closest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < centres.length; i += 1) {
    for (let j = i + 1; j < centres.length; j += 1) {
      if (rows[i] === null || rows[i] !== rows[j]) continue;
      closest = Math.min(closest, Math.abs((centres[j] ?? 0) - (centres[i] ?? 0)));
    }
  }
  return closest;
}

describe("layoutLabels", () => {
  it("deja en el renglon de abajo los rotulos que no se tocan", () => {
    expect(layoutLabels([10, 60, 110], { rows: 2, minGap: 34 })).toEqual([0, 0, 0]);
  });

  it("sube al segundo renglon el que choca con el anterior", () => {
    expect(layoutLabels([10, 30, 60, 70], { rows: 2, minGap: 34 })).toEqual([0, 1, 0, 1]);
  });

  it("saltea el que choca en todos los renglones", () => {
    // 10 y 20 ocupan los dos renglones; 30 esta a menos de 34 px de los dos.
    expect(layoutLabels([10, 20, 30, 44], { rows: 2, minGap: 34 })).toEqual([0, 1, null, 0]);
  });

  it("no pone un rotulo sobre lo reservado al comienzo de un renglon", () => {
    // El renglon de arriba esta ocupado hasta 88 px: 97 empezaria en 80 y no entra; 106 si.
    const options = { rows: 2, minGap: 34, reserved: [Number.NEGATIVE_INFINITY, 88] };
    expect(layoutLabels([84, 97, 106], options)).toEqual([0, null, 1]);
  });

  it("sin renglones no dibuja ninguno", () => {
    expect(layoutLabels([10, 60], { rows: 0, minGap: 34 })).toEqual([null, null]);
  });

  it("rotula las ocho bandas moleculares en dos renglones cuando el grafico es ancho", () => {
    const centres = bandCentres(456);
    const rows = layoutLabels(centres, { rows: 2, minGap: 34 });
    expect(rows).not.toContain(null);
    expect(closestInRow(centres, rows)).toBeGreaterThanOrEqual(34);
  });

  it.each([274, 240, 202, 160])(
    "con %i px de ancho ningun rotulo queda a menos de la separacion minima de otro del renglon",
    (plotWidth) => {
      const centres = bandCentres(plotWidth);
      const rows = layoutLabels(centres, { rows: 2, minGap: 34 });
      expect(closestInRow(centres, rows)).toBeGreaterThanOrEqual(34);
      // Aun angosto, cada renglon lleva alguno.
      expect(rows.filter((row) => row !== null).length).toBeGreaterThanOrEqual(4);
    },
  );
});
