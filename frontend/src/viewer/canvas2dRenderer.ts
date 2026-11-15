// Dibujo con canvas 2D, para cuando el navegador no da WebGL2.
//
// Usa la composicion de referencia (`composeScene`) tal cual: arma la imagen
// a su tamano en un canvas aparte y la copia al visor sin suavizado, en el
// rectangulo que le toca. El resultado es el mismo que el de WebGL2.
//
// `ImageData` dibuja la primera fila arriba y el plano empieza por el sur, asi
// que la composicion se pide con las filas del norte primero.
//
// La trama del resaltado (`highlight.alternate`, la capa de flags) va en
// pixeles de pantalla y no entra en esa composicion. Se arma en un tercer
// canvas, del tamano del visor: se lo llena con la trama (`hatchBand`) y se
// deja solo lo que cae sobre los pixeles marcados, ampliando la mascara igual
// que la imagen. El resultado se copia encima.

import { type Rgb, toCssHex } from "./colors";
import {
  composeScene,
  hatchBand,
  hatchStripe,
  type ImageSize,
  type Scene,
  type SceneHighlight,
  sameScene,
  sceneError,
  sceneHatch,
  sceneSize,
} from "./compose";
import type { PlaneImage } from "./planeImage";
import type { Frame, PixelSnapshot, SceneRenderer } from "./renderer";
import { toByte } from "./stretch";
import { backingStoreSize, imageScreenRect, type ScreenRect } from "./view";

export interface Canvas2dOptions {
  /**
   * Pide el contexto preparado para leer pixeles muchas veces seguidas
   * (`willReadFrequently`). Hace falta solo si se va a llamar a `readPixels`
   * una y otra vez, como en la comparacion de la pagina de desarrollo: sin
   * esto el navegador deja un aviso en la consola. El visor no lo necesita.
   */
  readonly willReadFrequently?: boolean;
}

/**
 * Crea el dibujo con canvas 2D. Devuelve null si el canvas no da un contexto
 * 2D, que es lo que pasa cuando ya tiene uno de WebGL.
 */
export function createCanvas2dRenderer(
  canvas: HTMLCanvasElement,
  options: Canvas2dOptions = {},
): SceneRenderer | null {
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = options.willReadFrequently
      ? canvas.getContext("2d", { willReadFrequently: true })
      : canvas.getContext("2d");
  } catch {
    context = null;
  }
  if (context === null) return null;
  const target = context;

  /** Canvas aparte con la imagen compuesta, a su tamano, y la escena que tiene dibujada. */
  let buffer: HTMLCanvasElement | null = null;
  let composed: Scene | null = null;
  let lastFrame: Frame | null = null;
  let disposed = false;

  /** Mascara de la trama como imagen: opaca donde marca, a tamano de imagen. Y de que mascara salio. */
  let maskCanvas: HTMLCanvasElement | null = null;
  let maskSource: Uint8Array | null = null;
  /** Baldosa que se repite para llenar con la trama, y con que se armo. */
  let tileCanvas: HTMLCanvasElement | null = null;
  let tileKey = "";
  /** Canvas del tamano del visor donde se recorta la trama. */
  let hatchCanvas: HTMLCanvasElement | null = null;

  /** La mascara del resaltado como imagen, con el norte en la primera fila. */
  function hatchMask(mask: Uint8Array, image: ImageSize): HTMLCanvasElement | null {
    const { width, height } = image;
    if (
      maskCanvas !== null &&
      maskSource === mask &&
      maskCanvas.width === width &&
      maskCanvas.height === height
    ) {
      return maskCanvas;
    }
    maskCanvas ??= canvas.ownerDocument.createElement("canvas");
    if (maskCanvas.width !== width) maskCanvas.width = width;
    if (maskCanvas.height !== height) maskCanvas.height = height;
    const context = maskCanvas.getContext("2d");
    if (context === null) return null;
    const pixels = context.createImageData(width, height);
    for (let row = 0; row < height; row += 1) {
      const offset = (height - 1 - row) * width * 4;
      for (let column = 0; column < width; column += 1) {
        // Solo importa la opacidad: es lo que recorta la trama.
        if (mask[row * width + column] !== 0) pixels.data[offset + column * 4 + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
    maskSource = mask;
    return maskCanvas;
  }

  /** Baldosa de la trama: un cuadrado de dos franjas de lado que, repetido, da `hatchBand`. */
  function hatchTile(stripe: number, color: Rgb, alternate: Rgb): HTMLCanvasElement | null {
    const key = `${stripe}|${color.join(",")}|${alternate.join(",")}`;
    if (tileCanvas !== null && tileKey === key) return tileCanvas;
    const side = 2 * stripe;
    tileCanvas ??= canvas.ownerDocument.createElement("canvas");
    if (tileCanvas.width !== side) tileCanvas.width = side;
    if (tileCanvas.height !== side) tileCanvas.height = side;
    const context = tileCanvas.getContext("2d");
    if (context === null) return null;
    const pixels = context.createImageData(side, side);
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const [red, green, blue] = hatchBand(x, y, stripe) === 0 ? color : alternate;
        const offset = (y * side + x) * 4;
        pixels.data[offset] = toByte(red);
        pixels.data[offset + 1] = toByte(green);
        pixels.data[offset + 2] = toByte(blue);
        pixels.data[offset + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
    tileKey = key;
    return tileCanvas;
  }

  /**
   * Dibuja la trama sobre los pixeles marcados. `rect` es el rectangulo de la
   * imagen en pixeles CSS y `scaleX`, `scaleY` llevan de pixeles CSS a fisicos.
   */
  function drawHatch(
    hatch: SceneHighlight & { readonly alternate: Rgb },
    image: ImageSize,
    rect: ScreenRect,
    scaleX: number,
    scaleY: number,
  ): void {
    const mask = hatchMask(hatch.mask, image);
    const [red, green, blue] = hatch.color;
    const tile = hatchTile(hatchStripe(scaleX), [red, green, blue], hatch.alternate);
    if (mask === null || tile === null) return;

    hatchCanvas ??= canvas.ownerDocument.createElement("canvas");
    if (hatchCanvas.width !== canvas.width) hatchCanvas.width = canvas.width;
    if (hatchCanvas.height !== canvas.height) hatchCanvas.height = canvas.height;
    const layer = hatchCanvas.getContext("2d");
    if (layer === null) return;
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.globalCompositeOperation = "source-over";
    layer.clearRect(0, 0, hatchCanvas.width, hatchCanvas.height);
    // La trama se cuenta desde la esquina del canvas, en pixeles fisicos.
    const pattern = layer.createPattern(tile, "repeat");
    if (pattern === null) return;
    layer.fillStyle = pattern;
    layer.fillRect(0, 0, hatchCanvas.width, hatchCanvas.height);
    // Queda solo lo que cae sobre un pixel marcado; lo demas se vuelve transparente.
    layer.globalCompositeOperation = "destination-in";
    layer.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    layer.imageSmoothingEnabled = false;
    layer.drawImage(mask, rect.left, rect.top, rect.width, rect.height);
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.globalCompositeOperation = "source-over";

    target.drawImage(hatchCanvas, 0, 0, hatchCanvas.width, hatchCanvas.height);
  }

  /** Compone la escena, o devuelve la imagen guardada si es la misma. */
  function compose(scene: Scene): HTMLCanvasElement | null {
    if (buffer !== null && composed !== null && sameScene(composed, scene)) return buffer;
    const { width, height } = sceneSize(scene);
    buffer ??= canvas.ownerDocument.createElement("canvas");
    if (buffer.width !== width) buffer.width = width;
    if (buffer.height !== height) buffer.height = height;
    const bufferContext = buffer.getContext("2d");
    if (bufferContext === null) return null;
    const pixels = bufferContext.createImageData(width, height);
    pixels.data.set(composeScene(scene, { rowOrder: "north-first" }));
    bufferContext.putImageData(pixels, 0, 0);
    composed = scene;
    return buffer;
  }

  function draw(frame: Frame): void {
    if (disposed) return;
    // Una escena que no es valida no se dibuja ni se recuerda: se limpia el
    // canvas, para que no quede a la vista el cuadro anterior, y se avisa.
    const invalid = sceneError(frame.scene);
    const shown = invalid === null ? frame : { ...frame, scene: null };
    lastFrame = shown;
    paint(shown);
    if (invalid !== null) throw invalid;
  }

  /** Dibuja un cuadro cuya escena ya se sabe valida. */
  function paint(frame: Frame): void {
    const size = backingStoreSize(frame.viewport, frame.pixelRatio);
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;

    target.setTransform(1, 0, 0, 1, 0, 0);
    target.clearRect(0, 0, canvas.width, canvas.height);
    const scene = frame.scene;
    if (scene === null) return;

    const image = sceneSize(scene);
    target.fillStyle = toCssHex(scene.noDataColor);
    target.fillRect(0, 0, canvas.width, canvas.height);

    const source = compose(scene);
    if (source === null) return;
    // De pixeles CSS a pixeles fisicos.
    const width = frame.viewport.width > 0 ? frame.viewport.width : 1;
    const height = frame.viewport.height > 0 ? frame.viewport.height : 1;
    const scaleX = canvas.width / width;
    const scaleY = canvas.height / height;
    target.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    // Sin suavizado: cada pixel del plano es un cuadrado, como con NEAREST.
    target.imageSmoothingEnabled = false;
    const rect = imageScreenRect(frame.transform, image);
    target.drawImage(source, rect.left, rect.top, rect.width, rect.height);
    target.setTransform(1, 0, 0, 1, 0, 0);

    const hatch = sceneHatch(scene);
    if (hatch !== null) drawHatch(hatch, image, rect, scaleX, scaleY);
  }

  function readPixels(): PixelSnapshot | null {
    if (disposed || lastFrame === null) return null;
    paint(lastFrame);
    const { width, height } = canvas;
    const topDown = target.getImageData(0, 0, width, height).data;
    // Mismo orden que readPixels de WebGL: la fila de abajo primero.
    const data = new Uint8Array(topDown.length);
    const rowBytes = width * 4;
    for (let row = 0; row < height; row += 1) {
      const from = (height - 1 - row) * rowBytes;
      data.set(topDown.subarray(from, from + rowBytes), row * rowBytes);
    }
    return { width, height, data };
  }

  function forget(plane: PlaneImage): void {
    // No guarda nada por plano: solo la ultima escena compuesta.
    if (composed?.planes.includes(plane)) composed = null;
  }

  function dispose(): void {
    disposed = true;
    buffer = null;
    composed = null;
    lastFrame = null;
    maskCanvas = null;
    maskSource = null;
    tileCanvas = null;
    hatchCanvas = null;
  }

  return {
    info: { kind: "canvas2d", version: null, shadingLanguageVersion: null, gpu: null },
    draw,
    readPixels,
    forget,
    dispose,
  };
}
