import { DEFAULT_LANGUAGE, type Language, matchLanguage } from "./languages";

/** Nombre del parametro de URL que fija el idioma. */
export const LANGUAGE_PARAM = "lang";

/**
 * Elige el idioma inicial: el parametro "lang" de la URL, si es un idioma
 * admitido, y si no el idioma por defecto (ingles). El idioma del navegador no
 * se consulta: quien quiere otro lo elige con el selector, que lo deja en la URL.
 */
export function detectLanguage(search: string): Language {
  return matchLanguage(new URLSearchParams(search).get(LANGUAGE_PARAM)) ?? DEFAULT_LANGUAGE;
}
