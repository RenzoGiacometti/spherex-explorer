// Colores del visor. El codigo del visor no escribe ningun color: los recibe
// como parametros, y quien arma la escena los lee de las variables CSS de
// src/styles/tokens.css con `readCssColor`.
//
// Los canales van de 0 a 1, que es lo que usan el shader y la composicion.

/** Color sin transparencia: rojo, verde y azul, de 0 a 1. */
export type Rgb = readonly [red: number, green: number, blue: number];

/** Color con opacidad: rojo, verde, azul y alfa, de 0 a 1. */
export type Rgba = readonly [red: number, green: number, blue: number, alpha: number];

/** Lo que se devuelve cuando una variable no se puede leer: ningun color. */
export const NO_COLOR: Rgba = [0, 0, 0, 0];

/** Variable de tokens.css para los pixeles sin datos y el fondo (`{colors.void}` de DESIGN.md). */
export const NO_DATA_COLOR_VARIABLE = "--color-void";

function hexPair(digits: string, index: number): number {
  return Number.parseInt(digits.slice(index, index + 2), 16) / 255;
}

function parseHex(digits: string): Rgba | null {
  if (!/^[0-9a-f]+$/.test(digits)) return null;
  if (digits.length === 3 || digits.length === 4) {
    // Forma corta: cada digito vale por dos.
    const doubled = [...digits].map((digit) => digit + digit).join("");
    return parseHex(doubled);
  }
  if (digits.length === 6) return [hexPair(digits, 0), hexPair(digits, 2), hexPair(digits, 4), 1];
  if (digits.length === 8) {
    return [hexPair(digits, 0), hexPair(digits, 2), hexPair(digits, 4), hexPair(digits, 6)];
  }
  return null;
}

/** Un canal de la notacion funcional: numero de 0 a 255 o porcentaje. */
function parseChannel(text: string): number | null {
  const percent = text.endsWith("%");
  const value = Number(percent ? text.slice(0, -1) : text);
  if (text === "" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, percent ? value / 100 : value / 255));
}

/** La opacidad de la notacion funcional: numero de 0 a 1 o porcentaje. */
function parseAlpha(text: string | undefined): number | null {
  if (text === undefined) return 1;
  const percent = text.endsWith("%");
  const value = Number(percent ? text.slice(0, -1) : text);
  if (text === "" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, percent ? value / 100 : value));
}

function parseFunctional(value: string): Rgba | null {
  const call = /^(rgba?)\(([^)]*)\)$/.exec(value);
  if (!call) return null;
  const parts = (call[2] ?? "").split(/[\s,/]+/).filter((part) => part !== "");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const red = parseChannel(parts[0] ?? "");
  const green = parseChannel(parts[1] ?? "");
  const blue = parseChannel(parts[2] ?? "");
  const alpha = parseAlpha(parts[3]);
  if (red === null || green === null || blue === null || alpha === null) return null;
  return [red, green, blue, alpha];
}

/**
 * Interpreta un color de CSS escrito en hexadecimal (3, 4, 6 u 8 digitos) o en
 * notacion funcional de rojo, verde y azul, con o sin opacidad. Son los
 * formatos que usa tokens.css. Devuelve null para cualquier otro texto.
 */
export function parseCssColor(text: string): Rgba | null {
  const value = text.trim().toLowerCase();
  if (value.startsWith("#")) return parseHex(value.slice(1));
  return parseFunctional(value);
}

/**
 * Lee un color de una variable CSS, por ejemplo `--color-void`. Las variables
 * de tokens.css estan en `:root`, que es donde se busca si no se pasa otro
 * elemento. Devuelve null si la variable no existe o no es un color legible.
 */
export function readCssColor(variable: string, element?: Element): Rgba | null {
  if (typeof document === "undefined") return null;
  const target = element ?? document.documentElement;
  return parseCssColor(getComputedStyle(target).getPropertyValue(variable));
}

/** Los tres canales de color, sin la opacidad. */
export function toRgb(color: Rgba): Rgb {
  return [color[0], color[1], color[2]];
}

function hexByte(channel: number): string {
  // Lo que no es un numero cuenta como 0.
  const byte = channel > 0 ? Math.round(Math.min(channel, 1) * 255) : 0;
  return byte.toString(16).padStart(2, "0");
}

/** El color como texto hexadecimal de CSS, para `fillStyle` de un canvas 2D. */
export function toCssHex(color: Rgb): string {
  return `#${hexByte(color[0])}${hexByte(color[1])}${hexByte(color[2])}`;
}
