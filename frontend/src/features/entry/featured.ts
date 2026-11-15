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
  },
  { id: "luhman-16", label: "Luhman 16", name: "Luhman 16", ra: 162.2955, dec: -53.317, band: 5 },
  { id: "wolf-359", label: "Wolf 359", name: "Wolf 359", ra: 164.0925, dec: 6.9952, band: 6 },
  {
    id: "teegarden",
    label: "Teegarden's Star",
    name: "Teegarden's Star",
    ra: 43.2795,
    dec: 16.8538,
    band: 5,
  },
  { id: "m-82", label: "M 82", name: "M 82", ra: 148.9685, dec: 69.6797, band: 1 },
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

/** Diferencia maxima, en grados, para tomar un centro como el de un campo precalculado. */
const SAME_CENTER_DEG = 1e-4;

/**
 * Banda de apertura de lo buscado, si es un campo precalculado: se reconoce
 * por el texto (su nombre visible o el de catalogo) o por el centro del campo
 * que resolvio el backend. Es la misma banda con la que abren el marcador y
 * "Lugar al azar". `null` para cualquier otro lugar.
 */
export function openingBand(
  text: string,
  center?: { readonly ra: number; readonly dec: number },
): FeaturedObject["band"] | null {
  const wanted = normalize(text);
  const match = PRECOMPUTED_OBJECTS.find(
    (object) =>
      normalize(object.label) === wanted ||
      normalize(object.name) === wanted ||
      (center !== undefined &&
        Math.abs(object.ra - center.ra) < SAME_CENTER_DEG &&
        Math.abs(object.dec - center.dec) < SAME_CENTER_DEG),
  );
  return match?.band ?? null;
}
