import { useTranslation } from "react-i18next";
import { DEFAULT_LANGUAGE, type Language, matchLanguage } from "./languages";

/**
 * Idioma activo dentro de un componente. Se actualiza al cambiar de idioma y
 * sirve para pasarle el idioma a las funciones de lib/format.ts.
 */
export function useLanguage(): Language {
  const { i18n } = useTranslation();
  return matchLanguage(i18n.resolvedLanguage ?? i18n.language) ?? DEFAULT_LANGUAGE;
}
