// Textos del medidor (measure.es.json, measure.en.json), en su propio
// namespace de i18next.
//
// Van al lado del codigo y se registran solos al cargarse este modulo, igual
// que los de una pagina de desarrollo (src/dev/devTexts.ts): asi el medidor no
// toca src/i18n/resources.ts ni src/i18n/i18next.d.ts. Cuando el medidor se
// sume al visor, los dos JSON pueden pasar a src/i18n/locales/<idioma>/measure.json
// y registrarse ahi como cualquier otro namespace.
//
// Como el namespace no esta en los tipos de i18next, las claves se comprueban
// aca: `useMeasureTexts` solo acepta las que existen en measure.es.json.

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n";
import type { Language } from "@/i18n/languages";
import en from "./measure.en.json";
import es from "./measure.es.json";

export const MEASURE_NAMESPACE = "measure";

// Los dos idiomas tienen que tener las mismas claves: si a uno le falta una,
// no compila.
const bundles = {
  es: es satisfies typeof en,
  en: en satisfies typeof es,
} satisfies Record<Language, object>;

function register(): void {
  for (const [language, bundle] of Object.entries(bundles)) {
    i18n.addResourceBundle(language, MEASURE_NAMESPACE, bundle, true, true);
  }
}

if (i18n.isInitialized) register();
else i18n.on("initialized", register);

/** Rutas con puntos de las hojas de un arbol de textos: "panel.title". */
type Leaves<Tree> = {
  [Key in keyof Tree & string]: Tree[Key] extends string ? Key : `${Key}.${Leaves<Tree[Key]>}`;
}[keyof Tree & string];

export type MeasureTextKey = Leaves<typeof es>;

export type MeasureTexts = (
  key: MeasureTextKey,
  values?: Record<string, string | number>,
) => string;

/** i18next sin el tipado de claves, que no conoce este namespace. */
type LooseTranslate = (key: string, values?: Record<string, string | number>) => string;

/**
 * Traductor del medidor: `t("panel.title")`. Se actualiza al cambiar de idioma.
 */
export function useMeasureTexts(): MeasureTexts {
  const { t } = useTranslation();
  return useCallback<MeasureTexts>(
    (key, values) => (t as unknown as LooseTranslate)(`${MEASURE_NAMESPACE}:${key}`, values),
    [t],
  );
}
