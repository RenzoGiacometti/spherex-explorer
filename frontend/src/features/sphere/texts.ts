// Textos de la esfera, en espanol e ingles (sphere.es.json, sphere.en.json).
//
// Van al lado de la funcionalidad y se suman a i18next al cargar este modulo,
// igual que los de las paginas de desarrollo (src/dev/devTexts.ts). Cuando la
// esfera pase a ser la entrada, el namespace se puede mudar a
// src/i18n/locales y registrarse en src/i18n/resources.ts como los demas.
//
// Como el namespace no esta en los tipos de i18next (src/i18n/i18next.d.ts),
// `useSphereTexts` tipa las claves con el JSON en espanol: una clave que no
// existe no compila.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n";
import en from "./sphere.en.json";
import es from "./sphere.es.json";

export const SPHERE_NAMESPACE = "sphere";

function register(): void {
  i18n.addResourceBundle("es", SPHERE_NAMESPACE, es, true, true);
  i18n.addResourceBundle("en", SPHERE_NAMESPACE, en, true, true);
}

if (i18n.isInitialized) register();
else i18n.on("initialized", register);

/** Rutas con puntos de las hojas de un arbol de textos: "search.label". */
type Leaves<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type SphereTextKey = Leaves<typeof es>;

export type SphereTexts = (key: SphereTextKey, values?: Record<string, string | number>) => string;

type LooseTranslate = (key: string, options: Record<string, unknown>) => string;

/** Traductor de los textos de la esfera; se actualiza al cambiar de idioma. */
export function useSphereTexts(): SphereTexts {
  const { i18n: instance } = useTranslation();
  const language = instance.resolvedLanguage ?? instance.language;
  return useMemo(() => {
    // El namespace se registra en tiempo de ejecucion: los tipos de i18next no lo conocen.
    const translate = instance.t.bind(instance) as unknown as LooseTranslate;
    return (key, values) => translate(key, { ...values, ns: SPHERE_NAMESPACE, lng: language });
  }, [instance, language]);
}
