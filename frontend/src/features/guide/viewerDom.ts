// Lo que el recorrido lee de la pantalla del visor.
//
// El recorrido va montado al lado del visor, no adentro: no recibe sus
// controles ni la transformacion de la imagen. Los busca en el documento por lo
// mismo que usan los tests de la pantalla, que es lo que el visor ya publica:
//
//   main[data-layout]                 la pantalla (ViewerPage.tsx)
//   main[data-playing="true"]         el reproductor esta andando
//   fieldset > legend + radios        los selectores de banda y de modo, por su nombre
//   button[aria-label]                el boton de reproducir, por su nombre
//   [role="application"]              la imagen (ImageViewer.tsx)
//   [data-annotation="reticle"]       la mira sobre el objeto (ImageAnnotations.tsx)
//   [data-annotation="scale"]         la barra de escala, con lo que mide
//
// Si alguno de esos cambia, la funcion que lo busca devuelve null y el paso se
// queda sin resaltado, pero el recorrido sigue: los pasos avanzan por el estado
// de la URL y siempre se puede saltar.

import type { ScreenPoint } from "./locate";

/** Pantalla del visor, o null si no esta montada. */
export function findViewerPage(): HTMLElement | null {
  return document.querySelector<HTMLElement>("main[data-layout]");
}

/** Dice si el reproductor de esa pantalla esta andando. */
export function isPlaying(page: HTMLElement | null): boolean {
  return page?.dataset.playing === "true";
}

/** La imagen: el elemento que recibe los gestos del visor. */
export function findImageRoot(page: HTMLElement | null): HTMLElement | null {
  return page?.querySelector<HTMLElement>('[role="application"]') ?? null;
}

/**
 * Celda de una opcion de un control segmentado: la del radio con ese valor,
 * dentro del grupo con ese nombre (su `legend`).
 */
export function findOptionCell(
  page: HTMLElement,
  groupLabel: string,
  value: string | number,
): HTMLElement | null {
  for (const group of page.querySelectorAll("fieldset")) {
    if (group.querySelector("legend")?.textContent?.trim() !== groupLabel) continue;
    for (const input of group.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
      if (input.value === String(value)) return input.closest<HTMLElement>("label") ?? input;
    }
  }
  return null;
}

/** Boton con ese nombre accesible. */
export function findButton(page: HTMLElement, label: string): HTMLElement | null {
  for (const button of page.querySelectorAll<HTMLElement>("button[aria-label]")) {
    if (button.getAttribute("aria-label") === label) return button;
  }
  return null;
}

/**
 * Dice si un elemento ocupa lugar y se ve: los controles del celular siguen
 * montados, con `visibility: hidden`, debajo del cajon de herramientas.
 */
export function isShown(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return getComputedStyle(element).visibility !== "hidden";
}

/**
 * Posicion del objeto en la ventana, en pixeles CSS: el centro de la mira que
 * el visor dibuja sobre el en la epoca que se ve. null si no hay mira: la
 * trayectoria todavia no llego, no hay imagen, o el objeto quedo fuera de la
 * vista. Sirve aunque la mira este oculta con `visibility: hidden`.
 */
export function readTargetPoint(page: HTMLElement | null): ScreenPoint | null {
  const ring = page?.querySelector('[data-annotation="reticle"] circle');
  if (!ring) return null;
  const rect = ring.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * Escala vigente de la imagen, en pixeles CSS por segundo de arco: lo que mide
 * la barra de escala en pantalla dividido lo que mide en el cielo. null si no
 * hay barra.
 */
export function readPixelsPerArcsec(page: HTMLElement | null): number | null {
  const scale = page?.querySelector<SVGElement>('[data-annotation="scale"]');
  if (!scale) return null;
  const arcsec = Number(scale.dataset.arcsec);
  const length = Number(scale.dataset.length);
  if (!(arcsec > 0) || !(length > 0)) return null;
  return length / arcsec;
}
