// Tipado de las claves de traduccion: t("viewer:field.ra") se comprueba al compilar.
// El espanol es el idioma de referencia para los tipos.

import "i18next";
import type galleryTexts from "../components/gallery.es.json";
import type viewerDevTexts from "../viewer/viewerDev.es.json";
import type { DEFAULT_NAMESPACE, resources } from "./resources";

/**
 * Textos de las paginas de desarrollo (`*.devpage.tsx`). No estan en
 * `resources`, porque lo que se importa ahi viaja en el sitio compilado: cada
 * pagina registra los suyos al cargarse (src/dev/devTexts.ts). Aca solo se
 * tipan sus claves.
 */
interface DevPageTexts {
  gallery: typeof galleryTexts;
  viewerDev: typeof viewerDevTexts;
}

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: typeof DEFAULT_NAMESPACE;
    resources: (typeof resources)["es"] & DevPageTexts;
  }
}
