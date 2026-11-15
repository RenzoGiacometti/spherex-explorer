// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EPOCH_STOP_WIDTH_PX, layoutEpochs, MIN_EPOCH_GAP, minEpochGap } from "./timelineLayout";

function rounded(values: number[]): number[] {
  return values.map((value) => Number(value.toFixed(4)));
}

describe("layoutEpochs", () => {
  it("sin epocas no devuelve nada y una sola queda en el centro", () => {
    expect(layoutEpochs([])).toEqual([]);
    expect(layoutEpochs([60800])).toEqual([0.5]);
  });

  it("ubica cada epoca segun su fecha, de la primera a la ultima", () => {
    // Inicio de las tres epocas de WISE 0855, en MJD.
    const positions = layoutEpochs([60800.70003, 60979.72268, 61151.19793]);

    expect(positions[0]).toBe(0);
    expect(positions[2]).toBe(1);
    expect(positions[1]).toBeCloseTo((60979.72268 - 60800.70003) / (61151.19793 - 60800.70003), 6);
  });

  it("con las cuatro epocas de Epsilon Indi B no hace falta separar nada", () => {
    const times = [60789.85552, 60946.96411, 61148.84479, 61305.22691];
    const span = 61305.22691 - 60789.85552;

    expect(rounded(layoutEpochs(times))).toEqual(
      rounded(times.map((time) => (time - 60789.85552) / span)),
    );
  });

  it("fechas iguales o que no son numeros se reparten parejo", () => {
    expect(layoutEpochs([5, 5, 5])).toEqual([0, 0.5, 1]);
    expect(layoutEpochs([1, Number.NaN, 3])).toEqual([0, 0.5, 1]);
    expect(layoutEpochs([1, Number.POSITIVE_INFINITY])).toEqual([0, 1]);
  });

  it("dos epocas muy cercanas se separan lo minimo para que no se pisen", () => {
    const positions = layoutEpochs([0, 1, 100]);

    expect(positions[0]).toBe(0);
    expect(positions[1]).toBeCloseTo(MIN_EPOCH_GAP, 10);
    expect(positions[2]).toBe(1);
  });

  it("si las cercanas estan al final, corre hacia atras sin pasarse de 1", () => {
    const positions = layoutEpochs([0, 99, 100]);

    expect(positions[2]).toBe(1);
    expect(positions[1]).toBeCloseTo(1 - MIN_EPOCH_GAP, 10);
    expect(positions[0]).toBe(0);
  });

  it("nunca sale del intervalo ni desordena, aunque no haya lugar para la separacion", () => {
    const times = [0, 1, 2, 3, 4, 5, 6, 1000];
    const positions = layoutEpochs(times);

    expect(positions).toHaveLength(times.length);
    expect(Math.min(...positions)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...positions)).toBeLessThanOrEqual(1);
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index] as number).toBeGreaterThan(positions[index - 1] as number);
    }
    // Con 8 epocas la separacion pedida no entra: quedan repartidas parejo.
    expect(rounded(positions)).toEqual(rounded(times.map((_, index) => index / 7)));
  });

  it("respeta la separacion que se le pide", () => {
    const positions = layoutEpochs([0, 1, 100], 0.3);
    expect(positions[1]).toBeCloseTo(0.3, 10);
  });
});

describe("minEpochGap", () => {
  /** Ancho, en pixeles, del mes de inicio debajo de una marca: "2025-06" en data-sm. */
  const DATE_LABEL_PX = 46.2;

  /** Separaciones entre marcas vecinas, en pixeles, para una pista de ese ancho. */
  function gapsPx(times: number[], trackWidth: number): number[] {
    const positions = layoutEpochs(times, minEpochGap(trackWidth));
    return positions.slice(1).map((position, index) => {
      return (position - (positions[index] as number)) * trackWidth;
    });
  }

  it("sin ancho conocido es la separacion por defecto", () => {
    expect(minEpochGap(null)).toBe(MIN_EPOCH_GAP);
    expect(minEpochGap(0)).toBe(MIN_EPOCH_GAP);
    expect(minEpochGap(-5)).toBe(MIN_EPOCH_GAP);
    expect(minEpochGap(Number.NaN)).toBe(MIN_EPOCH_GAP);
  });

  it("en una pista ancha no cambia nada", () => {
    // La pista de la galeria a 1440 px mide 494: el 16 % son 79 px.
    expect(minEpochGap(494)).toBe(MIN_EPOCH_GAP);
    expect(minEpochGap(Number.POSITIVE_INFINITY)).toBe(MIN_EPOCH_GAP);
  });

  it("en una pista angosta es el ancho de una parada", () => {
    expect(minEpochGap(280)).toBeCloseTo(EPOCH_STOP_WIDTH_PX / 280, 12);
    expect(minEpochGap(250)).toBeCloseTo(EPOCH_STOP_WIDTH_PX / 250, 12);
    expect(EPOCH_STOP_WIDTH_PX).toBeGreaterThan(DATE_LABEL_PX);
  });

  it.each([
    [390, 280],
    [360, 250],
    [320, 210],
  ])("en un celular de %i px las fechas de dos epocas cercanas no se pisan", (_screen, track) => {
    // Con el 16 % fijo quedaban a 44,8 px (pista de 280) y a 40 px (pista de 250).
    for (const times of [
      [60800, 60861, 61050, 61230],
      [60800, 60861, 61150],
      [60800, 61169, 61230],
    ]) {
      const gaps = gapsPx(times, track);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(EPOCH_STOP_WIDTH_PX - 1e-9);
      expect(Math.min(...gaps)).toBeGreaterThan(DATE_LABEL_PX);
    }
    // Con las fechas de un campo real no hace falta mover nada.
    const real = [60789.85552, 60946.96411, 61148.84479, 61305.22691];
    expect(layoutEpochs(real, minEpochGap(track))).toEqual(layoutEpochs(real));
  });

  it("si ni asi entran, las marcas se reparten parejo", () => {
    // Cuatro paradas de 56 px no entran en una pista de 120.
    expect(rounded(layoutEpochs([0, 1, 2, 100], minEpochGap(120)))).toEqual(
      rounded([0, 1 / 3, 2 / 3, 1]),
    );
  });
});
