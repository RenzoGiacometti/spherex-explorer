// @vitest-environment node

import { describe, expect, it } from "vitest";
import { FEATURED_OBJECTS, featuredUrlPatch } from "@/features/entry";
import { DEFAULT_URL_STATE, parseUrlState, serializeUrlState } from "@/state/urlState";
import barnardMeta from "@/test/fixtures/barnard/meta.json";
import epsIndBMeta from "@/test/fixtures/epsindb/meta.json";
import wiseMeta from "@/test/fixtures/wise0855/meta.json";
import {
  PRECOMPUTED_FIELDS,
  pickRandomField,
  RANDOM_FIELDS,
  SKY_TARGETS,
  skyPointField,
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
      "M 31",
      "M 33",
      "M 81",
      "M 101",
      "M 104",
      "UGPS J072227.51-054031.2",
      "2MASS J04151954-0935066",
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
      "?ra=162.2955&dec=-53.317&fov=0.1667&band=5&mode=blink&name=Luhman+16",
      "?ra=164.0925&dec=6.9952&fov=0.1667&band=6&mode=blink&name=Wolf+359",
      "?ra=43.2795&dec=16.8538&fov=0.1667&band=5&mode=blink&name=Teegarden%27s+Star",
    ]);
  });
});

// La huella en si (cuadrado de 10 minutos de arco, coseno de la declinacion,
// cruce de 0/360) se prueba en src/features/entry/featured.test.ts. Aca, lo
// que la esfera abre con ella.
describe("punto elegido en la esfera", () => {
  const barnard = target("barnard");
  /** Un minuto de arco, en grados. */
  const ARCMIN = 1 / 60;

  it("dentro de la huella de un campo guardado abre ese campo entero", () => {
    // A 3 y a 4,5 minutos de arco del centro: lejos del minuto que usaba antes la esfera.
    for (const offset of [0, 0.5 * ARCMIN, 3 * ARCMIN, -4.5 * ARCMIN]) {
      const point = { ra: barnard.ra, dec: barnard.dec + offset };
      const { saved, patch } = skyPointField(point);
      expect(saved, String(offset)).toBe(barnard);
      // El centro, el nombre y la banda del campo, no los del punto.
      expect(patch, String(offset)).toEqual(featuredUrlPatch(barnard));
    }
  });

  it("abre con la banda y el nombre de catalogo del campo, como el buscador", () => {
    // WISE 0855 abre en la banda 6; el punto esta a 2 minutos de arco al este y 2 al norte.
    const wise = target("wise-0855");
    const east = (2 * ARCMIN) / Math.cos((wise.dec * Math.PI) / 180);
    const { saved, patch } = skyPointField({ ra: wise.ra + east, dec: wise.dec + 2 * ARCMIN });
    expect(saved?.id).toBe("wise-0855");
    expect(serializeUrlState({ ...DEFAULT_URL_STATE, ...patch })).toBe(
      "?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink&name=WISE+J085510.83-071442.5",
    );
  });

  it("vale para todos los campos guardados, tengan o no marcador", () => {
    for (const field of PRECOMPUTED_FIELDS) {
      const { saved, patch } = skyPointField({ ra: field.ra, dec: field.dec - 4 * ARCMIN });
      expect(saved, field.label).toBe(field);
      expect(patch, field.label).toEqual(featuredUrlPatch(field));
    }
  });

  it("fuera de toda huella abre un campo nuevo centrado en el punto, sin nombre", () => {
    for (const point of [
      // A 5,5 minutos de arco de Barnard: pasado el borde de la huella.
      { ra: barnard.ra, dec: barnard.dec + 5.5 * ARCMIN },
      { ra: 187.7059, dec: 12.3911 },
    ]) {
      const { saved, patch } = skyPointField(point);
      expect(saved).toBeNull();
      expect(patch).toEqual({
        ra: point.ra,
        dec: point.dec,
        fov: 0.1667,
        band: 3,
        mode: "blink",
        epoch: null,
        name: null,
      });
    }
  });
});

describe("lugar al azar", () => {
  it("elige siempre un campo precalculado", () => {
    for (const value of [0, 0.19, 0.5, 0.99, 0.999999]) {
      expect(RANDOM_FIELDS).toContain(pickRandomField(null, () => value));
    }
  });

  it("no repite el anterior", () => {
    for (const previous of RANDOM_FIELDS) {
      for (const value of [0, 0.3, 0.6, 0.99]) {
        expect(pickRandomField(previous.id, () => value).id).not.toBe(previous.id);
      }
    }
  });

  it("recorre todos los campos", () => {
    const total = RANDOM_FIELDS.length;
    const seen = new Set<string>();
    // El medio paso evita caer justo en el borde entre dos campos.
    for (let step = 0; step < total; step += 1) {
      seen.add(pickRandomField(null, () => (step + 0.5) / total).id);
    }
    expect(seen.size).toBe(total);
  });
});
