// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  auxByteLength,
  cubeByteLength,
  cubePlaneView,
  isInCube,
  pixelCount,
  planeByteLength,
  planeView,
  splitAux,
} from "./binary";

const SHAPE = [2, 3] as const;

describe("tamanos", () => {
  it("usa la forma como [ny, nx]", () => {
    expect(pixelCount(SHAPE)).toBe(6);
    expect(pixelCount([195, 195])).toBe(38025);
  });

  it("un plano pesa 4 bytes por pixel: 152 kB en el campo base", () => {
    expect(planeByteLength(SHAPE)).toBe(24);
    expect(planeByteLength([195, 195])).toBe(152100);
  });

  it("las capas auxiliares pesan 6 bytes por pixel", () => {
    expect(auxByteLength(SHAPE)).toBe(36);
  });

  it("el cubo cuenta solo los planos ready y partial", () => {
    expect(isInCube({ status: "ready" })).toBe(true);
    expect(isInCube({ status: "partial" })).toBe(true);
    expect(isInCube({ status: "building" })).toBe(false);
    expect(isInCube({ status: "pending" })).toBe(false);
    expect(isInCube({ status: "empty" })).toBe(false);

    expect(
      cubeByteLength(SHAPE, [{ status: "ready" }, { status: "empty" }, { status: "partial" }]),
    ).toBe(48);
    // 18 planos del campo base: 2,7 MB, como dice el contrato.
    expect(
      cubeByteLength(
        [195, 195],
        Array.from({ length: 18 }, () => ({ status: "ready" as const })),
      ),
    ).toBe(2737800);
  });
});

describe("planeView", () => {
  it("lee Float32 little-endian fila por fila, sin copiar", () => {
    const buffer = new ArrayBuffer(24);
    const data = new DataView(buffer);
    for (let index = 0; index < 6; index += 1) {
      data.setFloat32(index * 4, index + 0.5, true);
    }
    data.setFloat32(8, Number.NaN, true);
    data.setFloat32(12, Number.POSITIVE_INFINITY, true);

    const plane = planeView(buffer, SHAPE);
    expect(plane).toHaveLength(6);
    expect(plane[0]).toBe(0.5);
    expect(plane[1]).toBe(1.5);
    expect(plane[2]).toBeNaN();
    expect(plane[3]).toBe(Number.POSITIVE_INFINITY);
    expect(plane[5]).toBe(5.5);
    expect(plane.buffer).toBe(buffer);
  });

  it("lee un plano dentro del cubo desde su cube_offset", () => {
    const cube = new ArrayBuffer(72);
    new Float32Array(cube).set([0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    expect(Array.from(planeView(cube, SHAPE, 24))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(cubePlaneView(cube, SHAPE, { cube_offset: 48 }) ?? [])).toEqual([
      7, 8, 9, 10, 11, 12,
    ]);
  });

  it("cubePlaneView devuelve null para un plano sin lugar en el cubo", () => {
    expect(cubePlaneView(new ArrayBuffer(24), SHAPE, { cube_offset: null })).toBeNull();
  });

  it("rechaza un plano que no entra en el buffer o esta mal alineado", () => {
    expect(() => planeView(new ArrayBuffer(20), SHAPE)).toThrow(RangeError);
    expect(() => planeView(new ArrayBuffer(48), SHAPE, 28)).toThrow(RangeError);
    expect(() => planeView(new ArrayBuffer(48), SHAPE, 2)).toThrow(RangeError);
    expect(() => planeView(new ArrayBuffer(48), SHAPE, -4)).toThrow(RangeError);
  });
});

describe("splitAux", () => {
  it("separa los flags Uint32 de la cobertura Uint16", () => {
    const buffer = new ArrayBuffer(36);
    const data = new DataView(buffer);
    // Flags: bit 1 (OVERFLOW) en el pixel 0 y bit 19 en el pixel 5.
    data.setUint32(0, 1 << 1, true);
    data.setUint32(20, 1 << 19, true);
    // Cobertura: empieza despues de los 6 Uint32.
    for (let index = 0; index < 6; index += 1) {
      data.setUint16(24 + index * 2, 20 + index, true);
    }

    const { flags, coverage } = splitAux(buffer, SHAPE);
    expect(Array.from(flags)).toEqual([2, 0, 0, 0, 0, 524288]);
    expect(Array.from(coverage)).toEqual([20, 21, 22, 23, 24, 25]);
  });

  it("rechaza un buffer de otro tamano", () => {
    expect(() => splitAux(new ArrayBuffer(24), SHAPE)).toThrow(RangeError);
  });
});
