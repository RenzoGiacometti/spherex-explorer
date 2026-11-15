// @vitest-environment node

import { describe, expect, it } from "vitest";
import { FEATURED_OBJECTS, featuredUrlPatch } from "@/features/entry";
import { DEFAULT_URL_STATE, parseUrlState, serializeUrlState } from "@/state/urlState";
import barnardMeta from "@/test/fixtures/barnard/meta.json";
import epsIndBMeta from "@/test/fixtures/epsindb/meta.json";
import wiseMeta from "@/test/fixtures/wise0855/meta.json";
import { PRECOMPUTED_FIELDS, pickRandomField, SKY_TARGETS } from "./targets";

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

  it("son la misma lista que los destacados de la entrada, no una copia", () => {
    expect(SKY_TARGETS).toBe(FEATURED_OBJECTS);
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
});

describe("campos precalculados", () => {
  it("son los cinco objetos de prueba y los campos que se sumaron", () => {
    expect(PRECOMPUTED_FIELDS.map((field) => field.name)).toEqual([
      "Barnard's Star",
      "Epsilon Indi B",
      "WISE J085510.83-071442.5",
      "RW Aurigae",
      "R Draconis",
      "Proxima Centauri",
      "Luhman 16",
      "Wolf 359",
      "Teegarden's Star",
      "M 82",
      "M 51",
      "M 42",
      "M 1",
      "Kapteyn's Star",
    ]);
    expect(new Set(PRECOMPUTED_FIELDS.map((field) => field.id)).size).toBe(
      PRECOMPUTED_FIELDS.length,
    );
  });

  it("cada centro tiene 4 decimales y su link se lee de vuelta sin cambios", () => {
    // Con otro redondeo el visor pediria un campo casi igual, que no esta precalculado.
    for (const field of PRECOMPUTED_FIELDS) {
      expect(Number(field.ra.toFixed(4)), field.label).toBe(field.ra);
      expect(Number(field.dec.toFixed(4)), field.label).toBe(field.dec);
      expect(field.ra).toBeGreaterThanOrEqual(0);
      expect(field.ra).toBeLessThan(360);
      expect(Math.abs(field.dec)).toBeLessThanOrEqual(90);
      const state = { ...DEFAULT_URL_STATE, ...featuredUrlPatch(field) };
      expect(parseUrlState(serializeUrlState(state)), field.label).toEqual(state);
    }
  });

  it("los que no son objetos de prueba abren en su centro, con su nombre", () => {
    expect(
      // Los cuatro primeros que se sumaron; los que vengan despues no cambian este test.
      PRECOMPUTED_FIELDS.slice(SKY_TARGETS.length, SKY_TARGETS.length + 4).map((field) =>
        serializeUrlState({ ...DEFAULT_URL_STATE, ...featuredUrlPatch(field) }),
      ),
    ).toEqual([
      "?ra=217.3698&dec=-62.6739&fov=0.1667&band=3&mode=blink&name=Proxima+Centauri",
      "?ra=162.2955&dec=-53.317&fov=0.1667&band=3&mode=blink&name=Luhman+16",
      "?ra=164.0925&dec=6.9952&fov=0.1667&band=3&mode=blink&name=Wolf+359",
      "?ra=43.2795&dec=16.8538&fov=0.1667&band=3&mode=blink&name=Teegarden%27s+Star",
    ]);
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
    const total = PRECOMPUTED_FIELDS.length;
    const seen = new Set<string>();
    // El medio paso evita caer justo en el borde entre dos campos.
    for (let step = 0; step < total; step += 1) {
      seen.add(pickRandomField(null, () => (step + 0.5) / total).id);
    }
    expect(seen.size).toBe(total);
  });
});
