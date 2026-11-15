// Textos del panel de curva de luz (es, en), por i18next.
//
// Viven al lado de la funcionalidad y se registran al cargar este modulo, para
// no tocar src/i18n/resources.ts mientras esto se construye aparte. Al
// integrarla: mover locales/es.json y locales/en.json a
// src/i18n/locales/<idioma>/lightcurve.json, sumarlos a resources.ts y
// reemplazar `useLightcurveTexts()` por `useTranslation("lightcurve")`.
//
// Las claves se comprueban al compilar contra el JSON en espanol. Este archivo
// repite a proposito el ayudante de features/spectrum/texts.ts: las dos
// funcionalidades se integran por separado y ninguna depende de la otra.

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

export const LIGHTCURVE_NAMESPACE = "lightcurve";

registerTexts(LIGHTCURVE_NAMESPACE, { es, en });

/** Traduce una clave del panel: "chart.axisY", "verdict.variable". */
export type LightcurveT = Translate<typeof es>;

/** Textos del panel en el idioma activo. */
export function useLightcurveTexts(): LightcurveT {
  return useTexts<typeof es>(LIGHTCURVE_NAMESPACE);
}
