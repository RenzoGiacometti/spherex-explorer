// Celular: cuanto ocuparian los controles de abajo si el modo fuera el parpadeo.
//
// En los modos que comparan con una epoca de referencia (diferencia, rojo/cian,
// mantener apretado) el panel Modo suma controles arriba del selector de modos:
// la epoca de referencia, el boton de mantener y los avisos de la comparacion.
// La imagen no se achica por eso: ViewerPage le reserva a la zona de controles
// el alto que tendria en el parpadeo y lo que no entra se desplaza adentro
// (ViewerPage.module.css, `data-stage-lock`).
//
// Ese alto se calcula con lo que hay en pantalla, sin haber pasado antes por el
// parpadeo: un link abierto directamente en rojo/cian muestra la imagen del
// mismo tamano que uno abierto en parpadeo y cambiado de modo despues. Solo se
// lee el layout, no se toca: no mueve el desplazamiento de los controles ni el foco.

import { type RefObject, useLayoutEffect, useState } from "react";
import type { ViewMode } from "@/state/urlState";

/** El modo en el que el panel Modo del celular muestra solo su selector de modos. */
const PLAIN_MODE: ViewMode = "blink";

/** El radio de ese modo: con el se encuentra el selector de modos (un `fieldset` de radios). */
const PLAIN_MODE_RADIO = `input[type="radio"][value="${PLAIN_MODE}"]`;

/** El navegador hace layout en fracciones de 1/64 de pixel: la medida se lleva a esa grilla. */
const LAYOUT_UNITS_PER_PIXEL = 64;

function snap(value: number): number {
  return Math.round(value * LAYOUT_UNITS_PER_PIXEL) / LAYOUT_UNITS_PER_PIXEL;
}

/**
 * Alto, en pixeles CSS, que ocuparian los controles del celular en el parpadeo:
 * el de todo lo que tienen, menos lo que el modo suma arriba del selector de
 * modos (ModePanel, variante `compact`: los modos van abajo de todo).
 *
 * Vale igual con los controles desplazados o recortados: sale de la distancia
 * entre sus hijos, no de la caja que los contiene. `null` si no hay nada que
 * medir (sin controles, o donde no hay layout).
 */
export function plainControlsHeight(controls: HTMLElement): number | null {
  const first = controls.firstElementChild;
  const last = controls.lastElementChild;
  if (first === null || last === null) return null;
  const natural = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top;

  const modes = controls.querySelector(PLAIN_MODE_RADIO)?.closest("fieldset") ?? null;
  const lead = modes?.parentElement?.firstElementChild ?? null;
  const extra =
    modes === null || lead === null
      ? 0
      : Math.max(0, modes.getBoundingClientRect().top - lead.getBoundingClientRect().top);

  const height = snap(natural - extra);
  return height > 0 ? height : null;
}

/**
 * El alto de `plainControlsHeight`, al dia: se mide despues de cada dibujo,
 * antes de pintar, y cuando cambia de tamano alguno de los controles (la
 * ventana se angosta y un renglon se parte, o termina la carga del campo).
 * `null` mientras no hace falta (`enabled` en false) o no se puede medir.
 */
export function usePlainControlsHeight(
  controlsRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): number | null {
  const [height, setHeight] = useState<number | null>(null);

  // Sin dependencias: lo que hay en los controles cambia de un dibujo a otro (la epoca de
  // referencia aparece cuando el campo ya tiene sus epocas; el boton de la curva, cuando abre).
  useLayoutEffect(() => {
    if (!enabled) return;
    const controls = controlsRef.current;
    if (controls === null) return;

    const measure = (): void => {
      const next = plainControlsHeight(controls);
      // Sin layout no hay medida: queda la ultima, o ninguna.
      if (next !== null) setHeight(next);
    };

    // Antes de pintar: la imagen no se ve cambiar de tamano al abrir.
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // Los hijos tambien: recortados por el desplazamiento, la caja de los controles no cambia con ellos.
    const observer = new ResizeObserver(measure);
    observer.observe(controls);
    for (const child of controls.children) observer.observe(child);
    return () => observer.disconnect();
  });

  return enabled ? height : null;
}
