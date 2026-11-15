// @vitest-environment node
//
// tokens.css tiene que decir lo mismo que el front matter de DESIGN.md. Si este
// test falla, uno de los dos cambio sin el otro.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeFontStack,
  normalizeLength,
  parseCssVariables,
  parseDesignTokens,
  referenceToVariable,
  resolveCssVariable,
  type TokenGroup,
} from "./designTokens";
import { parseColor } from "./guards";
import { FRONTEND_DIR, readRepoFile } from "./sourceFiles";

const design = parseDesignTokens(readRepoFile("DESIGN.md"));
const css = readFileSync(join(FRONTEND_DIR, "src", "styles", "tokens.css"), "utf8");
const variables = parseCssVariables(css);

function group(name: string): TokenGroup {
  const found = design.get(name);
  if (!found) throw new Error(`DESIGN.md no tiene el grupo ${name}`);
  return found;
}

/** Entradas escalares de un grupo: [nombre, valor]. */
function scalars(name: string): Array<[string, string]> {
  return [...group(name)].flatMap(([key, value]) =>
    typeof value === "string" ? [[key, value] as [string, string]] : [],
  );
}

/** Entradas compuestas de un grupo: [nombre, propiedades]. */
function composites(name: string): Array<[string, Map<string, string>]> {
  return [...group(name)].flatMap(([key, value]) =>
    typeof value === "string" ? [] : [[key, value] as [string, Map<string, string>]],
  );
}

describe("lectura de DESIGN.md", () => {
  it("encuentra los grupos de tokens", () => {
    expect([...design.keys()]).toEqual([
      "colors",
      "typography",
      "rounded",
      "spacing",
      "effects",
      "components",
    ]);
    expect(scalars("colors")).toHaveLength(13);
    expect(composites("typography")).toHaveLength(10);
    expect(scalars("rounded")).toHaveLength(4);
    expect(scalars("spacing")).toHaveLength(7);
    expect(scalars("effects")).toHaveLength(2);
    expect(composites("components").length).toBeGreaterThanOrEqual(15);
  });
});

describe("colors", () => {
  it.each(scalars("colors"))("--color-%s vale %s", (name, value) => {
    expect(variables.get(`--color-${name}`)?.toLowerCase()).toBe(value.toLowerCase());
  });

  it("tokens.css no define colores que no esten en DESIGN.md", () => {
    const expected = scalars("colors")
      .map(([name]) => `--color-${name}`)
      .sort();
    const actual = [...variables.keys()].filter((name) => name.startsWith("--color-")).sort();
    expect(actual).toEqual(expected);
  });

  it("los colores literales estan solo en las variables --color-*", () => {
    const literal = /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i;
    const offenders = [...variables]
      .filter(([name, value]) => !name.startsWith("--color-") && literal.test(value))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});

describe("rounded, spacing y effects", () => {
  it.each(scalars("rounded"))("--radius-%s vale %s", (name, value) => {
    expect(variables.get(`--radius-${name}`)).toBe(value);
  });

  it.each(scalars("spacing"))("--space-%s vale %s", (name, value) => {
    expect(variables.get(`--space-${name}`)).toBe(value);
  });

  it.each(scalars("effects"))("--effect-%s vale %s", (name, value) => {
    expect(variables.get(`--effect-${name}`)).toBe(value);
  });
});

describe("typography", () => {
  describe.each(composites("typography"))("%s", (name, properties) => {
    const variable = (suffix: string) => resolveCssVariable(variables, `--type-${name}-${suffix}`);

    it("familia", () => {
      expect(normalizeFontStack(variable("family") ?? "")).toEqual(
        normalizeFontStack(properties.get("fontFamily") ?? ""),
      );
    });

    it("tamano, peso, interlinea y tracking", () => {
      expect(variable("size")).toBe(properties.get("fontSize"));
      expect(variable("weight")).toBe(properties.get("fontWeight"));
      expect(variable("line-height")).toBe(properties.get("lineHeight"));
      expect(normalizeLength(variable("tracking") ?? "")).toBe(
        normalizeLength(properties.get("letterSpacing") ?? ""),
      );
    });

    it("mayusculas y cifras tabulares", () => {
      expect(variable("transform")).toBe(properties.get("textTransform") ?? "none");
      expect(variable("numeric")).toBe(properties.get("fontVariantNumeric") ?? "normal");
    });

    it("tiene el atajo para la propiedad font", () => {
      expect(variables.get(`--type-${name}-font`)).toBe(
        `var(--type-${name}-weight) var(--type-${name}-size) / var(--type-${name}-line-height) var(--type-${name}-family)`,
      );
    });
  });
});

describe("components", () => {
  // Propiedad de DESIGN.md y sufijo de la variable CSS. `typography` no tiene
  // variable: se aplica con las clases .type-* de base.css.
  const SUFFIXES: Record<string, string> = {
    backgroundColor: "bg",
    textColor: "text",
    rounded: "radius",
    padding: "padding",
    height: "height",
    size: "size",
  };

  describe.each(composites("components"))("%s", (name, properties) => {
    it.each([...properties].filter(([property]) => property !== "typography"))(
      "%s es %s",
      (property, value) => {
        const suffix = SUFFIXES[property];
        expect(suffix, `propiedad sin variable: ${property}`).toBeDefined();
        expect(variables.get(`--${name}-${suffix}`)).toBe(referenceToVariable(value) ?? value);
      },
    );

    it("su tipografia existe", () => {
      const typography = properties.get("typography");
      if (typography === undefined) return;
      const reference = /^\{typography\.([\w-]+)\}$/.exec(typography);
      expect(reference, typography).not.toBeNull();
      expect(variables.has(`--type-${reference?.[1]}-font`)).toBe(true);
    });
  });
});

describe("base.css", () => {
  const base = readFileSync(join(FRONTEND_DIR, "src", "styles", "base.css"), "utf8");

  it("pinta el fondo de negro puro con el token void", () => {
    expect(parseColor(variables.get("--color-void") ?? "")).toEqual({ r: 0, g: 0, b: 0 });
    expect(base).toMatch(/body\s*\{[^}]*background-color:\s*var\(--color-void\)/);
  });

  it("tiene una clase de tipografia por cada token", () => {
    for (const [name] of composites("typography")) {
      expect(base, name).toMatch(
        new RegExp(`\\.type-${name}\\s*\\{[^}]*var\\(--type-${name}-font\\)`),
      );
    }
  });

  it("solo usa variables que existen en tokens.css", () => {
    const used = [...base.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1] ?? "");
    const missing = used.filter((name) => !variables.has(name));
    expect(missing).toEqual([]);
  });
});
