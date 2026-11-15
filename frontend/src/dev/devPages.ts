// Paginas de desarrollo: pantallas sueltas para mirar una parte de la interfaz
// en un navegador real (una galeria de componentes, el visor con datos de
// muestra) sin armar la aplicacion entera.
//
// Cualquier archivo `src/**/<id>.devpage.tsx` que exporte `devPage` queda
// disponible en `/?dev=<id>` al correr `pnpm dev`. No hay registro que editar:
// alcanza con crear el archivo. En el sitio compilado no existen.

import type { ComponentType } from "react";

export interface DevPage {
  /** Lo que se dibuja en la pagina. */
  readonly Component: ComponentType;
}

export interface DevPageModule {
  readonly devPage: DevPage;
}

export type DevPageLoader = () => Promise<DevPageModule>;

const loaders: Record<string, DevPageLoader> = import.meta.env.DEV
  ? import.meta.glob<DevPageModule>("../**/*.devpage.tsx")
  : {};

/** Identificador de una pagina: el nombre del archivo sin `.devpage.tsx`. */
export function devPageId(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  return file.replace(/\.devpage\.tsx$/, "");
}

/** Identificadores disponibles, en orden alfabetico. */
export function devPageIds(source: Record<string, DevPageLoader> = loaders): string[] {
  return Object.keys(source).map(devPageId).sort();
}

/** Cargador de la pagina con ese identificador, o null si no existe. */
export function findDevPage(
  id: string,
  source: Record<string, DevPageLoader> = loaders,
): DevPageLoader | null {
  for (const [path, loader] of Object.entries(source)) {
    if (devPageId(path) === id) return loader;
  }
  return null;
}
