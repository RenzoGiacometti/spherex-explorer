// Registro de traducciones: un namespace por funcionalidad.
//
// Para sumar un namespace: crear locales/es/<nombre>.json y
// locales/en/<nombre>.json con las mismas claves, importarlos aca y agregarlos
// a los dos idiomas. resources.test.ts falla si las claves no coinciden.
//
// Los textos de una pagina de desarrollo no van aca: lo que se importa en este
// archivo viaja en el sitio compilado. Ver src/dev/devTexts.ts.

import enCommon from "./locales/en/common.json";
import enComponents from "./locales/en/components.json";
import enContext from "./locales/en/context.json";
import enEntry from "./locales/en/entry.json";
import enErrors from "./locales/en/errors.json";
import enSpectrum from "./locales/en/spectrum.json";
import enViewer from "./locales/en/viewer.json";
import esCommon from "./locales/es/common.json";
import esComponents from "./locales/es/components.json";
import esContext from "./locales/es/context.json";
import esEntry from "./locales/es/entry.json";
import esErrors from "./locales/es/errors.json";
import esSpectrum from "./locales/es/spectrum.json";
import esViewer from "./locales/es/viewer.json";

export const DEFAULT_NAMESPACE = "common";

export const resources = {
  es: {
    common: esCommon,
    components: esComponents,
    context: esContext,
    entry: esEntry,
    errors: esErrors,
    spectrum: esSpectrum,
    viewer: esViewer,
  },
  en: {
    common: enCommon,
    components: enComponents,
    context: enContext,
    entry: enEntry,
    errors: enErrors,
    spectrum: enSpectrum,
    viewer: enViewer,
  },
} as const;

export type Namespace = keyof (typeof resources)["es"];

export const NAMESPACES = Object.keys(resources.es) as Namespace[];
