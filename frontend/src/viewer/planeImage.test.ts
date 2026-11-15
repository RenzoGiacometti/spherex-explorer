import { describe, expect, it } from "vitest";
import { MASK_NO_DATA, MASK_SATURATED, MASK_VALID, toPlaneImage } from "./planeImage";

describe("toPlaneImage", () => {
  it("separa valores, sin datos y saturados", () => {
    const source = new Float32Array([
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0.25,
      0,
      Number.NEGATIVE_INFINITY,
    ]);
    const image = toPlaneImage(source, [2, 3]);
    expect(image.width).toBe(3);
    expect(image.height).toBe(2);
    expect(Array.from(image.values)).toEqual([1.5, 0, 0, -0.25, 0, 0]);
    expect(Array.from(image.mask)).toEqual([
      MASK_VALID,
      MASK_NO_DATA,
      MASK_SATURATED,
      MASK_VALID,
      MASK_VALID,
      MASK_NO_DATA,
    ]);
    expect(image.saturatedCount).toBe(1);
  });

  it("copia los valores en vez de compartir el buffer", () => {
    const source = new Float32Array([1, 2, 3, 4]);
    const image = toPlaneImage(source, [2, 2]);
    source[0] = 99;
    expect(image.values[0]).toBe(1);
    expect(image.values.buffer).not.toBe(source.buffer);
  });

  it("acepta una vista con desplazamiento dentro de un buffer mayor", () => {
    const cube = new Float32Array([9, 9, 9, 9, 1, Number.NaN, 3, 4]);
    const view = new Float32Array(cube.buffer, 4 * Float32Array.BYTES_PER_ELEMENT, 4);
    const image = toPlaneImage(view, [2, 2]);
    expect(Array.from(image.values)).toEqual([1, 0, 3, 4]);
    expect(Array.from(image.mask)).toEqual([MASK_VALID, MASK_NO_DATA, MASK_VALID, MASK_VALID]);
  });

  it("rechaza un plano de otro tamano", () => {
    expect(() => toPlaneImage(new Float32Array(5), [2, 3])).toThrow(RangeError);
  });
});
