// @vitest-environment node
import { describe, expect, it } from "vitest";
import { formatSpeed, nextSpeed } from "./TimelineDock";
import { PLAYBACK_SPEEDS, type PlaybackSpeed } from "./useViewerController";

describe("formatSpeed", () => {
  it("escribe la velocidad con el signo de multiplicar y el separador decimal del idioma", () => {
    expect(formatSpeed(0.5, "es")).toBe("0,5×");
    expect(formatSpeed(0.5, "en")).toBe("0.5×");
    expect(formatSpeed(1, "es")).toBe("1×");
    expect(formatSpeed(2, "en")).toBe("2×");
  });
});

describe("nextSpeed", () => {
  it("pasa a la siguiente y, desde la mas rapida, vuelve a la mas lenta", () => {
    expect(nextSpeed(0.5)).toBe(1);
    expect(nextSpeed(1)).toBe(2);
    expect(nextSpeed(2)).toBe(0.5);
  });

  it("recorre todas las velocidades del reproductor", () => {
    const seen = new Set<number>();
    let speed: PlaybackSpeed = PLAYBACK_SPEEDS[0];
    for (let step = 0; step < PLAYBACK_SPEEDS.length; step += 1) {
      seen.add(speed);
      speed = nextSpeed(speed);
    }
    expect([...seen].sort()).toEqual([...PLAYBACK_SPEEDS].sort());
    expect(speed).toBe(PLAYBACK_SPEEDS[0]);
  });
});
