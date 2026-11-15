// @vitest-environment node
//
// El anillo de foco del visor, leido de la hoja de estilos. jsdom no pinta, asi
// que lo que se comprueba aca es como esta armado; que se vea de verdad se
// comprobo en Chrome y en Edge, comparando capturas con y sin foco.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FRONTEND_DIR } from "@/test/sourceFiles";

const css = readFileSync(join(FRONTEND_DIR, "src/viewer/ImageViewer.module.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Declaraciones de la regla con ese selector, como "propiedad: valor". */
function declarations(selector: string): string[] {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return [];
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return body
    .split(";")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

describe("anillo de foco del visor", () => {
  it("se dibuja en un ::after, encima del canvas, y no como contorno del contenedor", () => {
    // El canvas cubre todo el visor: un `outline` de la raiz queda tapado.
    expect(declarations(".canvas")).toEqual(
      expect.arrayContaining(["position: absolute", "inset: 0"]),
    );
    const ring = declarations(".root:focus-visible::after");
    expect(ring).toEqual(expect.arrayContaining(['content: ""', "position: absolute"]));
    expect(ring.some((line) => /^border: \d+px solid var\(--color-text\)$/.test(line))).toBe(true);
    // Hacia adentro: el visor llega a los bordes de la ventana y recorta lo que sobresale.
    expect(ring.some((line) => /^inset: [1-9]\d*px$/.test(line))).toBe(true);
    expect(declarations(".root")).toContain("overflow: hidden");
  });

  it("no le saca el puntero a la imagen", () => {
    expect(declarations(".root:focus-visible::after")).toContain("pointer-events: none");
  });

  it("solo aparece con el foco del teclado", () => {
    expect(css).not.toMatch(/\.root::after/);
    expect(css).not.toMatch(/\.root:focus::after/);
  });
});
