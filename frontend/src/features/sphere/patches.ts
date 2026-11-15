// Parches de detalle de la esfera: la imagen real de SPHEREx de cada campo
// precalculado, que la escena dibuja sobre el cielo en la posicion del campo
// (SkyScene.ts) y que aparece al acercarse.
//
// Las imagenes y el indice `parches.json` los escribe
// assets/generar_parches.py a partir de backend/data/fields; el comando para
// regenerarlos esta en assets/FUENTES.md. Cada PNG tiene el norte arriba y el
// este a la izquierda, como el visor.
//
// Los PNG no entran en la carga inicial: aca solo quedan sus URL, y la escena
// pide cada imagen cuando la vista se acerca a su campo.

import manifest from "./assets/parches/parches.json";
import type { SkyPosition } from "./skyMath";

/** Un parche: de donde sale la imagen y que parte del cielo cubre. */
export interface SkyPatch extends SkyPosition {
  /** El `id` del campo en src/features/entry/featured.ts. */
  readonly id: string;
  readonly url: string;
  /**
   * Lados de la imagen sobre el plano tangente, en grados de la proyeccion TAN
   * del campo (pixeles por `cdelt`): este-oeste y norte-sur.
   */
  readonly widthDeg: number;
  readonly heightDeg: number;
}

const urls = import.meta.glob<string>("./assets/parches/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

/** Parches disponibles, uno por campo precalculado. */
export const SKY_PATCHES: readonly SkyPatch[] = Object.entries(manifest).flatMap(([id, entry]) => {
  const url = urls[`./assets/parches/${entry.file}`];
  if (url === undefined) return [];
  return [
    {
      id,
      url,
      ra: entry.ra,
      dec: entry.dec,
      widthDeg: entry.width_deg,
      heightDeg: entry.height_deg,
    },
  ];
});

/** Diferencia maxima, en grados, para tomar un punto como el centro de un parche. */
const SAME_CENTER_DEG = 1e-4;

/** Parche cuyo centro es ese punto del cielo, si lo hay: el lugar es un campo precalculado. */
export function findPatch(position: SkyPosition): SkyPatch | undefined {
  return SKY_PATCHES.find(
    (patch) =>
      Math.abs(patch.ra - position.ra) < SAME_CENTER_DEG &&
      Math.abs(patch.dec - position.dec) < SAME_CENTER_DEG,
  );
}
