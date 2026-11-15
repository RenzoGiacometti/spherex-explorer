// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { type AuxLayers, splitAux } from "@/api/binary";
import { fieldMetaSchema } from "@/api/schema";
import type { Flag } from "@/api/types";
import barnardMeta from "@/test/fixtures/meta-barnard.json";
import { FRONTEND_DIR } from "@/test/sourceFiles";
import { MASK_SATURATED, toPlaneImage } from "@/viewer/planeImage";
import { countFlags, flagMask, maskedFlagBits } from "./flags";

function flag(bit: number, name: string, masked: boolean, saturation = false): Flag {
  return { bit, name, description: `flag ${name}`, masked, saturation };
}

function layers(...values: number[]): AuxLayers {
  return { flags: new Uint32Array(values), coverage: new Uint16Array(values.length) };
}

const TRANSIENT = flag(0, "TRANSIENT", true);
const OVERFLOW = flag(1, "OVERFLOW", true, true);
const SOURCE = flag(21, "SOURCE", false);
const HIGH = flag(31, "HIGH", true);

describe("maskedFlagBits", () => {
  it("junta los bits de los flags que el pipeline descarta", () => {
    expect(maskedFlagBits([TRANSIENT, OVERFLOW, SOURCE])).toBe(0b11);
    expect(maskedFlagBits([SOURCE])).toBe(0);
    expect(maskedFlagBits([])).toBe(0);
    expect(maskedFlagBits(undefined)).toBe(0);
  });

  it("el bit 31 no da un numero negativo", () => {
    expect(maskedFlagBits([HIGH])).toBe(2 ** 31);
    expect(maskedFlagBits([TRANSIENT, HIGH])).toBe(2 ** 31 + 1);
  });

  it("ignora un bit que no entra en 32 bits", () => {
    expect(maskedFlagBits([flag(32, "FUERA", true), flag(-1, "NEGATIVO", true), OVERFLOW])).toBe(
      0b10,
    );
  });
});

describe("flagMask", () => {
  const bits = maskedFlagBits([TRANSIENT, OVERFLOW, SOURCE]);

  it("marca los pixeles con algun flag descartado y no los demas", () => {
    // Pixel 0 sin flags, 1 con TRANSIENT, 2 con OVERFLOW, 3 solo con SOURCE (informativo), 4 con los tres.
    const mask = flagMask([layers(0, 1, 2, 1 << 21, (1 << 21) | 3)], bits);
    expect(Array.from(mask ?? [])).toEqual([0, 1, 1, 0, 1]);
  });

  it("con varias epocas es la union", () => {
    const mask = flagMask([layers(1, 0, 0), layers(0, 0, 2)], bits);
    expect(Array.from(mask ?? [])).toEqual([1, 0, 1]);
  });

  it("funciona con el bit mas alto", () => {
    const mask = flagMask([layers(2 ** 31, 0)], maskedFlagBits([HIGH]));
    expect(Array.from(mask ?? [])).toEqual([1, 0]);
  });

  it("devuelve null si no hay nada que dibujar", () => {
    expect(flagMask([], bits)).toBeNull();
    expect(flagMask([layers(1, 2)], 0)).toBeNull();
    // Solo flags informativos.
    expect(flagMask([layers(1 << 21, 0)], bits)).toBeNull();
    // Capas de distinto tamano no se pueden unir.
    expect(flagMask([layers(1, 0), layers(1)], bits)).toBeNull();
  });
});

describe("countFlags", () => {
  const all = [TRANSIENT, OVERFLOW, SOURCE];

  it("cuenta los pixeles de cada flag presente, en el orden de la lista", () => {
    const counts = countFlags([layers(0, 1, 1, 1 << 21, (1 << 21) | 1)], all);
    expect(counts).toEqual([
      { flag: TRANSIENT, pixels: 3 },
      { flag: SOURCE, pixels: 2 },
    ]);
  });

  it("con varias epocas un pixel cuenta una sola vez", () => {
    const counts = countFlags([layers(1, 1, 0), layers(1, 0, 2)], all);
    expect(counts).toEqual([
      { flag: TRANSIENT, pixels: 2 },
      { flag: OVERFLOW, pixels: 1 },
    ]);
  });

  it("cuenta el bit mas alto", () => {
    expect(countFlags([layers(2 ** 31, 2 ** 31 + 1)], [TRANSIENT, HIGH])).toEqual([
      { flag: TRANSIENT, pixels: 1 },
      { flag: HIGH, pixels: 2 },
    ]);
  });

  it("no lista nada sin capas, sin flags o con capas de distinto tamano", () => {
    expect(countFlags([], all)).toEqual([]);
    expect(countFlags([layers(1)], [])).toEqual([]);
    expect(countFlags([layers(1, 0), layers(1)], all)).toEqual([]);
    expect(countFlags([layers(0, 0)], all)).toEqual([]);
  });

  it("un bit encendido que la lista no nombra no aparece", () => {
    expect(countFlags([layers(1 << 5)], all)).toEqual([]);
  });
});

describe("capas de muestra de Barnard (epoca 1, detector 3)", () => {
  // 195 x 195, generadas por el backend con datos reales (src/test/fixtures/barnard).
  const directory = join(FRONTEND_DIR, "src", "test", "fixtures", "barnard");
  const meta = fieldMetaSchema.parse(barnardMeta);
  const shape = meta.grid?.shape ?? [0, 0];
  const flags = meta.flags ?? [];
  const packed = gunzipSync(readFileSync(join(directory, "aux_e1_d3.bin.gz")));
  const aux = splitAux(
    packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength) as ArrayBuffer,
    shape,
  );
  const plane = readFileSync(join(directory, "plane_e1_d3.f32"));
  const image = toPlaneImage(
    new Float32Array(plane.buffer.slice(plane.byteOffset, plane.byteOffset + plane.byteLength)),
    shape,
  );

  it("todo pixel saturado queda bajo la trama (contrato, seccion 16.1)", () => {
    const mask = flagMask([aux], maskedFlagBits(flags));
    if (mask === null) throw new Error("la muestra no tiene pixeles marcados");
    let saturated = 0;
    for (let index = 0; index < image.mask.length; index += 1) {
      if (image.mask[index] !== MASK_SATURATED) continue;
      saturated += 1;
      expect(mask[index], `pixel ${index}`).toBe(1);
    }
    // Los 152 pixeles del nucleo de la estrella.
    expect(saturated).toBe(152);
  });

  it("lista los flags de saturacion entre los presentes", () => {
    const present = countFlags([aux], flags);
    const names = present.map((item) => item.flag.name);
    expect(names).toContain("OVERFLOW");
    expect(names).toContain("BLOOM");
    for (const item of present) expect(item.pixels).toBeGreaterThan(0);
    // Ningun flag puede tener mas pixeles que la imagen.
    for (const item of present) expect(item.pixels).toBeLessThanOrEqual(image.mask.length);
    // La suma de los descartados cubre al menos lo que marca la mascara.
    const hatched = flagMask([aux], maskedFlagBits(flags))?.reduce((sum, value) => sum + value, 0);
    const maskedTotal = present
      .filter((item) => item.flag.masked)
      .reduce((sum, item) => sum + item.pixels, 0);
    expect(maskedTotal).toBeGreaterThanOrEqual(hatched ?? 0);
  });
});
