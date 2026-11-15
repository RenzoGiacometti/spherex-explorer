// @vitest-environment node

import { describe, expect, it } from "vitest";
import check from "./assets/constelaciones/comprobacion.json";
import {
  CONSTELLATION_NAMES,
  constellationAt,
  constellationLabel,
  precessToB1875,
} from "./constellations";
import { angularSeparation } from "./skyMath";
import { PRECOMPUTED_FIELDS, savedFieldNear } from "./targets";

/** [RA, Dec, abreviatura] calculados con astropy (assets/FUENTES.md, "Constelaciones"). */
const CHECK = check as unknown as readonly (readonly [number, number, string])[];

describe("constelacion de un punto", () => {
  it("coincide con astropy en 674 puntos de todo el cielo, polos incluidos", () => {
    const wrong = CHECK.filter(([ra, dec, expected]) => constellationAt({ ra, dec }) !== expected);
    expect(wrong).toEqual([]);
    expect(new Set(CHECK.map((row) => row[2])).size).toBeGreaterThan(80);
  });

  it("ubica objetos conocidos", () => {
    expect(constellationAt({ ra: 269.4463, dec: 4.7683 })).toBe("Oph"); // Barnard's Star
    expect(constellationAt({ ra: 202.4696, dec: 47.1953 })).toBe("CVn"); // M 51
    expect(constellationAt({ ra: 83.8201, dec: -5.3876 })).toBe("Ori"); // M 42
    expect(constellationAt({ ra: 331.0966, dec: -56.8006 })).toBe("Ind"); // Epsilon Indi
    expect(constellationAt({ ra: 133.7598, dec: -7.2422 })).toBe("Hya"); // WISE 0855
    expect(constellationAt({ ra: 0, dec: 90 })).toBe("UMi");
    expect(constellationAt({ ra: 0, dec: -90 })).toBe("Oct");
  });

  it("la precesion a B1875 corre la posicion cerca de 1,7 grados", () => {
    // 125 anos a unos 50 segundos de arco por ano sobre la ecliptica.
    const moved = angularSeparation({ ra: 90, dec: 0 }, precessToB1875({ ra: 90, dec: 0 }));
    expect(moved).toBeGreaterThan(1.5);
    expect(moved).toBeLessThan(1.8);
  });
});

describe("nombres de las constelaciones", () => {
  it("son 88, con nombre en latin, espanol e ingles", () => {
    const entries = Object.entries(CONSTELLATION_NAMES);
    expect(entries).toHaveLength(88);
    for (const [abbreviation, entry] of entries) {
      expect(abbreviation).toMatch(/^[A-Z][A-Za-z]{2}$/);
      for (const text of [entry.la, entry.es, entry.en]) {
        expect(text.trim()).toBe(text);
        expect(text.length).toBeGreaterThan(2);
        // Espacios comunes: la fuente trae U+2005 entre palabras.
        expect(text).not.toMatch(/[ -​]/);
      }
    }
  });

  it("muestra el nombre en el idioma y el latino si es otro", () => {
    expect(constellationLabel("Oph", "es")).toBe("Ofiuco (Ophiuchus)");
    expect(constellationLabel("UMa", "en")).toBe("Great Bear (Ursa Major)");
    expect(constellationLabel("Oct", "es")).toBe("Octante (Octans)");
    expect(constellationLabel("Ori", "en")).toBe("Orion");
  });
});

describe("campo guardado cerca de un punto", () => {
  const barnard = PRECOMPUTED_FIELDS.find((field) => field.id === "barnard");

  it("a menos de un minuto de arco del centro, es ese campo", () => {
    if (barnard === undefined) throw new Error("falta el campo de Barnard");
    expect(savedFieldNear({ ra: barnard.ra, dec: barnard.dec + 0.5 / 60 })?.id).toBe("barnard");
    expect(savedFieldNear({ ra: barnard.ra, dec: barnard.dec })?.id).toBe("barnard");
  });

  it("mas lejos, no hay campo guardado", () => {
    if (barnard === undefined) throw new Error("falta el campo de Barnard");
    expect(savedFieldNear({ ra: barnard.ra, dec: barnard.dec + 2 / 60 })).toBeUndefined();
    expect(savedFieldNear({ ra: 10, dec: 10 })).toBeUndefined();
  });
});
