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
  /**
   * Otras formas de escribir el nombre, ademas de `label` y `name`. El buscador
   * las reconoce sin distinguir mayusculas, espacios, guiones, apostrofos ni
   * acentos, y abre el campo sin pasar por el servicio de nombres.
   *
   * Un alias equivocado abre el objeto equivocado sin avisar. Por eso aca van
   * solo nombres comunes y formas cortas del propio nombre; un identificador de
   * catalogo (HIP, GJ, NGC, WISE largo, estrella variable) entra solo si lo
   * confirma una respuesta guardada del servicio de nombres
   * (backend/data/sesame). Los demas se resuelven por la red, como cualquier
   * otro nombre.
   */
  readonly aliases: readonly string[];
}

const BARNARD: FeaturedObject = {
  id: "barnard",
  label: "Barnard's Star",
  name: "Barnard's Star",
  ra: 269.4463,
  dec: 4.7683,
  band: 3,
  aliases: ["Barnard", "Barnard Star", "Estrella de Barnard"],
};

const EPSILON_INDI_B: FeaturedObject = {
  id: "epsilon-indi-b",
  label: "Epsilon Indi B",
  name: "Epsilon Indi B",
  ra: 331.0966,
  dec: -56.8006,
  band: 3,
  aliases: ["Eps Ind B", "Eps Indi B", "Epsilon Ind B", "ε Ind B", "ε Indi B"],
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
  aliases: [
    "W0855",
    // Formas cortas del nombre de catalogo de arriba: las mismas cifras, recortadas.
    "W0855-0714",
    "WISE 0855-0714",
    "WISE J0855-0714",
    // Nombre principal con el que responde el servicio de nombres
    // (backend/data/sesame/wise_j085510_83_071442_5-*.xml).
    "WISEA J085510.74-071442.5",
  ],
};

const RW_AURIGAE: FeaturedObject = {
  id: "rw-aurigae",
  label: "RW Aurigae",
  name: "RW Aurigae",
  ra: 76.9566,
  dec: 30.4013,
  // El detector 1 es el unico donde no satura (SPEC.md, seccion 2 y Etapa 2).
  band: 1,
  aliases: ["RW Aur"],
};

const R_DRACONIS: FeaturedObject = {
  id: "r-draconis",
  label: "R Draconis",
  name: "R Draconis",
  ra: 248.1672,
  dec: 66.755,
  band: 3,
  aliases: ["R Dra"],
};

/** Los cinco objetos de prueba, en el orden en que se muestran. */
export const FEATURED_OBJECTS: readonly FeaturedObject[] = [
  BARNARD,
  EPSILON_INDI_B,
  WISE_0855,
  RW_AURIGAE,
  R_DRACONIS,
];

/**
 * Los demas campos precalculados (backend/data/fields): no llevan marcador en la
 * esfera, pero se abren por nombre y, salvo M 42, salen en "Lugar al azar".
 *
 * Banda de apertura de cada campo, la misma para el buscador, el marcador y el
 * azar: la de mejor senal para su objeto. Sale del espectro guardado del objeto
 * (backend/data/spectra/fields), medido el 15 de noviembre de 2026: el detector
 * con mayor senal sobre ruido entre los que tienen al menos la mitad de sus
 * exposiciones sin saturar; si ninguno llega a la mitad, el que tiene mas
 * exposiciones validas; y la banda 3 si el objeto satura en los seis o si la
 * diferencia con la 3 es de menos del 10 %.
 *
 * - Luhman 16 y Teegarden: banda 5 (senal sobre ruido de 314 y 313).
 * - Wolf 359: banda 6, la unica con exposiciones validas ademas de una de la 1.
 * - M 82: banda 1, la unica donde el nucleo no satura.
 * - M 31: banda 5 (senal sobre ruido de 98); el nucleo satura en las bandas 1 a 4.
 * - M 33: banda 2 (senal sobre ruido de 93, un 13 % mas que la 3).
 * - Proxima, Kapteyn y M 42 saturan en los seis detectores; M 51 y M 1 dan su
 *   mejor senal en la 3 o a menos del 10 % de ella.
 *
 * De los cinco objetos de prueba, WISE 0855 abre en la 6 aunque su apertura
 * mida mas senal en las bandas 1 a 3: ahi lo que se mide es la estrella de
 * fondo que tiene a 4 segundos de arco (SPEC.md, seccion 6).
 */
const MORE_PRECOMPUTED_OBJECTS: readonly FeaturedObject[] = [
  {
    id: "proxima-centauri",
    label: "Proxima Centauri",
    name: "Proxima Centauri",
    ra: 217.3698,
    dec: -62.6739,
    band: 3,
    aliases: ["Proxima", "Proxima Cen", "Alpha Centauri C", "Alpha Cen C"],
  },
  {
    id: "luhman-16",
    label: "Luhman 16",
    name: "Luhman 16",
    ra: 162.2955,
    dec: -53.317,
    band: 5,
    aliases: ["Luhman 16 AB"],
  },
  {
    id: "wolf-359",
    label: "Wolf 359",
    name: "Wolf 359",
    ra: 164.0925,
    dec: 6.9952,
    band: 6,
    aliases: [],
  },
  {
    id: "teegarden",
    label: "Teegarden's Star",
    name: "Teegarden's Star",
    ra: 43.2795,
    dec: 16.8538,
    band: 5,
    aliases: ["Teegarden", "Teegarden Star", "Estrella de Teegarden"],
  },
  {
    id: "m-82",
    label: "M 82",
    name: "M 82",
    ra: 148.9685,
    dec: 69.6797,
    band: 1,
    aliases: ["Messier 82", "Cigar Galaxy", "Galaxia del Cigarro"],
  },
  {
    id: "m-51",
    label: "M 51",
    name: "M 51",
    ra: 202.4696,
    dec: 47.1953,
    band: 3,
    aliases: ["Messier 51", "Whirlpool Galaxy", "Galaxia del Remolino"],
  },
  {
    id: "m-42",
    label: "M 42",
    name: "M 42",
    ra: 83.8201,
    dec: -5.3876,
    band: 3,
    aliases: [
      "Messier 42",
      "Orion Nebula",
      "Great Orion Nebula",
      "Nebulosa de Orion",
      "Gran Nebulosa de Orion",
    ],
  },
  {
    id: "m-1",
    label: "M 1",
    name: "M 1",
    ra: 83.6324,
    dec: 22.0174,
    band: 3,
    aliases: ["Messier 1", "Crab Nebula", "Nebulosa del Cangrejo"],
  },
  {
    id: "kapteyn",
    label: "Kapteyn's Star",
    name: "Kapteyn's Star",
    ra: 77.9853,
    dec: -45.0596,
    band: 3,
    aliases: ["Kapteyn", "Kapteyn Star", "Estrella de Kapteyn"],
  },
  {
    id: "m-31",
    label: "M 31",
    name: "M 31",
    ra: 10.6847,
    dec: 41.2687,
    band: 5,
    aliases: ["Messier 31", "Andromeda Galaxy", "Galaxia de Andromeda"],
  },
  {
    id: "m-33",
    label: "M 33",
    name: "M 33",
    ra: 23.4621,
    dec: 30.6602,
    band: 2,
    aliases: ["Messier 33", "Triangulum Galaxy", "Galaxia del Triangulo"],
  },
];

/** Todos los campos precalculados: los cinco objetos de prueba y los demas. */
export const PRECOMPUTED_OBJECTS: readonly FeaturedObject[] = [
  ...FEATURED_OBJECTS,
  ...MORE_PRECOMPUTED_OBJECTS,
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

/**
 * Clave con la que se comparan los nombres: sin mayusculas, acentos, espacios,
 * guiones, puntos ni apostrofos. "Barnards Star", "barnard's-star" y
 * "BARNARD'S STAR" dan la misma.
 */
function aliasKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s\-_.'`´‐-―‘’−]/g, "");
}

/** Cada forma de escribir el nombre de un campo guardado, por su clave. */
const SAVED_FIELD_BY_ALIAS: ReadonlyMap<string, FeaturedObject> = new Map(
  PRECOMPUTED_OBJECTS.flatMap((object) =>
    [object.label, object.name, ...object.aliases].map((alias): [string, FeaturedObject] => [
      aliasKey(alias),
      object,
    ]),
  ),
);

/**
 * Campo guardado que se llama asi, o null. Compara con el nombre visible, el de
 * catalogo y los alias de cada campo, sin red: "WISE 0855", que el servicio de
 * nombres no conoce, o "M51" abren su campo aunque ese servicio no responda.
 */
export function savedFieldByName(text: string): FeaturedObject | null {
  return SAVED_FIELD_BY_ALIAS.get(aliasKey(text)) ?? null;
}

/** Mitad del lado de un campo guardado, en grados: miden 10 minutos de arco. */
const FIELD_HALF_SIDE_DEG = 10 / 60 / 2;

const DEG = Math.PI / 180;

/**
 * Campo guardado cuya huella contiene ese punto del cielo, o null. La huella es
 * el cuadrado de 10 minutos de arco centrado en el centro del campo: la
 * diferencia en ascension recta (por el camino corto, y por el coseno de la
 * declinacion del centro) y la diferencia en declinacion tienen que ser menores
 * que la mitad del lado. Si el punto cae en mas de una, gana el centro mas
 * cercano.
 *
 * Sirve para que unas coordenadas de catalogo abran el campo guardado: las de
 * 2010 de WISE 0855 quedan a 126 segundos de arco del centro, que es la
 * posicion de 2026.
 */
export function savedFieldAt(
  position: { readonly ra: number; readonly dec: number },
  fields: readonly FeaturedObject[] = PRECOMPUTED_OBJECTS,
): FeaturedObject | null {
  let best: FeaturedObject | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const field of fields) {
    const deltaRa = ((((position.ra - field.ra + 180) % 360) + 360) % 360) - 180;
    const east = deltaRa * Math.cos(field.dec * DEG);
    const north = position.dec - field.dec;
    if (Math.abs(east) >= FIELD_HALF_SIDE_DEG || Math.abs(north) >= FIELD_HALF_SIDE_DEG) continue;
    const distance = Math.hypot(east, north);
    if (distance < bestDistance) {
      best = field;
      bestDistance = distance;
    }
  }
  return best;
}
