// Capa de flags: que pixeles se cubren con la trama y que flags hay en la
// imagen que se ve. Funciones puras; el estado vive en useFlagLayer.ts.
//
// docs/contrato-cubo.md, secciones 5 y 6:
// - `flags[]` nombra los bits; `bit` es la posicion del bit, desde 0.
// - La capa auxiliar trae un Uint32 por pixel: el bit `n` esta encendido si al
//   menos la mitad de las exposiciones que cubren ese pixel lo tienen.
// - `masked` dice si el pipeline descarta los pixeles con ese bit. Son los que
//   se cubren con la trama (DESIGN.md, "Capa de flags").

import type { AuxLayers } from "@/api/binary";
import type { Flag } from "@/api/types";

/** Bits de un Uint32. */
const FLAG_BITS = 32;

/** Un flag presente en la imagen que se ve. */
export interface FlagCount {
  readonly flag: Flag;
  /** Pixeles que lo tienen encendido. En una comparacion, en alguna de las epocas. */
  readonly pixels: number;
}

function bitValue(bit: number): number {
  return Number.isInteger(bit) && bit >= 0 && bit < FLAG_BITS ? (1 << bit) >>> 0 : 0;
}

/**
 * Los bits de los flags que el pipeline descarta (`masked: true`), juntos en
 * un entero sin signo de 32 bits. 0 si no hay ninguno o la lista todavia no llego.
 */
export function maskedFlagBits(flags: readonly Flag[] | undefined): number {
  let bits = 0;
  for (const flag of flags ?? []) {
    if (flag.masked) bits |= bitValue(flag.bit);
  }
  return bits >>> 0;
}

/**
 * Mascara de un byte por pixel para la capa de resaltado del visor: 1 donde
 * alguna de las capas tiene encendido alguno de esos bits. Con varias capas
 * (una comparacion entre epocas) es la union.
 *
 * Devuelve null si no hay capas, si no tienen todas el mismo tamano o si
 * ningun pixel queda marcado: no hay nada que dibujar.
 */
export function flagMask(layers: readonly AuxLayers[], bits: number): Uint8Array | null {
  const first = layers[0];
  if (first === undefined || bits === 0) return null;
  const length = first.flags.length;
  if (layers.some((layer) => layer.flags.length !== length)) return null;

  const mask = new Uint8Array(length);
  let marked = false;
  for (const layer of layers) {
    const values = layer.flags;
    for (let index = 0; index < length; index += 1) {
      if (((values[index] as number) & bits) !== 0) {
        mask[index] = 1;
        marked = true;
      }
    }
  }
  return marked ? mask : null;
}

/**
 * Flags presentes en las capas, en el orden de `flags` (por bit), con la
 * cantidad de pixeles que tienen cada uno. Con varias capas un pixel cuenta
 * una vez aunque tenga el flag en mas de una epoca. Los que no aparecen en
 * ningun pixel no se listan.
 */
export function countFlags(layers: readonly AuxLayers[], flags: readonly Flag[]): FlagCount[] {
  const first = layers[0];
  if (first === undefined || flags.length === 0) return [];
  const length = first.flags.length;
  if (layers.some((layer) => layer.flags.length !== length)) return [];

  const counts = new Uint32Array(FLAG_BITS);
  for (let index = 0; index < length; index += 1) {
    let value = 0;
    for (const layer of layers) value |= layer.flags[index] as number;
    // La mayoria de los pixeles no tiene ningun flag.
    if (value === 0) continue;
    for (let bit = 0; bit < FLAG_BITS; bit += 1) {
      if ((value & (1 << bit)) !== 0) counts[bit] = (counts[bit] as number) + 1;
    }
  }
  return flags.flatMap((flag) => {
    const pixels = bitValue(flag.bit) === 0 ? 0 : (counts[flag.bit] as number);
    return pixels > 0 ? [{ flag, pixels }] : [];
  });
}
