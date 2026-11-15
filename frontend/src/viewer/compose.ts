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

/**
 * Capa de resaltado: una mascara que se dibuja encima con un color o, con
 * `alternate`, con una trama diagonal de dos colores.
 */
export interface SceneHighlight {
  /** Un byte por pixel, en el mismo orden que el plano: distinto de 0 resalta. */
  readonly mask: Uint8Array;
  /** Color del resaltado. El alfa dice cuanto tapa lo que hay debajo. */
  readonly color: Rgba;
  /**
   * Segundo color. Si viene, el resaltado no es un color liso sino una trama
   * diagonal que alterna `color` y `alternate`, los dos opacos (del alfa de
   * `color` solo importa que sea mayor que 0). Es la capa de flags de
   * DESIGN.md ("Sobre la imagen"): con `{colors.text}` y `{colors.void}` se
   * distingue sobre cielo oscuro y sobre una estrella.
   *
   * La trama se mide en pixeles de pantalla, no de imagen (`hatchBand`): un
   * pixel marcado suelto muestra los dos colores con cualquier acercamiento.
   * Por eso no entra en `composeScene`, que trabaja en la grilla del plano.
   */
  readonly alternate?: Rgb | null | undefined;
}

/** Ancho de cada franja de la trama, en pixeles CSS (DESIGN.md: trama diagonal de 1 px). */
export const HATCH_STRIPE_CSS_PX = 1;

/**
 * Ancho de una franja de la trama en pixeles fisicos del canvas, para una
 * densidad (pixeles fisicos por pixel CSS). Nunca menos de 1.
 */
export function hatchStripe(pixelRatio: number): number {
  const ratio = pixelRatio > 0 && Number.isFinite(pixelRatio) ? pixelRatio : 1;
  return Math.max(1, Math.round(ratio * HATCH_STRIPE_CSS_PX));
}

/**
 * Franja de la trama que le toca a un pixel fisico del canvas: 0 lleva `color`
 * y 1 lleva `alternate`. `x` crece a la derecha e `y` hacia abajo, desde la
 * esquina superior izquierda del canvas. Las franjas suben hacia la derecha.
 *
 * Es la definicion de la trama: el shader de webglRenderer.ts y el dibujo de
 * canvas2dRenderer.ts hacen esta misma cuenta, y la pagina de desarrollo los
 * compara con ella.
 */
export function hatchBand(x: number, y: number, stripe: number): 0 | 1 {
  return Math.floor((x + y) / stripe) % 2 === 0 ? 0 : 1;
}

/** Dice si el resaltado de la escena es una trama: tiene `alternate` y no es transparente. */
export function sceneHatch(scene: Scene): (SceneHighlight & { readonly alternate: Rgb }) | null {
  const highlight = scene.highlight ?? null;
  if (highlight === null || !highlight.alternate || !(highlight.color[3] > 0)) return null;
  return highlight as SceneHighlight & { readonly alternate: Rgb };
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
  const firstAlternate = first.alternate ?? null;
  const secondAlternate = second.alternate ?? null;
  if (firstAlternate === null || secondAlternate === null) {
    if (firstAlternate !== secondAlternate) return false;
  } else if (!sameColor(firstAlternate, secondAlternate)) {
    return false;
  }
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
 *
 * Un resaltado con trama (`highlight.alternate`) no se compone aca: va en
 * pixeles de pantalla y lo dibuja cada camino encima de esta imagen, segun
 * `hatchBand`.
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

  // La trama no se mezcla con la imagen: ver el comentario de la funcion.
  const highlight = sceneHatch(scene) === null ? (scene.highlight ?? null) : null;
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
