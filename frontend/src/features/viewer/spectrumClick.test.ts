// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type GridWcs, separationArcsec } from "@/lib/wcs";
import { imageToScreen, screenToImage, type ViewTransform } from "@/viewer/view";
import {
  isOnTarget,
  snapPointToSource,
  spectrumPointForClick,
  spectrumPointForSky,
} from "./spectrumClick";

// Grilla, /resolve y /track de los ejemplos de docs/contrato-cubo.md (Barnard).
const GRID: GridWcs = {
  crval: [269.4463, 4.7683],
  crpix: [98.0, 98.0],
  cdelt: [-0.000854167, 0.000854167],
};
const RESOLVED = {
  field_center: { ra: 269.4463, dec: 4.7683, epoch: 2026.0 },
  motion: {
    pm_ra: -801.551,
    pm_dec: 10362.394,
    parallax: 546.976,
    radial_velocity: -110.11,
    per_year_arcsec: 10.39,
  },
};
const TRACK = [
  { ra: 269.44604, dec: 4.7674, x: 97.3, y: 96.0 },
  { ra: 269.44661, dec: 4.76896, x: 96.6, y: 97.8 },
];
const FIELD = "f3a91c0e52d47b18";
/** Una vista cualquiera: 4,2 px de pantalla por pixel de imagen. */
const TRANSFORM: ViewTransform = { scale: 4.2, originX: 310, originY: 905 };

describe("spectrumPointForClick", () => {
  it("un clic sobre el pixel que da /track pide la posicion que da /track", () => {
    for (const position of TRACK) {
      // Ida y vuelta por la pantalla, como llega un clic del visor.
      const screen = imageToScreen(TRANSFORM, position.x, position.y);
      const pixel = screenToImage(TRANSFORM, screen.x, screen.y);
      const point = spectrumPointForClick({
        ...pixel,
        scale: TRANSFORM.scale,
        grid: GRID,
        fieldId: FIELD,
        name: null,
        target: null,
        resolved: null,
      });
      expect(point.name).toBeNull();
      expect(point.query.field).toBe(FIELD);
      expect(point.query.pmRa).toBeUndefined();
      // /track redondea x e y al decimo de pixel: 0,3 segundos de arco.
      expect(separationArcsec(point.query, position)).toBeLessThan(0.3);
      expect(point.pixel?.x).toBeCloseTo(position.x, 9);
      expect(point.pixel?.y).toBeCloseTo(position.y, 9);
    }
  });

  it("al norte y al oeste del centro la declinacion sube y la ascension recta baja", () => {
    const point = spectrumPointForClick({
      x: 137,
      y: 147,
      scale: 4,
      grid: GRID,
      fieldId: FIELD,
      name: null,
      target: null,
      resolved: null,
    });
    expect(point.query.dec).toBeCloseTo(4.7683 + 50 * 0.000854167, 5);
    expect(point.query.ra).toBeLessThan(269.4463);
  });

  it("sobre la mira pide el objeto, con su movimiento propio y la epoca de field_center", () => {
    const target = { x: 97.3, y: 96.0, inField: true };
    const point = spectrumPointForClick({
      x: 99.3,
      y: 97.0,
      scale: 4,
      grid: GRID,
      fieldId: FIELD,
      name: "Barnard's Star",
      target,
      resolved: RESOLVED,
    });
    expect(point).toEqual({
      query: {
        ra: 269.4463,
        dec: 4.7683,
        field: FIELD,
        pmRa: -801.551,
        pmDec: 10362.394,
        epoch: 2026.0,
      },
      name: "Barnard's Star",
      pixel: null,
    });
  });

  it("lejos de la mira es un punto suelto, sin nombre ni movimiento propio", () => {
    const target = { x: 97.3, y: 96.0, inField: true };
    const click = { x: 120, y: 60, scale: 4 };
    expect(isOnTarget(click, target)).toBe(false);
    const point = spectrumPointForClick({
      ...click,
      grid: GRID,
      fieldId: FIELD,
      name: "Barnard's Star",
      target,
      resolved: RESOLVED,
    });
    expect(point.name).toBeNull();
    expect(point.query.pmRa).toBeUndefined();
    expect(point.query.epoch).toBeUndefined();
  });

  it("con la imagen muy alejada vale la apertura; fuera del campo no hay mira", () => {
    expect(isOnTarget({ x: 98.5, y: 96.0, scale: 0.5 }, { x: 97.3, y: 96.0, inField: true })).toBe(
      true,
    );
    expect(isOnTarget({ x: 97.3, y: 96.0, scale: 4 }, { x: 97.3, y: 96.0, inField: false })).toBe(
      false,
    );
    expect(isOnTarget({ x: 97.3, y: 96.0, scale: 4 }, null)).toBe(false);
  });
});

describe("snapPointToSource", () => {
  // Un clic suelto y una fuente guardada a 3 px al oeste y 2 al norte de el.
  const click = spectrumPointForClick({
    x: 120,
    y: 60,
    scale: 4,
    grid: GRID,
    fieldId: FIELD,
    name: null,
    target: null,
    resolved: null,
  });
  const source = spectrumPointForSky({
    ...spectrumPointForClick({
      x: 123,
      y: 62,
      scale: 4,
      grid: GRID,
      fieldId: FIELD,
      name: null,
      target: null,
      resolved: null,
    }).query,
    grid: GRID,
    fieldId: FIELD,
  });
  const target = { ra: source.query.ra, dec: source.query.dec };
  const snapped = { code: "snapped_source", ...target, offset_arcsec: 22.2 };

  it("una posicion del cielo vuelve al pixel del que salio", () => {
    expect(source.query.field).toBe(FIELD);
    expect(source.name).toBeNull();
    expect(source.pixel?.x).toBeCloseTo(123, 6);
    expect(source.pixel?.y).toBeCloseTo(62, 6);
  });

  it("con snapped_source el anillo pasa al pixel de la fuente", () => {
    const point = snapPointToSource(click, { target, warnings: [snapped] }, GRID);
    expect(point.pixel?.x).toBeCloseTo(123, 6);
    expect(point.pixel?.y).toBeCloseTo(62, 6);
    // El pedido sigue siendo el del clic: es lo que se reintenta.
    expect(point.query).toEqual(click.query);
  });

  it("si el aviso no trae posicion vale la de target", () => {
    const point = snapPointToSource(
      click,
      { target, warnings: [{ code: "snapped_source" }] },
      GRID,
    );
    expect(point.pixel?.x).toBeCloseTo(123, 6);
    expect(point.pixel?.y).toBeCloseTo(62, 6);
  });

  it("sin el aviso, sin grilla o sobre la mira, el punto queda como estaba", () => {
    expect(snapPointToSource(click, { target, warnings: [] }, GRID)).toBe(click);
    expect(snapPointToSource(click, { target, warnings: [snapped] }, null)).toBe(click);
    const onTarget = { ...click, name: "Barnard's Star", pixel: null };
    expect(snapPointToSource(onTarget, { target, warnings: [snapped] }, GRID)).toBe(onTarget);
  });
});
