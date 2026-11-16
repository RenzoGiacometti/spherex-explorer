// Accesos directos de la entrada: un campo precalculado y el modo del visor
// en el que mejor se ve. Van junto al boton del recorrido guiado (SpherePage).
//
// Los centros son los de los campos precalculados (features/entry/featured.ts,
// `PRECOMPUTED_OBJECTS`), con sus 4 decimales: asi se abre el campo guardado y
// no uno casi igual.

import type { IconName } from "@/components";
import type { ViewerUrlPatch } from "@/features/entry";
import { DEFAULT_VIEW_FOV } from "@/lib/fov";

export interface EntryShortcut {
  /** Tambien es la clave de su texto: `shortcuts.<id>` en sphere.*.json. */
  readonly id: "journey" | "curtain";
  readonly icon: IconName;
  /** Nombre del objeto, para el aviso "Abriendo ...". Es un nombre propio: no se traduce. */
  readonly label: string;
  readonly patch: ViewerUrlPatch;
}

export const ENTRY_SHORTCUTS: readonly EntryShortcut[] = [
  {
    // Viaje en el tiempo: Wolf 359 se mueve 4,7" por anio y el viaje va de la
    // placa de 1953 a SPHEREx en 2026. Banda 6: la que tiene exposiciones validas.
    id: "journey",
    icon: "clock",
    label: "Wolf 359",
    patch: {
      ra: 164.0925,
      dec: 6.9952,
      fov: DEFAULT_VIEW_FOV,
      band: 6,
      mode: "journey",
      epoch: null,
      name: "Wolf 359",
    },
  },
  {
    // Visible contra infrarrojo: M 51 con la cortina, la placa del DSS contra SPHEREx B3.
    id: "curtain",
    icon: "contrast",
    label: "M 51",
    patch: {
      ra: 202.4696,
      dec: 47.1953,
      fov: DEFAULT_VIEW_FOV,
      band: 3,
      mode: "curtain",
      epoch: null,
      name: "M 51",
    },
  },
];
