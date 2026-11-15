// @vitest-environment node

import { describe, expect, it } from "vitest";
import barnardMeta from "@/test/fixtures/barnard/meta.json";
import epsIndBMeta from "@/test/fixtures/epsindb/meta.json";
import wiseMeta from "@/test/fixtures/wise0855/meta.json";
import {
  findTargetByName,
  PRECOMPUTED_FIELDS,
  pickRandomField,
  SKY_TARGETS,
  targetUrlPatch,
} from "./targets";

function target(id: string) {
  const found = SKY_TARGETS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`falta el objeto ${id}`);
  return found;
}

describe("objetos marcados en la esfera", () => {
  it("son los cinco objetos de prueba, con coordenadas validas", () => {
    expect(SKY_TARGETS.map((item) => item.label)).toEqual([
      "Barnard's Star",
      "Epsilon Indi B",
      "WISE 0855",
      "RW Aurigae",
      "R Draconis",
    ]);
    for (const item of SKY_TARGETS) {
      expect(item.ra).toBeGreaterThanOrEqual(0);
      expect(item.ra).toBeLessThan(360);
      expect(Math.abs(item.dec)).toBeLessThanOrEqual(90);
    }
  });

  it("usa el centro del campo precalculado, no la posicion de catalogo", () => {
    for (const [id, meta] of [
      ["barnard", barnardMeta],
      ["epsilon-indi-b", epsIndBMeta],
      ["wise-0855", wiseMeta],
    ] as const) {
      expect(target(id).ra).toBe(meta.request.ra);
      expect(target(id).dec).toBe(meta.request.dec);
    }
  });

  it("WISE 0855 va en su posicion de 2026 (SPEC.md, seccion 1)", () => {
    expect(target("wise-0855")).toMatchObject({ ra: 133.7598, dec: -7.2422, band: 6 });
  });

  it("arma el estado de URL que abre el campo", () => {
    expect(targetUrlPatch(target("rw-aurigae"))).toEqual({
      ra: 76.9566,
      dec: 30.4013,
      fov: 0.1667,
      band: 1,
      mode: "blink",
      epoch: null,
      name: "RW Aurigae",
    });
  });

  it("encuentra un objeto por su nombre visible o de catalogo", () => {
    expect(findTargetByName("  wise   0855 ")?.id).toBe("wise-0855");
    expect(findTargetByName("WISE J085510.83-071442.5")?.id).toBe("wise-0855");
    expect(findTargetByName("barnard's star")?.id).toBe("barnard");
    expect(findTargetByName("M 31")).toBeNull();
  });
});

describe("lugar al azar", () => {
  it("elige siempre un campo precalculado", () => {
    for (const value of [0, 0.19, 0.5, 0.99, 0.999999]) {
      expect(PRECOMPUTED_FIELDS).toContain(pickRandomField(null, () => value));
    }
  });

  it("no repite el anterior", () => {
    for (const previous of PRECOMPUTED_FIELDS) {
      for (const value of [0, 0.3, 0.6, 0.99]) {
        expect(pickRandomField(previous.id, () => value).id).not.toBe(previous.id);
      }
    }
  });

  it("recorre todos los campos", () => {
    const seen = new Set<string>();
    for (let step = 0; step < 5; step += 1) seen.add(pickRandomField(null, () => step / 5).id);
    expect(seen.size).toBe(PRECOMPUTED_FIELDS.length);
  });
});
