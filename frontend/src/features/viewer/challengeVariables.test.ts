import { describe, expect, it } from "vitest";
import {
  CHALLENGE_MATCH_RADIUS_ARCSEC,
  CHALLENGE_VARIABLES,
  challengeVariableFor,
} from "./challengeVariables";

const R_DRA = { ra: 248.1672, dec: 66.755 };

describe("challengeVariableFor", () => {
  it("reconoce a la estrella por el nombre de la URL, sin mirar mayusculas ni espacios", () => {
    expect(challengeVariableFor({ name: "R Draconis", center: null })?.name).toBe("R Draconis");
    expect(challengeVariableFor({ name: "  rw   aurigae ", center: null })?.name).toBe(
      "RW Aurigae",
    );
    expect(challengeVariableFor({ name: "RW Aur", center: null })?.name).toBe("RW Aurigae");
  });

  it("reconoce a la estrella por el centro del campo, hasta 30 segundos de arco", () => {
    expect(challengeVariableFor({ name: null, center: R_DRA })?.name).toBe("R Draconis");
    // 20" al norte: adentro. 40" al norte: afuera.
    const north = (arcsec: number) => ({ ra: R_DRA.ra, dec: R_DRA.dec + arcsec / 3600 });
    expect(challengeVariableFor({ name: null, center: north(20) })?.name).toBe("R Draconis");
    expect(challengeVariableFor({ name: null, center: north(40) })).toBeNull();
    // En ascension recta el radio se mide sobre el cielo: a esa declinacion,
    // 60" de ascension recta son menos de 24" de arco.
    const east = { ra: R_DRA.ra + 60 / 3600, dec: R_DRA.dec };
    expect(challengeVariableFor({ name: null, center: east })?.name).toBe("R Draconis");
    expect(CHALLENGE_MATCH_RADIUS_ARCSEC).toBe(30);
  });

  it("no ofrece nada en un campo que no es de una variable del desafio", () => {
    expect(challengeVariableFor({ name: "Barnard's Star", center: null })).toBeNull();
    expect(
      challengeVariableFor({ name: "Barnard's Star", center: { ra: 269.4463, dec: 4.7683 } }),
    ).toBeNull();
    expect(challengeVariableFor({ name: null, center: null })).toBeNull();
  });

  it("las posiciones de la lista son validas", () => {
    for (const variable of CHALLENGE_VARIABLES) {
      expect(variable.ra).toBeGreaterThanOrEqual(0);
      expect(variable.ra).toBeLessThan(360);
      expect(Math.abs(variable.dec)).toBeLessThanOrEqual(90);
    }
  });
});
