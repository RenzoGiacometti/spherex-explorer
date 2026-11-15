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
// Dos cosas las cambia el recorrido por su cuenta (viewerControls.ts): al
// elegir B6 pasa el estirado a lineal, y al activar rojo/cian elige la epoca
// de referencia (`pickReferenceEpoch`).
//
// Lo que se ve en el campo real (precalculado el 15 de noviembre de 2026), y
// por eso las consignas dicen lo que dicen:
//
// - El objeto solo se detecta en B5 y B6 (SPEC.md, seccion 2). En las bandas
//   mas azules, casi en el mismo lugar, hay una estrella de fondo que no se
//   mueve: el recorrido abre en B1 y nunca dice que el centro este vacio.
// - En B6 se corre 1,5 px de grilla entre la epoca 2 y la 3. Con la vista de
//   10' son 5 px de pantalla; con la de 5', 10. Por eso abre en 5'.
// - Por defecto el visor compara la ultima epoca (A) con la primera (B), y la
//   primera de B6 se armo con 3 exposiciones (las otras, con 21): su ruido
//   tapa al objeto. Entre la 2 y la 3 el objeto queda con un lado cian (donde
//   estaba) y otro rojo (donde esta), y las estrellas, blancas.
// - El estirado asinh con el que abre el visor levanta el ruido del fondo y
//   comprime lo brillante; el lineal deja el fondo oscuro.
//
// Medido sobre la imagen que se muestra (vista de 5', 1440 x 900): senial de
// la mancha del objeto, promediada en 2 px de grilla, contra la dispersion
// robusta del fondo; y en cuantas otras zonas de la imagen hay una mancha
// igual de fuerte. Lado rojo (o claro) y lado cian (u oscuro):
//
//   rojo/cian 1 y 3, asinh (lo de antes)   2,5 y 1,7 sigma    6 y 81 zonas
//   diferencia 1 y 3, asinh                3,1 y 1,9          3 y 50
//   diferencia 2 y 3, asinh                4,6 y 4,2          0 y 3
//   rojo/cian 2 y 3, asinh                 2,3 y 2,7          62 y 33
//   diferencia 2 y 3, lineal               8,3 y 7,0          0 y 4
//   rojo/cian 2 y 3, lineal                7,6 y 7,1          0 y 0
//
// Un suavizado (probado como filtro de 3 y 5 px sobre la imagen) no suma: baja
// la senial un poco mas que el ruido.
//
// El estirado lineal va desde que se elige B6 porque tambien mejora el
// parpadeo: en cada cuadro de las epocas 2 y 3 el objeto pasa de 6,3 y 6,9
// sigma (asinh) a 15,0 y 18,3. Ahi se ve como una estrella mas (hay entre 6 y
// 11 mas brillantes en la vista); lo que lo delata es que se corre.

import { FEATURED_OBJECTS, featuredUrlPatch, type ViewerUrlPatch } from "@/features/entry/featured";
import type { ViewFov } from "@/lib/fov";
import type { Band, ViewMode } from "@/state/urlState";
import type { StretchKind } from "@/viewer/stretch";

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

/** Estirado del recorrido desde que se elige la banda: el que deja el fondo oscuro. */
export const TOUR_STRETCH: StretchKind = "linear";

/**
 * Una epoca cuenta como bien armada si tiene al menos esta fraccion de las
 * exposiciones de la mejor. En B6 las epocas tienen 3, 21 y 21: la primera
 * queda afuera.
 */
export const GOOD_EPOCH_FRACTION = 0.5;

/** Exposiciones con las que se armo la imagen de una epoca, en la banda que se mira. */
export interface EpochExposures {
  readonly epoch: number;
  readonly exposures: number;
}

/**
 * Epoca de referencia (B) para comparar con la actual (A): entre las que
 * estan bien armadas, la mas alejada de la actual, que es donde el objeto mas
 * se movio. null si no hay ninguna otra epoca con exposiciones.
 */
export function pickReferenceEpoch(
  epochs: readonly EpochExposures[],
  current: number,
): number | null {
  const others = epochs.filter((item) => item.epoch !== current && item.exposures > 0);
  const best = Math.max(0, ...others.map((item) => item.exposures));
  const good = others.filter((item) => item.exposures >= best * GOOD_EPOCH_FRACTION);
  let chosen: EpochExposures | null = null;
  for (const item of good) {
    if (chosen === null || Math.abs(item.epoch - current) > Math.abs(chosen.epoch - current)) {
      chosen = item;
    }
  }
  return chosen?.epoch ?? null;
}

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
