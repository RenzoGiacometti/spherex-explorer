// @vitest-environment node
//
// Reglas de la hoja de estilos de la entrada que jsdom no puede comprobar,
// porque no hace layout. Como se ve se midio en Chrome, de 320 a 1920 px; estos
// tests cuidan que las reglas de DESIGN.md no se pierdan.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FRONTEND_DIR } from "@/test/sourceFiles";

const PHONE = "@media (max-width: 599px)";

const css = readFileSync(
  join(FRONTEND_DIR, "src", "features", "entry", "EntryPage.module.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const phoneStart = css.indexOf(PHONE);
const desktopCss = css.slice(0, phoneStart);
const phoneCss = css.slice(phoneStart);

/** Declaraciones de un selector, como "propiedad: valor", en un tramo de la hoja. */
function declarations(source: string, selector: string): string[] {
  const start = source.indexOf(`${selector} {`);
  if (start === -1) return [];
  const body = source.slice(source.indexOf("{", start) + 1, source.indexOf("}", start));
  return body
    .split(";")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

describe("hoja de estilos de la entrada", () => {
  it("tiene un solo tramo para celular, al final", () => {
    expect(phoneStart).toBeGreaterThan(0);
    expect(css.indexOf("@media", phoneStart + 1)).toBe(-1);
  });

  it("el fondo es el negro del lienzo y ocupa toda la ventana", () => {
    expect(declarations(desktopCss, ".page")).toEqual(
      expect.arrayContaining(["min-height: 100%", "background-color: var(--color-void)"]),
    );
  });

  it("la barra superior queda a 24 px del borde en escritorio y a 12 px en celular", () => {
    expect(declarations(desktopCss, ".topbar")).toContain("padding: 0 var(--space-lg)");
    expect(declarations(phoneCss, ".topbar")).toContain("padding: 0 var(--space-sm)");
    // Transparente: sin fondo ni borde propios.
    expect(declarations(desktopCss, ".topbar").join(";")).not.toMatch(/background|border/);
  });

  it("la columna nunca es mas ancha que la ventana: 680 px como maximo y margenes a los lados", () => {
    expect(declarations(desktopCss, ".main")).toContain(
      "width: min(680px, calc(100% - 2 * var(--space-huge)))",
    );
    expect(declarations(phoneCss, ".main")).toContain("width: calc(100% - 2 * var(--space-sm))");
  });

  it("el titular va en la tipografia display", () => {
    expect(declarations(desktopCss, ".headline")).toEqual(
      expect.arrayContaining([
        "font: var(--type-display-font)",
        "letter-spacing: var(--type-display-tracking)",
        "text-transform: var(--type-display-transform)",
      ]),
    );
    // En celular baja como mucho hasta display-sm.
    expect(declarations(phoneCss, ".headline")).toEqual([
      "font-size: clamp(var(--type-display-sm-size), 11vw, var(--type-display-size))",
    ]);
  });

  it("lo que es dato o nombre propio no hereda las mayusculas de la etiqueta", () => {
    expect(declarations(desktopCss, ".kicker")).toContain(
      "text-transform: var(--type-label-cap-transform)",
    );
    expect(declarations(desktopCss, ".asWritten")).toEqual(["text-transform: none"]);
    expect(declarations(desktopCss, ".kickerRange")).toEqual(
      expect.arrayContaining(["font: var(--type-data-sm-font)", "text-transform: none"]),
    );
    expect(declarations(desktopCss, ".brand").join(";")).not.toContain("text-transform");
  });

  it("el buscador reserva el renglon del mensaje, y en celular tambien el del ejemplo", () => {
    expect(declarations(desktopCss, ".search")).toContain("--entry-message-rows: 1");
    expect(declarations(phoneCss, ".search")).toEqual(["--entry-message-rows: 2"]);
  });
});
