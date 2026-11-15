// Textos de las paginas de desarrollo.
//
// Los textos de una pagina `*.devpage.tsx` van al lado de la pagina
// (`<pagina>.es.json`, `<pagina>.en.json`) y los registra ella al cargarse. No
// van en src/i18n/resources.ts: lo que se importa ahi viaja en el sitio
// compilado, y las paginas de desarrollo no existen en el. Sus claves se tipan
// en src/i18n/i18next.d.ts (`DevPageTexts`).

import { i18n } from "@/i18n";
import type { Language } from "@/i18n/languages";

/** Suma los textos de una pagina a i18next; si todavia no arranco, apenas arranque. */
export function registerDevTexts(namespace: string, texts: Record<Language, object>): void {
  const add = (): void => {
    for (const [language, bundle] of Object.entries(texts)) {
      i18n.addResourceBundle(language, namespace, bundle, true, true);
    }
  };
  if (i18n.isInitialized) add();
  else i18n.on("initialized", add);
}
