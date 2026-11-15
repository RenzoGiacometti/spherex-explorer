// @vitest-environment node
//
// El foco del campo de busqueda contra DESIGN.md ("Foco y deshabilitado"). Va
// aparte de SearchField.test.tsx porque jsdom no aplica las hojas de estilo: la
// regla se lee del archivo, y eso necesita el entorno de Node. Como se ve se
// comprobo en Chrome.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FRONTEND_DIR } from "@/test/sourceFiles";

const css = readFileSync(
  join(FRONTEND_DIR, "src", "components", "SearchField.module.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** Declaraciones de la primera regla con ese selector, como "propiedad: valor". */
function declarations(selector: string): string[] {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return [];
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return body
    .split(";")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

describe("foco del campo de busqueda", () => {
  it("con el foco en el texto, el campo entero lleva el anillo de DESIGN.md", () => {
    // Contorno blanco de 2 px separado 2 px; el acento no se usa para el foco.
    expect(declarations(".field:has(.input:focus-visible)")).toEqual([
      "outline: 2px solid var(--color-text)",
      "outline-offset: 2px",
    ]);
  });

  it("el borde del campo se enciende con el foco en el texto o en el boton", () => {
    expect(declarations(".field:focus-within")).toEqual(["border-color: var(--color-text)"]);
  });

  it("el campo de texto no dibuja un contorno propio adentro del campo", () => {
    expect(declarations(".input")).toContain("outline: 0");
  });
});
