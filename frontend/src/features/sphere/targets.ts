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
// MORE_PRECOMPUTED_OBJECTS, en src/features/entry/featured.ts.

import {
  FEATURED_OBJECTS,
  type FeaturedObject,
  featuredUrlPatch,
  PRECOMPUTED_OBJECTS,
  savedFieldAt,
  type ViewerUrlPatch,
} from "@/features/entry";
import { DEFAULT_VIEW_FOV } from "@/lib/fov";
import { DEFAULT_BAND, DEFAULT_MODE } from "@/state/urlState";
import type { SkyPosition } from "./skyMath";

/** Un lugar con campo propio: nombre visible, texto que lo resuelve, centro y banda inicial. */
export type SkyTarget = FeaturedObject;

/** Objetos marcados en la esfera: los cinco objetos de prueba. */
export const SKY_TARGETS: readonly SkyTarget[] = FEATURED_OBJECTS;

/** Todos los campos precalculados (los cinco objetos de prueba y los demas). */
export const PRECOMPUTED_FIELDS: readonly SkyTarget[] = PRECOMPUTED_OBJECTS;

/** Lo que abre un punto del cielo elegido en la esfera. */
export interface SkyPointField {
  /** Campo guardado cuya huella contiene al punto, o null si hay que armar uno nuevo. */
  readonly saved: SkyTarget | null;
  /** Estado de URL que abre ese campo en el visor. */
  readonly patch: ViewerUrlPatch;
}

/**
 * Campo que abre un punto del cielo elegido en la esfera: el clic libre y el
 * centro de la ventana al cielo.
 *
 * La regla es una sola, la del buscador (useObjectSearch.ts) y la de la URL
 * (state/fieldUrlSync.ts): `savedFieldAt`, de src/features/entry/featured.ts.
 * Si el punto cae dentro de la huella de un campo guardado se abre ese campo
 * entero, con su centro, su nombre y su banda de apertura, y no uno casi igual
 * a su lado que habria que armar de cero. Fuera de toda huella, un campo nuevo
 * centrado en el punto, en la banda por defecto y sin nombre.
 */
export function skyPointField(position: SkyPosition): SkyPointField {
  const saved = savedFieldAt(position);
  if (saved !== null) return { saved, patch: featuredUrlPatch(saved) };
  return {
    saved: null,
    patch: {
      ra: position.ra,
      dec: position.dec,
      fov: DEFAULT_VIEW_FOV,
      band: DEFAULT_BAND,
      mode: DEFAULT_MODE,
      epoch: null,
      name: null,
    },
  };
}

/**
 * Campos que no salen en "Lugar al azar". M 42 (Orion) satura en casi todo el
 * centro del campo: sigue precalculado y se abre por nombre, pero no es un buen
 * primer lugar para caer.
 */
const NOT_RANDOM: ReadonlySet<string> = new Set(["m-42"]);

/** De aca elige "Lugar al azar". */
export const RANDOM_FIELDS: readonly SkyTarget[] = PRECOMPUTED_FIELDS.filter(
  (field) => !NOT_RANDOM.has(field.id),
);

/**
 * Elige un campo al azar, distinto del anterior para que el boton siempre
 * lleve a otro lado. `random` devuelve un numero en [0, 1), como Math.random.
 */
export function pickRandomField(
  previousId: string | null,
  random: () => number = Math.random,
  fields: readonly SkyTarget[] = RANDOM_FIELDS,
): SkyTarget {
  const candidates = fields.filter((field) => field.id !== previousId);
  const pool = candidates.length > 0 ? candidates : fields;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  const chosen = pool[index];
  if (chosen === undefined) throw new Error("no hay campos precalculados");
  return chosen;
}

/** Clave de sessionStorage con el `id` del ultimo campo que eligio "Lugar al azar". */
const LAST_RANDOM_KEY = "skyblink.lastRandomField";

/** Respaldo en memoria: solo se usa si el navegador no deja escribir en sessionStorage. */
let lastRandomInMemory: string | null = null;

/**
 * `id` del ultimo campo que eligio "Lugar al azar" en esta pestana, o null. Se
 * guarda fuera de la pantalla de entrada, que se desmonta al abrir el visor:
 * al volver (o al recargar) el boton no repite el campo del que se viene.
 */
export function lastRandomFieldId(): string | null {
  try {
    return window.sessionStorage.getItem(LAST_RANDOM_KEY) ?? lastRandomInMemory;
  } catch {
    return lastRandomInMemory;
  }
}

export function rememberRandomField(id: string): void {
  try {
    window.sessionStorage.setItem(LAST_RANDOM_KEY, id);
    lastRandomInMemory = null;
  } catch {
    // Sin sessionStorage (modo privado, permisos) alcanza con la memoria.
    lastRandomInMemory = id;
  }
}
