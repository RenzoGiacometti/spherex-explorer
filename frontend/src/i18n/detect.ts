import { DEFAULT_LANGUAGE, type Language, matchLanguage } from "./languages";

/** Nombre del parametro de URL que fija el idioma. */
export const LANGUAGE_PARAM = "lang";

/**
 * Elige el idioma inicial. Orden de prioridad:
 * 1. el parametro "lang" de la URL, si es un idioma admitido;
 * 2. el primer idioma preferido del navegador que este admitido;
 * 3. espanol.
 */
export function detectLanguage(search: string, browserLanguages: readonly string[]): Language {
  const fromUrl = matchLanguage(new URLSearchParams(search).get(LANGUAGE_PARAM));
  if (fromUrl) return fromUrl;

  for (const tag of browserLanguages) {
    const match = matchLanguage(tag);
    if (match) return match;
  }
  return DEFAULT_LANGUAGE;
}

/** Idiomas preferidos del navegador, o una lista vacia fuera de un navegador. */
export function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}
