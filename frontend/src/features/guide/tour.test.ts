// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isOnTourField,
  isStepDone,
  isTargetRevealed,
  nextStep,
  STEP_DWELL_MS,
  stepDwell,
  stepNumber,
  TOUR_START,
  TOUR_STEPS,
  type TourSignals,
} from "./tour";

const START: TourSignals = { band: 1, mode: "blink", playing: false };

describe("recorrido guiado", () => {
  // Eran cinco: se sumo el del espectro, despues del cierre.
  it("tiene seis pasos y termina en el espectro", () => {
    expect(TOUR_STEPS.length).toBe(6);
    expect(TOUR_STEPS.at(-1)).toBe("spectrum");
    expect(TOUR_STEPS.map(stepNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("la mira del visor se muestra recien cuando el objeto esta encontrado", () => {
    expect(TOUR_STEPS.filter(isTargetRevealed)).toEqual(["closing", "spectrum"]);
  });

  it("abre el campo de WISE 0855 de SPEC.md, con su nombre y en una banda que no es la que pide", () => {
    expect(TOUR_START).toMatchObject({
      ra: 133.7598,
      dec: -7.2422,
      name: "WISE J085510.83-071442.5",
      mode: "blink",
      epoch: null,
      // La vista de 5': el mismo cubo que la de 10', mas cerca.
      fov: 0.0833,
    });
    expect(isStepDone("band", { ...START, band: TOUR_START?.band ?? 6 })).toBe(false);
  });

  it("reconoce el campo del recorrido y ningun otro", () => {
    expect(isOnTourField(133.7598, -7.2422)).toBe(true);
    expect(isOnTourField(269.4463, 4.7683)).toBe(false);
    expect(isOnTourField(null, null)).toBe(false);
  });

  it("cada paso se cumple con lo que pide", () => {
    expect(isStepDone("band", START)).toBe(false);
    expect(isStepDone("band", { ...START, band: 6 })).toBe(true);
    expect(isStepDone("band", { ...START, band: 5 })).toBe(false);

    expect(isStepDone("play", START)).toBe(false);
    expect(isStepDone("play", { ...START, playing: true })).toBe(true);

    expect(isStepDone("redcyan", { ...START, mode: "difference" })).toBe(false);
    expect(isStepDone("redcyan", { ...START, mode: "redcyan" })).toBe(true);
  });

  it("pasar a rojo/cian sin reproducir no deja el recorrido trabado en el parpadeo", () => {
    expect(isStepDone("play", { ...START, mode: "redcyan" })).toBe(true);
  });

  it("ubicar el objeto, el cierre y el espectro no se cumplen solos", () => {
    const everything: TourSignals = { band: 6, mode: "redcyan", playing: true };
    expect(isStepDone("locate", everything)).toBe(false);
    expect(isStepDone("closing", everything)).toBe(false);
    expect(isStepDone("spectrum", everything)).toBe(false);
  });

  it("avanza en orden y se queda en el ultimo", () => {
    expect(TOUR_STEPS.map(nextStep)).toEqual([
      "play",
      "redcyan",
      "locate",
      "closing",
      "spectrum",
      "spectrum",
    ]);
  });

  it("el parpadeo se deja ver una vuelta entera antes de pedir otra cosa", () => {
    // Tres epocas a 800 ms cada una.
    expect(STEP_DWELL_MS.play).toBeGreaterThanOrEqual(3 * 800);
    expect(stepDwell("play", { ...START, band: 6, playing: true })).toBe(STEP_DWELL_MS.play);
  });

  it("si el paso siguiente tambien esta cumplido, no espera", () => {
    expect(stepDwell("play", { band: 6, mode: "redcyan", playing: false })).toBe(0);
    expect(stepDwell("redcyan", { band: 6, mode: "redcyan", playing: false })).toBe(
      STEP_DWELL_MS.redcyan,
    );
  });
});
