// Objetos destacados de la entrada: los cinco objetos de prueba de SPEC.md
// (seccion 1), cada uno con el link completo a su campo en el visor.
//
// Es la unica lista de estos objetos. La esfera (src/features/sphere) la usa
// para sus marcadores y le suma los demas campos precalculados para "Lugar al
// azar" (src/features/sphere/targets.ts).
//
// El centro de cada campo es `field_center` de GET /api/resolve: la posicion
// propagada a la epoca 2026,0 y redondeada a 4 decimales
// (docs/contrato-cubo.md, seccion 4.8). Para Barnard y WISE 0855 la posicion
// de catalogo queda a 4,5 y 3,5 minutos de arco de ahi. Van escritos aca, y no
// se resuelven al hacer clic, para que el link sea completo y el campo
// precalculado abra sin pasar por el servicio de nombres.
//
// Los cinco centros se confirmaron el 15 de noviembre de 2026 contra
// /api/resolve del servidor falso (backend/app/fake.py), que responde con las
// respuestas reales de Sesame guardadas en backend/tests/fixtures/sesame.
// featured.test.ts compara los tres que tienen campo de muestra con el pedido
// de ese campo.

import { DEFAULT_VIEW_FOV } from "@/lib/fov";
import { type Band, DEFAULT_MODE, serializeUrlState, type UrlState } from "@/state/urlState";

export interface FeaturedObject {
  /** Clave estable, para las listas de React y los tests. */
  readonly id: string;
  /** Nombre que se muestra, escrito como en el catalogo y sin mayusculas forzadas. */
  readonly label: string;
  /**
   * Texto con el que /api/resolve encuentra el objeto. Va en `name` de la URL,
   * y el visor lo usa para la mira y el rastro.
   */
  readonly name: string;
  /** Centro del campo en grados ICRS: `field_center` de /api/resolve, epoca 2026,0. */
  readonly ra: number;
  readonly dec: number;
  /** Banda con la que abre el visor. */
  readonly band: Band;
}

const BARNARD: FeaturedObject = {
  id: "barnard",
  label: "Barnard's Star",
  name: "Barnard's Star",
  ra: 269.4463,
  dec: 4.7683,
  band: 3,
};

const EPSILON_INDI_B: FeaturedObject = {
  id: "epsilon-indi-b",
  label: "Epsilon Indi B",
  name: "Epsilon Indi B",
  ra: 331.0966,
  dec: -56.8006,
  band: 3,
};

const WISE_0855: FeaturedObject = {
  id: "wise-0855",
  label: "WISE 0855",
  // El servicio de nombres no conoce el apodo: se resuelve por el nombre del
  // catalogo (SPEC.md, seccion 1).
  name: "WISE J085510.83-071442.5",
  ra: 133.7598,
  dec: -7.2422,
  // Solo se detecta en los detectores 5 y 6 (SPEC.md, seccion 2).
  band: 6,
};

const RW_AURIGAE: FeaturedObject = {
  id: "rw-aurigae",
  label: "RW Aurigae",
  name: "RW Aurigae",
  ra: 76.9566,
  dec: 30.4013,
  // El detector 1 es el unico donde no satura (SPEC.md, seccion 2 y Etapa 2).
  band: 1,
};

const R_DRACONIS: FeaturedObject = {
  id: "r-draconis",
  label: "R Draconis",
  name: "R Draconis",
  ra: 248.1672,
  dec: 66.755,
  band: 3,
};

/** Los cinco objetos de prueba, en el orden en que se muestran. */
export const FEATURED_OBJECTS: readonly FeaturedObject[] = [
  BARNARD,
  EPSILON_INDI_B,
  WISE_0855,
  RW_AURIGAE,
  R_DRACONIS,
];

/** Objeto del ejemplo del buscador: su nombre y las coordenadas de su campo. */
export const SEARCH_EXAMPLE: FeaturedObject = BARNARD;

/**
 * Coordenadas de un objeto como se pueden tipear en el buscador: grados con
 * cuatro decimales y punto, en cualquier idioma. Son los mismos decimales del
 * centro del campo, asi que quien copia el ejemplo abre el campo precalculado y
 * no uno casi igual. En sexagesimales con segundos enteros no alcanza: el centro
 * de Barnard quedaba a 1,8 segundos de arco y era otro campo.
 */
export function typedCoordinates(object: FeaturedObject): string {
  const sign = object.dec < 0 ? "-" : "+";
  return `${object.ra.toFixed(4)} ${sign}${Math.abs(object.dec).toFixed(4)}`;
}

/** Parte del estado de la URL que abre un campo en el visor: siempre con coordenadas. */
export type ViewerUrlPatch = Pick<UrlState, "fov" | "band" | "mode" | "epoch" | "name"> & {
  readonly ra: number;
  readonly dec: number;
};

/** Estado de URL que abre el campo de un objeto destacado: vista de 10 minutos y su banda. */
export function featuredUrlPatch(object: FeaturedObject): ViewerUrlPatch {
  return {
    ra: object.ra,
    dec: object.dec,
    fov: DEFAULT_VIEW_FOV,
    band: object.band,
    mode: DEFAULT_MODE,
    epoch: null,
    name: object.name,
  };
}

/** Link al visor para un estado de URL: la raiz del sitio con la consulta completa. */
export function viewerHref(state: UrlState): string {
  return `${import.meta.env.BASE_URL}${serializeUrlState(state)}`;
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Texto que hay que mandarle a /api/resolve para lo que escribio la persona.
 * Es el mismo texto, salvo que sea el nombre visible de un destacado que el
 * servicio de nombres no conoce: "WISE 0855" se busca por su nombre de catalogo.
 */
export function resolvableName(text: string): string {
  const wanted = normalize(text);
  return FEATURED_OBJECTS.find((object) => normalize(object.label) === wanted)?.name ?? text;
}
