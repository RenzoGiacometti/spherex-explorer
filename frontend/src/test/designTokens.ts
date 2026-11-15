// Lectura de los tokens de DESIGN.md (front matter YAML) y de las variables de
// tokens.css, para comprobar en tokens.test.ts que dicen lo mismo.

/** Un grupo de tokens: nombre y valor, o nombre y sus propiedades. */
export type TokenGroup = Map<string, string | Map<string, string>>;

function unquote(value: string): string {
  const text = value.trim();
  const quoted =
    (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"));
  return quoted ? text.slice(1, -1) : text;
}

/**
 * Lee el front matter de DESIGN.md. Alcanza con un subconjunto de YAML: claves
 * con sangria de 0, 2 y 4 espacios, y valores escalares con o sin comillas.
 */
export function parseDesignTokens(markdown: string): Map<string, TokenGroup> {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error("DESIGN.md no empieza con front matter");
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error("DESIGN.md: el front matter no cierra");

  const groups = new Map<string, TokenGroup>();
  let group: TokenGroup | null = null;
  let entry: Map<string, string> | null = null;

  for (const line of lines.slice(1, end)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const match = /^( *)([\w-]+):(.*)$/.exec(line);
    if (!match) throw new Error(`DESIGN.md: linea de front matter no reconocida: ${line}`);
    const indent = match[1]?.length ?? 0;
    const key = match[2] ?? "";
    const value = unquote(match[3] ?? "");

    if (indent === 0) {
      entry = null;
      if (value === "") {
        group = new Map();
        groups.set(key, group);
      } else {
        // Escalares de primer nivel (version, name, description): no son tokens.
        group = null;
      }
    } else if (indent === 2 && group) {
      if (value === "") {
        entry = new Map();
        group.set(key, entry);
      } else {
        entry = null;
        group.set(key, value);
      }
    } else if (indent === 4 && entry) {
      entry.set(key, value);
    } else {
      throw new Error(`DESIGN.md: sangria inesperada en: ${line}`);
    }
  }
  return groups;
}

/** Variables CSS declaradas en una hoja de estilos: nombre y valor, sin comentarios. */
export function parseCssVariables(css: string): Map<string, string> {
  const variables = new Map<string, string>();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    variables.set(match[1] ?? "", (match[2] ?? "").replace(/\s+/g, " ").trim());
  }
  return variables;
}

/** Sigue las referencias var(--x) hasta llegar a un valor literal. */
export function resolveCssVariable(
  variables: Map<string, string>,
  name: string,
): string | undefined {
  let value = variables.get(name);
  for (let depth = 0; depth < 10 && value !== undefined; depth += 1) {
    const reference = /^var\((--[\w-]+)\)$/.exec(value);
    if (!reference) return value;
    value = variables.get(reference[1] ?? "");
  }
  return value;
}

/** Lista de fuentes sin comillas ni espacios de mas, para comparar. */
export function normalizeFontStack(value: string): string[] {
  return value.split(",").map((font) => unquote(font).trim());
}

/** "0" y "0px" son la misma longitud. */
export function normalizeLength(value: string): string {
  const text = value.trim();
  return /^0(?:px)?$/.test(text) ? "0" : text;
}

/** Pasa una referencia de DESIGN.md, "{colors.void}", a la variable CSS, "var(--color-void)". */
export function referenceToVariable(reference: string): string | null {
  const match = /^\{(colors|rounded|spacing|effects)\.([\w-]+)\}$/.exec(reference.trim());
  if (!match) return null;
  const prefix = { colors: "color", rounded: "radius", spacing: "space", effects: "effect" }[
    match[1] as "colors" | "rounded" | "spacing" | "effects"
  ];
  return `var(--${prefix}-${match[2]})`;
}
