// Las estrellas variables del desafio: en sus campos el visor ofrece la curva
// de luz de entrada (LightcurveOffer.tsx).
//
// Un campo es de una de ellas si la URL trae su nombre (`name`) o si el centro
// del campo cae sobre la estrella. Para sumar otra, agregarla a la lista.

import { separationArcsec } from "@/lib/wcs";

export interface ChallengeVariable {
  /** Nombre de catalogo: no se traduce. */
  readonly name: string;
  /** Otras formas de escribirlo en `name` de la URL, en minusculas. */
  readonly aliases: readonly string[];
  /** Posicion de catalogo, grados ICRS. */
  readonly ra: number;
  readonly dec: number;
}

// Las posiciones con las que la entrada abre sus campos (features/entry/featured.ts):
// las de SIMBAD guardadas en backend/data/sesame, a menos de 1" de diferencia.
export const CHALLENGE_VARIABLES: readonly ChallengeVariable[] = [
  { name: "R Draconis", aliases: ["r dra"], ra: 248.1672, dec: 66.755 },
  { name: "RW Aurigae", aliases: ["rw aur"], ra: 76.9566, dec: 30.4013 },
];

/**
 * Hasta donde el centro del campo cuenta como puesto sobre la estrella: 30",
 * unos cinco pixeles de SPHEREx. Alcanza para un centro escrito con tres
 * decimales y no confunde a la estrella con una vecina.
 */
export const CHALLENGE_MATCH_RADIUS_ARCSEC = 30;

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** La variable del desafio de ese campo, o null si el campo no es de ninguna. */
export function challengeVariableFor(field: {
  /** `name` de la URL, si hay. */
  readonly name: string | null;
  /** Centro del campo, grados ICRS; null si todavia no hay campo. */
  readonly center: { readonly ra: number; readonly dec: number } | null;
}): ChallengeVariable | null {
  const wanted = field.name === null ? null : normalizeName(field.name);
  if (wanted !== null) {
    const byName = CHALLENGE_VARIABLES.find(
      (variable) => normalizeName(variable.name) === wanted || variable.aliases.includes(wanted),
    );
    if (byName !== undefined) return byName;
  }
  const { center } = field;
  if (center === null) return null;
  return (
    CHALLENGE_VARIABLES.find(
      (variable) => separationArcsec(center, variable) <= CHALLENGE_MATCH_RADIUS_ARCSEC,
    ) ?? null
  );
}
