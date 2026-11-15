// @vitest-environment node
//
// Guardas de las convenciones de CLAUDE.md. Recorren src/ (y, para emojis y
// colores, tambien los archivos sueltos de frontend/) y fallan con la lista de
// archivos y lineas que rompen la regla.

import { describe, expect, it } from "vitest";
import {
  type Finding,
  findHardcodedText,
  findLiteralColors,
  findNamedColorsInCss,
  findNamedColorsInScript,
  findPictographs,
  findVioletColors,
  findVioletNamesInCss,
  findVioletNamesInScript,
  isVioletOrPurple,
  parseColor,
  stripCssComments,
  toHsl,
} from "./guards";
import { listProjectFiles, listSrcFiles, type SourceFile } from "./sourceFiles";

/** Unico archivo que puede tener colores literales. */
const TOKENS_FILE = "src/styles/tokens.css";

/** La guarda y su test contienen las listas de nombres y los ejemplos de color. */
const GUARD_FILES = new Set(["src/test/guards.ts", "src/test/guards.test.ts"]);

const srcFiles = listSrcFiles();
const projectFiles = listProjectFiles();

function isCss(file: SourceFile): boolean {
  return file.path.endsWith(".css");
}

function isScript(file: SourceFile): boolean {
  return /\.(?:ts|tsx|mts|js|mjs|cjs)$/.test(file.path);
}

/** Aplica un detector a una lista de archivos y devuelve "ruta:linea  texto" por hallazgo. */
function scan(files: SourceFile[], detect: (file: SourceFile) => Finding[]): string[] {
  return files.flatMap((file) =>
    detect(file).map((finding) => `${file.path}:${finding.line}  ${finding.match}`),
  );
}

describe("recorrido de archivos", () => {
  it("encuentra el codigo de src/", () => {
    const paths = srcFiles.map((file) => file.path);
    expect(paths).toContain(TOKENS_FILE);
    expect(paths).toContain("src/styles/base.css");
    expect(paths).toContain("src/main.tsx");
    expect(paths).toContain("src/i18n/locales/es/common.json");
    expect(paths.length).toBeGreaterThan(30);
  });

  it("no entra en los datos de muestra ni en las dependencias", () => {
    for (const file of [...srcFiles, ...projectFiles]) {
      expect(file.path).not.toMatch(/(^|\/)(fixtures|node_modules|dist)\//);
    }
  });

  it("incluye los archivos sueltos de frontend/", () => {
    const paths = projectFiles.map((file) => file.path);
    expect(paths).toContain("index.html");
    expect(paths).toContain("vite.config.ts");
    expect(paths).toContain(".husky/pre-commit");
  });
});

describe("cero colores hardcodeados", () => {
  const scanned = [...srcFiles, ...projectFiles].filter(
    (file) => file.path !== TOKENS_FILE && !GUARD_FILES.has(file.path),
  );

  it("no hay colores hexadecimales ni rgb() o hsl() fuera de tokens.css", () => {
    const found = scan(scanned, (file) =>
      findLiteralColors(isCss(file) ? stripCssComments(file.text) : file.text),
    );
    expect(found, "usar var(--color-*) de src/styles/tokens.css").toEqual([]);
  });

  it("no hay nombres de color de CSS en las hojas de estilo", () => {
    const found = scan(scanned.filter(isCss), (file) => findNamedColorsInCss(file.text));
    expect(found, "usar var(--color-*) de src/styles/tokens.css").toEqual([]);
  });

  it("no hay nombres de color en estilos escritos en TS o TSX", () => {
    const found = scan(scanned.filter(isScript), (file) => findNamedColorsInScript(file.text));
    expect(found, "usar var(--color-*) o currentColor").toEqual([]);
  });

  it("tokens.css si define colores: la guarda no esta mirando un archivo vacio", () => {
    const tokens = srcFiles.find((file) => file.path === TOKENS_FILE);
    expect(findLiteralColors(stripCssComments(tokens?.text ?? "")).length).toBeGreaterThanOrEqual(
      13,
    );
  });
});

describe("cero emojis ni dingbats", () => {
  it("no hay pictogramas de Unicode en ningun archivo de frontend/", () => {
    const found = scan([...srcFiles, ...projectFiles], (file) => findPictographs(file.text));
    expect(found, "usar iconos de linea en SVG y texto").toEqual([]);
  });
});

describe("sin violeta ni purpura", () => {
  const everything = [...srcFiles, ...projectFiles].filter((file) => !GUARD_FILES.has(file.path));

  it("ningun color literal tiene tono violeta o purpura, tampoco en tokens.css", () => {
    const found = scan(everything, (file) =>
      findVioletColors(isCss(file) ? stripCssComments(file.text) : file.text),
    );
    expect(found).toEqual([]);
  });

  it("ninguna hoja de estilo usa un nombre de color violeta o purpura", () => {
    const found = scan(everything.filter(isCss), (file) => findVioletNamesInCss(file.text));
    expect(found).toEqual([]);
  });

  it("ningun archivo TS o TSX nombra un color violeta o purpura", () => {
    const found = scan(everything.filter(isScript), (file) => findVioletNamesInScript(file.text));
    expect(found).toEqual([]);
  });

  it("tokens.css solo usa formatos de color que la guarda sabe leer", () => {
    const tokens = srcFiles.find((file) => file.path === TOKENS_FILE);
    const unreadable = findLiteralColors(stripCssComments(tokens?.text ?? "")).filter(
      (finding) => !finding.match.startsWith("#") && !/^(?:rgba?|hsla?)\s*\(/i.test(finding.match),
    );
    expect(unreadable, "en tokens.css usar hexadecimal, rgb() o hsl()").toEqual([]);
  });
});

describe("cero textos de interfaz hardcodeados", () => {
  it("los componentes no llevan textos escritos a mano", () => {
    const components = srcFiles.filter(
      (file) => file.path.endsWith(".tsx") && !file.path.endsWith(".test.tsx"),
    );
    expect(components.length).toBeGreaterThan(0);

    const found = scan(components, (file) => findHardcodedText(file.text));
    expect(found, "llevar el texto a src/i18n/locales y usar t()").toEqual([]);
  });
});

// ---- Los detectores, probados con ejemplos -------------------------------

function matches(findings: Finding[]): string[] {
  return findings.map((finding) => finding.match);
}

describe("findLiteralColors", () => {
  it("detecta hexadecimales de 3, 4, 6 y 8 digitos", () => {
    expect(matches(findLiteralColors("a { color: #fff; }"))).toEqual(["#fff"]);
    expect(matches(findLiteralColors("a { color: #FFB020; border-color: #ffffff24 }"))).toEqual([
      "#FFB020",
      "#ffffff24",
    ]);
    expect(matches(findLiteralColors('const c = "#0b0d";'))).toEqual(["#0b0d"]);
  });

  it("detecta rgb(), rgba(), hsl(), hsla() y las funciones nuevas", () => {
    const css =
      "a { color: rgb(0 0 0); fill: RGBA(1,2,3,.5); stroke: hsl(38 100% 56%); outline-color: oklch(70% 0.1 80) }";
    expect(matches(findLiteralColors(css))).toEqual(["rgb(", "RGBA(", "hsl(", "oklch("]);
  });

  it("informa la linea", () => {
    expect(findLiteralColors("a {\n  color: var(--color-text);\n  background: #000;\n}")).toEqual([
      { line: 3, match: "#000" },
    ]);
  });

  it("no confunde lo que no es un color", () => {
    for (const text of [
      "color: var(--color-accent);",
      'document.getElementById("root")',
      "#root { height: 100%; }",
      'const id = "f3a91c0e52d47b18";',
      "const minus = 0x2212;",
      'window.location.hash === "#ancla"',
      "&#160;",
      "issue #12",
      "#12345",
      "#1234567",
      "color-mix(in srgb, var(--color-text) 45%, transparent)",
      "const collab = collaborate(lab);",
    ]) {
      expect(matches(findLiteralColors(text)), text).toEqual([]);
    }
  });
});

describe("findNamedColorsInCss", () => {
  it("detecta nombres de color usados como valor", () => {
    expect(matches(findNamedColorsInCss("a { color: white; background: Black; }"))).toEqual([
      "white",
      "Black",
    ]);
    expect(matches(findNamedColorsInCss("a {\n  border: 1px solid red;\n}"))).toEqual(["red"]);
  });

  it("permite transparent, currentColor e inherit", () => {
    expect(
      findNamedColorsInCss("a { color: inherit; fill: currentColor; background: transparent; }"),
    ).toEqual([]);
  });

  it("no mira comentarios, nombres de variables, selectores ni cadenas", () => {
    for (const css of [
      "/* blanco: white */ a { color: var(--color-text); }",
      "a { color: var(--color-white); }",
      ":root { --red-alert: var(--color-accent); }",
      ".red { color: var(--color-accent); }",
      ".tan:hover { color: var(--color-accent); }",
      'a { font-family: "Linen Sans", sans-serif; }',
      "a { transition: color 0.2s; }",
      "@media (max-width: 599px) { .root { padding: var(--space-sm); } }",
    ]) {
      expect(matches(findNamedColorsInCss(css)), css).toEqual([]);
    }
  });
});

describe("findNamedColorsInScript", () => {
  it("detecta un nombre de color asignado a una propiedad de estilo", () => {
    expect(matches(findNamedColorsInScript('<p style={{ color: "white" }} />'))).toEqual(["white"]);
    expect(matches(findNamedColorsInScript('<path fill="red" stroke={"blue"} />'))).toEqual([
      "red",
      "blue",
    ]);
    expect(matches(findNamedColorsInScript("context.fillStyle = 'black';"))).toEqual(["black"]);
  });

  it("permite currentColor, none y las variables", () => {
    for (const text of [
      '<path fill="none" stroke="currentColor" />',
      '<p style={{ color: "var(--color-text)" }} />',
      'const mode = "redcyan";',
      'const label = t("mode.redcyan");',
    ]) {
      expect(matches(findNamedColorsInScript(text)), text).toEqual([]);
    }
  });
});

describe("violeta y purpura", () => {
  it("lee hexadecimal, rgb() y hsl()", () => {
    expect(parseColor("#FFB020")).toEqual({ r: 255, g: 176, b: 32 });
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseColor("#08080ab8")).toEqual({ r: 8, g: 8, b: 10 });
    expect(parseColor("rgb(255, 176, 32)")).toEqual({ r: 255, g: 176, b: 32 });
    expect(parseColor("rgba(100% 0% 0% / 50%)")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseColor("oklch(70% 0.1 300)")).toBeNull();

    const fromHsl = parseColor("hsl(270, 100%, 50%)");
    expect(Math.round(fromHsl?.r ?? 0)).toBe(128);
    expect(Math.round(fromHsl?.g ?? 0)).toBe(0);
    expect(Math.round(fromHsl?.b ?? 0)).toBe(255);
  });

  it("calcula el tono", () => {
    expect(Math.round(toHsl({ r: 255, g: 176, b: 32 }).hue)).toBe(39);
    expect(Math.round(toHsl({ r: 128, g: 0, b: 255 }).hue)).toBe(270);
    expect(toHsl({ r: 255, g: 255, b: 255 }).saturation).toBe(0);
  });

  it("reconoce violetas, purpuras y magentas", () => {
    for (const color of [
      "#8000ff",
      "#7c3aed",
      "#a855f7",
      "#800080",
      "#ff00ff",
      "#c084fc",
      "#4b0082",
      "rgb(147, 51, 234)",
      "hsl(280 60% 50%)",
    ]) {
      const parsed = parseColor(color);
      expect(parsed !== null && isVioletOrPurple(parsed), color).toBe(true);
    }
  });

  it("deja pasar los colores de DESIGN.md y los que no son violetas", () => {
    for (const color of [
      "#000000",
      "#08080AB8",
      "#0B0B0D",
      "#FFFFFF24",
      "#FFFFFF",
      "#B4B4BC",
      "#8E8E97",
      "#FFB020",
      "#ff0000",
      "#00ffff",
      "#0000ff",
      "#2563eb",
      "#ff4d6d",
    ]) {
      const parsed = parseColor(color);
      expect(parsed !== null && isVioletOrPurple(parsed), color).toBe(false);
    }
  });

  it("encuentra colores violetas dentro de un texto", () => {
    expect(
      matches(findVioletColors(":root { --a: #ffb020; --b: #7c3aed; --c: rgb(147 51 234); }")),
    ).toEqual(["#7c3aed", "rgb(147 51 234)"]);
  });

  it("encuentra nombres de color violetas en CSS y en TS", () => {
    expect(matches(findVioletNamesInCss("a { color: rebeccapurple; fill: Violet; }"))).toEqual([
      "rebeccapurple",
      "Violet",
    ]);
    expect(findVioletNamesInCss("/* sin violet */ a { color: var(--color-text); }")).toEqual([]);
    expect(matches(findVioletNamesInScript('context.fillStyle = "purple";'))).toEqual(['"purple"']);
    expect(findVioletNamesInScript("// ultraviolet y violeta en un comentario")).toEqual([]);
  });
});

describe("findPictographs", () => {
  const sample = (codePoint: number) => `texto ${String.fromCodePoint(codePoint)} texto`;

  it("detecta emojis", () => {
    for (const codePoint of [0x1f600, 0x1f680, 0x1f52d, 0x1f1e6, 0x1fa90, 0x2b50, 0x231a]) {
      expect(findPictographs(sample(codePoint)), codePoint.toString(16)).toHaveLength(1);
    }
  });

  it("detecta dingbats, simbolos y figuras geometricas usados como iconos", () => {
    for (const codePoint of [
      0x2713, 0x2714, 0x2717, 0x2764, 0x27a1, 0x2605, 0x2606, 0x2600, 0x26a0, 0x25b6, 0x25cf,
      0x25a0, 0xfe0f,
    ]) {
      expect(findPictographs(sample(codePoint)), codePoint.toString(16)).toHaveLength(1);
    }
  });

  it("informa la linea y el codigo", () => {
    expect(findPictographs(`uno\ndos ${String.fromCodePoint(0x2713)}\ntres`)).toEqual([
      { line: 2, match: "U+2713 (Dingbats)" },
    ]);
  });

  it("deja pasar la tipografia de DESIGN.md y el texto en espanol", () => {
    const allowed = [
      0x2212, // signo menos
      0x2032, // prima
      0x2033, // doble prima
      0x00b0, // grado
      0x00b5, // micro
      0x00b7, // punto medio
      0x2013, // raya corta
      0x2014, // raya
      0x03bb, // lambda
      0x00b1, // mas menos
      0x2082, // subindice dos
      0x221a, // raiz
      0x2265, // mayor o igual
      0x00d7, // por
      0x2192, // flecha
      0x00f1, // enie
      0x00e1, // a con acento
      0x00bf, // signo de pregunta de apertura
      0x00a9, // copyright
      0x2122, // marca comercial
    ];
    for (const codePoint of allowed) {
      expect(findPictographs(sample(codePoint)), codePoint.toString(16)).toEqual([]);
    }
  });
});

describe("findHardcodedText", () => {
  it("detecta texto escrito entre etiquetas", () => {
    expect(matches(findHardcodedText("<button>Buscar</button>"))).toEqual(["Buscar"]);
    expect(matches(findHardcodedText('<p className="x">  Lugar al azar </p>'))).toEqual([
      "Lugar al azar",
    ]);
  });

  it("detecta atributos con texto", () => {
    expect(matches(findHardcodedText('<button aria-label="Cerrar" />'))).toEqual(["Cerrar"]);
    expect(matches(findHardcodedText("<input placeholder={'Nombre o coordenadas'} />"))).toEqual([
      "Nombre o coordenadas",
    ]);
    expect(matches(findHardcodedText('<img alt="Campo de WISE 0855" title="WISE" />'))).toEqual([
      "Campo de WISE 0855",
      "WISE",
    ]);
  });

  it("deja pasar lo que sale de i18n y lo que no es texto", () => {
    for (const tsx of [
      '<h1 className="type-title">{t("app.name")}</h1>',
      '<button aria-label={t("actions.close")} />',
      "<dd>{formatBand(band)}</dd>",
      "<span>B{detector}</span>",
      "<span>/</span>",
      '<a href="/?ra=1&dec=2">{href}</a>',
      "const next = (value: number) => value + 1;",
      "const items: Array<Record<string, number>> = [];",
      'import styles from "./Panel.module.css";',
    ]) {
      expect(matches(findHardcodedText(tsx)), tsx).toEqual([]);
    }
  });

  it("respeta la marca i18n-ignore en la linea", () => {
    expect(findHardcodedText("<abbr>UTC</abbr> {/* i18n-ignore: sigla */}")).toEqual([]);
  });
});
