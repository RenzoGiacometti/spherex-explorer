// Estado en la URL (SPEC.md, seccion 3.3):
//
//   /?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink
//
// Todo lo que hace falta para volver a abrir la misma vista esta en la URL.
// Sin `ra` y `dec` validos se muestra la entrada; con ellos, el visor.
//
//   ra, dec  centro del campo en grados ICRS (4 decimales, como normaliza el backend)
//   fov      lado de la vista en grados: 0.0833 (5'), 0.1667 (10') o 0.5 (30')
//   band     detector que se esta mirando, de 1 a 6
//   mode     blink, difference, sum, redcyan, hold, journey o curtain
//   epoch    epoca actual, desde 1 (opcional)
//   ref      epoca de referencia (B) elegida a mano, desde 1 (opcional; sin
//            ella el visor elige la mejor cubierta y mas lejana en fecha)
//   stretch  estirado elegido a mano: linear, log o asinh (opcional; sin el,
//            el del modo: lineal en difference y redcyan, asinh en los demas)
//   name     nombre del objeto, para la mira y el rastro (opcional)
//   embed    1 oculta la interfaz alrededor del visor
//   lang     es o en; sin el, el idioma sale del navegador
//
// Un valor invalido no rompe nada: se reemplaza por su valor por defecto.

import { create } from "zustand";
import { type Language, matchLanguage } from "@/i18n/languages";
import { DEFAULT_VIEW_FOV, snapViewFov, type ViewFov } from "@/lib/fov";
import { STRETCH_KINDS, type StretchKind } from "@/viewer/stretch";

/**
 * Modos del visor: parpadeo, diferencia, suma, rojo/cian, mantener apretado y
 * viaje entre misiones (2MASS, WISE y las epocas de SPHEREx en orden de fecha;
 * solo en los campos con contexto guardado, en los demas cae a parpadeo).
 */
export const VIEW_MODES = [
  "blink",
  "difference",
  "sum",
  "redcyan",
  "hold",
  "journey",
  "curtain",
] as const;

export type ViewMode = (typeof VIEW_MODES)[number];

export const DEFAULT_MODE: ViewMode = "blink";

/** Detectores de SPHEREx; la interfaz los muestra como B1 a B6. */
export const BANDS = [1, 2, 3, 4, 5, 6] as const;

export type Band = (typeof BANDS)[number];

export const DEFAULT_BAND: Band = 3;

/** Largo maximo de `name`; lo que pase de ahi no es un nombre de objeto. */
const MAX_NAME_LENGTH = 120;

/** Decimales de `ra` y `dec` en la URL: los mismos a los que redondea el backend. */
const COORDINATE_DECIMALS = 4;

export interface UrlState {
  /** Ascension recta del centro en grados, en [0, 360); null si no hay campo. */
  ra: number | null;
  /** Declinacion del centro en grados; null si no hay campo. */
  dec: number | null;
  /** Lado de la vista en grados. */
  fov: ViewFov;
  /** Detector que se esta mirando. */
  band: Band;
  mode: ViewMode;
  /** Epoca actual, desde 1; null si la URL no la fija. */
  epoch: number | null;
  /** Epoca de referencia (B) elegida a mano, desde 1; null si la elige el visor. */
  ref: number | null;
  /** Estirado elegido a mano; null si va el del modo. */
  stretch: StretchKind | null;
  /** Nombre del objeto, para la mira y el rastro. */
  name: string | null;
  /** Oculta la interfaz alrededor del visor. */
  embed: boolean;
  /** Idioma pedido en la URL; null si se detecta por el navegador. */
  lang: Language | null;
}

export const DEFAULT_URL_STATE: UrlState = {
  ra: null,
  dec: null,
  fov: DEFAULT_VIEW_FOV,
  band: DEFAULT_BAND,
  mode: DEFAULT_MODE,
  epoch: null,
  ref: null,
  stretch: null,
  name: null,
  embed: false,
  lang: null,
};

const URL_KEYS = [
  "ra",
  "dec",
  "fov",
  "band",
  "mode",
  "epoch",
  "ref",
  "stretch",
  "name",
  "embed",
  "lang",
] as const;

const KNOWN_KEYS: ReadonlySet<string> = new Set(URL_KEYS);

/** Numero decimal simple: sin exponente, sin espacios y sin texto vacio. */
function parseDecimal(text: string | null): number | null {
  if (text === null || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function roundCoordinate(value: number): number {
  const rounded = Number(value.toFixed(COORDINATE_DECIMALS));
  // Evita el "-0" que deja un valor negativo muy chico.
  return rounded === 0 ? 0 : rounded;
}

function normalizeRa(ra: number): number {
  const wrapped = roundCoordinate(((ra % 360) + 360) % 360);
  // 359,99996 redondea a 360: vuelve a 0.
  return wrapped >= 360 ? 0 : wrapped;
}

function parseBand(text: string | null): Band {
  const value = text !== null && /^\d$/.test(text) ? Number(text) : null;
  return BANDS.find((band) => band === value) ?? DEFAULT_BAND;
}

function parseMode(text: string | null): ViewMode {
  return VIEW_MODES.find((mode) => mode === text) ?? DEFAULT_MODE;
}

function parseEpoch(text: string | null): number | null {
  return text !== null && /^[1-9]\d{0,2}$/.test(text) ? Number(text) : null;
}

function parseStretch(text: string | null): StretchKind | null {
  return STRETCH_KINDS.find((kind) => kind === text) ?? null;
}

function parseName(text: string | null): string | null {
  const name = text?.trim() ?? "";
  return name === "" || name.length > MAX_NAME_LENGTH ? null : name;
}

/** Dice si el estado trae un campo para abrir en el visor. */
export function hasField(state: UrlState): state is UrlState & { ra: number; dec: number } {
  return state.ra !== null && state.dec !== null;
}

/** Lee el estado de una cadena de consulta ("?ra=..."), con valores por defecto y validacion. */
export function parseUrlState(search: string): UrlState {
  const params = new URLSearchParams(search);

  const ra = parseDecimal(params.get("ra"));
  const dec = parseDecimal(params.get("dec"));
  // Las coordenadas valen de a dos: una sola, o una declinacion imposible, es no tener campo.
  const hasCoordinates = ra !== null && dec !== null && dec >= -90 && dec <= 90;

  const fov = parseDecimal(params.get("fov"));
  const embed = params.get("embed");

  return {
    ra: hasCoordinates ? normalizeRa(ra) : null,
    dec: hasCoordinates ? roundCoordinate(dec) : null,
    fov: (fov === null ? null : snapViewFov(fov)) ?? DEFAULT_VIEW_FOV,
    band: parseBand(params.get("band")),
    mode: parseMode(params.get("mode")),
    epoch: parseEpoch(params.get("epoch")),
    ref: parseEpoch(params.get("ref")),
    stretch: parseStretch(params.get("stretch")),
    name: parseName(params.get("name")),
    embed: embed === "1" || embed === "true",
    lang: matchLanguage(params.get("lang")),
  };
}

/**
 * Escribe el estado como cadena de consulta, con "?" adelante o vacia.
 * Con un campo van siempre ra, dec, fov, band y mode; epoch, ref, stretch y
 * name solo si estan. Sin campo solo quedan embed y lang.
 */
export function serializeUrlState(state: UrlState): string {
  const params = new URLSearchParams();

  if (hasField(state)) {
    params.set("ra", String(normalizeRa(state.ra)));
    params.set("dec", String(roundCoordinate(state.dec)));
    params.set("fov", String(state.fov));
    params.set("band", String(state.band));
    params.set("mode", state.mode);
    if (state.epoch !== null) params.set("epoch", String(state.epoch));
    if (state.ref !== null) params.set("ref", String(state.ref));
    if (state.stretch !== null) params.set("stretch", state.stretch);
    if (state.name !== null) params.set("name", state.name);
  }
  if (state.embed) params.set("embed", "1");
  if (state.lang !== null) params.set("lang", state.lang);

  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/**
 * Pasa un estado por las mismas reglas que la URL: lo que sale es exactamente
 * lo que se leeria despues de escribirlo.
 */
export function normalizeUrlState(state: UrlState): UrlState {
  return parseUrlState(serializeUrlState(state));
}

export interface UrlUpdateOptions {
  /**
   * "replace" (por defecto) cambia la entrada actual del historial; sirve para
   * banda, modo, epoca, referencia o estirado. "push" agrega una entrada; sirve para abrir otro campo.
   */
  history?: "push" | "replace";
}

export interface UrlStore extends UrlState {
  /** Cambia parte del estado y lo escribe en la URL. */
  update: (patch: Partial<UrlState>, options?: UrlUpdateOptions) => void;
  /** Vuelve a leer el estado de la URL actual (al navegar por el historial). */
  syncFromLocation: () => void;
}

function pickState(store: UrlState): UrlState {
  return {
    ra: store.ra,
    dec: store.dec,
    fov: store.fov,
    band: store.band,
    mode: store.mode,
    epoch: store.epoch,
    ref: store.ref,
    stretch: store.stretch,
    name: store.name,
    embed: store.embed,
    lang: store.lang,
  };
}

function readLocation(): UrlState {
  return typeof window === "undefined" ? DEFAULT_URL_STATE : parseUrlState(window.location.search);
}

/** Escribe el estado en la barra de direcciones, sin tocar los parametros que no son de este modulo. */
function writeLocation(state: UrlState, history: "push" | "replace"): void {
  if (typeof window === "undefined") return;

  const params = new URLSearchParams(serializeUrlState(state));
  for (const [key, value] of new URLSearchParams(window.location.search)) {
    if (!KNOWN_KEYS.has(key)) params.append(key, value);
  }
  const text = params.toString();
  const search = text === "" ? "" : `?${text}`;
  if (search === window.location.search) return;

  const url = `${window.location.pathname}${search}${window.location.hash}`;
  if (history === "push") window.history.pushState(window.history.state, "", url);
  else window.history.replaceState(window.history.state, "", url);
}

/**
 * Estado de la URL como store de zustand:
 *
 *   const band = useUrlState((state) => state.band);
 *   const update = useUrlState((state) => state.update);
 *   update({ band: 6 });
 *   update({ ra: 133.7598, dec: -7.2422, epoch: null, name: null }, { history: "push" });
 */
export const useUrlState = create<UrlStore>()((set, get) => ({
  ...readLocation(),

  update(patch, options) {
    const previous = pickState(get());
    const merged = { ...previous, ...patch };
    // La epoca de referencia es del campo: otro centro no la hereda, salvo que el cambio la traiga.
    if (!("ref" in patch) && (merged.ra !== previous.ra || merged.dec !== previous.dec)) {
      merged.ref = null;
    }
    const next = normalizeUrlState(merged);
    writeLocation(next, options?.history ?? "replace");
    set(next);
  },

  syncFromLocation() {
    set(readLocation());
  },
}));

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => useUrlState.getState().syncFromLocation());
}
