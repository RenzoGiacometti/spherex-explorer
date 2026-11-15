// Textos del contexto (es, en) y como se usan.
//
// Los textos estan al lado de los componentes (`context.es.json`,
// `context.en.json`) y se suman a i18next al cargar este modulo, con el
// namespace "context". Todavia no figuran en src/i18n/resources.ts: esta
// etapa agrego solo archivos nuevos. Por eso las claves no pasan por el tipado
// global de i18next y se tipan aca, contra el JSON en espanol: `useContextTexts`
// devuelve una funcion que solo acepta claves que existen.
//
// Al integrar: mover los dos JSON a src/i18n/locales/<idioma>/context.json,
// sumarlos a `resources` y reemplazar `useContextTexts()` por
// `useTranslation("context")`. Las claves no cambian.

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n";
import type { Language } from "@/i18n/languages";
import contextEn from "./context.en.json";
import contextEs from "./context.es.json";

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

export const CONTEXT_NAMESPACE = "context";

registerTexts(CONTEXT_NAMESPACE, { es: contextEs, en: contextEn });

/** Textos de los componentes de contexto. */
export function useContextTexts(): Texts<typeof contextEs> {
  return useTexts<typeof contextEs>(CONTEXT_NAMESPACE);
}

export type ContextTexts = ReturnType<typeof useContextTexts>;
