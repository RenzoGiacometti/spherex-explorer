// @vitest-environment node
//
// Medidas de las hojas de estilo del visor que jsdom no puede comprobar, porque
// no hace layout: el armado del celular (DESIGN.md, "Responsive Behavior"), los
// objetivos tactiles de lo que no es una primitiva de src/components, y los
// trazos de las anotaciones (DESIGN.md, "Sobre la imagen").
//
// Que el resultado sea el esperado se midio en Chrome y en Edge por DevTools;
// estos tests cuidan que la regla no se pierda.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCssVariables, resolveCssVariable } from "@/test/designTokens";
import { FRONTEND_DIR } from "@/test/sourceFiles";

const VIEWER_DIR = join(FRONTEND_DIR, "src", "features", "viewer");

function read(name: string): string {
  return readFileSync(join(VIEWER_DIR, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

function squeeze(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Declaraciones ("propiedad" a "valor") de la primera regla con ese selector exacto. */
function rule(css: string, selector: string): Map<string, string> {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? "").split(",").map(squeeze);
    if (!selectors.includes(selector)) continue;
    const declarations = new Map<string, string>();
    for (const declaration of (match[2] ?? "").split(";")) {
      const colon = declaration.indexOf(":");
      if (colon > 0) {
        declarations.set(
          squeeze(declaration.slice(0, colon)),
          squeeze(declaration.slice(colon + 1)),
        );
      }
    }
    return declarations;
  }
  throw new Error(`no hay una regla para ${selector}`);
}

const tokens = parseCssVariables(
  readFileSync(join(FRONTEND_DIR, "src", "styles", "tokens.css"), "utf8"),
);

/** Valor en px de una declaracion que usa una variable de tokens.css o un numero. */
function px(value: string | undefined): number {
  const variable = /^var\((--[\w-]+)\)$/.exec(value ?? "");
  const resolved = variable ? resolveCssVariable(tokens, variable[1] ?? "") : value;
  const number = /^(-?[\d.]+)px$/.exec(resolved ?? "");
  if (!number) throw new Error(`no es una medida en px: ${value}`);
  return Number(number[1]);
}

describe("armado del celular", () => {
  const page = read("ViewerPage.module.css");
  const phone = rule(page, '.page[data-layout="phone"]');

  it("es una columna unica: informacion arriba, la imagen y los controles abajo", () => {
    expect(phone.get("grid-template-areas")).toBe('"top" "stage" "thumb"');
    expect(phone.get("grid-template-columns")).toBe("minmax(0, 1fr)");
    // La imagen se queda con lo que sobra; los controles miden lo que necesitan.
    expect(phone.get("grid-template-rows")).toBe("auto minmax(180px, 1fr) auto");
  });

  it("deja los paneles a 12 px del borde", () => {
    expect(px(phone.get("padding"))).toBe(12);
  });

  it("si no entra en la pantalla se desplaza en vez de cortar los controles", () => {
    expect(phone.get("height")).toBe("auto");
    expect(phone.get("min-height")).toBe("100%");
    expect(phone.get("overflow")).toBe("visible");
  });

  it("el visor ocupa la pantalla entera, por debajo de los paneles", () => {
    const viewer = rule(page, '.page[data-layout="phone"] .viewer');
    expect(viewer.get("position")).toBe("absolute");
    expect(viewer.get("inset")).toBe("0");
  });

  it("con el cajon abierto los controles de abajo no se ven ni reciben el foco, pero guardan su lugar", () => {
    const covered = rule(page, '.controls[data-covered="true"]');
    expect(covered.get("visibility")).toBe("hidden");
    expect(covered.has("display")).toBe(false);
    // El cajon ocupa exactamente esa celda.
    const drawer = rule(read("ToolsDrawer.module.css"), ".drawer");
    expect(drawer.get("position")).toBe("absolute");
    expect(drawer.get("inset")).toBe("0");
    expect(rule(page, ".thumb").get("position")).toBe("relative");
  });

  it("lo que flota sobre la imagen deja pasar el arrastre, salvo los paneles", () => {
    expect(rule(page, ".thumb").get("pointer-events")).toBe("none");
    expect(rule(page, ".controls > *").get("pointer-events")).toBe("auto");
    expect(rule(read("ToolsDrawer.module.css"), ".drawer").get("pointer-events")).toBe("auto");
  });
});

describe("objetivos tactiles del celular", () => {
  it("el acceso a los avisos mide 44 px de alto y por lo menos 44 de ancho", () => {
    const notices = rule(read("TopBar.module.css"), ".notices");
    expect(px(notices.get("height"))).toBeGreaterThanOrEqual(44);
    expect(px(notices.get("min-width"))).toBeGreaterThanOrEqual(44);
  });

  it("el boton de velocidad mide 44 por 44", () => {
    const speed = rule(read("TimelineDock.module.css"), ".speedButton");
    expect(px(speed.get("width"))).toBeGreaterThanOrEqual(44);
    expect(px(speed.get("height"))).toBeGreaterThanOrEqual(44);
  });

  it("los dos tienen foco visible en blanco, no en el acento", () => {
    for (const [file, selector] of [
      ["TopBar.module.css", ".notices:focus-visible"],
      ["TimelineDock.module.css", ".speedButton:focus-visible"],
    ] as const) {
      const focus = rule(read(file), selector);
      expect(focus.get("outline"), selector).toBe("2px solid var(--color-text)");
      expect(focus.get("outline-offset"), selector).toBe("2px");
    }
  });
});

describe("modo embed", () => {
  const embed = rule(read("ViewerPage.module.css"), '.page[data-layout="embed"]');

  it("la imagen se queda con todo el marco menos la franja del pie", () => {
    expect(embed.get("grid-template-areas")).toBe('"stage" "dock"');
    expect(embed.get("grid-template-rows")).toBe("minmax(0, 1fr) auto");
  });

  it("no desborda el marco que lo aloja", () => {
    expect(embed.get("height")).toBe("100%");
    expect(embed.get("overflow")).toBe("hidden");
  });
});

describe("anotaciones sobre la imagen", () => {
  const css = read("ImageAnnotations.module.css");

  it("el contorno es un trazo de 1 px claro montado sobre uno de 3 px de vacio", () => {
    // DESIGN.md, "Fuente saturada": asi se lee tambien sobre el blanco de la estrella.
    const halo = rule(css, ".halo");
    expect(halo.get("stroke")).toBe("var(--color-void)");
    expect(halo.get("stroke-width")).toBe("3px");
    expect(halo.get("fill")).toBe("none");
    const line = rule(css, ".line");
    expect(line.get("stroke")).toBe("var(--color-text)");
    expect(line.get("stroke-width")).toBe("1px");
    expect(line.get("fill")).toBe("none");
  });

  it("la mira va en el acento, con el grosor de los iconos", () => {
    const reticle = rule(css, ".reticle");
    expect(reticle.get("stroke")).toBe("var(--reticle-text)");
    expect(resolveCssVariable(tokens, "--reticle-text")).toBe(
      resolveCssVariable(tokens, "--color-accent"),
    );
    expect(reticle.get("stroke-width")).toBe("var(--effect-icon-stroke)");
  });

  it("el acento no se usa en ninguna otra anotacion", () => {
    const uses = [...css.matchAll(/var\(--(?:color-accent|reticle-text)\)/g)];
    expect(uses).toHaveLength(1);
  });

  it("los textos llevan un borde de vacio por debajo del relleno, no una sombra", () => {
    const text = rule(css, ".labelCap");
    expect(text.get("stroke")).toBe("var(--color-void)");
    expect(text.get("paint-order")).toBe("stroke fill");
    expect(css).not.toMatch(/text-shadow|box-shadow|drop-shadow/);
  });

  it("la capa no recibe el puntero: arrastrar sobre una anotacion desplaza la imagen", () => {
    // La capa de ImageViewer ya lo apaga; aca nadie lo vuelve a prender.
    expect(css).not.toMatch(/pointer-events:\s*auto/);
  });
});

describe("sin sombras ni degradados", () => {
  it("ninguna hoja de estilos del visor los usa", () => {
    for (const file of [
      "ViewerPage.module.css",
      "TopBar.module.css",
      "TimelineDock.module.css",
      "ToolsDrawer.module.css",
      "EmbedBar.module.css",
      "FlagsControl.module.css",
      "ImageAnnotations.module.css",
      "panels.module.css",
    ]) {
      expect(read(file), file).not.toMatch(/shadow|gradient/);
    }
  });
});
