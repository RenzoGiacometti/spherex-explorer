// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_VIEW_FOV, FIELD_FOVS, fieldFovForView, snapViewFov, VIEW_FOVS } from "./fov";

describe("snapViewFov", () => {
  it("acepta las tres vistas de la interfaz", () => {
    expect(snapViewFov(0.0833)).toBe(0.0833);
    expect(snapViewFov(0.1667)).toBe(0.1667);
    expect(snapViewFov(0.5)).toBe(0.5);
  });

  it("tolera mas decimales que los de la URL", () => {
    expect(snapViewFov(5 / 60)).toBe(0.0833);
    expect(snapViewFov(10 / 60)).toBe(0.1667);
  });

  it("redondea hacia arriba a la vista mas chica que lo contiene, como el backend", () => {
    expect(snapViewFov(0.02)).toBe(0.0833);
    expect(snapViewFov(0.1)).toBe(0.1667);
    expect(snapViewFov(0.2)).toBe(0.5);
  });

  it("rechaza lo que esta fuera de los limites del contrato", () => {
    expect(snapViewFov(0.01)).toBeNull();
    expect(snapViewFov(1)).toBeNull();
    expect(snapViewFov(-0.1667)).toBeNull();
    expect(snapViewFov(Number.NaN)).toBeNull();
  });
});

describe("fieldFovForView", () => {
  it("las vistas de 5' y de 10' usan el cubo base", () => {
    expect(fieldFovForView(0.0833)).toBe(0.1667);
    expect(fieldFovForView(0.1667)).toBe(0.1667);
  });

  it("la vista de 30' usa el campo amplio", () => {
    expect(fieldFovForView(0.5)).toBe(0.5);
  });

  it("cada vista tiene un escalon de campo admitido", () => {
    for (const view of VIEW_FOVS) {
      expect(FIELD_FOVS).toContain(fieldFovForView(view));
    }
  });
});

describe("valores por defecto", () => {
  it("la vista por defecto es la de 10'", () => {
    expect(DEFAULT_VIEW_FOV).toBe(0.1667);
    expect(VIEW_FOVS).toContain(DEFAULT_VIEW_FOV);
  });
});
