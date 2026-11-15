// Que se resalta en cada paso del recorrido y donde va el anillo, en pixeles
// CSS de la ventana. El anillo es un elemento fijo que se dibuja encima de la
// pantalla del visor (GuideTour.tsx); aca solo se decide su lugar.

import { searchArea } from "./locate";
import { TOUR_BAND, TOUR_MODE, type TourStep } from "./tour";
import {
  findButton,
  findImageRoot,
  findOptionCell,
  isShown,
  readPixelsPerArcsec,
  readTargetPoint,
} from "./viewerDom";

/** Nombres con los que se buscan los controles: salen de i18n, en el idioma activo. */
export interface ControlLabels {
  /** Nombre del grupo de bandas (`viewer:band.group`). */
  readonly bandGroup: string;
  /** Nombre del grupo de modos (`viewer:comparison.group`). */
  readonly modeGroup: string;
  /** Nombre del boton de reproducir (`components:transport.play`). */
  readonly play: string;
}

export interface Highlight {
  /** Paso para el que se midio: uno viejo no se dibuja en el paso siguiente. */
  readonly step: TourStep;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** `box` para una celda o un panel; `round` para un boton circular o una zona de la imagen. */
  readonly shape: "box" | "round";
}

/** Separacion entre el anillo y lo que rodea. */
export const RING_OFFSET_PX = 4;

/**
 * Control sobre el que actua la persona en un paso: la celda B6, el boton de
 * reproducir, la celda de rojo/cian o la imagen. null si el paso no tiene
 * (el cierre) o si el control no esta en pantalla.
 */
export function findStepControl(
  step: TourStep,
  page: HTMLElement,
  labels: ControlLabels,
): HTMLElement | null {
  switch (step) {
    case "band":
      return findOptionCell(page, labels.bandGroup, TOUR_BAND);
    case "play":
      return findButton(page, labels.play);
    case "redcyan":
      return findOptionCell(page, labels.modeGroup, TOUR_MODE);
    case "locate":
      return findImageRoot(page);
    default:
      return null;
  }
}

/**
 * Lugar del anillo para un paso. En los pasos con control, lo rodea. En el de
 * ubicar el objeto, marca una zona de la imagen que lo contiene: la imagen
 * entera llega a los bordes de la ventana y un anillo alrededor no diria nada.
 */
export function measureHighlight(
  step: TourStep,
  page: HTMLElement,
  control: HTMLElement | null,
): Highlight | null {
  if (step === "locate") {
    const target = readTargetPoint(page);
    if (target === null) return null;
    const area = searchArea(target, readPixelsPerArcsec(page));
    return {
      step,
      left: area.x - area.radius,
      top: area.y - area.radius,
      width: 2 * area.radius,
      height: 2 * area.radius,
      shape: "round",
    };
  }
  if (control === null || !isShown(control)) return null;
  const rect = control.getBoundingClientRect();
  return {
    step,
    left: rect.left - RING_OFFSET_PX,
    top: rect.top - RING_OFFSET_PX,
    width: rect.width + 2 * RING_OFFSET_PX,
    height: rect.height + 2 * RING_OFFSET_PX,
    // El boton de reproducir es un circulo; las celdas, rectangulos.
    shape: step === "play" ? "round" : "box",
  };
}

/** Dos lugares que se dibujan igual: mismo paso, misma forma y menos de medio pixel de diferencia. */
export function sameHighlight(a: Highlight | null, b: Highlight | null): boolean {
  if (a === null || b === null) return a === b;
  const close = (one: number, other: number): boolean => Math.abs(one - other) < 0.5;
  return (
    a.step === b.step &&
    a.shape === b.shape &&
    close(a.left, b.left) &&
    close(a.top, b.top) &&
    close(a.width, b.width) &&
    close(a.height, b.height)
  );
}

/**
 * Trae un control a la vista si quedo fuera de la ventana (en una ventana
 * angosta los paneles van debajo de la imagen y la pagina se desplaza).
 */
export function ensureVisible(element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const viewHeight = window.innerHeight;
  // Lo que no entra entero (la imagen, a ventana completa) alcanza con que se vea en parte.
  const fits = rect.height <= viewHeight;
  const visible = fits
    ? rect.top >= 0 && rect.bottom <= viewHeight
    : rect.top < viewHeight / 2 && rect.bottom > viewHeight / 2;
  if (visible) return;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  element.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
}
