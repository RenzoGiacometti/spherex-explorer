// Registro de traducciones: un namespace por funcionalidad.
//
// Para sumar un namespace: crear locales/es/<nombre>.json y
// locales/en/<nombre>.json con las mismas claves, importarlos aca y agregarlos
// a los dos idiomas. resources.test.ts falla si las claves no coinciden.

import enCommon from "./locales/en/common.json";
import enEntry from "./locales/en/entry.json";
import enViewer from "./locales/en/viewer.json";
import esCommon from "./locales/es/common.json";
import esEntry from "./locales/es/entry.json";
import esViewer from "./locales/es/viewer.json";

export const DEFAULT_NAMESPACE = "common";

export const resources = {
  es: {
    common: esCommon,
    entry: esEntry,
    viewer: esViewer,
  },
  en: {
    common: enCommon,
    entry: enEntry,
    viewer: enViewer,
  },
} as const;

export type Namespace = keyof (typeof resources)["es"];

export const NAMESPACES = Object.keys(resources.es) as Namespace[];
