// Dibujo con canvas 2D, para cuando el navegador no da WebGL2.
//
// Usa la composicion de referencia (`composeScene`) tal cual: arma la imagen
// a su tamano en un canvas aparte y la copia al visor sin suavizado, en el
// rectangulo que le toca. El resultado es el mismo que el de WebGL2.
//
// `ImageData` dibuja la primera fila arriba y el plano empieza por el sur, asi
// que la composicion se pide con las filas del norte primero.

import { toCssHex } from "./colors";
import { composeScene, type Scene, sameScene, sceneError, sceneSize } from "./compose";
import type { PlaneImage } from "./planeImage";
import type { Frame, PixelSnapshot, SceneRenderer } from "./renderer";
import { backingStoreSize, imageScreenRect } from "./view";

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
    target.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
    // Sin suavizado: cada pixel del plano es un cuadrado, como con NEAREST.
    target.imageSmoothingEnabled = false;
    const rect = imageScreenRect(frame.transform, image);
    target.drawImage(source, rect.left, rect.top, rect.width, rect.height);
    target.setTransform(1, 0, 0, 1, 0, 0);
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
  }

  return {
    info: { kind: "canvas2d", version: null, shadingLanguageVersion: null, gpu: null },
    draw,
    readPixels,
    forget,
    dispose,
  };
}
