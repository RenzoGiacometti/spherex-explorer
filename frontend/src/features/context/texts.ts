// Textos de las paginas de desarrollo del contexto y como se registran.
//
// Los textos de los componentes estan en src/i18n/locales/<idioma>/, registrados
// en src/i18n/resources.ts: `context.json` (`MissionJourney`, `GaiaLayer`,
// `GaiaControls`), `curtain.json` (`Curtain`, `OpticalCredit`) y
// `objectCard.json` (`ObjectCard`). Se leen con `useTranslation(<namespace>)` y
// sus claves pasan por el tipado global de i18next.
//
// Lo que queda aca es para las paginas de prueba (`*.devpage.tsx`): sus textos
// van al lado (`contextDev.*.json`, `cortinaDev.*.json`, `fichaDev.*.json`), no
// viajan en el sitio compilado y se suman a i18next al cargar la pagina, con
// claves tipadas contra su JSON.

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n";
import type { Language } from "@/i18n/languages";

/** Rutas con puntos de las hojas de un arbol de textos: "journey.title". */
type TextKey<Tree, Prefix extends string = ""> = {
  [Key in keyof Tree & string]: Tree[Key] extends string
    ? `${Prefix}${Key}`
    : TextKey<Tree[Key], `${Prefix}${Key}.`>;
}[keyof Tree & string];

/** Funcion de traduccion de un juego de textos: clave tipada y variables de interpolacion. */
export type Texts<Tree> = (key: TextKey<Tree>, values?: Record<string, string | number>) => string;

type LooseTranslate = (key: string, values?: Record<string, string | number>) => string;

/** Suma un juego de textos a i18next: ya, o apenas arranque. */
export function registerTexts<Tree extends object>(
  namespace: string,
  bundles: Record<Language, Tree>,
): void {
  const add = (): void => {
    for (const [language, bundle] of Object.entries(bundles)) {
      i18n.addResourceBundle(language, namespace, bundle, true, true);
    }
  };
  if (i18n.isInitialized) add();
  else i18n.on("initialized", add);
}

/**
 * Funcion de traduccion de un juego de textos registrado con `registerTexts`.
 * El componente se vuelve a dibujar al cambiar de idioma.
 */
export function useTexts<Tree>(namespace: string): Texts<Tree> {
  const { t } = useTranslation();
  return useCallback(
    (key, values) => (t as unknown as LooseTranslate)(`${namespace}:${key}`, values),
    [t, namespace],
  );
}
