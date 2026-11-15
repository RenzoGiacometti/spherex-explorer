// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { EpochTargetPosition, TargetPosition } from "@/data/selectors";
import { homeView, viewTransform } from "@/viewer/view";
import {
  chooseScaleBar,
  formatScaleLabel,
  isInsideRect,
  SCALE_MAX_FRACTION,
  SCALE_MAX_PX,
  SCALE_STEPS_ARCSEC,
  trailOpacity,
  trailPoints,
  visibleImageRect,
} from "./annotations";

/** El cubo base del contrato: 195 x 195 pixeles de 3,075 segundos de arco. */
const IMAGE = { width: 195, height: 195 };
const PIXEL_SCALE = 3.075;

describe("visibleImageRect", () => {
  it("con la imagen mas chica que la zona libre, es la imagen", () => {
    // Zona apaisada de 800 x 400: la imagen entra por el alto y queda centrada.
    const frame = { left: 100, top: 50, width: 800, height: 400 };
    const size = { width: frame.width, height: frame.height };
    const framed = viewTransform(homeView(IMAGE), IMAGE, size);
    const transform = { ...framed, originX: framed.originX + 100, originY: framed.originY + 50 };
    const visible = visibleImageRect(transform, IMAGE, frame);
    expect(visible?.top).toBeCloseTo(50, 6);
    expect(visible?.height).toBeCloseTo(400, 6);
    expect(visible?.width).toBeCloseTo(400, 6);
    expect(visible?.left).toBeCloseTo(300, 6);
  });

  it("con la imagen acercada, es la zona libre: lo que se ve de la imagen", () => {
    const frame = { left: 100, top: 50, width: 800, height: 400 };
    const size = { width: frame.width, height: frame.height };
    const framed = viewTransform(homeView(IMAGE, 4), IMAGE, size);
    const transform = { ...framed, originX: framed.originX + 100, originY: framed.originY + 50 };
    expect(visibleImageRect(transform, IMAGE, frame)).toEqual(frame);
  });

  it("devuelve null si la imagen quedo fuera de la zona libre", () => {
    const frame = { left: 0, top: 0, width: 100, height: 100 };
    // El pixel (0, 0) a 500 px de la esquina: toda la imagen cae a la derecha.
    expect(visibleImageRect({ scale: 1, originX: 500, originY: 80 }, IMAGE, frame)).toBeNull();
    expect(
      visibleImageRect({ scale: 1, originX: 0, originY: 0 }, IMAGE, { ...frame, width: 0 }),
    ).toBeNull();
  });
});

describe("isInsideRect", () => {
  const rect = { left: 10, top: 20, width: 100, height: 50 };

  it("cuenta los bordes como adentro", () => {
    expect(isInsideRect(rect, 10, 20)).toBe(true);
    expect(isInsideRect(rect, 110, 70)).toBe(true);
    expect(isInsideRect(rect, 60, 45)).toBe(true);
  });

  it("afuera por cualquiera de los cuatro lados", () => {
    expect(isInsideRect(rect, 9, 45)).toBe(false);
    expect(isInsideRect(rect, 111, 45)).toBe(false);
    expect(isInsideRect(rect, 60, 19)).toBe(false);
    expect(isInsideRect(rect, 60, 71)).toBe(false);
  });
});

describe("chooseScaleBar", () => {
  it("elige el largo redondo mas grande que entra", () => {
    // 622 px para el cubo de 10 minutos: 1 minuto son 62,2 px y 2 minutos, 124,4.
    const scale = 622 / 195;
    const bar = chooseScaleBar(PIXEL_SCALE, scale, 622);
    expect(bar?.arcsec).toBe(120);
    expect(bar?.lengthPx).toBeCloseTo((120 / PIXEL_SCALE) * scale, 9);
  });

  it("al acercar la barra marca menos cielo y sigue midiendo lo que dice", () => {
    const scale = 622 / 195;
    const closer = chooseScaleBar(PIXEL_SCALE, 2 * scale, 622);
    expect(closer?.arcsec).toBe(60);
    expect(closer?.lengthPx).toBeCloseTo((60 / PIXEL_SCALE) * 2 * scale, 9);
    const closest = chooseScaleBar(PIXEL_SCALE, 16 * scale, 622);
    expect(closest?.arcsec).toBe(5);
  });

  it("no pasa del largo maximo ni de la fraccion del ancho que se ve", () => {
    for (const available of [200, 366, 622, 1200]) {
      for (const zoom of [1, 1.5, 2, 3.7, 8, 16]) {
        const scale = (available / 195) * zoom;
        const bar = chooseScaleBar(PIXEL_SCALE, scale, available);
        if (bar === null) throw new Error("sin barra");
        expect(SCALE_STEPS_ARCSEC).toContain(bar.arcsec);
        const limit = Math.min(SCALE_MAX_PX, available * SCALE_MAX_FRACTION);
        // Salvo que ni el paso mas chico entre.
        if (bar.arcsec !== SCALE_STEPS_ARCSEC[0]) expect(bar.lengthPx).toBeLessThanOrEqual(limit);
        expect(bar.lengthPx).toBeGreaterThan(0);
      }
    }
  });

  it("si ni el paso mas chico entra, va el mas chico", () => {
    const bar = chooseScaleBar(PIXEL_SCALE, 400, 100);
    expect(bar?.arcsec).toBe(SCALE_STEPS_ARCSEC[0]);
  });

  it("vale para el escalon amplio, de 6,15 segundos de arco por pixel", () => {
    // 293 pixeles en 622 px: 5 minutos son 103,6 px.
    const bar = chooseScaleBar(6.15, 622 / 293, 622);
    expect(bar?.arcsec).toBe(300);
  });

  it("devuelve null si falta algun dato", () => {
    expect(chooseScaleBar(0, 3, 600)).toBeNull();
    expect(chooseScaleBar(PIXEL_SCALE, 0, 600)).toBeNull();
    expect(chooseScaleBar(PIXEL_SCALE, 3, 0)).toBeNull();
    expect(chooseScaleBar(Number.NaN, 3, 600)).toBeNull();
    expect(chooseScaleBar(PIXEL_SCALE, Number.POSITIVE_INFINITY, 600)).toBeNull();
  });
});

describe("formatScaleLabel", () => {
  it("segundos de arco por debajo de un minuto, con la doble prima", () => {
    expect(formatScaleLabel(5, "es")).toBe("5″");
    expect(formatScaleLabel(30, "en")).toBe("30″");
  });

  it("minutos de arco desde un minuto, con la prima", () => {
    expect(formatScaleLabel(60, "es")).toBe("1′");
    expect(formatScaleLabel(120, "es")).toBe("2′");
    expect(formatScaleLabel(1800, "en")).toBe("30′");
  });

  it("todos los pasos dan un numero entero", () => {
    for (const step of SCALE_STEPS_ARCSEC) {
      expect(formatScaleLabel(step, "es")).toMatch(/^\d+[′″]$/);
    }
  });
});

describe("trailOpacity", () => {
  it("crece hacia el presente: la epoca anterior es la mas visible", () => {
    expect(trailOpacity(1)).toBeCloseTo(0.8, 9);
    expect(trailOpacity(2)).toBeCloseTo(0.575, 9);
    expect(trailOpacity(3)).toBeCloseTo(0.35, 9);
  });

  it("no baja de un minimo que todavia se ve", () => {
    expect(trailOpacity(4)).toBeCloseTo(0.35, 9);
    expect(trailOpacity(40)).toBeCloseTo(0.35, 9);
  });

  it("nunca pasa de la del anillo mas reciente", () => {
    expect(trailOpacity(0)).toBeCloseTo(0.8, 9);
    expect(trailOpacity(-3)).toBeCloseTo(0.8, 9);
  });
});

describe("trailPoints", () => {
  function at(epoch: number, x: number, extra: Partial<TargetPosition> = {}): EpochTargetPosition {
    return {
      epoch,
      position: { x, y: 2 * x, ra: 10, dec: 20, inField: true, source: "track", ...extra },
    };
  }

  const trail = [at(1, 10), at(2, 20), at(3, 30), at(4, 40)];

  it("son las epocas anteriores a la que se ve, de la mas vieja a la mas reciente", () => {
    expect(trailPoints(trail, 3)).toEqual([
      { epoch: 1, x: 10, y: 20, opacity: trailOpacity(2) },
      { epoch: 2, x: 20, y: 40, opacity: trailOpacity(1) },
    ]);
    expect(trailPoints(trail, 4).map((point) => point.epoch)).toEqual([1, 2, 3]);
    expect(trailPoints(trail, 4).map((point) => point.opacity)).toEqual([
      trailOpacity(3),
      trailOpacity(2),
      trailOpacity(1),
    ]);
  });

  it("la primera epoca no tiene rastro", () => {
    expect(trailPoints(trail, 1)).toEqual([]);
  });

  it("sin epoca a la vista no hay rastro", () => {
    expect(trailPoints(trail, null)).toEqual([]);
  });

  it("un objeto sin trayectoria no deja rastro: esta siempre en el mismo lugar", () => {
    const still = [1, 2, 3].map((epoch) => at(epoch, 50, { source: "field_center" }));
    expect(trailPoints(still, 3)).toEqual([]);
  });

  it("saltea las epocas en las que el objeto cae fuera del campo", () => {
    const leaving = [at(1, -40, { inField: false }), at(2, 20), at(3, 30)];
    expect(trailPoints(leaving, 3)).toEqual([{ epoch: 2, x: 20, y: 40, opacity: trailOpacity(1) }]);
  });
});
