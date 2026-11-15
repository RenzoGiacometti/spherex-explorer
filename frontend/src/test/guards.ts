// Detectores de las guardas del proyecto (CLAUDE.md, "Convenciones"):
// - cero colores hardcodeados: solo tokens semanticos;
// - cero emojis, incluidos dingbats Unicode;
// - sin violeta ni purpura en la interfaz;
// - cero textos de interfaz hardcodeados: todo por i18next.
//
// Son funciones puras sobre el texto de un archivo; guards.test.ts las aplica
// a todo src/. Este archivo y su test quedan fuera de las guardas de color
// porque contienen las listas de nombres y los ejemplos.

import { lineOf } from "./sourceFiles";

export interface Finding {
  /** Linea del archivo, desde 1. */
  line: number;
  /** Texto que disparo la guarda. */
  match: string;
}

function collect(text: string, pattern: RegExp, group = 0): Finding[] {
  const findings: Finding[] = [];
  for (const match of text.matchAll(pattern)) {
    findings.push({ line: lineOf(text, match.index), match: match[group] ?? match[0] });
  }
  return findings;
}

/** Reemplaza los comentarios de CSS por espacios, conservando las lineas. */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

// ---- Colores literales ---------------------------------------------------

// "#" seguido de 3, 4, 6 u 8 digitos hexadecimales. No cuenta dentro de una
// palabra ni en una entidad HTML ("&#160;").
const HEX_COLOR = /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z_-])/g;

// Funciones de color de CSS con valores literales.
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/gi;

/** Colores literales: hexadecimales y funciones rgb(), hsl() y similares. */
export function findLiteralColors(text: string): Finding[] {
  return [...collect(text, HEX_COLOR), ...collect(text, COLOR_FUNCTION)].sort(
    (a, b) => a.line - b.line,
  );
}

// Nombres de color de CSS (CSS Color Module Level 4, "Named colors").
// transparent, currentColor e inherit no son colores literales y se permiten.
const NAMED_COLORS = [
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
] as const;

// Nombres de color de CSS que son violetas, purpuras o magentas.
const VIOLET_NAMES: readonly string[] = [
  "blueviolet",
  "darkmagenta",
  "darkorchid",
  "darkslateblue",
  "darkviolet",
  "fuchsia",
  "indigo",
  "lavender",
  "magenta",
  "mediumorchid",
  "mediumpurple",
  "mediumslateblue",
  "mediumvioletred",
  "orchid",
  "palevioletred",
  "plum",
  "purple",
  "rebeccapurple",
  "slateblue",
  "thistle",
  "violet",
];

function wordPattern(words: readonly string[]): RegExp {
  return new RegExp(`(?<![\\w-])(?:${words.join("|")})(?![\\w-])`, "gi");
}

/**
 * Valores de las declaraciones de una hoja CSS, con los comentarios, los
 * nombres de variables y las cadenas reemplazados por espacios para que no
 * cuenten ("--color-white", `"Gill Sans"`), y solo el texto entre ":" y ";".
 */
function cssValues(css: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  return stripCssComments(css)
    .replace(/--[\w-]+/g, blank)
    .replace(/"[^"\n]*"|'[^'\n]*'/g, blank)
    .replace(/(^|[{};])([^{};:]*)(?=:|[{};]|$)/g, (_all, start: string, name: string) => {
      // Deja el separador y borra el selector o el nombre de la propiedad.
      return `${start}${blank(name)}`;
    });
}

/** Nombres de color de CSS usados como valor en una hoja de estilos. */
export function findNamedColorsInCss(css: string): Finding[] {
  return collect(cssValues(css), wordPattern(NAMED_COLORS));
}

// Propiedades de estilo o atributos de SVG con un nombre de color entre
// comillas: color: "white", fill="red", strokeStyle = 'blue'.
const STYLE_COLOR_ASSIGNMENT = new RegExp(
  "\\b(?:color|background|backgroundColor|borderColor|outlineColor|fill|stroke|fillStyle|strokeStyle|stopColor|floodColor)" +
    "\\s*[:=]\\s*\\{?\\s*[\"'`](" +
    NAMED_COLORS.join("|") +
    ")[\"'`]",
  "gi",
);

/** Nombres de color de CSS asignados a una propiedad de estilo en TS o TSX. */
export function findNamedColorsInScript(text: string): Finding[] {
  return collect(text, STYLE_COLOR_ASSIGNMENT, 1);
}

// ---- Violeta y purpura ---------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(text: string): Rgb | null {
  const digits = text.slice(1);
  if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
  if (digits.length === 3 || digits.length === 4) {
    const [r = "0", g = "0", b = "0"] = digits;
    return {
      r: Number.parseInt(r + r, 16),
      g: Number.parseInt(g + g, 16),
      b: Number.parseInt(b + b, 16),
    };
  }
  if (digits.length === 6 || digits.length === 8) {
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
    };
  }
  return null;
}

function channel(text: string): number {
  const value = Number.parseFloat(text);
  return text.trim().endsWith("%") ? (value / 100) * 255 : value;
}

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const [r, g, b] =
    sector < 1
      ? [chroma, second, 0]
      : sector < 2
        ? [second, chroma, 0]
        : sector < 3
          ? [0, chroma, second]
          : sector < 4
            ? [0, second, chroma]
            : sector < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  const offset = lightness - chroma / 2;
  return { r: (r + offset) * 255, g: (g + offset) * 255, b: (b + offset) * 255 };
}

/**
 * Interpreta un color literal en hexadecimal, rgb() o hsl(). Devuelve null
 * para cualquier otro formato.
 */
export function parseColor(text: string): Rgb | null {
  const value = text.trim().toLowerCase();
  if (value.startsWith("#")) return parseHex(value);

  const call = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(value);
  if (!call) return null;
  const parts = (call[2] ?? "").split(/[\s,/]+/).filter((part) => part !== "");
  const [first, second, third] = parts;
  if (first === undefined || second === undefined || third === undefined) return null;

  if (call[1]?.startsWith("rgb")) {
    return { r: channel(first), g: channel(second), b: channel(third) };
  }
  return hslToRgb(
    Number.parseFloat(first),
    Number.parseFloat(second) / 100,
    Number.parseFloat(third) / 100,
  );
}

/** Tono (grados), saturacion y luminosidad (0 a 1) de un color. */
export function toHsl(color: Rgb): { hue: number; saturation: number; lightness: number } {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) return { hue: 0, saturation: 0, lightness };

  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return { hue: (hue * 60 + 360) % 360, saturation, lightness };
}

/**
 * Dice si un color se ve violeta, purpura o magenta: tono entre 250 y 330
 * grados, con saturacion suficiente para que el tono se note y sin ser casi
 * negro ni casi blanco. Los grises azulados de DESIGN.md (tono 240, saturacion
 * menor a 0,06) quedan fuera.
 */
export function isVioletOrPurple(color: Rgb): boolean {
  const { hue, saturation, lightness } = toHsl(color);
  return saturation >= 0.15 && lightness >= 0.08 && lightness <= 0.95 && hue >= 250 && hue <= 330;
}

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])|\b(?:rgba?|hsla?)\([^)]*\)/gi;

/** Colores literales de un texto cuyo tono es violeta o purpura. */
export function findVioletColors(text: string): Finding[] {
  return collect(text, COLOR_LITERAL).filter((finding) => {
    const color = parseColor(finding.match);
    return color !== null && isVioletOrPurple(color);
  });
}

/** Nombres de color violetas o purpuras usados como valor en una hoja CSS. */
export function findVioletNamesInCss(css: string): Finding[] {
  return collect(cssValues(css), wordPattern(VIOLET_NAMES));
}

/** Nombres de color violetas o purpuras escritos como cadena en TS o TSX. */
export function findVioletNamesInScript(text: string): Finding[] {
  return collect(text, new RegExp(`["'\`](?:${VIOLET_NAMES.join("|")})["'\`]`, "gi"));
}

// ---- Emojis y dingbats ---------------------------------------------------

// Bloques de Unicode que son pictogramas: no hay texto de interfaz que los necesite.
const PICTOGRAPH_RANGES: ReadonlyArray<readonly [number, number, string]> = [
  [0x20e3, 0x20e3, "tecla combinable"],
  [0x25a0, 0x25ff, "Geometric Shapes"],
  [0x2600, 0x26ff, "Miscellaneous Symbols"],
  [0x2700, 0x27bf, "Dingbats"],
  [0x2b00, 0x2bff, "Miscellaneous Symbols and Arrows"],
  [0xfe0f, 0xfe0f, "selector de presentacion como emoji"],
  [0x1f000, 0x1faff, "emojis y pictogramas"],
  [0x1fb00, 0x1fbff, "Symbols for Legacy Computing"],
  [0xe0020, 0xe007f, "etiquetas de emoji"],
];

// Simbolos de texto corriente que Unicode marca como pictograma: copyright,
// marca registrada y marca comercial.
const ALLOWED_PICTOGRAPHS = new Set([0x00a9, 0x00ae, 0x2122]);

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

function pictographBlock(codePoint: number): string | null {
  if (ALLOWED_PICTOGRAPHS.has(codePoint)) return null;
  for (const [start, end, name] of PICTOGRAPH_RANGES) {
    if (codePoint >= start && codePoint <= end) return name;
  }
  return EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(codePoint))
    ? "Extended_Pictographic"
    : null;
}

/** Emojis, dingbats y demas pictogramas de Unicode que aparecen en un texto. */
export function findPictographs(text: string): Finding[] {
  const findings: Finding[] = [];
  let line = 1;
  for (const character of text) {
    if (character === "\n") {
      line += 1;
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x80) continue;
    const block = pictographBlock(codePoint);
    if (block !== null) {
      findings.push({
        line,
        match: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} (${block})`,
      });
    }
  }
  return findings;
}

// ---- Textos de interfaz fuera de i18n ------------------------------------

// Texto entre una etiqueta y su cierre: >Buscar</button>. Tiene que tener una
// palabra de dos letras o mas; "B{n}" o un signo suelto no cuentan.
const JSX_TEXT = /(?<![=-])>\s*([^<>{}\n]*\p{L}{2,}[^<>{}\n]*?)\s*<\//gu;

// Atributos que la persona lee o escucha, con un texto literal.
const TEXT_ATTRIBUTE =
  /\b(?:aria-label|aria-description|aria-placeholder|aria-roledescription|aria-valuetext|title|placeholder|alt|label)\s*=\s*\{?\s*(["'`])([^"'`\n]*\p{L}{2,}[^"'`\n]*)\1/gu;

/** Marca para excluir una linea: un texto que no se traduce, con su motivo al lado. */
export const I18N_IGNORE = "i18n-ignore";

/**
 * Textos de interfaz escritos a mano en un archivo TSX. Es una heuristica: no
 * ve los textos partidos en varias lineas ni los que estan en variables.
 */
export function findHardcodedText(tsx: string): Finding[] {
  const lines = tsx.split("\n");
  return [...collect(tsx, JSX_TEXT, 1), ...collect(tsx, TEXT_ATTRIBUTE, 2)]
    .filter((finding) => !(lines[finding.line - 1] ?? "").includes(I18N_IGNORE))
    .sort((a, b) => a.line - b.line);
}
