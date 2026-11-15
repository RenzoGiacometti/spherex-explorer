// Lugares de la esfera: los marcadores y los campos de "Lugar al azar".
//
// Los marcadores son los cinco objetos de prueba de SPEC.md (seccion 1). Esa
// lista vive en src/features/entry/featured.ts y es la unica: aca no se repite.
//
// "Lugar al azar" elige entre todos los campos precalculados (los que el
// backend ya tiene armados en backend/data/fields): los cinco objetos de prueba
// y los que se fueron sumando. Cada posicion es el centro del campo, la
// propagada a la epoca 2026,0 y redondeada a 4 decimales (`field_center` de
// GET /api/resolve, docs/contrato-cubo.md, seccion 4.8), y `name` es el texto
// exacto que resuelve /api/resolve. Los centros se compararon el 15 de
// noviembre de 2026 con el `request` de cada campo en backend/data/fields.
//
// Para sumar un campo precalculado alcanza con agregar un renglon a
// MORE_PRECOMPUTED_FIELDS.

import { FEATURED_OBJECTS, type FeaturedObject } from "@/features/entry";

/** Un lugar con campo propio: nombre visible, texto que lo resuelve, centro y banda inicial. */
export type SkyTarget = FeaturedObject;

/** Objetos marcados en la esfera: los cinco objetos de prueba. */
export const SKY_TARGETS: readonly SkyTarget[] = FEATURED_OBJECTS;

/** Campos precalculados que no son objetos de prueba: no llevan marcador. */
const MORE_PRECOMPUTED_FIELDS: readonly SkyTarget[] = [
  {
    id: "proxima-centauri",
    label: "Proxima Centauri",
    name: "Proxima Centauri",
    ra: 217.3698,
    dec: -62.6739,
    band: 3,
  },
  { id: "luhman-16", label: "Luhman 16", name: "Luhman 16", ra: 162.2955, dec: -53.317, band: 3 },
  { id: "wolf-359", label: "Wolf 359", name: "Wolf 359", ra: 164.0925, dec: 6.9952, band: 3 },
  {
    id: "teegarden",
    label: "Teegarden's Star",
    name: "Teegarden's Star",
    ra: 43.2795,
    dec: 16.8538,
    band: 3,
  },
  { id: "m-82", label: "M 82", name: "M 82", ra: 148.9685, dec: 69.6797, band: 3 },
  { id: "m-51", label: "M 51", name: "M 51", ra: 202.4696, dec: 47.1953, band: 3 },
  { id: "m-42", label: "M 42", name: "M 42", ra: 83.8201, dec: -5.3876, band: 3 },
  { id: "m-1", label: "M 1", name: "M 1", ra: 83.6324, dec: 22.0174, band: 3 },
  {
    id: "kapteyn",
    label: "Kapteyn's Star",
    name: "Kapteyn's Star",
    ra: 77.9853,
    dec: -45.0596,
    band: 3,
  },
];

/** Todos los campos precalculados: de aca sale "Lugar al azar". */
export const PRECOMPUTED_FIELDS: readonly SkyTarget[] = [
  ...SKY_TARGETS,
  ...MORE_PRECOMPUTED_FIELDS,
];

/**
 * Elige un campo al azar, distinto del anterior para que el boton siempre
 * lleve a otro lado. `random` devuelve un numero en [0, 1), como Math.random.
 */
export function pickRandomField(
  previousId: string | null,
  random: () => number = Math.random,
  fields: readonly SkyTarget[] = PRECOMPUTED_FIELDS,
): SkyTarget {
  const candidates = fields.filter((field) => field.id !== previousId);
  const pool = candidates.length > 0 ? candidates : fields;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  const chosen = pool[index];
  if (chosen === undefined) throw new Error("no hay campos precalculados");
  return chosen;
}
