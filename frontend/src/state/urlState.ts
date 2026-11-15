// Estado en la URL (SPEC.md, seccion 3.3):
//
//   /?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink
//
// Todo lo que hace falta para volver a abrir la misma vista esta en la URL.
// Sin `ra` y `dec` validos se muestra la entrada; con ellos, el visor.
//
//   ra, dec  centro del campo en grados ICRS (4 decimales, como normaliza el backend)
//   fov      lado de la vista en grados: 0.0833 (5'), 0.1667 (10') o 0.5 (30').
//            Donde la interfaz no ofrece el campo de 30' (lib/deploy.ts), un
//            valor mayor que 10' se lee como 10' y la URL se corrige.
//   band     detector que se esta mirando, de 1 a 6
//   mode     blink, difference, sum, redcyan, hold, journey o curtain
//   epoch    epoca actual, desde 1 (opcional)
//   ref      epoca de referencia (B) elegida a mano, desde 1 (opcional; sin
//            ella el visor elige la mejor cubierta y mas lejana en fecha)
//   stretch  estirado elegido a mano: linear, log o asinh (opcional; sin el,
//            el del modo: lineal en difference y redcyan, asinh en los demas)
//   name     nombre del objeto, para la mira y el rastro (opcional)
//   contrast posicion del control de contraste, de 0 a 100 (opcional; sin el, 50)
//   flags    1 con la capa de flags prendida
//   gaia     1 con la capa de Gaia prendida
//   sobj     1 si el punto elegido, con su panel abierto, es el objeto de `name`
//   sra, sdec  punto elegido en grados ICRS (5 decimales), si no es el objeto:
//            al abrir el link se vuelve a pedir su espectro y se abre el panel
//   tab      pestana abierta de ese panel: lightcurve (opcional; sin ella, el espectro)
//   const    1 con la capa de constelaciones de la esfera de entrada prendida
//            (src/features/sphere). Es de la entrada, no del campo: se escribe
//            con y sin campo, asi al volver del visor la capa sigue prendida
//   embed    1 oculta la interfaz alrededor del visor
//   lang     es o en; sin el, el idioma sale del navegador
//
// Un valor invalido no rompe nada: se reemplaza por su valor por defecto.

import { create } from "zustand";
import { type Language, matchLanguage } from "@/i18n/languages";
import { WIDE_FIELD_ENABLED } from "@/lib/deploy";
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

/** Pestanas del panel de la fuente elegida: su espectro y su curva de luz. */
export const SOURCE_TABS = ["spectrum", "lightcurve"] as const;

export type SourceTabName = (typeof SOURCE_TABS)[number];

export const DEFAULT_TAB: SourceTabName = "spectrum";

/** Contraste de partida, en porcentaje del recorrido del control (`DEFAULT_CONTRAST`). */
export const DEFAULT_CONTRAST_PERCENT = 50;

/**
 * Decimales de `sra` y `sdec`: 0,04 segundos de arco, muy por debajo del pixel
 * de 6 segundos. Con los 4 del centro del campo el punto se correria 0,2.
 */
const POINT_DECIMALS = 5;

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
  /** Posicion del control de contraste, en porcentaje entero de 0 a 100. */
  contrast: number;
  /** Capa de flags prendida. */
  flags: boolean;
  /** Capa de Gaia prendida. */
  gaia: boolean;
  /** El punto elegido, con su panel abierto, es el objeto de `name`. */
  sobj: boolean;
  /** Punto elegido en grados ICRS; null si no hay ninguno o si es el objeto. */
  sra: number | null;
  sdec: number | null;
  /** Pestana abierta del panel del punto elegido; sin punto, la del espectro. */
  tab: SourceTabName;
  /** Capa de constelaciones de la esfera de entrada prendida (`const` en la URL). */
  constellations: boolean;
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
  contrast: DEFAULT_CONTRAST_PERCENT,
  flags: false,
  gaia: false,
  sobj: false,
  sra: null,
  sdec: null,
  tab: DEFAULT_TAB,
  constellations: false,
  embed: false,
  lang: null,
};

/**
 * Nombres de los parametros en la URL. Casi todos se llaman como su clave del
 * estado; la capa de constelaciones (`constellations`) se escribe `const`.
 */
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
  "contrast",
  "flags",
  "gaia",
  "sobj",
  "sra",
  "sdec",
  "tab",
  "const",
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

function roundCoordinate(value: number, decimals = COORDINATE_DECIMALS): number {
  const rounded = Number(value.toFixed(decimals));
  // Evita el "-0" que deja un valor negativo muy chico.
  return rounded === 0 ? 0 : rounded;
}

function normalizeRa(ra: number, decimals = COORDINATE_DECIMALS): number {
  const wrapped = roundCoordinate(((ra % 360) + 360) % 360, decimals);
  // 359,99996 redondea a 360: vuelve a 0.
  return wrapped >= 360 ? 0 : wrapped;
}

/** Declinacion posible: de -90 a 90 grados. */
function isDeclination(dec: number): boolean {
  return dec >= -90 && dec <= 90;
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

/** Porcentaje entero de 0 a 100; cualquier otra cosa es el contraste de partida. */
function parseContrast(text: string | null): number {
  const value = text !== null && /^\d{1,3}$/.test(text) ? Number(text) : null;
  return value !== null && value <= 100 ? value : DEFAULT_CONTRAST_PERCENT;
}

function parseTab(text: string | null): SourceTabName {
  return SOURCE_TABS.find((tab) => tab === text) ?? DEFAULT_TAB;
}

/** Conmutador de la URL: prendido con 1 o true. */
function parseSwitch(text: string | null): boolean {
  return text === "1" || text === "true";
}

function parseName(text: string | null): string | null {
  const name = text?.trim() ?? "";
  return name === "" || name.length > MAX_NAME_LENGTH ? null : name;
}

/**
 * Vista mas grande que ofrece la interfaz sin el campo amplio: 10'. Un link con
 * `fov=0.5` no tiene que pedir ahi un campo de 30' que la interfaz no muestra.
 */
const MAX_BASE_VIEW_FOV: ViewFov = DEFAULT_VIEW_FOV;

export interface ParseUrlOptions {
  /** La interfaz ofrece el campo de 30'. Por defecto, lo que diga la compilacion. */
  readonly wideField?: boolean;
}

/** Lleva `fov` de la URL a una vista que la interfaz ofrece. */
function parseFov(text: string | null, wideField: boolean): ViewFov {
  const value = parseDecimal(text);
  const fov = (value === null ? null : snapViewFov(value)) ?? DEFAULT_VIEW_FOV;
  return !wideField && fov > MAX_BASE_VIEW_FOV ? MAX_BASE_VIEW_FOV : fov;
}

/** Dice si el estado trae un campo para abrir en el visor. */
export function hasField(state: UrlState): state is UrlState & { ra: number; dec: number } {
  return state.ra !== null && state.dec !== null;
}

/** Lee el estado de una cadena de consulta ("?ra=..."), con valores por defecto y validacion. */
export function parseUrlState(search: string, options: ParseUrlOptions = {}): UrlState {
  const params = new URLSearchParams(search);
  const wideField = options.wideField ?? WIDE_FIELD_ENABLED;

  const ra = parseDecimal(params.get("ra"));
  const dec = parseDecimal(params.get("dec"));
  // Las coordenadas valen de a dos: una sola, o una declinacion imposible, es no tener campo.
  const hasCoordinates = ra !== null && dec !== null && isDeclination(dec);

  // El punto elegido: el objeto con nombre o, si no, un par de coordenadas.
  const name = parseName(params.get("name"));
  const sobj = parseSwitch(params.get("sobj")) && name !== null;
  const sra = parseDecimal(params.get("sra"));
  const sdec = parseDecimal(params.get("sdec"));
  const hasPoint = !sobj && sra !== null && sdec !== null && isDeclination(sdec);

  return {
    ra: hasCoordinates ? normalizeRa(ra) : null,
    dec: hasCoordinates ? roundCoordinate(dec) : null,
    fov: parseFov(params.get("fov"), wideField),
    band: parseBand(params.get("band")),
    mode: parseMode(params.get("mode")),
    epoch: parseEpoch(params.get("epoch")),
    ref: parseEpoch(params.get("ref")),
    stretch: parseStretch(params.get("stretch")),
    name,
    contrast: parseContrast(params.get("contrast")),
    flags: parseSwitch(params.get("flags")),
    gaia: parseSwitch(params.get("gaia")),
    sobj,
    sra: hasPoint ? normalizeRa(sra, POINT_DECIMALS) : null,
    sdec: hasPoint ? roundCoordinate(sdec, POINT_DECIMALS) : null,
    // La pestana es la del panel del punto: sin punto no hay panel abierto.
    tab: sobj || hasPoint ? parseTab(params.get("tab")) : DEFAULT_TAB,
    constellations: parseSwitch(params.get("const")),
    embed: parseSwitch(params.get("embed")),
    lang: matchLanguage(params.get("lang")),
  };
}

/**
 * Escribe el estado como cadena de consulta, con "?" adelante o vacia.
 * Con un campo van siempre ra, dec, fov, band y mode; epoch, ref, stretch y
 * name solo si estan, y contrast, flags, gaia, el punto elegido (sobj, o sra
 * y sdec) y tab solo si no valen lo de partida. Sin campo solo quedan const,
 * embed y lang, que son de la pagina y no del campo.
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
    if (state.contrast !== DEFAULT_CONTRAST_PERCENT) {
      params.set("contrast", String(Math.round(state.contrast)));
    }
    if (state.flags) params.set("flags", "1");
    if (state.gaia) params.set("gaia", "1");
    const isObject = state.sobj && state.name !== null;
    const hasPoint = !isObject && state.sra !== null && state.sdec !== null;
    if (isObject) params.set("sobj", "1");
    if (hasPoint) {
      params.set("sra", String(normalizeRa(state.sra ?? 0, POINT_DECIMALS)));
      params.set("sdec", String(roundCoordinate(state.sdec ?? 0, POINT_DECIMALS)));
    }
    if ((isObject || hasPoint) && state.tab !== DEFAULT_TAB) params.set("tab", state.tab);
  }
  if (state.constellations) params.set("const", "1");
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
   * banda, modo, epoca, referencia, estirado, contraste, capas (las del visor y
   * la de constelaciones de la entrada) o punto elegido.
   * "push" agrega una entrada; sirve para abrir otro campo.
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
    contrast: store.contrast,
    flags: store.flags,
    gaia: store.gaia,
    sobj: store.sobj,
    sra: store.sra,
    sdec: store.sdec,
    tab: store.tab,
    constellations: store.constellations,
    embed: store.embed,
    lang: store.lang,
  };
}

function readLocation(): UrlState {
  return typeof window === "undefined" ? DEFAULT_URL_STATE : parseUrlState(window.location.search);
}

/**
 * Dice si `fov` de una consulta pide una vista mas grande que la que ofrece la
 * interfaz (el campo de 30' donde esta oculto): ahi la URL se corrige al leerla.
 */
export function fovOverMaximum(search: string, options: ParseUrlOptions = {}): boolean {
  if (options.wideField ?? WIDE_FIELD_ENABLED) return false;
  const requested = parseDecimal(new URLSearchParams(search).get("fov"));
  if (requested === null) return false;
  // Lo que pasa del contrato (mas de 30') tampoco es una vista: tambien queda en 10'.
  return (snapViewFov(requested) ?? requested) > MAX_BASE_VIEW_FOV;
}

/** Lee el estado de la URL y, si pedia una vista que la interfaz no ofrece, la corrige. */
function readAndCorrectLocation(): UrlState {
  const state = readLocation();
  if (typeof window !== "undefined" && fovOverMaximum(window.location.search)) {
    writeLocation(state, "replace");
  }
  return state;
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
  try {
    if (history === "push") window.history.pushState(window.history.state, "", url);
    else window.history.replaceState(window.history.state, "", url);
  } catch {
    // Safari corta a las 100 escrituras del historial en 30 s: la barra de
    // direcciones queda atrasada hasta el proximo cambio, y el visor sigue.
  }
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
  ...readAndCorrectLocation(),

  update(patch, options) {
    const previous = pickState(get());
    const merged = { ...previous, ...patch };
    // La epoca de referencia es del campo: otro centro no la hereda, salvo que el cambio la traiga.
    const otherCenter = merged.ra !== previous.ra || merged.dec !== previous.dec;
    if (!("ref" in patch) && otherCenter) merged.ref = null;
    // El punto elegido tambien es del campo: al abrir otro (una entrada nueva
    // del historial) no se hereda. Una correccion del centro en la misma
    // entrada (fieldUrlSync.ts lleva el link a su campo guardado) lo conserva.
    const bringsPoint = "sobj" in patch || "sra" in patch || "sdec" in patch;
    if (otherCenter && options?.history === "push" && !bringsPoint) {
      merged.sobj = false;
      merged.sra = null;
      merged.sdec = null;
      merged.tab = DEFAULT_TAB;
    }
    const next = normalizeUrlState(merged);
    writeLocation(next, options?.history ?? "replace");
    set(next);
  },

  syncFromLocation() {
    set(readAndCorrectLocation());
  },
}));

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => useUrlState.getState().syncFromLocation());
}
