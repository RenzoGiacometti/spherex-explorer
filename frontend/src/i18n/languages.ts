// Idiomas de la interfaz. Este modulo no depende de i18next para que lo puedan
// usar lib/format.ts y state/urlState.ts sin cargar el motor de traducciones.

export const SUPPORTED_LANGUAGES = ["es", "en"] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Idioma por defecto cuando ni la URL ni el navegador piden uno admitido. */
export const DEFAULT_LANGUAGE: Language = "es";

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Lleva una etiqueta BCP 47 ("en-US", "ES_ar") al idioma admitido que le
 * corresponde, o null si no hay ninguno.
 */
export function matchLanguage(tag: string | null | undefined): Language | null {
  if (!tag) return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return isLanguage(primary) ? primary : null;
}
