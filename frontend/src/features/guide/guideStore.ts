// Estado del recorrido guiado: si esta en marcha y en que paso. Vive fuera de
// React porque lo comparten dos pantallas: el boton que lo inicia esta en la
// entrada y los pasos se muestran sobre el visor.
//
// No va en la URL: un link copiado a mitad del recorrido abre el visor solo.

import { create } from "zustand";
import { useUrlState } from "@/state/urlState";
import { nextStep, TOUR_START, TOUR_STEPS, type TourStep } from "./tour";

export interface GuideStore {
  /** El recorrido esta en marcha. */
  readonly active: boolean;
  readonly step: TourStep;
  /** En el paso de ubicar el objeto, el ultimo clic cayo lejos. */
  readonly missed: boolean;
  start(): void;
  /**
   * Da por cumplido un paso y pasa al siguiente. No hace nada si ese paso ya
   * no es el actual: un temporizador viejo no saltea pasos.
   */
  completeStep(step: TourStep): void;
  /** Un clic que no dio con el objeto. */
  miss(): void;
  /** Termina el recorrido: por haberlo saltado, cerrado o salido del campo. */
  end(): void;
}

const FIRST_STEP: TourStep = TOUR_STEPS[0];

export const useGuideStore = create<GuideStore>()((set, get) => ({
  active: false,
  step: FIRST_STEP,
  missed: false,

  start() {
    set({ active: true, step: FIRST_STEP, missed: false });
  },

  completeStep(step) {
    const current = get();
    if (!current.active || current.step !== step) return;
    set({ step: nextStep(step), missed: false });
  },

  miss() {
    if (get().active) set({ missed: true });
  },

  end() {
    if (get().active) set({ active: false, step: FIRST_STEP, missed: false });
  },
}));

/**
 * Inicia el recorrido: abre el campo del objeto en el visor y muestra el
 * primer paso. Con `embed=1` el visor no tiene los controles que el recorrido
 * pide, asi que se abre completo.
 */
export function startTour(): void {
  if (TOUR_START === null) return;
  useUrlState.getState().update({ ...TOUR_START, embed: false }, { history: "push" });
  useGuideStore.getState().start();
}
