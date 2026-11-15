// Interfaz comun de los dos dibujos del visor: WebGL2 (webglRenderer.ts) y
// canvas 2D (canvas2dRenderer.ts). Los dos reciben lo mismo y tienen que
// mostrar lo mismo; la definicion de "lo mismo" es `composeScene`.

import { createCanvas2dRenderer } from "./canvas2dRenderer";
import type { Scene } from "./compose";
import type { PlaneImage } from "./planeImage";
import type { ViewportSize, ViewTransform } from "./view";
import { createWebglRenderer } from "./webglRenderer";

export type RendererKind = "webgl2" | "canvas2d";

/** Con que se esta dibujando, para mostrarlo o registrarlo. */
export interface RendererInfo {
  readonly kind: RendererKind;
  /** `gl.VERSION`, por ejemplo "WebGL 2.0 (OpenGL ES 3.0 Chromium)". null con canvas 2D. */
  readonly version: string | null;
  /** `gl.SHADING_LANGUAGE_VERSION`. null con canvas 2D. */
  readonly shadingLanguageVersion: string | null;
  /** Placa y controlador, si el navegador los informa (WEBGL_debug_renderer_info). */
  readonly gpu: string | null;
}

/** Un cuadro: que se dibuja y donde. */
export interface Frame {
  /** null deja el canvas transparente: se ve el fondo de la pagina. */
  readonly scene: Scene | null;
  /** Transformacion de imagen a pantalla, en pixeles CSS. */
  readonly transform: ViewTransform;
  /** Tamano del visor en pixeles CSS. */
  readonly viewport: ViewportSize;
  /** Densidad de pixeles de la pantalla (`devicePixelRatio`). */
  readonly pixelRatio: number;
}

/** Lo que hay dibujado, en pixeles fisicos. */
export interface PixelSnapshot {
  readonly width: number;
  readonly height: number;
  /** RGBA fila por fila desde la fila de abajo, como `readPixels` de WebGL. */
  readonly data: Uint8Array;
}

export interface SceneRenderer {
  readonly info: RendererInfo;
  /**
   * Dibuja un cuadro. Ajusta el tamano del canvas a `viewport` y `pixelRatio`
   * si cambio. Lanza `RangeError` si la escena no es valida (`sceneSize`);
   * antes deja el canvas limpio, como con `scene: null`, para que no quede a la
   * vista el cuadro anterior.
   */
  draw(frame: Frame): void;
  /**
   * Vuelve a dibujar el ultimo cuadro y devuelve sus pixeles. null si todavia
   * no se dibujo nada o si el contexto se perdio. No lanza: despues de una
   * escena que no era valida, el ultimo cuadro es el canvas limpio.
   */
  readPixels(): PixelSnapshot | null;
  /**
   * Suelta lo que se guardo para un plano (sus texturas). Hace falta llamarlo
   * solo para liberar memoria antes de tiempo: lo que no se usa se descarta
   * solo al pasar el tope de planos guardados.
   */
  forget(plane: PlaneImage): void;
  /** Libera todo. Despues de esto el objeto no se usa mas. */
  dispose(): void;
}

export interface RendererOptions {
  /** Planos cuyas texturas se guardan a la vez. Por defecto 32: un cubo tiene hasta 24. */
  readonly maxPlanes?: number;
  /** Se llama cuando el navegador quita el contexto de WebGL. */
  readonly onContextLost?: () => void;
  /** Se llama cuando el contexto vuelve; el ultimo cuadro ya se dibujo de nuevo. */
  readonly onContextRestored?: () => void;
}

/**
 * Crea el dibujo para un canvas. Con `webgl2` intenta WebGL2 y, si el
 * navegador no lo da, canvas 2D sobre el mismo canvas. Devuelve null si no se
 * pudo crear ninguno; pasa cuando el canvas ya tiene un contexto de otro tipo,
 * y entonces hay que probar con un canvas nuevo.
 */
export function createRenderer(
  canvas: HTMLCanvasElement,
  prefer: RendererKind = "webgl2",
  options: RendererOptions = {},
): SceneRenderer | null {
  if (prefer === "webgl2") {
    const webgl = createWebglRenderer(canvas, options);
    if (webgl !== null) return webgl;
  }
  return createCanvas2dRenderer(canvas);
}
