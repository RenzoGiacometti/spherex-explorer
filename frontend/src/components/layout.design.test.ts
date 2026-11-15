// @vitest-environment node
//
// Medidas y reglas de las hojas de estilo que jsdom no puede comprobar, porque
// no hace layout: objetivos tactiles de 44 px (DESIGN.md, "Responsive
// Behavior"), lo que cambia en celular y como estan armadas las capas.
//
// Se leen de los archivos .module.css. Que el resultado sea el esperado se
// midio en Chrome y en Edge; estos tests cuidan que la regla no se pierda.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FRONTEND_DIR } from "@/test/sourceFiles";
import { EPOCH_STOP_WIDTH_PX } from "./timelineLayout";

/** Consulta de las reglas para celular, como esta escrita en las hojas de estilo. */
const PHONE = "@media (max-width: 599px)";

/** Lado minimo de un objetivo tactil. */
const TOUCH_TARGET_PX = 44;

interface Rule {
  /** Regla que la contiene ("@media ..."), o null si esta suelta. */
  at: string | null;
  selector: string;
  /** Declaraciones como "propiedad: valor". */
  declarations: string[];
}

function squeeze(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Reglas de una hoja de estilos, con las de adentro de cada @media. */
function parseRules(css: string): Rule[] {
  const rules: Rule[] = [];
  const walk = (source: string, at: string | null): void => {
    let index = 0;
    for (;;) {
      const open = source.indexOf("{", index);
      if (open === -1) return;
      let depth = 1;
      let close = open + 1;
      while (close < source.length && depth > 0) {
        if (source[close] === "{") depth += 1;
        else if (source[close] === "}") depth -= 1;
        close += 1;
      }
      const prelude = squeeze(source.slice(index, open));
      const body = source.slice(open + 1, close - 1);
      if (prelude.startsWith("@")) {
        walk(body, prelude);
      } else {
        const declarations = body.split(";").map(squeeze).filter(Boolean);
        for (const selector of prelude.split(",")) {
          rules.push({ at, selector: squeeze(selector), declarations });
        }
      }
      index = close;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ""), null);
  return rules;
}

function stylesOf(component: string): Rule[] {
  return parseRules(
    readFileSync(join(FRONTEND_DIR, "src", "components", `${component}.module.css`), "utf8"),
  );
}

/** Declaraciones de un selector, sueltas o dentro de una regla @media. */
function declared(rules: Rule[], selector: string, at: string | null = null): string[] {
  return rules
    .filter((rule) => rule.selector === selector && rule.at === at)
    .flatMap((rule) => rule.declarations);
}

/** Valor en pixeles de una declaracion "propiedad: Npx", o NaN. */
function pixels(declarations: string[], property: string): number {
  const value = declarations
    .find((line) => line.startsWith(`${property}:`))
    ?.slice(property.length + 1)
    .trim();
  return value !== undefined && /^\d+(\.\d+)?px$/.test(value)
    ? Number.parseFloat(value)
    : Number.NaN;
}

describe("lectura de las hojas de estilo", () => {
  it("separa las reglas sueltas de las de cada @media", () => {
    const rules = parseRules(`
      /* comentario { con llaves } */
      .a, .b:hover { color: var(--x); width: 10px }
      @media (max-width: 599px) { .a { width: 44px; } }
    `);
    expect(declared(rules, ".a")).toEqual(["color: var(--x)", "width: 10px"]);
    expect(declared(rules, ".b:hover")).toEqual(["color: var(--x)", "width: 10px"]);
    expect(declared(rules, ".a", PHONE)).toEqual(["width: 44px"]);
    expect(pixels(declared(rules, ".a", PHONE), "width")).toBe(44);
    expect(pixels(declared(rules, ".a"), "color")).toBeNaN();
  });
});

describe("linea de tiempo", () => {
  const rules = stylesOf("Timeline");

  it("la pista tiene alto propio en una caja que no es el fieldset", () => {
    // Una capa absoluta con top y bottom en 0 dentro de un fieldset queda con
    // alto 0 en Chrome y en Edge: la parada media 56 x 0.
    const rail = declared(rules, ".rail");
    expect(rail).toContain("position: relative");
    expect(pixels(rail, "height")).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
    expect(declared(rules, ".track").some((line) => line.startsWith("position:"))).toBe(false);
    expect(declared(rules, ".stops")).toEqual(
      expect.arrayContaining(["position: absolute", "height: 100%"]),
    );
  });

  it("la parada, que es lo que recibe el toque, ocupa todo el alto y mide lo que dice timelineLayout.ts", () => {
    const stop = declared(rules, ".stop");
    expect(stop).toEqual(
      expect.arrayContaining(["height: 100%", "width: var(--epoch-stop-width)"]),
    );
    expect(EPOCH_STOP_WIDTH_PX).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
    // El radio nativo la cubre entera.
    expect(declared(rules, ".input")).toEqual(
      expect.arrayContaining(["position: absolute", "inset: 0", "width: 100%", "height: 100%"]),
    );
  });
});

describe("control segmentado ajustado al contenido (selector de idioma)", () => {
  const rules = stylesOf("SegmentedControl");

  it("no se encoge cuando la barra se queda sin lugar, y el label no es mas angosto que su celda", () => {
    expect(declared(rules, ".fitContent")).toContain("flex-shrink: 0");
    expect(declared(rules, ".fitContent .option")).toContain("min-width: auto");
  });

  it("en celular las celdas miden 44 px como minimo, de alto y de ancho", () => {
    expect(pixels(declared(rules, ".cell", PHONE), "min-height")).toBe(TOUCH_TARGET_PX);
    expect(pixels(declared(rules, ".fitContent .cell", PHONE), "min-width")).toBe(TOUCH_TARGET_PX);
  });
});

describe("barra de progreso", () => {
  const rules = stylesOf("ProgressBar");

  it("en celular el riel va en su propio renglon, debajo de la etiqueta y el conteo", () => {
    expect(declared(rules, ".progress")).toContain("flex-wrap: wrap");
    expect(declared(rules, ".rail", PHONE)).toEqual(
      expect.arrayContaining(["order: 1", "flex-basis: 100%"]),
    );
  });
});

describe("transporte", () => {
  const rules = stylesOf("Transport");

  it("en celular el boton de reproducir sin tamano pedido mide 56 px", () => {
    expect(pixels(declared(rules, ".transport .playAuto", PHONE), "--icon-button-side")).toBe(56);
    // Fuera del celular queda en el tamano normal de un boton de icono.
    expect(declared(rules, ".transport .playAuto")).toEqual([]);
  });
});

describe("campo de busqueda", () => {
  const rules = stylesOf("SearchField");

  it("los renglones de ayuda van en text-mute: se leen directo sobre la imagen", () => {
    for (const selector of [".hint", ".example", ".label"]) {
      expect(declared(rules, selector), selector).toContain("color: var(--color-text-mute)");
    }
  });

  it("en celular el ejemplo sale del campo, donde no entra, y se muestra entero debajo", () => {
    expect(declared(rules, ".example")).toContain("display: none");
    expect(declared(rules, ".example", PHONE)).toContain("display: block");
    expect(declared(rules, ".input::placeholder", PHONE)).toContain("color: transparent");
  });
});
