// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isOnTourField,
  isStepDone,
  nextStep,
  pickReferenceEpoch,
  STEP_DWELL_MS,
  stepDwell,
  stepNumber,
  TOUR_START,
  TOUR_STEPS,
  type TourSignals,
} from "./tour";

const START: TourSignals = { band: 1, mode: "blink", playing: false };

describe("recorrido guiado", () => {
  it("tiene cinco pasos como maximo y termina en el cierre", () => {
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(5);
    expect(TOUR_STEPS.at(-1)).toBe("closing");
    expect(TOUR_STEPS.map(stepNumber)).toEqual([1, 2, 3, 4, 5]);
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

  it("ubicar el objeto y el cierre no se cumplen solos", () => {
    const everything: TourSignals = { band: 6, mode: "redcyan", playing: true };
    expect(isStepDone("locate", everything)).toBe(false);
    expect(isStepDone("closing", everything)).toBe(false);
  });

  it("avanza en orden y se queda en el ultimo", () => {
    expect(TOUR_STEPS.map(nextStep)).toEqual(["play", "redcyan", "locate", "closing", "closing"]);
  });

  it("el parpadeo se deja ver una vuelta entera antes de pedir otra cosa", () => {
    // Tres epocas a 800 ms cada una.
    expect(STEP_DWELL_MS.play).toBeGreaterThanOrEqual(3 * 800);
    expect(stepDwell("play", { ...START, band: 6, playing: true })).toBe(STEP_DWELL_MS.play);
  });

  it("compara con la epoca bien armada mas lejana, no con la que tiene pocas exposiciones", () => {
    // B6 de WISE 0855: la primera epoca se armo con 3 exposiciones.
    const b6 = [
      { epoch: 1, exposures: 3 },
      { epoch: 2, exposures: 21 },
      { epoch: 3, exposures: 21 },
    ];
    expect(pickReferenceEpoch(b6, 3)).toBe(2);
    expect(pickReferenceEpoch(b6, 2)).toBe(3);
    expect(pickReferenceEpoch(b6, 1)).toBe(3);
  });

  it("entre epocas igual de buenas elige la mas lejana, y sin otra epoca no elige", () => {
    const even = [
      { epoch: 1, exposures: 18 },
      { epoch: 2, exposures: 25 },
      { epoch: 3, exposures: 21 },
      { epoch: 4, exposures: 20 },
    ];
    expect(pickReferenceEpoch(even, 4)).toBe(1);
    expect(pickReferenceEpoch(even, 1)).toBe(4);
    expect(pickReferenceEpoch([{ epoch: 3, exposures: 21 }], 3)).toBeNull();
    expect(
      pickReferenceEpoch(
        [
          { epoch: 1, exposures: 0 },
          { epoch: 2, exposures: 21 },
        ],
        2,
      ),
    ).toBeNull();
  });

  it("si el paso siguiente tambien esta cumplido, no espera", () => {
    expect(stepDwell("play", { band: 6, mode: "redcyan", playing: false })).toBe(0);
    expect(stepDwell("redcyan", { band: 6, mode: "redcyan", playing: false })).toBe(
      STEP_DWELL_MS.redcyan,
    );
  });
});
