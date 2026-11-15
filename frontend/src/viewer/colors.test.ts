import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseCssVariables, resolveCssVariable } from "@/test/designTokens";
import {
  NO_DATA_COLOR_VARIABLE,
  parseCssColor,
  type Rgb,
  readCssColor,
  toCssHex,
  toRgb,
} from "./colors";

// Los colores de prueba se arman por partes: en el codigo del frontend no se
// escribe ningun color literal (src/test/guards.test.ts), tampoco en un test.

/** Color hexadecimal de CSS a partir de sus digitos. */
function hex(digits: string): string {
  return `#${digits}`;
}

/** Notacion funcional de CSS: nombre de la funcion y lo que va entre parentesis. */
function functional(name: string, body: string): string {
  return `${name}(${body})`;
}

/** Variables de src/styles/tokens.css, leidas del archivo. */
const tokens = parseCssVariables(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "styles", "tokens.css"), "utf8"),
);

describe("parseCssColor", () => {
  it("lee hexadecimales de 6 y 8 digitos", () => {
    expect(parseCssColor(hex("000000"))).toEqual([0, 0, 0, 1]);
    expect(parseCssColor(hex("ffffff"))).toEqual([1, 1, 1, 1]);
    expect(parseCssColor(hex("FF8000"))).toEqual([1, 128 / 255, 0, 1]);
    expect(parseCssColor(hex("ffffff80"))).toEqual([1, 1, 1, 128 / 255]);
  });

  it("lee la forma corta de 3 y 4 digitos", () => {
    expect(parseCssColor(hex("f80"))).toEqual([1, 136 / 255, 0, 1]);
    expect(parseCssColor(hex("f808"))).toEqual([1, 136 / 255, 0, 136 / 255]);
  });

  it("lee la notacion funcional, con comas o con espacios", () => {
    expect(parseCssColor(functional("rgb", "255, 128, 0"))).toEqual([1, 128 / 255, 0, 1]);
    expect(parseCssColor(functional("rgb", "255 128 0"))).toEqual([1, 128 / 255, 0, 1]);
    expect(parseCssColor(functional("rgba", "8, 8, 10, 0.72"))).toEqual([
      8 / 255,
      8 / 255,
      10 / 255,
      0.72,
    ]);
    expect(parseCssColor(functional("rgb", "100% 0% 50% / 25%"))).toEqual([1, 0, 0.5, 0.25]);
  });

  it("no le molestan los espacios ni las mayusculas", () => {
    expect(parseCssColor(`  ${hex("FFFFFF")} `)).toEqual([1, 1, 1, 1]);
    expect(parseCssColor(functional("RGB", "0, 0, 0"))).toEqual([0, 0, 0, 1]);
  });

  it("devuelve null para lo que no entiende", () => {
    for (const text of [
      "",
      "white",
      "transparent",
      hex("12"),
      hex("12345"),
      hex("xyzxyz"),
      functional("rgb", "1, 2"),
      functional("rgb", "a, b, c"),
      functional("hsl", "38 100% 56%"),
      "var(--color-void)",
    ]) {
      expect(parseCssColor(text), text).toBeNull();
    }
  });

  it("entiende todos los colores de tokens.css", () => {
    const names = [...tokens.keys()].filter((name) => name.startsWith("--color-"));
    expect(names.length).toBeGreaterThanOrEqual(13);
    for (const name of names) {
      const value = resolveCssVariable(tokens, name) ?? "";
      const color = parseCssColor(value);
      expect(color, name).not.toBeNull();
      for (const channel of color ?? []) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("readCssColor", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("lee una variable de :root", () => {
    const value = resolveCssVariable(tokens, NO_DATA_COLOR_VARIABLE) ?? "";
    document.documentElement.style.setProperty(NO_DATA_COLOR_VARIABLE, value);
    // DESIGN.md: el vacio es negro puro.
    expect(readCssColor(NO_DATA_COLOR_VARIABLE)).toEqual([0, 0, 0, 1]);
  });

  it("lee una variable con opacidad", () => {
    const value = resolveCssVariable(tokens, "--color-hairline-strong") ?? "";
    document.documentElement.style.setProperty("--color-hairline-strong", value);
    const color = readCssColor("--color-hairline-strong");
    expect(color?.slice(0, 3)).toEqual([1, 1, 1]);
    // DESIGN.md: blanco al 32 %.
    expect(color?.[3]).toBeCloseTo(0.32, 2);
  });

  it("lee de otro elemento si se lo pasan", () => {
    const element = document.createElement("div");
    element.style.setProperty("--prueba", hex("ff0000"));
    document.body.append(element);
    expect(readCssColor("--prueba", element)).toEqual([1, 0, 0, 1]);
    element.remove();
  });

  it("devuelve null si la variable no existe", () => {
    expect(readCssColor("--no-existe")).toBeNull();
  });
});

describe("conversiones", () => {
  it("toRgb descarta la opacidad", () => {
    expect(toRgb([0.1, 0.2, 0.3, 0.4])).toEqual([0.1, 0.2, 0.3]);
  });

  it("toCssHex escribe el color como lo lee parseCssColor", () => {
    const colors: Rgb[] = [
      [0, 0, 0],
      [1, 1, 1],
      [1, 128 / 255, 0],
      [8 / 255, 8 / 255, 10 / 255],
    ];
    for (const color of colors) {
      expect(parseCssColor(toCssHex(color))).toEqual([...color, 1]);
    }
    expect(toCssHex([1, 0.5, 0])).toBe(hex("ff8000"));
    expect(toCssHex([2, -1, Number.NaN])).toBe(hex("ff0000"));
  });
});
