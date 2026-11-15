// i18next: espanol por defecto e ingles. Todo texto de interfaz sale de
// locales/<idioma>/<namespace>.json; no hay textos sueltos en los componentes.

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { browserLanguages, detectLanguage } from "./detect";
import { DEFAULT_LANGUAGE, type Language, matchLanguage, SUPPORTED_LANGUAGES } from "./languages";
import { DEFAULT_NAMESPACE, NAMESPACES, resources } from "./resources";

export { browserLanguages, detectLanguage, LANGUAGE_PARAM } from "./detect";
export {
  DEFAULT_LANGUAGE,
  isLanguage,
  type Language,
  matchLanguage,
  SUPPORTED_LANGUAGES,
} from "./languages";
export { DEFAULT_NAMESPACE, NAMESPACES, type Namespace } from "./resources";

function applyDocumentLanguage(language: string): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = language;
  }
}

/**
 * Inicializa i18next. Las traducciones van empaquetadas, asi que termina de
 * forma sincronica y no hace falta Suspense. Sin argumento detecta el idioma
 * por el parametro "lang" de la URL y despues por el navegador.
 */
export function initI18n(language?: Language): typeof i18n {
  const initial =
    language ??
    detectLanguage(typeof window === "undefined" ? "" : window.location.search, browserLanguages());

  if (i18n.isInitialized) {
    if (i18n.language !== initial) void i18n.changeLanguage(initial);
    return i18n;
  }

  i18n.on("languageChanged", applyDocumentLanguage);
  void i18n.use(initReactI18next).init({
    resources,
    lng: initial,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: [...SUPPORTED_LANGUAGES],
    ns: NAMESPACES,
    defaultNS: DEFAULT_NAMESPACE,
    initAsync: false,
    interpolation: {
      // React ya escapa lo que se inserta en el DOM.
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  });
  applyDocumentLanguage(initial);
  return i18n;
}

/** Idioma activo, siempre uno de los admitidos. */
export function currentLanguage(): Language {
  return matchLanguage(i18n.resolvedLanguage ?? i18n.language) ?? DEFAULT_LANGUAGE;
}

/** Cambia el idioma de la interfaz. */
export async function setLanguage(language: Language): Promise<void> {
  if (currentLanguage() !== language || i18n.language !== language) {
    await i18n.changeLanguage(language);
  }
}

export { i18n };
