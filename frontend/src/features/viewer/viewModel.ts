// Que se ve en el visor: a partir de los planos de la banda, el modo y lo que
// eligio la persona, decide las epocas A y B y que planos se componen. Son
// funciones puras; el estado vive en useViewerController.ts.
//
//   A  epoca actual: la de la linea de tiempo (`epoch` en la URL). Si la URL no
//      la fija, la ultima que tiene imagen.
//   B  epoca de referencia: la que se elige en el panel Modo (`ref` en la URL).
//      Si no se eligio, entre las bien cubiertas, la mas lejana en fecha a A
//      (`pickReferenceEpoch`).
//
//   modo        que se dibuja                              compose.ts
//   blink       A, o el cuadro del reproductor             single [A]
//   hold        A y, mientras se mantiene apretado, B      single [A] o [B]
//   difference  A menos B                                  difference [B, A]
//   redcyan     A en rojo y B en cian                      redcyan [A, B]
//   sum         promedio de las epocas con imagen          sum [todas]
//   journey     A, como blink sin reproductor; los cuadros de otras misiones
//               los pone useViewerController.ts         single [A]
//
// compose.ts resta el segundo plano menos el primero, por eso la diferencia
// lleva B adelante.

import type { BandPlane } from "@/data/selectors";
import type { ViewMode } from "@/state/urlState";
import { MAX_SCENE_PLANES, type SceneMode } from "@/viewer/compose";
import type { PlaneImage } from "@/viewer/planeImage";
import { DEFAULT_STRETCH, type StretchKind } from "@/viewer/stretch";

/** Lo que eligio la persona y lo que hay para mostrar. */
export interface ViewSelection {
  /** Planos de la banda actual, uno por epoca (`selectBandPlanes`). */
  readonly entries: readonly BandPlane[];
  readonly mode: ViewMode;
  /** Epoca fijada en la URL, o null. */
  readonly urlEpoch: number | null;
  /** Cuadro del reproductor mientras reproduce, o null si esta en pausa. */
  readonly frameEpoch: number | null;
  /** Epoca de referencia elegida en el panel (`ref` en la URL), o null si no se eligio. */
  readonly chosenReference: number | null;
  /** Se esta manteniendo apretado (modo `hold`). */
  readonly holding: boolean;
}

/** Los planos que se componen y con que modo de compose.ts. */
export interface Composition {
  readonly mode: SceneMode;
  /** En el orden que espera compose.ts para ese modo. */
  readonly planes: readonly PlaneImage[];
  /** Epoca de cada plano, en el mismo orden. */
  readonly epochs: readonly number[];
}

/**
 * Por que un modo de comparacion no puede comparar:
 * - `missing-current`: la epoca actual no tiene imagen en esta banda.
 * - `missing-reference`: no hay otra epoca con imagen para usar de referencia.
 */
export type ComparisonIssue = "missing-current" | "missing-reference";

/**
 * Por que no hay imagen de SPHEREx de la epoca que se quiere ver:
 * - `waiting`: el campo todavia no tiene epocas (antes de `listed`).
 * - `empty`: esa epoca no tiene datos en esta banda; no va a haber imagen.
 * - `pending`: la imagen todavia no llego.
 */
export type MissingImage = "waiting" | "empty" | "pending";

export interface ViewModel {
  /** Epocas de la banda que tienen imagen bajada, en orden temporal. */
  readonly imageEpochs: readonly number[];
  /** Epoca A, la actual. null antes de `listed`. */
  readonly current: number | null;
  /** Epoca B, la de referencia. null si no hay otra epoca. */
  readonly reference: number | null;
  /** Epoca marcada en la linea de tiempo: el cuadro del reproductor o, en pausa, A. */
  readonly displayed: number | null;
  /** Lo que se dibuja, o null si no hay ninguna imagen de SPHEREx que mostrar. */
  readonly composition: Composition | null;
  /** Si el modo compara dos epocas y no puede, por que. */
  readonly issue: ComparisonIssue | null;
  /** Sin composicion, por que falta la imagen. null si hay algo dibujado. */
  readonly missing: MissingImage | null;
  /**
   * Alguna de las epocas comparadas es provisoria (docs/contrato-cubo.md,
   * seccion 8). Siempre false en `blink`, que no compara: ahi lo provisorio se
   * lee en el rotulo de la imagen.
   */
  readonly provisional: boolean;
}

function epochOf(entry: BandPlane): number {
  return entry.epoch.epoch;
}

function hasImage(entry: BandPlane): boolean {
  return entry.loaded !== null;
}

function isEmpty(entry: BandPlane): boolean {
  return entry.plane?.status === "empty";
}

function isProvisional(entry: BandPlane | undefined): boolean {
  return entry?.loaded?.status === "building";
}

/**
 * Epoca A cuando la URL no la fija: la ultima con imagen. Mientras no llega
 * ninguna, la ultima que va a tener datos.
 */
function defaultCurrent(entries: readonly BandPlane[]): number | null {
  const chosen =
    entries.filter(hasImage).at(-1) ??
    entries.filter((entry) => !isEmpty(entry)).at(-1) ??
    entries.at(-1);
  return chosen ? epochOf(chosen) : null;
}

/** Lo que hace falta saber de una epoca para elegir la referencia por defecto. */
export interface ReferenceCandidate {
  readonly epoch: number;
  /** Fecha media de la epoca (MJD). */
  readonly mjd: number;
  /** Exposiciones de la epoca en la banda que se ve. */
  readonly exposures: number;
}

/**
 * Parte de las exposiciones de la epoca mejor cubierta que tiene que tener una
 * epoca para servir de referencia por defecto.
 */
export const REFERENCE_MIN_COVERAGE = 0.5;

/**
 * Epoca de referencia (B) por defecto entre las candidatas (las que no son A):
 * de las que tienen al menos la mitad de las exposiciones de la mejor cubierta,
 * la mas lejana en fecha a la epoca actual. Asi la comparacion no se hace
 * contra una epoca ruidosa y el objeto tuvo el mayor tiempo posible para
 * moverse o variar (WISE 0855 en B6: de 2,5 a 7,6 sigmas en la diferencia).
 *
 * Si dos quedan a la misma distancia gana la de mas exposiciones y, si
 * empatan, la mas antigua. Sin fecha actual gana la mejor cubierta. null si no
 * hay candidatas.
 */
export function pickReferenceEpoch(
  candidates: readonly ReferenceCandidate[],
  currentMjd: number | null,
): number | null {
  const best = candidates.reduce((most, item) => Math.max(most, item.exposures), 0);
  const covered = candidates.filter((item) => item.exposures >= best * REFERENCE_MIN_COVERAGE);
  let chosen: ReferenceCandidate | null = null;
  let chosenDistance = -1;
  for (const item of covered) {
    const distance = currentMjd === null ? 0 : Math.abs(item.mjd - currentMjd);
    const better =
      chosen === null ||
      distance > chosenDistance ||
      (distance === chosenDistance &&
        (item.exposures > chosen.exposures ||
          (item.exposures === chosen.exposures && item.epoch < chosen.epoch)));
    if (better) {
      chosen = item;
      chosenDistance = distance;
    }
  }
  return chosen?.epoch ?? null;
}

/**
 * Epoca B cuando no se eligio: `pickReferenceEpoch` entre las que tienen
 * imagen y no son A. Mientras no llega ninguna, entre las que van a tener
 * datos. Las exposiciones son las del plano de la banda que se ve.
 */
function defaultReference(entries: readonly BandPlane[], current: number | null): number | null {
  const others = entries.filter((entry) => epochOf(entry) !== current);
  const withImage = others.filter(hasImage);
  const withData = others.filter((entry) => !isEmpty(entry));
  const pool = withImage.length > 0 ? withImage : withData.length > 0 ? withData : others;
  const currentEntry = entries.find((entry) => epochOf(entry) === current);
  return pickReferenceEpoch(
    pool.map((entry) => ({
      epoch: epochOf(entry),
      mjd: entry.epoch.mjd_mean,
      exposures: entry.plane?.n_exposures ?? 0,
    })),
    currentEntry?.epoch.mjd_mean ?? null,
  );
}

/**
 * Estirado con el que abre cada modo si la persona no eligio uno: lineal en
 * los que restan o superponen dos epocas (diferencia y rojo/cian), donde el
 * asinh aplasta justo los cambios chicos que se buscan; el del visor en los demas.
 */
export function defaultStretchForMode(mode: ViewMode): StretchKind {
  return mode === "difference" || mode === "redcyan" ? "linear" : DEFAULT_STRETCH;
}

function single(entry: BandPlane | undefined): Composition | null {
  if (!entry?.loaded) return null;
  return { mode: "single", planes: [entry.loaded.image], epochs: [epochOf(entry)] };
}

/** Decide que se ve. */
export function deriveView(selection: ViewSelection): ViewModel {
  const { entries } = selection;
  // El viaje entre misiones y la cortina muestran las epocas de SPHEREx de a una, como el parpadeo.
  const mode =
    selection.mode === "journey" || selection.mode === "curtain" ? "blink" : selection.mode;
  const find = (epoch: number | null): BandPlane | undefined =>
    epoch === null ? undefined : entries.find((entry) => epochOf(entry) === epoch);
  const withImage = entries.filter(hasImage);
  const imageEpochs = withImage.map(epochOf);

  // Una epoca de la URL que el campo no tiene no fija nada.
  const current = find(selection.urlEpoch) ? selection.urlEpoch : defaultCurrent(entries);
  const chosen = selection.chosenReference;
  const reference =
    chosen !== null && chosen !== current && find(chosen)
      ? chosen
      : defaultReference(entries, current);

  const playing = mode === "blink" && selection.frameEpoch !== null;
  const frame = playing && find(selection.frameEpoch)?.loaded ? selection.frameEpoch : null;
  const displayed = frame ?? current;

  const entryA = find(current);
  const entryB = find(reference);
  let composition: Composition | null = null;
  let issue: ComparisonIssue | null = null;
  let provisional = false;

  if (mode === "blink") {
    composition = single(find(displayed));
  } else if (mode === "sum") {
    // Si alguna vez hay mas epocas que las que admite una escena, las mas nuevas.
    const planes = withImage.slice(-MAX_SCENE_PLANES);
    if (planes.length > 0) {
      composition = {
        mode: "sum",
        planes: planes.flatMap((entry) => (entry.loaded ? [entry.loaded.image] : [])),
        epochs: planes.map(epochOf),
      };
    }
    provisional = planes.some(isProvisional);
  } else {
    const imageA = entryA?.loaded?.image;
    const imageB = entryB?.loaded?.image;
    if (!imageA) issue = "missing-current";
    else if (!imageB) issue = "missing-reference";
    provisional = isProvisional(entryA) || isProvisional(entryB);

    if (mode === "hold") {
      composition = (selection.holding ? single(entryB) : null) ?? single(entryA);
    } else if (imageA && imageB && current !== null && reference !== null) {
      composition =
        mode === "difference"
          ? { mode: "difference", planes: [imageB, imageA], epochs: [reference, current] }
          : { mode: "redcyan", planes: [imageA, imageB], epochs: [current, reference] };
    } else {
      // Sin con que comparar se ve la epoca actual sola, con el aviso del panel.
      composition = single(entryA);
    }
  }

  let missing: MissingImage | null = null;
  if (composition === null) {
    const wanted = find(displayed);
    if (entries.length === 0) missing = "waiting";
    else if (mode !== "sum" && wanted && isEmpty(wanted)) missing = "empty";
    else if (mode === "sum" && entries.every(isEmpty)) missing = "empty";
    else missing = "pending";
  }

  return {
    imageEpochs,
    current,
    reference,
    displayed,
    composition,
    issue,
    missing,
    provisional,
  };
}

/**
 * Epoca vecina para los botones anterior y siguiente: recorre las epocas con
 * imagen y da la vuelta al llegar a una punta. Si ninguna tiene imagen, recorre
 * todas. `step` es +1 o -1.
 */
export function stepEpoch(
  entries: readonly BandPlane[],
  from: number | null,
  step: 1 | -1,
): number | null {
  const withImage = entries.filter(hasImage);
  const stops = (withImage.length > 0 ? withImage : entries).map(epochOf);
  if (stops.length === 0) return null;
  if (from === null) return (step > 0 ? stops[0] : stops.at(-1)) ?? null;

  const index = stops.indexOf(from);
  if (index >= 0) return stops[(index + step + stops.length) % stops.length] ?? null;
  // Desde una epoca sin imagen: la parada mas cercana en ese sentido.
  const next =
    step > 0 ? stops.find((epoch) => epoch > from) : stops.filter((epoch) => epoch < from).at(-1);
  return next ?? (step > 0 ? stops[0] : stops.at(-1)) ?? null;
}
