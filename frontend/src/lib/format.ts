// Formato de datos segun DESIGN.md ("Formato de datos"):
// - ascension recta  22h 04m 10s
// - declinacion      -56 46 58 con signo menos tipografico y primas reales
// - fecha ISO        2025-12-03, hora en UTC
// - decimales con coma en espanol (0,75 um) y con punto en ingles (0.75 um)
//
// Son funciones puras: reciben el idioma como argumento y no dependen de
// i18next ni de Intl, para que el resultado sea el mismo en cualquier entorno.

import type { Language } from "@/i18n/languages";

// Los caracteres especiales se arman por codigo para que no dependan de la
// codificacion del archivo ni se confundan con sus parecidos de teclado.

/** Signo menos tipografico (U+2212). */
export const MINUS = String.fromCodePoint(0x2212);
/** Prima (U+2032), minutos de arco. */
export const PRIME = String.fromCodePoint(0x2032);
/** Doble prima (U+2033), segundos de arco. */
export const DOUBLE_PRIME = String.fromCodePoint(0x2033);
/** Signo de grado (U+00B0). */
export const DEGREE = String.fromCodePoint(0x00b0);
/** Signo micro (U+00B5), para micrometros. */
export const MICRO = String.fromCodePoint(0x00b5);
/** Raya corta (U+2013), para rangos. */
export const EN_DASH = String.fromCodePoint(0x2013);
/** Raya (U+2014): lo que se muestra cuando no hay valor. */
export const NO_VALUE = String.fromCodePoint(0x2014);

const DECIMAL_SEPARATOR: Record<Language, string> = { es: ",", en: "." };

const MJD_UNIX_EPOCH = 40587;
const MS_PER_DAY = 86_400_000;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Numero con una cantidad fija de decimales, sin separador de miles, con coma
 * en espanol y punto en ingles, y con signo menos tipografico.
 */
export function formatDecimal(value: number, language: Language, decimals = 2): string {
  if (!Number.isFinite(value)) return NO_VALUE;
  const fixed = Math.abs(value).toFixed(decimals);
  const isZero = Number(fixed) === 0;
  const text = fixed.replace(".", DECIMAL_SEPARATOR[language]);
  return value < 0 && !isZero ? `${MINUS}${text}` : text;
}

/** Entero sin separador de miles, con signo menos tipografico. */
export function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return NO_VALUE;
  const rounded = Math.round(value);
  return rounded < 0 ? `${MINUS}${Math.abs(rounded)}` : String(Math.abs(rounded));
}

/**
 * Parte un angulo no negativo en tres campos sexagesimales redondeando el
 * ultimo, con acarreo: nunca devuelve 60 en minutos o segundos.
 */
function toSexagesimal(
  value: number,
  secondDecimals: number,
): { units: number; minutes: number; seconds: number } {
  const scale = 10 ** secondDecimals;
  const total = Math.round(value * 3600 * scale);
  const perUnit = 3600 * scale;
  const perMinute = 60 * scale;
  const units = Math.floor(total / perUnit);
  const minutes = Math.floor((total - units * perUnit) / perMinute);
  const seconds = (total - units * perUnit - minutes * perMinute) / scale;
  return { units, minutes, seconds };
}

function formatSeconds(seconds: number, decimals: number, language: Language): string {
  if (decimals <= 0) return pad(seconds, 2);
  const [whole = "0", fraction = ""] = seconds.toFixed(decimals).split(".");
  return `${whole.padStart(2, "0")}${DECIMAL_SEPARATOR[language]}${fraction}`;
}

export interface SexagesimalOptions {
  /** Decimales de los segundos. Por defecto 0, como en DESIGN.md. */
  decimals?: number;
  /** Idioma para el separador decimal de los segundos. Por defecto espanol. */
  language?: Language;
}

/** Ascension recta en grados como "22h 04m 10s". */
export function formatRa(raDeg: number, options: SexagesimalOptions = {}): string {
  if (!Number.isFinite(raDeg)) return NO_VALUE;
  const { decimals = 0, language = "es" } = options;
  const normalized = ((raDeg % 360) + 360) % 360;
  const { units, minutes, seconds } = toSexagesimal(normalized / 15, decimals);
  // 359,9999 grados redondea a 24h: vuelve a 00h.
  const hours = units % 24;
  return `${pad(hours, 2)}h ${pad(minutes, 2)}m ${formatSeconds(seconds, decimals, language)}s`;
}

/**
 * Declinacion en grados como "-56 46 58" con signo menos tipografico, signo
 * de grado y primas reales. Las positivas llevan "+", como en los catalogos.
 */
export function formatDec(decDeg: number, options: SexagesimalOptions = {}): string {
  if (!Number.isFinite(decDeg)) return NO_VALUE;
  const { decimals = 0, language = "es" } = options;
  const clamped = Math.min(90, Math.max(-90, decDeg));
  const { units, minutes, seconds } = toSexagesimal(Math.abs(clamped), decimals);
  const isZero = units === 0 && minutes === 0 && seconds === 0;
  const sign = clamped < 0 && !isZero ? MINUS : "+";
  const secondsText = formatSeconds(seconds, decimals, language);
  return `${sign}${pad(units, 2)}${DEGREE} ${pad(minutes, 2)}${PRIME} ${secondsText}${DOUBLE_PRIME}`;
}

/** Fecha como texto ISO "AAAA-MM-DD", en UTC. */
export function formatIsoDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return NO_VALUE;
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

/** Hora del dia como "HH:MM UTC". */
export function formatUtcTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return NO_VALUE;
  return `${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)} UTC`;
}

/** Fecha y hora como "AAAA-MM-DD HH:MM UTC". */
export function formatIsoDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return NO_VALUE;
  return `${formatIsoDate(date)} ${formatUtcTime(date)}`;
}

/** Fecha juliana modificada (UTC) a Date. */
export function mjdToDate(mjd: number): Date {
  return new Date((mjd - MJD_UNIX_EPOCH) * MS_PER_DAY);
}

/** Fecha juliana modificada como texto ISO "AAAA-MM-DD". */
export function formatMjdDate(mjd: number): string {
  if (!Number.isFinite(mjd)) return NO_VALUE;
  return formatIsoDate(mjdToDate(mjd));
}

/** Longitud de onda en micrometros con su unidad: "0,75 um" con signo micro. */
export function formatWavelength(um: number, language: Language, decimals = 2): string {
  if (!Number.isFinite(um)) return NO_VALUE;
  return `${formatDecimal(um, language, decimals)} ${MICRO}m`;
}

/** Rango de una banda sin unidad, como en el selector de banda: "1,63-2,43" con raya corta. */
export function formatWaveRange(
  minUm: number,
  maxUm: number,
  language: Language,
  decimals = 2,
): string {
  if (!Number.isFinite(minUm) || !Number.isFinite(maxUm)) return NO_VALUE;
  return `${formatDecimal(minUm, language, decimals)}${EN_DASH}${formatDecimal(maxUm, language, decimals)}`;
}

/** Angulo en grados decimales con su signo de grado: "133,7598" seguido del signo. */
export function formatDegrees(deg: number, language: Language, decimals = 4): string {
  if (!Number.isFinite(deg)) return NO_VALUE;
  return `${formatDecimal(deg, language, decimals)}${DEGREE}`;
}

/** Lado de un campo en minutos de arco: 0,1667 grados es "10" seguido de la prima. */
export function formatArcminutes(deg: number, language: Language, decimals = 0): string {
  if (!Number.isFinite(deg)) return NO_VALUE;
  return `${formatDecimal(deg * 60, language, decimals)}${PRIME}`;
}

/** Angulo en segundos de arco: "3,075" seguido de la doble prima. */
export function formatArcseconds(arcsec: number, language: Language, decimals = 1): string {
  if (!Number.isFinite(arcsec)) return NO_VALUE;
  return `${formatDecimal(arcsec, language, decimals)}${DOUBLE_PRIME}`;
}

/**
 * Fraccion (0 a 1) como porcentaje. En espanol lleva espacio antes del signo
 * ("64 %", como en DESIGN.md); en ingles no ("64%").
 */
export function formatPercent(fraction: number, language: Language, decimals = 0): string {
  if (!Number.isFinite(fraction)) return NO_VALUE;
  const value = formatDecimal(fraction * 100, language, decimals);
  return language === "es" ? `${value} %` : `${value}%`;
}

/** Nombre de banda que muestra la interfaz para un detector de la API: 3 es "B3". */
export function formatBand(detector: number): string {
  return `B${detector}`;
}
