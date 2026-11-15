// Lo que el recorrido cambia en el visor: el estirado, al elegir la banda, y
// la epoca de referencia, al activar la comparacion.
//
// Ninguno de los dos esta en la URL: viven en el estado de la pantalla del
// visor, a la que el recorrido no tiene acceso (va montado al lado). Los elige
// como lo haria la persona, con un clic en los controles de la pantalla. Asi lo
// elegido queda a la vista en los paneles y se puede cambiar despues: el
// recorrido no dibuja nada distinto de lo que el visor dice que muestra.
//
// En el celular el estirado esta dentro del cajon de herramientas, que solo
// existe mientras esta abierto: se abre, se elige y se cierra. React aplica
// cada clic en una microtarea, antes de que el navegador pinte, asi que el
// cajon no llega a verse.

import type { StretchKind } from "@/viewer/stretch";
import { findButton, findOptionInput, findOptionInputs, findViewerPage } from "./viewerDom";

export interface StretchSetup {
  /** Nombre del grupo del estirado (`viewer:image.stretch`), en el idioma activo. */
  readonly stretchGroup: string;
  /** Boton que abre el cajon de herramientas del celular (`viewer:tools.open`). */
  readonly toolsOpen: string;
  /** Boton que lo cierra (`viewer:tools.close`). */
  readonly toolsClose: string;
  readonly stretch: StretchKind;
}

export interface ReferenceSetup {
  /** Nombre del grupo de la epoca de referencia (`viewer:comparison.reference`). */
  readonly referenceGroup: string;
  /** Epoca de referencia para una epoca actual, o null si no hay con que comparar. */
  readonly pickReference: (current: number) => number | null;
  /** Dice si ya no hay que seguir: el recorrido termino. */
  readonly cancelled: () => boolean;
}

/** Cuadros que se espera a que aparezca un control antes de darlo por ausente. */
const WAIT_FRAMES = 12;

/** Deja pasar las microtareas pendientes: React aplica ahi lo que desato un clic. */
function settled(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

/** Espera a que algo aparezca en la pantalla: primero sin pintar y despues de a un cuadro. */
async function waitFor<T>(find: () => T | null): Promise<T | null> {
  await settled();
  for (let frame = 0; frame < WAIT_FRAMES; frame += 1) {
    const found = find();
    if (found !== null) return found;
    await nextFrame();
  }
  return find();
}

/** Elige una opcion como con un clic. Devuelve si quedo elegida. */
function choose(input: HTMLInputElement | null): boolean {
  if (input === null || input.disabled) return false;
  if (!input.checked) input.click();
  return true;
}

async function setStretch(setup: StretchSetup): Promise<void> {
  const find = (): HTMLInputElement | null => {
    const page = findViewerPage();
    return page === null ? null : findOptionInput(page, setup.stretchGroup, setup.stretch);
  };
  if (choose(find())) return;

  // Celular: el control esta en el cajon de herramientas.
  const page = findViewerPage();
  const opener = page === null ? null : findButton(page, setup.toolsOpen);
  if (opener === null || opener.getAttribute("aria-expanded") === "true") return;
  opener.click();
  try {
    choose(await waitFor(find));
    await settled();
  } finally {
    const open = findViewerPage();
    (open === null ? null : findButton(open, setup.toolsClose))?.click();
  }
}

/** Epoca de referencia: la actual es la opcion deshabilitada (no se compara consigo misma). */
async function setReference(setup: ReferenceSetup): Promise<void> {
  const inputs = await waitFor(() => {
    const page = findViewerPage();
    const found = page === null ? [] : findOptionInputs(page, setup.referenceGroup);
    return found.length > 0 ? found : null;
  });
  if (inputs === null || setup.cancelled()) return;
  const current = Number(inputs.find((input) => input.disabled)?.value);
  if (!Number.isFinite(current)) return;
  const wanted = setup.pickReference(current);
  if (wanted === null) return;
  choose(inputs.find((input) => input.value === String(wanted)) ?? null);
}

const pending = new Map<string, Promise<void>>();
let last: Promise<void> = Promise.resolve();

/**
 * Corre un cambio despues del anterior, y una sola vez si se lo pide dos veces
 * seguidas (React, en desarrollo, corre cada efecto dos veces). De a uno: dos
 * cambios a la vez se pisarian en el cajon del celular.
 */
function once(key: string, change: () => Promise<void>): Promise<void> {
  const running = pending.get(key);
  if (running !== undefined) return running;
  const run = last
    .then(change)
    .catch((error: unknown) => {
      // Sin el cambio el recorrido sigue: la imagen queda como la dejo la persona.
      console.warn("recorrido: no se pudo cambiar un control del visor", error);
    })
    .finally(() => pending.delete(key));
  pending.set(key, run);
  last = run;
  return run;
}

/** Deja el visor con el estirado pedido. Si no encuentra el control, queda como esta. */
export function applyStretch(setup: StretchSetup): Promise<void> {
  return once("stretch", () => setStretch(setup));
}

/**
 * Deja el visor comparando con la epoca de referencia que elige
 * `pickReference`. El control aparece al activar un modo que compara: se lo
 * espera unos cuadros y, si no esta, la referencia queda como esta.
 */
export function applyReference(setup: ReferenceSetup): Promise<void> {
  return once("reference", () => setReference(setup));
}
