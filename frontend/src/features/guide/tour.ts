// Recorrido guiado "Encontra a WISE 0855": sus pasos y cuando se cumple cada
// uno. Funciones puras; el estado esta en guideStore.ts y lo que se dibuja, en
// GuideTour.tsx.
//
//   paso      que hace la persona            como se sabe que lo hizo
//   band      elige la banda B6              `band` de la URL
//   play      reproduce el parpadeo          `data-playing` de la pantalla del visor
//   redcyan   activa el modo rojo/cian       `mode` de la URL
//   locate    marca el objeto en la imagen   un clic o un toque cerca de su posicion
//   closing   lee que es lo que encontro     el boton Terminar
//
// Lo que se ve en el campo real (precalculado el 15 de noviembre de 2026), y
// por eso las consignas dicen lo que dicen:
//
// - El objeto solo se detecta en B5 y B6 (SPEC.md, seccion 2). En las bandas
//   mas azules, casi en el mismo lugar, hay una estrella de fondo que no se
//   mueve: el recorrido abre en B1 y nunca dice que el centro este vacio.
// - En B6 se corre 1,5 px de grilla entre la epoca 2 y la 3. Con la vista de
//   10' son 5 px de pantalla; con la de 5', 10. Por eso abre en 5'.
// - En rojo/cian el visor compara la ultima epoca (A, rojo) con la primera (B,
//   cian). La primera epoca de B6 tiene pocas exposiciones y casi no muestra el
//   objeto, asi que no queda "un lado rojo y otro cian": queda un punto rojo
//   entre estrellas blancas, sobre un fondo moteado de los dos colores.

import { FEATURED_OBJECTS, featuredUrlPatch, type ViewerUrlPatch } from "@/features/entry/featured";
import type { ViewFov } from "@/lib/fov";
import type { Band, ViewMode } from "@/state/urlState";

export const TOUR_STEPS = ["band", "play", "redcyan", "locate", "closing"] as const;

export type TourStep = (typeof TOUR_STEPS)[number];

/** Banda con la que abre el recorrido: la mas azul, donde el objeto no se ve. */
export const TOUR_START_BAND: Band = 1;

/** Vista con la que abre: la de 5', donde lo que el objeto se mueve se nota a simple vista. */
export const TOUR_VIEW_FOV: ViewFov = 0.0833;

/** Banda que pide el primer paso: la mas roja. */
export const TOUR_BAND: Band = 6;

/** Modo en el que se puede reproducir: el segundo paso lo necesita. */
export const TOUR_PLAY_MODE: ViewMode = "blink";

/** Modo que pide el tercer paso. */
export const TOUR_MODE: ViewMode = "redcyan";

/** Clave del objeto del recorrido entre los destacados de la entrada. */
export const TOUR_OBJECT_ID = "wise-0855";

const TOUR_OBJECT = FEATURED_OBJECTS.find((object) => object.id === TOUR_OBJECT_ID);

/**
 * Estado de URL con el que arranca el recorrido: el campo del objeto, con su
 * nombre, en la banda y la vista de partida. null si el objeto ya no esta
 * entre los destacados: sin campo no hay recorrido.
 *
 * El nombre va en la URL desde el principio porque con el el visor pide la
 * trayectoria y sabe donde esta el objeto en cada epoca. La mira que dibuja
 * queda oculta hasta el final (GuideTour.tsx).
 */
export const TOUR_START: ViewerUrlPatch | null = TOUR_OBJECT
  ? { ...featuredUrlPatch(TOUR_OBJECT), band: TOUR_START_BAND, fov: TOUR_VIEW_FOV }
  : null;

/** Dice si el campo abierto es el del recorrido. */
export function isOnTourField(ra: number | null, dec: number | null): boolean {
  return TOUR_START !== null && ra === TOUR_START.ra && dec === TOUR_START.dec;
}

/** Lo que el recorrido mira del visor para saber si un paso se cumplio. */
export interface TourSignals {
  readonly band: Band;
  readonly mode: ViewMode;
  /** El reproductor esta andando. */
  readonly playing: boolean;
}

/**
 * Dice si lo que pide un paso ya esta hecho. `locate` y `closing` no dependen
 * del estado del visor: se cumplen con un clic sobre el objeto y con el boton
 * de cierre.
 *
 * Quien pasa a rojo/cian sin haber reproducido ya comparo dos epocas: el paso
 * del parpadeo se da por hecho, en vez de pedirle que vuelva atras.
 */
export function isStepDone(step: TourStep, signals: TourSignals): boolean {
  switch (step) {
    case "band":
      return signals.band === TOUR_BAND;
    case "play":
      return signals.playing || signals.mode === TOUR_MODE;
    case "redcyan":
      return signals.mode === TOUR_MODE;
    default:
      return false;
  }
}

/**
 * Tiempo entre que un paso se cumple y aparece el siguiente, en ms: lo que
 * hace falta para ver el resultado antes de leer otra consigna. El parpadeo
 * necesita una vuelta entera por las epocas (800 ms cada una a velocidad 1x).
 */
export const STEP_DWELL_MS: Record<TourStep, number> = {
  band: 1500,
  play: 4000,
  redcyan: 600,
  locate: 0,
  closing: 0,
};

/** El paso que sigue; el ultimo se sigue a si mismo. */
export function nextStep(step: TourStep): TourStep {
  return TOUR_STEPS[TOUR_STEPS.indexOf(step) + 1] ?? step;
}

/**
 * Cuanto esperar antes de mostrar el paso siguiente a uno cumplido. Si el
 * siguiente tambien esta cumplido no hay nada que mirar: quien paso a
 * rojo/cian mientras el parpadeo andaba no espera a que termine la vuelta.
 */
export function stepDwell(step: TourStep, signals: TourSignals): number {
  return isStepDone(nextStep(step), signals) ? 0 : STEP_DWELL_MS[step];
}

/** Numero de un paso, desde 1, para "2 / 5". */
export function stepNumber(step: TourStep): number {
  return TOUR_STEPS.indexOf(step) + 1;
}
