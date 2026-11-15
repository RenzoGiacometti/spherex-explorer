// @vitest-environment node

import { describe, expect, it } from "vitest";
import check from "./assets/constelaciones/comprobacion.json";
import figuresData from "./assets/constelaciones/lineas.json";
import {
  CONSTELLATION_NAMES,
  type ConstellationFigure,
  constellationAt,
  constellationLabel,
  figureFrame,
  precessToB1875,
} from "./constellations";
import { angularSeparation } from "./skyMath";

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

describe("encuadre de una figura", () => {
  const figures = figuresData as unknown as readonly ConstellationFigure[];
  const byId = (id: string): ConstellationFigure => {
    const figure = figures.find((candidate) => candidate.id === id);
    if (figure === undefined) throw new Error(`falta la figura ${id}`);
    return figure;
  };

  it("Orion queda centrado en su cinturon, con unos 12 grados de radio", () => {
    const { center, radius } = figureFrame(byId("Ori"));
    // Alnilam, la estrella del medio del cinturon.
    expect(angularSeparation(center, { ra: 84.05, dec: -1.2 })).toBeLessThan(10);
    expect(radius).toBeGreaterThan(8);
    expect(radius).toBeLessThan(18);
  });

  it("la Cruz del Sur es chica", () => {
    const { center, radius } = figureFrame(byId("Cru"));
    expect(radius).toBeLessThan(5);
    expect(center.dec).toBeLessThan(-55);
  });

  it("el circulo contiene todos los puntos de cada una de las 89 figuras", () => {
    expect(figures).toHaveLength(89);
    for (const figure of figures) {
      const { center, radius } = figureFrame(figure);
      expect(radius).toBeGreaterThan(0);
      // La mas larga es Hidra, que cruza mas de cien grados de cielo.
      expect(radius).toBeLessThan(75);
      for (const line of figure.lines) {
        for (let index = 0; index + 1 < line.length; index += 2) {
          const point = { ra: line[index] as number, dec: line[index + 1] as number };
          expect(angularSeparation(center, point)).toBeLessThanOrEqual(radius + 1e-9);
        }
      }
    }
  });
});
