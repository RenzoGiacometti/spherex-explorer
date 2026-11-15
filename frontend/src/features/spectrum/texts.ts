// Textos del panel de espectro (es, en), por i18next.
//
// Viven al lado de la funcionalidad y se registran al cargar este modulo, para
// no tocar src/i18n/resources.ts mientras la Etapa 2 se construye aparte. Al
// integrarla: mover locales/es.json y locales/en.json a
// src/i18n/locales/<idioma>/spectrum.json, sumarlos a resources.ts y reemplazar
// `useSpectrumTexts()` por `useTranslation("spectrum")`.
//
// Las claves se comprueban al compilar contra el JSON en espanol, igual que las
// del resto de la interfaz.

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n";
import type { Language } from "@/i18n/languages";
import en from "./locales/en.json";
import es from "./locales/es.json";

type Leaves<Tree, Prefix extends string = ""> = {
  [Key in keyof Tree & string]: Tree[Key] extends string
    ? `${Prefix}${Key}`
    : Leaves<Tree[Key], `${Prefix}${Key}.`>;
}[keyof Tree & string];

export type TextValues = Record<string, string | number>;

/** Traduce una clave de un juego de textos, con sus variables. */
export type Translate<Tree> = (key: Leaves<Tree>, values?: TextValues) => string;

type LooseT = (key: string, values: TextValues) => string;

/** Registra un juego de textos en i18next bajo `namespace`; si todavia no arranco, apenas arranque. */
export function registerTexts<Tree extends object>(
  namespace: string,
  texts: Record<Language, Tree>,
): void {
  const register = (): void => {
    for (const [language, bundle] of Object.entries(texts)) {
      i18n.addResourceBundle(language, namespace, bundle, true, true);
    }
  };
  if (i18n.isInitialized) register();
  else i18n.on("initialized", register);
}

/** Textos de `namespace` en el idioma activo, con las claves tipadas; se actualiza al cambiar de idioma. */
export function useTexts<Tree>(namespace: string): Translate<Tree> {
  const { t } = useTranslation();
  return useCallback<Translate<Tree>>(
    (key, values) => (t as unknown as LooseT)(`${namespace}:${key}`, values ?? {}),
    [t, namespace],
  );
}

export const SPECTRUM_NAMESPACE = "spectrum";

registerTexts(SPECTRUM_NAMESPACE, { es, en });

/** Traduce una clave del panel: "chart.axisX", "fingerprint.level.strong". */
export type SpectrumT = Translate<typeof es>;

/** Textos del panel en el idioma activo. */
export function useSpectrumTexts(): SpectrumT {
  return useTexts<typeof es>(SPECTRUM_NAMESPACE);
}
