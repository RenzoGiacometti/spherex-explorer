// Forma de la grilla de un campo antes de conocer `grid`.
//
// La vista provisoria puede quedar lista antes de `listed`, cuando el
// documento todavia no trae `grid` (docs/contrato-cubo.md, secciones 4.2 y 5).
// Para poder bajarla y comprobar su tamano sin esperar la lista de
// exposiciones se usa la tabla de escalones de la seccion 3 del contrato:
//
//   Base    fov 0,1667   195 x 195 px
//   Amplio  fov 0,5      293 x 293 px
//
// Es solo un adelanto: apenas llega `grid.shape` manda ese valor, y si no
// coincide con el de la tabla la vista se vuelve a pedir.

import type { GridShape } from "@/api/binary";
import { FIELD_FOVS, type FieldFov } from "@/lib/fov";

const STEP_SHAPES: Record<FieldFov, GridShape> = {
  0.1667: [195, 195],
  0.5: [293, 293],
};

// El mismo margen que lib/fov.ts, para que 0,16667 cuente como el escalon base.
const TOLERANCE = 1e-4;

/**
 * Forma [ny, nx] de la grilla del escalon al que corresponde `fov`, segun la
 * tabla del contrato; null si `fov` no entra en ningun escalon.
 */
export function contractGridShape(fov: number): GridShape | null {
  if (!Number.isFinite(fov) || fov <= 0) return null;
  const step = FIELD_FOVS.find((candidate) => fov <= candidate + TOLERANCE);
  return step === undefined ? null : STEP_SHAPES[step];
}

export function sameShape(a: GridShape, b: GridShape): boolean {
  return a[0] === b[0] && a[1] === b[1];
}
