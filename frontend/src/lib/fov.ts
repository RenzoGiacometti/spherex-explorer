// Campo de vision: lo que ofrece la interfaz y lo que se le pide al backend.
//
// docs/contrato-cubo.md, seccion 3: el backend arma dos escalones de campo, el
// base de 10' (0,1667 grados) y el amplio de 30' (0,5 grados). Las vistas de 5'
// y de 10' usan el mismo cubo base: 5' es un acercamiento en el navegador.

/** Lados de vista que ofrece la interfaz, en grados: 5', 10' y 30'. */
export const VIEW_FOVS = [0.0833, 0.1667, 0.5] as const;

export type ViewFov = (typeof VIEW_FOVS)[number];

/** Vista por defecto: 10'. */
export const DEFAULT_VIEW_FOV: ViewFov = 0.1667;

/** Escalones de campo que admite el backend, en grados. */
export const FIELD_FOVS = [0.1667, 0.5] as const;

export type FieldFov = (typeof FIELD_FOVS)[number];

/** Limites de `fov` en POST /api/field. */
export const MIN_FOV = 0.02;
export const MAX_FOV = 0.5;

// Margen para que 0,08333 o 0,16667 cuenten como 5' y 10'.
const TOLERANCE = 1e-4;

/**
 * Lleva un lado en grados a la vista mas chica que lo contiene (igual que el
 * backend, que redondea hacia arriba). Devuelve null si no es un numero o esta
 * fuera de los limites del contrato.
 */
export function snapViewFov(fov: number): ViewFov | null {
  if (!Number.isFinite(fov) || fov < MIN_FOV - TOLERANCE || fov > MAX_FOV + TOLERANCE) return null;
  return VIEW_FOVS.find((option) => fov <= option + TOLERANCE) ?? null;
}

/** Escalon de campo que hay que pedirle al backend para una vista. */
export function fieldFovForView(viewFov: number): FieldFov {
  return FIELD_FOVS.find((step) => viewFov <= step + TOLERANCE) ?? MAX_FOV;
}
