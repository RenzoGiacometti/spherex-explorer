// Objetos marcados en la esfera: los cinco objetos de prueba de SPEC.md
// (seccion 1). Son tambien los campos precalculados (SPEC.md, Etapa 1:
// "precalculo de los 5 objetos"), entre los que elige "Lugar al azar".
//
// Cada posicion es el centro del campo del objeto: `field_center` de
// GET /api/resolve, la posicion propagada a la epoca 2026,0 y redondeada a 4
// decimales (docs/contrato-cubo.md, seccion 4.8). No son las de catalogo:
// Barnard y WISE 0855 quedan a minutos de arco de su posicion J2000.
//
// De donde sale cada una:
// - WISE 0855: SPEC.md, seccion 1 (RA 133,7598, Dec -7,2422 en 2026,0).
// - Barnard's Star y Epsilon Indi B: el pedido de su campo de muestra
//   (src/test/fixtures/<campo>/meta.json); targets.test.ts los compara.
// - RW Aurigae y R Draconis: posicion y movimiento propio de la respuesta de
//   Sesame guardada en backend/tests/fixtures/sesame, llevados de 2000,0 a
//   2026,0 (se mueven 0,6 y 0,6 segundos de arco en ese lapso).

import { DEFAULT_VIEW_FOV } from "@/lib/fov";
import { type Band, DEFAULT_MODE, serializeUrlState, type UrlState } from "@/state/urlState";

export interface SkyTarget {
  /** Clave estable, para las listas de React y los tests. */
  readonly id: string;
  /** Nombre que se muestra, escrito como en el catalogo. */
  readonly label: string;
  /**
   * Texto con el que /api/resolve encuentra el objeto. Va en `name` de la URL
   * y el visor lo usa para la mira y el rastro.
   */
  readonly name: string;
  /** Centro del campo en grados ICRS, epoca 2026,0. */
  readonly ra: number;
  readonly dec: number;
  /** Banda con la que abre el visor. */
  readonly band: Band;
}

export const SKY_TARGETS: readonly SkyTarget[] = [
  {
    id: "barnard",
    label: "Barnard's Star",
    name: "Barnard's Star",
    ra: 269.4463,
    dec: 4.7683,
    band: 3,
  },
  {
    id: "epsilon-indi-b",
    label: "Epsilon Indi B",
    name: "Epsilon Indi B",
    ra: 331.0966,
    dec: -56.8006,
    band: 3,
  },
  {
    id: "wise-0855",
    label: "WISE 0855",
    // El servicio de nombres no conoce el apodo (SPEC.md, seccion 1).
    name: "WISE J085510.83-071442.5",
    ra: 133.7598,
    dec: -7.2422,
    // Solo se detecta en los detectores 5 y 6 (SPEC.md, seccion 2).
    band: 6,
  },
  {
    id: "rw-aurigae",
    label: "RW Aurigae",
    name: "RW Aurigae",
    ra: 76.9566,
    dec: 30.4013,
    // El detector 1 es el unico donde no satura (SPEC.md, seccion 2).
    band: 1,
  },
  { id: "r-draconis", label: "R Draconis", name: "R Draconis", ra: 248.1672, dec: 66.755, band: 3 },
];

/** Campos precalculados: de aca sale "Lugar al azar". Hoy son los cinco objetos de prueba. */
export const PRECOMPUTED_FIELDS: readonly SkyTarget[] = SKY_TARGETS;

/** Objeto del ejemplo del buscador. */
export const SEARCH_EXAMPLE: SkyTarget = SKY_TARGETS[0] as SkyTarget;

/** Parte del estado de la URL que abre un campo en el visor: siempre con coordenadas. */
export type FieldUrlPatch = Pick<UrlState, "fov" | "band" | "mode" | "epoch" | "name"> & {
  readonly ra: number;
  readonly dec: number;
};

/** Estado de URL que abre el campo de un objeto: vista de 10 minutos y su banda. */
export function targetUrlPatch(target: SkyTarget): FieldUrlPatch {
  return {
    ra: target.ra,
    dec: target.dec,
    fov: DEFAULT_VIEW_FOV,
    band: target.band,
    mode: DEFAULT_MODE,
    epoch: null,
    name: target.name,
  };
}

/** Link al visor para un estado de URL: la raiz del sitio con la consulta completa. */
export function viewerHref(state: UrlState): string {
  return `${import.meta.env.BASE_URL}${serializeUrlState(state)}`;
}

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

function normalizeName(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Objeto marcado que corresponde a lo que escribio la persona, por su nombre
 * visible o por el de catalogo. Asi "WISE 0855", que el servicio de nombres no
 * conoce, abre igual, y los cinco campos precalculados no dependen de el.
 */
export function findTargetByName(text: string): SkyTarget | null {
  const wanted = normalizeName(text);
  return (
    SKY_TARGETS.find(
      (target) => normalizeName(target.label) === wanted || normalizeName(target.name) === wanted,
    ) ?? null
  );
}
