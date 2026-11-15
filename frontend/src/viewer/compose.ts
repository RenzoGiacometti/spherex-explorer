// Escena del visor y su composicion de referencia en CPU.
//
// Una escena dice que planos se combinan, con que modo, estirado y cortes, y
// con que colores. `composeScene` devuelve los RGBA que le corresponden. Es la
// definicion de lo que se tiene que ver: el shader de webglRenderer.ts hace la
// misma cuenta (la pagina de desarrollo compara los dos) y el dibujo con
// canvas 2D la usa tal cual.
//
// docs/contrato-cubo.md, seccion 7, como se muestra un pixel:
//
//   modo         sin datos   saturado
//   un plano     vacio       blanco maximo de la escala
//   suma         vacio       blanco maximo; alcanza con una epoca saturada
//   diferencia   vacio       vacio, si esta saturado en cualquiera de las dos
//   rojo/cian    vacio       vacio, si esta saturado en cualquiera de las dos
//
// "Vacio" es el color de `{colors.void}`, que llega en `noDataColor`.

import type { Rgb, Rgba } from "./colors";
import { MASK_SATURATED, MASK_VALID, type PlaneImage } from "./planeImage";
import {
  type Cuts,
  clampUnit,
  cutSpan,
  differenceHalfRange,
  type StretchKind,
  stretchSigned,
  stretchUnit,
  toByte,
} from "./stretch";

/**
 * Modos de composicion de la Etapa 1.
 *
 * - `single`: un plano. Lo usan el parpadeo y mantener apretado, que muestran
 *   de a uno y cambian de plano.
 * - `difference`: B menos A, con escala simetrica y gris medio en cero.
 * - `sum`: promedio de las epocas validas en cada pixel.
 * - `redcyan`: A en el canal rojo y B en verde y azul, con el mismo estirado.
 *   Es una asignacion de canales, no un color: donde A y B coinciden queda gris.
 */
export const SCENE_MODES = ["single", "difference", "sum", "redcyan"] as const;

export type SceneMode = (typeof SCENE_MODES)[number];

/** Maximo de planos por escena (un campo tiene 3 o 4 epocas). */
export const MAX_SCENE_PLANES = 4;

/** Capa de resaltado: una mascara que se dibuja encima con un color. */
export interface SceneHighlight {
  /** Un byte por pixel, en el mismo orden que el plano: distinto de 0 resalta. */
  readonly mask: Uint8Array;
  /** Color del resaltado. El alfa dice cuanto tapa lo que hay debajo. */
  readonly color: Rgba;
}

export interface Scene {
  readonly mode: SceneMode;
  /**
   * Planos de la escena, todos del mismo tamano:
   * `single` usa uno; `difference` y `redcyan` usan dos, A y B en ese orden;
   * `sum` usa de 1 a 4.
   */
  readonly planes: readonly PlaneImage[];
  readonly stretch: StretchKind;
  /**
   * Cortes del estirado (`contrastCuts`). En `difference` se usa su ancho
   * como medio rango de la escala simetrica.
   */
  readonly cuts: Cuts;
  /** Color de los pixeles sin datos y del fondo: `--color-void`. */
  readonly noDataColor: Rgb;
  /** Capa de resaltado, por ejemplo la de flags. */
  readonly highlight?: SceneHighlight | null | undefined;
}

export interface ImageSize {
  /** Columnas (nx). */
  readonly width: number;
  /** Filas (ny). */
  readonly height: number;
}

function expectedPlanes(mode: SceneMode): readonly [min: number, max: number] {
  switch (mode) {
    case "single":
      return [1, 1];
    case "sum":
      return [1, MAX_SCENE_PLANES];
    default:
      return [2, 2];
  }
}

/**
 * Comprueba que la escena se pueda dibujar y devuelve su tamano. Lanza
 * `RangeError` si la cantidad de planos no es la del modo, si los planos no
 * tienen todos el mismo tamano o si la mascara de resaltado es de otro largo.
 */
export function sceneSize(scene: Scene): ImageSize {
  const [min, max] = expectedPlanes(scene.mode);
  const count = scene.planes.length;
  if (count < min || count > max) {
    throw new RangeError(`el modo ${scene.mode} no admite ${count} planos`);
  }
  const first = scene.planes[0] as PlaneImage;
  for (const plane of scene.planes) {
    if (plane.width !== first.width || plane.height !== first.height) {
      throw new RangeError(
        `planos de distinto tamano: ${first.width} x ${first.height} y ${plane.width} x ${plane.height}`,
      );
    }
  }
  const length = first.width * first.height;
  if (scene.highlight && scene.highlight.mask.length !== length) {
    throw new RangeError(
      `mascara de resaltado de ${scene.highlight.mask.length} pixeles para una imagen de ${length}`,
    );
  }
  return { width: first.width, height: first.height };
}

/**
 * El `RangeError` con el que `sceneSize` rechaza esa escena, o null si se
 * puede dibujar. Sin escena no hay nada que rechazar.
 */
export function sceneError(scene: Scene | null): RangeError | null {
  if (scene === null) return null;
  try {
    sceneSize(scene);
    return null;
  } catch (error) {
    if (error instanceof RangeError) return error;
    throw error;
  }
}

function sameColor(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((channel, index) => channel === b[index]);
}

/**
 * Dice si dos escenas dibujan lo mismo. Compara los planos y la mascara de
 * resaltado por identidad, no por contenido: un `PlaneImage` no cambia despues
 * de creado.
 */
export function sameScene(a: Scene | null, b: Scene | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (
    a.mode !== b.mode ||
    a.stretch !== b.stretch ||
    a.cuts.low !== b.cuts.low ||
    a.cuts.high !== b.cuts.high ||
    a.planes.length !== b.planes.length ||
    !sameColor(a.noDataColor, b.noDataColor)
  ) {
    return false;
  }
  if (a.planes.some((plane, index) => plane !== b.planes[index])) return false;
  const first = a.highlight ?? null;
  const second = b.highlight ?? null;
  if (first === null || second === null) return first === second;
  return first.mask === second.mask && sameColor(first.color, second.color);
}

export interface ComposeOptions {
  /**
   * Orden de las filas de salida. `south-first` (por defecto) es el del plano
   * y el de `readPixels` de WebGL: la fila 0 es el sur. `north-first` es el de
   * `ImageData`, que dibuja la primera fila arriba.
   */
  readonly rowOrder?: "south-first" | "north-first";
}

/**
 * Composicion de referencia: los RGBA de la escena, cuatro bytes por pixel,
 * con la misma grilla que los planos. La opacidad es siempre 255.
 */
export function composeScene(scene: Scene, options: ComposeOptions = {}): Uint8ClampedArray {
  const { width, height } = sceneSize(scene);
  const northFirst = options.rowOrder === "north-first";
  const output = new Uint8ClampedArray(width * height * 4);

  const { mode, stretch } = scene;
  const planes = scene.planes;
  const first = planes[0] as PlaneImage;
  const second = planes[1] ?? first;
  const low = scene.cuts.low;
  const span = cutSpan(scene.cuts);
  const halfRange = differenceHalfRange(scene.cuts);
  const [emptyRed, emptyGreen, emptyBlue] = scene.noDataColor;

  const highlight = scene.highlight ?? null;
  const highlightAlpha = highlight === null ? 0 : highlight.color[3];
  const highlightMask = highlight === null || highlightAlpha <= 0 ? null : highlight.mask;
  const [highlightRed, highlightGreen, highlightBlue] =
    highlight === null ? [0, 0, 0] : highlight.color;

  /** Nivel de un valor: recorte entre los cortes y curva del estirado. */
  const level = (value: number): number => stretchUnit(clampUnit((value - low) / span), stretch);

  for (let row = 0; row < height; row += 1) {
    let offset = (northFirst ? height - 1 - row : row) * width * 4;
    for (let index = row * width; index < (row + 1) * width; index += 1) {
      let red = emptyRed;
      let green = emptyGreen;
      let blue = emptyBlue;

      if (mode === "single") {
        const mask = first.mask[index];
        if (mask === MASK_SATURATED) {
          red = green = blue = 1;
        } else if (mask === MASK_VALID) {
          red = green = blue = level(first.values[index] as number);
        }
      } else if (mode === "sum") {
        let total = 0;
        let valid = 0;
        let saturated = false;
        for (const plane of planes) {
          const mask = plane.mask[index];
          if (mask === MASK_SATURATED) saturated = true;
          else if (mask === MASK_VALID) {
            total += plane.values[index] as number;
            valid += 1;
          }
        }
        if (saturated) {
          red = green = blue = 1;
        } else if (valid > 0) {
          red = green = blue = level(total / valid);
        }
      } else if (first.mask[index] === MASK_VALID && second.mask[index] === MASK_VALID) {
        // Diferencia y rojo/cian: solo donde los dos planos tienen un valor.
        const a = first.values[index] as number;
        const b = second.values[index] as number;
        if (mode === "difference") {
          red = green = blue = stretchSigned(b - a, halfRange, stretch);
        } else {
          red = level(a);
          green = blue = level(b);
        }
      }

      if (highlightMask !== null && highlightMask[index] !== 0) {
        red = red * (1 - highlightAlpha) + highlightRed * highlightAlpha;
        green = green * (1 - highlightAlpha) + highlightGreen * highlightAlpha;
        blue = blue * (1 - highlightAlpha) + highlightBlue * highlightAlpha;
      }

      // Se redondea aca y no en el Uint8ClampedArray, que lleva los medios al par.
      output[offset] = toByte(red);
      output[offset + 1] = toByte(green);
      output[offset + 2] = toByte(blue);
      output[offset + 3] = 255;
      offset += 4;
    }
  }
  return output;
}
