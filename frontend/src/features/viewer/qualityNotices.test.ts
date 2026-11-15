// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fieldMetaSchema } from "@/api/schema";
import type { PlaneRef } from "@/api/types";
import barnardMeta from "@/test/fixtures/meta-barnard.json";
import epsIndMeta from "@/test/fixtures/meta-epsindb.json";
import {
  FEW_EXPOSURES_LIMIT,
  formatBandList,
  groupPlanes,
  LOW_COVERAGE_LIMIT,
} from "./qualityNotices";

function planes(...pairs: Array<[epoch: number, detector: number]>): PlaneRef[] {
  return pairs.map(([epoch, detector]) => ({ epoch, detector }));
}

describe("limites de los avisos", () => {
  it("son los de la tabla de avisos del contrato", () => {
    // docs/contrato-cubo.md, seccion 5: menos de 5 exposiciones; menos del 90 % con datos.
    expect(FEW_EXPOSURES_LIMIT).toBe(5);
    expect(LOW_COVERAGE_LIMIT).toBe(0.9);
  });
});

describe("formatBandList", () => {
  it("escribe tres o mas bandas seguidas como rango, con raya corta", () => {
    expect(formatBandList([1, 2, 3, 4, 5, 6])).toBe("B1–B6");
    expect(formatBandList([2, 3, 4])).toBe("B2–B4");
  });

  it("deja las sueltas y los pares separados por coma", () => {
    expect(formatBandList([1, 4])).toBe("B1, B4");
    expect(formatBandList([1, 2])).toBe("B1, B2");
    expect(formatBandList([3])).toBe("B3");
  });

  it("mezcla rangos y sueltas", () => {
    expect(formatBandList([1, 2, 3, 5])).toBe("B1–B3, B5");
    expect(formatBandList([1, 3, 4, 5, 6])).toBe("B1, B3–B6");
    expect(formatBandList([2, 3, 5, 6])).toBe("B2, B3, B5, B6");
  });

  it("ordena y saca los repetidos", () => {
    expect(formatBandList([6, 1, 4, 1])).toBe("B1, B4, B6");
    expect(formatBandList([3, 2, 1, 2])).toBe("B1–B3");
  });

  it("sin bandas no escribe nada", () => {
    expect(formatBandList([])).toBe("");
  });
});

describe("groupPlanes", () => {
  it("junta las epocas que tienen las mismas bandas", () => {
    const all = [1, 2, 3].flatMap((epoch) =>
      [1, 2, 3, 4, 5, 6].map((detector): [number, number] => [epoch, detector]),
    );
    expect(groupPlanes(planes(...all))).toEqual([
      { epochs: [1, 2, 3], detectors: [1, 2, 3, 4, 5, 6] },
    ]);
  });

  it("separa las que no coinciden, en el orden de su primera epoca", () => {
    expect(groupPlanes(planes([2, 6], [1, 1], [1, 4], [3, 6]))).toEqual([
      { epochs: [1], detectors: [1, 4] },
      { epochs: [2, 3], detectors: [6] },
    ]);
  });

  it("no depende del orden ni de los repetidos", () => {
    expect(groupPlanes(planes([4, 4], [4, 1], [4, 4]))).toEqual([
      { epochs: [4], detectors: [1, 4] },
    ]);
  });

  it("sin planos no hay grupos", () => {
    expect(groupPlanes([])).toEqual([]);
  });
});

describe("con los avisos de los campos de muestra", () => {
  function warnings(meta: unknown, code: string): PlaneRef[] {
    return fieldMetaSchema
      .parse(meta)
      .warnings.flatMap((warning) =>
        warning.code === code && "epoch" in warning
          ? [{ epoch: warning.epoch, detector: warning.detector }]
          : [],
      );
  }

  it("Barnard: los 18 avisos de poca cobertura quedan en un grupo", () => {
    const low = warnings(barnardMeta, "low_coverage");
    expect(low).toHaveLength(18);
    const groups = groupPlanes(low);
    expect(groups).toEqual([{ epochs: [1, 2, 3], detectors: [1, 2, 3, 4, 5, 6] }]);
    expect(formatBandList(groups[0]?.detectors ?? [])).toBe("B1–B6");
  });

  it("Epsilon Indi B: la epoca 4 no tiene B1 ni B4, y por eso va aparte", () => {
    const groups = groupPlanes(warnings(epsIndMeta, "low_coverage"));
    expect(groups).toEqual([
      { epochs: [1, 2, 3], detectors: [1, 2, 3, 4, 5, 6] },
      { epochs: [4], detectors: [2, 3, 5, 6] },
    ]);
    expect(groupPlanes(warnings(epsIndMeta, "plane_empty"))).toEqual([
      { epochs: [4], detectors: [1, 4] },
    ]);
  });
});
