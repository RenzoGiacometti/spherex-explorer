// Textos de la curva de luz.
//
// Los del panel viven en src/i18n/locales/<idioma>/lightcurve.json y se leen
// con `useTranslation("lightcurve")`, como el resto de la interfaz.
//
// Lo que queda aca es para la pagina de desarrollo (lightcurve.devpage.tsx):
// sus textos no viajan en el sitio compilado, asi que se registran al cargarla.
// Repite a proposito el ayudante de features/spectrum/texts.ts: ninguna de las
// dos funcionalidades depende de la otra.

import type { TFunction } from "i18next";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n";
import type { Language } from "@/i18n/languages";

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

/** La `t` de `useTranslation("lightcurve")`: "chart.axisY", "verdict.variable". */
export type LightcurveT = TFunction<typeof LIGHTCURVE_NAMESPACE>;
