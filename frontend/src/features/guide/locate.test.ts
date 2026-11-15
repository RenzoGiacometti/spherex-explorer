// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  HIT_MIN_RADIUS_PX,
  HIT_RADIUS_ARCSEC,
  hitRadius,
  isHit,
  isTap,
  SEARCH_MIN_RADIUS_PX,
  searchArea,
  TAP_MAX_MOVE_PX,
} from "./locate";

const TARGET = { x: 400, y: 300 };

describe("ubicar el objeto", () => {
  it("un puntero que casi no se movio es un clic; uno que se movio, un arrastre", () => {
    expect(isTap({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(true);
    expect(isTap({ x: 10, y: 10 }, { x: 10 + TAP_MAX_MOVE_PX, y: 10 })).toBe(true);
    expect(isTap({ x: 10, y: 10 }, { x: 10 + TAP_MAX_MOVE_PX + 1, y: 10 })).toBe(false);
  });

  it("sin escala conocida el acierto es el radio minimo", () => {
    expect(hitRadius(null)).toBe(HIT_MIN_RADIUS_PX);
    expect(hitRadius(0)).toBe(HIT_MIN_RADIUS_PX);
    expect(hitRadius(Number.NaN)).toBe(HIT_MIN_RADIUS_PX);
  });

  it("con la imagen entera en pantalla manda el radio minimo", () => {
    // 195 px de grilla a 3,075" en unos 650 px de pantalla: cerca de 1 px por segundo de arco.
    expect(hitRadius(1.08)).toBe(HIT_MIN_RADIUS_PX);
    expect(isHit({ x: 400 + HIT_MIN_RADIUS_PX, y: 300 }, TARGET, 1.08)).toBe(true);
    expect(isHit({ x: 400 + HIT_MIN_RADIUS_PX + 1, y: 300 }, TARGET, 1.08)).toBe(false);
  });

  it("al acercar, el acierto crece con la imagen", () => {
    expect(hitRadius(10)).toBe(HIT_RADIUS_ARCSEC * 10);
    // A 8" del centro de la mira esta el objeto en la otra epoca: cuenta.
    expect(isHit({ x: 400 - 80, y: 300 }, TARGET, 10)).toBe(true);
    expect(isHit({ x: 400 - 200, y: 300 }, TARGET, 10)).toBe(false);
  });

  it("la zona de busqueda contiene al objeto, pero no en el centro", () => {
    for (const scale of [null, 1.08, 10]) {
      const area = searchArea(TARGET, scale);
      const offset = Math.hypot(TARGET.x - area.x, TARGET.y - area.y);
      expect(area.radius).toBeGreaterThanOrEqual(SEARCH_MIN_RADIUS_PX);
      expect(offset).toBeLessThan(area.radius * 0.6);
      expect(offset).toBeGreaterThan(area.radius * 0.25);
      // El acierto entero queda adentro de la zona.
      expect(offset + hitRadius(scale)).toBeLessThan(area.radius);
    }
  });
});
