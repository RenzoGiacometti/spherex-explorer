// Geometria del paso "ubicar el objeto": cuando un clic cuenta como acierto y
// que zona de la imagen se resalta para buscar. Funciones puras, en pixeles CSS
// de la ventana.

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** Un puntero que se movio mas que esto entre apoyar y soltar fue un arrastre, no un clic. */
export const TAP_MAX_MOVE_PX = 10;

/**
 * Radio de acierto minimo: con los 64 px de diametro de la mira (`reticle` de
 * DESIGN.md) alcanza para un dedo.
 */
export const HIT_MIN_RADIUS_PX = 32;

/**
 * Radio de acierto en el cielo, en segundos de arco. Al acercar, la mancha del
 * objeto (6" de pixel nativo) y lo que se desplazo entre epocas (8" por anio)
 * ocupan mas que el radio minimo: el acierto crece con la imagen.
 */
export const HIT_RADIUS_ARCSEC = 15;

/** Radio de la zona de busqueda: minimo en pantalla y tamano en el cielo. */
export const SEARCH_MIN_RADIUS_PX = 96;
export const SEARCH_RADIUS_ARCSEC = 45;

/**
 * Cuanto se corre el centro de la zona de busqueda respecto del objeto, en
 * fracciones del radio: el objeto queda adentro, pero no en el medio, asi el
 * circulo dice donde mirar sin senialarlo.
 */
export const SEARCH_OFFSET = { x: -0.34, y: 0.26 } as const;

function scaled(minPx: number, arcsec: number, pixelsPerArcsec: number | null): number {
  if (pixelsPerArcsec === null || !Number.isFinite(pixelsPerArcsec) || pixelsPerArcsec <= 0) {
    return minPx;
  }
  return Math.max(minPx, arcsec * pixelsPerArcsec);
}

/** Dice si entre apoyar y soltar el puntero casi no se movio. */
export function isTap(down: ScreenPoint, up: ScreenPoint): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= TAP_MAX_MOVE_PX;
}

/**
 * Radio de acierto en pixeles CSS para la escala vigente de la imagen
 * (`pixelsPerArcsec`: pixeles CSS por segundo de arco; null si no se conoce).
 */
export function hitRadius(pixelsPerArcsec: number | null): number {
  return scaled(HIT_MIN_RADIUS_PX, HIT_RADIUS_ARCSEC, pixelsPerArcsec);
}

/** Dice si un clic en `tap` dio con el objeto, que esta en `target`. */
export function isHit(
  tap: ScreenPoint,
  target: ScreenPoint,
  pixelsPerArcsec: number | null,
): boolean {
  return Math.hypot(tap.x - target.x, tap.y - target.y) <= hitRadius(pixelsPerArcsec);
}

export interface SearchArea {
  /** Centro del circulo. */
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** Circulo que se resalta para buscar el objeto: lo contiene, descentrado. */
export function searchArea(target: ScreenPoint, pixelsPerArcsec: number | null): SearchArea {
  const radius = scaled(SEARCH_MIN_RADIUS_PX, SEARCH_RADIUS_ARCSEC, pixelsPerArcsec);
  return {
    x: target.x + SEARCH_OFFSET.x * radius,
    y: target.y + SEARCH_OFFSET.y * radius,
    radius,
  };
}
