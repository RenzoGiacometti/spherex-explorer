// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ASINH_STRETCH_A,
  clampUnit,
  contrastCuts,
  cutSpan,
  DEFAULT_CONTRAST,
  DEFAULT_STRETCH,
  differenceHalfRange,
  LOG_STRETCH_A,
  MAX_CONTRAST,
  MIN_CONTRAST,
  MIN_CUT_SPAN,
  MIN_SPAN_FRACTION,
  MIN_SPAN_SIGMAS,
  normalize,
  STRETCH_KINDS,
  stretchSigned,
  stretchUnit,
  stretchValue,
  toByte,
} from "./stretch";

// Escala del detector 3 del campo de Barnard (src/test/fixtures/barnard/meta.json).
const BARNARD_D3 = { vmin: -0.231633, vmax: 12.3752, median: 0.00942717, sigma: 0.12053 };

describe("clampUnit", () => {
  it("recorta a [0, 1]", () => {
    expect(clampUnit(-0.5)).toBe(0);
    expect(clampUnit(0)).toBe(0);
    expect(clampUnit(0.25)).toBe(0.25);
    expect(clampUnit(1)).toBe(1);
    expect(clampUnit(7)).toBe(1);
    expect(clampUnit(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampUnit(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("lo que no es un numero queda en 0", () => {
    expect(clampUnit(Number.NaN)).toBe(0);
  });
});

describe("normalize", () => {
  const cuts = { low: -2, high: 8 };

  it("lleva el corte bajo a 0 y el alto a 1", () => {
    expect(normalize(-2, cuts)).toBe(0);
    expect(normalize(8, cuts)).toBe(1);
    expect(normalize(3, cuts)).toBeCloseTo(0.5, 12);
  });

  it("recorta lo que queda fuera de los cortes", () => {
    expect(normalize(-50, cuts)).toBe(0);
    expect(normalize(50, cuts)).toBe(1);
  });

  it("con cortes iguales o invertidos no divide por cero", () => {
    expect(cutSpan({ low: 1, high: 1 })).toBe(MIN_CUT_SPAN);
    expect(cutSpan({ low: 1, high: 0 })).toBe(MIN_CUT_SPAN);
    expect(cutSpan({ low: Number.NaN, high: 1 })).toBe(MIN_CUT_SPAN);
    expect(normalize(1, { low: 1, high: 1 })).toBe(0);
    expect(normalize(2, { low: 1, high: 1 })).toBe(1);
    expect(normalize(0, { low: 1, high: 1 })).toBe(0);
  });
});

describe("stretchUnit", () => {
  it("todos los estirados dejan 0 en 0 y 1 en 1", () => {
    for (const kind of STRETCH_KINDS) {
      expect(stretchUnit(0, kind), kind).toBe(0);
      expect(stretchUnit(1, kind), kind).toBeCloseTo(1, 12);
    }
  });

  it("todos crecen", () => {
    for (const kind of STRETCH_KINDS) {
      let previous = -1;
      for (let step = 0; step <= 100; step += 1) {
        const value = stretchUnit(step / 100, kind);
        expect(value, `${kind} en ${step / 100}`).toBeGreaterThan(previous);
        previous = value;
      }
    }
  });

  it("el lineal no cambia nada", () => {
    expect(stretchUnit(0.37, "linear")).toBe(0.37);
  });

  it("el logaritmico es ln(1 + a x) / ln(1 + a)", () => {
    expect(LOG_STRETCH_A).toBe(1000);
    expect(stretchUnit(0.5, "log")).toBeCloseTo(Math.log(501) / Math.log(1001), 12);
    expect(stretchUnit(0.001, "log")).toBeCloseTo(Math.log(2) / Math.log(1001), 12);
  });

  it("el asinh es asinh(x / a) / asinh(1 / a)", () => {
    expect(ASINH_STRETCH_A).toBe(0.1);
    expect(stretchUnit(0.5, "asinh")).toBeCloseTo(Math.asinh(5) / Math.asinh(10), 12);
    expect(stretchUnit(0.02, "asinh")).toBeCloseTo(Math.asinh(0.2) / Math.asinh(10), 12);
  });

  it("log y asinh levantan lo debil: quedan por encima del lineal", () => {
    for (const position of [0.01, 0.1, 0.5, 0.9]) {
      expect(stretchUnit(position, "log")).toBeGreaterThan(position);
      expect(stretchUnit(position, "asinh")).toBeGreaterThan(position);
      // El logaritmico levanta mas que el asinh.
      expect(stretchUnit(position, "log")).toBeGreaterThan(stretchUnit(position, "asinh"));
    }
  });
});

describe("stretchValue", () => {
  it("recorta entre los cortes y aplica la curva", () => {
    const cuts = { low: 0, high: 10 };
    expect(stretchValue(5, cuts, "linear")).toBeCloseTo(0.5, 12);
    expect(stretchValue(5, cuts, "asinh")).toBeCloseTo(stretchUnit(0.5, "asinh"), 12);
    expect(stretchValue(-3, cuts, "log")).toBe(0);
    expect(stretchValue(30, cuts, "log")).toBeCloseTo(1, 12);
  });
});

describe("stretchSigned", () => {
  it("cero queda en gris medio", () => {
    for (const kind of STRETCH_KINDS) {
      expect(stretchSigned(0, 2, kind), kind).toBe(0.5);
    }
  });

  it("el medio rango queda en blanco y su opuesto en negro", () => {
    for (const kind of STRETCH_KINDS) {
      expect(stretchSigned(2, 2, kind), kind).toBeCloseTo(1, 12);
      expect(stretchSigned(-2, 2, kind), kind).toBeCloseTo(0, 12);
      expect(stretchSigned(50, 2, kind), kind).toBeCloseTo(1, 12);
      expect(stretchSigned(-50, 2, kind), kind).toBeCloseTo(0, 12);
    }
  });

  it("es simetrico alrededor de cero", () => {
    for (const kind of STRETCH_KINDS) {
      for (const delta of [0.01, 0.3, 1, 1.7]) {
        const above = stretchSigned(delta, 2, kind);
        const below = stretchSigned(-delta, 2, kind);
        expect(above + below, `${kind} ${delta}`).toBeCloseTo(1, 12);
        expect(above).toBeGreaterThan(0.5);
      }
    }
  });

  it("la curva se aplica al valor absoluto", () => {
    expect(stretchSigned(1, 2, "linear")).toBeCloseTo(0.75, 12);
    expect(stretchSigned(1, 2, "asinh")).toBeCloseTo(0.5 + 0.5 * stretchUnit(0.5, "asinh"), 12);
    expect(stretchSigned(-1, 2, "log")).toBeCloseTo(0.5 - 0.5 * stretchUnit(0.5, "log"), 12);
  });

  it("un medio rango nulo no divide por cero", () => {
    expect(stretchSigned(0, 0, "linear")).toBe(0.5);
    expect(stretchSigned(1, 0, "linear")).toBe(1);
    expect(stretchSigned(-1, 0, "linear")).toBe(0);
  });
});

describe("differenceHalfRange", () => {
  it("es el ancho entre cortes", () => {
    expect(differenceHalfRange({ low: -1, high: 3 })).toBe(4);
    expect(differenceHalfRange({ low: 3, high: 3 })).toBe(MIN_CUT_SPAN);
  });
});

describe("toByte", () => {
  it("pasa de nivel a byte redondeando al mas cercano", () => {
    expect(toByte(0)).toBe(0);
    expect(toByte(1)).toBe(255);
    expect(toByte(0.5)).toBe(128);
    expect(toByte(0.2)).toBe(51);
    expect(toByte(0.999)).toBe(255);
    expect(toByte(0.001)).toBe(0);
  });

  it("recorta lo que queda fuera", () => {
    expect(toByte(-3)).toBe(0);
    expect(toByte(3)).toBe(255);
    expect(toByte(Number.NaN)).toBe(0);
  });
});

describe("valores de partida", () => {
  it("son un estirado y un contraste validos", () => {
    expect(STRETCH_KINDS).toContain(DEFAULT_STRETCH);
    expect(DEFAULT_CONTRAST).toBeGreaterThanOrEqual(MIN_CONTRAST);
    expect(DEFAULT_CONTRAST).toBeLessThanOrEqual(MAX_CONTRAST);
  });
});

describe("contrastCuts", () => {
  it("con el contraste en 0 los cortes son vmin y vmax", () => {
    const cuts = contrastCuts(BARNARD_D3, 0);
    expect(cuts.low).toBe(BARNARD_D3.vmin);
    expect(cuts.high).toBeCloseTo(BARNARD_D3.vmax, 12);
  });

  it("con el contraste en 1 quedan 4 sigma entre los cortes", () => {
    const cuts = contrastCuts(BARNARD_D3, 1);
    expect(cuts.low).toBe(BARNARD_D3.vmin);
    expect(cuts.high - cuts.low).toBeCloseTo(MIN_SPAN_SIGMAS * BARNARD_D3.sigma, 12);
    // vmin es la mediana menos 2 sigma: el corte alto queda en la mediana mas 2 sigma.
    expect(cuts.high).toBeCloseTo(BARNARD_D3.median + 2 * BARNARD_D3.sigma, 3);
  });

  it("el corte bajo no se mueve y el alto baja siempre, sin salir de [vmin, vmax]", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let step = 0; step <= 20; step += 1) {
      const cuts = contrastCuts(BARNARD_D3, step / 20);
      expect(cuts.low).toBe(BARNARD_D3.vmin);
      expect(cuts.high).toBeLessThan(previous);
      expect(cuts.high).toBeGreaterThan(BARNARD_D3.vmin);
      expect(cuts.high).toBeLessThanOrEqual(BARNARD_D3.vmax + 1e-12);
      previous = cuts.high;
    }
  });

  it("el recorrido es geometrico: cada paso divide el ancho por el mismo factor", () => {
    const span = (contrast: number): number => {
      const cuts = contrastCuts(BARNARD_D3, contrast);
      return cuts.high - cuts.low;
    };
    expect(span(0.25) / span(0)).toBeCloseTo(span(0.5) / span(0.25), 10);
    expect(span(0.5) / span(0.25)).toBeCloseTo(span(1) / span(0.75), 10);
    expect(span(0.5)).toBeCloseTo(Math.sqrt(span(0) * span(1)), 10);
  });

  it("recorta el contraste a [0, 1]", () => {
    expect(contrastCuts(BARNARD_D3, -3)).toEqual(contrastCuts(BARNARD_D3, 0));
    expect(contrastCuts(BARNARD_D3, 9)).toEqual(contrastCuts(BARNARD_D3, 1));
    expect(contrastCuts(BARNARD_D3, Number.NaN)).toEqual(contrastCuts(BARNARD_D3, 0));
  });

  it("sin sigma el tope es una fraccion del rango", () => {
    const cuts = contrastCuts({ vmin: 0, vmax: 512 }, 1);
    expect(cuts.high - cuts.low).toBeCloseTo(512 * MIN_SPAN_FRACTION, 10);
    expect(contrastCuts({ vmin: 0, vmax: 512, sigma: 0 }, 1)).toEqual(cuts);
  });

  it("si 4 sigma ya es mas que el rango, el contraste no cambia nada", () => {
    const display = { vmin: 0, vmax: 1, sigma: 5 };
    expect(contrastCuts(display, 1)).toEqual({ low: 0, high: 1 });
  });

  it("con un rango vacio devuelve los cortes tal cual", () => {
    expect(contrastCuts({ vmin: 3, vmax: 3, sigma: 0 }, 0.5)).toEqual({ low: 3, high: 3 });
    expect(contrastCuts({ vmin: 3, vmax: 1 }, 0.5)).toEqual({ low: 3, high: 1 });
  });
});
