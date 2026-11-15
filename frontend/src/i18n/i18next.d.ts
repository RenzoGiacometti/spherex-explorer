// Tipado de las claves de traduccion: t("viewer:field.ra") se comprueba al compilar.
// El espanol es el idioma de referencia para los tipos.

import "i18next";
import type { DEFAULT_NAMESPACE, resources } from "./resources";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: typeof DEFAULT_NAMESPACE;
    resources: (typeof resources)["es"];
  }
}
