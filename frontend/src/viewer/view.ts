// Vista del visor: encuadre, acercamiento y desplazamiento. Funciones puras.
//
// Dos sistemas de coordenadas:
//
// - Imagen: los pixeles del contrato (docs/contrato-cubo.md, seccion 2).
//   Enteros desde 0 en el centro del primer pixel; `x` crece hacia el oeste y
//   `y` hacia el norte. La imagen ocupa de -0,5 a nx - 0,5 y de -0,5 a ny - 0,5.
//   Son las mismas coordenadas que devuelve `/track` y que usa lib/wcs.ts.
// - Pantalla: pixeles CSS desde la esquina superior izquierda del visor; `x`
//   crece a la derecha e `y` hacia abajo.
//
// La imagen se dibuja con el norte arriba y el este a la izquierda sin
// invertir nada: `x` de imagen va a la derecha e `y` de imagen va hacia arriba.

import { fieldFovForView } from "@/lib/fov";
import type { ImageSize } from "./compose";

/** Tamano del visor en pixeles CSS. */
export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Lo que la persona eligio mirar. No depende del tamano de la ventana. */
export interface ViewState {
  /** Pixel de imagen que queda en el centro del visor. */
  readonly centerX: number;
  readonly centerY: number;
  /** Acercamiento respecto del encuadre: con 1 la imagen entera entra justa. */
  readonly zoom: number;
}

/**
 * Transformacion vigente entre imagen y pantalla:
 *
 *   pantalla.x = originX + imagen.x * scale
 *   pantalla.y = originY - imagen.y * scale
 */
export interface ViewTransform {
  /** Pixeles CSS por pixel de imagen. */
  readonly scale: number;
  /** Posicion en pantalla del centro del pixel (0, 0), la esquina sudeste. */
  readonly originX: number;
  readonly originY: number;
}

/** Con 1 se ve el cubo entero; no se aleja mas que eso. */
export const MIN_ZOOM = 1;

/** Acercamiento maximo: en el cubo base quedan unos 12 pixeles de lado en pantalla. */
export const MAX_ZOOM = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Pixeles CSS por pixel de imagen con los que la imagen entera entra justa en
 * el visor. Con un visor sin tamano devuelve 1, para que nada divida por cero.
 */
export function fitScale(image: ImageSize, viewport: ViewportSize): number {
  if (!(viewport.width > 0) || !(viewport.height > 0) || image.width <= 0 || image.height <= 0) {
    return 1;
  }
  return Math.min(viewport.width / image.width, viewport.height / image.height);
}

/** Vista de partida: centrada, con el acercamiento pedido. */
export function homeView(image: ImageSize, zoom = MIN_ZOOM): ViewState {
  return {
    centerX: (image.width - 1) / 2,
    centerY: (image.height - 1) / 2,
    zoom: clamp(zoom, MIN_ZOOM, MAX_ZOOM),
  };
}

/**
 * Acercamiento de partida para una vista de la interfaz (lib/fov.ts). La de
 * 5' es el cubo base con acercamiento 2; las de 10' y 30' encuadran su cubo
 * entero. Es la relacion entre el lado del cubo y el de la vista, redondeada
 * al centesimo porque los grados vienen con 4 decimales (0,1667 / 0,0833).
 */
export function homeZoomForViewFov(viewFov: number): number {
  if (!(viewFov > 0)) return MIN_ZOOM;
  const ratio = Math.round((fieldFovForView(viewFov) / viewFov) * 100) / 100;
  return clamp(ratio, MIN_ZOOM, MAX_ZOOM);
}

/** Centro permitido en un eje: el visor no muestra mas afuera de la imagen de lo necesario. */
function clampCenter(center: number, size: number, viewportSize: number, scale: number): number {
  const middle = (size - 1) / 2;
  const half = viewportSize / (2 * scale);
  const min = -0.5 + half;
  const max = size - 0.5 - half;
  // Si el visor ve mas que la imagen en este eje, queda centrada.
  if (!(min < max)) return middle;
  return clamp(Number.isFinite(center) ? center : middle, min, max);
}

/**
 * Lleva una vista a sus limites: acercamiento entre `MIN_ZOOM` y `MAX_ZOOM`, y
 * el centro donde la imagen siga cubriendo el visor. Con acercamiento 1 no
 * hay desplazamiento posible.
 */
export function clampView(view: ViewState, image: ImageSize, viewport: ViewportSize): ViewState {
  const zoom = clamp(Number.isFinite(view.zoom) ? view.zoom : MIN_ZOOM, MIN_ZOOM, MAX_ZOOM);
  const scale = fitScale(image, viewport) * zoom;
  return {
    centerX: clampCenter(view.centerX, image.width, viewport.width, scale),
    centerY: clampCenter(view.centerY, image.height, viewport.height, scale),
    zoom,
  };
}

/** Transformacion de una vista para un tamano de visor. */
export function viewTransform(
  view: ViewState,
  image: ImageSize,
  viewport: ViewportSize,
): ViewTransform {
  const scale = fitScale(image, viewport) * view.zoom;
  return {
    scale,
    originX: viewport.width / 2 - view.centerX * scale,
    originY: viewport.height / 2 + view.centerY * scale,
  };
}

/** De pixel de imagen (admite fracciones) a pixel CSS de pantalla. */
export function imageToScreen(transform: ViewTransform, x: number, y: number): Point {
  return {
    x: transform.originX + x * transform.scale,
    y: transform.originY - y * transform.scale,
  };
}

/** De pixel CSS de pantalla a pixel de imagen, con fracciones. */
export function screenToImage(transform: ViewTransform, x: number, y: number): Point {
  return {
    x: (x - transform.originX) / transform.scale,
    y: (transform.originY - y) / transform.scale,
  };
}

/**
 * Matriz para el atributo `transform` de un grupo SVG: lo que se dibuje
 * adentro va en pixeles de imagen. Los trazos tambien escalan; para un grosor
 * fijo en pantalla, usar `vector-effect: non-scaling-stroke` o `imageToScreen`.
 */
export function svgTransform(transform: ViewTransform): string {
  const { scale, originX, originY } = transform;
  return `matrix(${scale} 0 0 ${-scale} ${originX} ${originY})`;
}

export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Rectangulo que ocupa la imagen entera en pantalla, en pixeles CSS. */
export function imageScreenRect(transform: ViewTransform, image: ImageSize): ScreenRect {
  const { scale, originX, originY } = transform;
  return {
    left: originX - 0.5 * scale,
    top: originY - (image.height - 0.5) * scale,
    width: image.width * scale,
    height: image.height * scale,
  };
}

/**
 * Rectangulo de la imagen en coordenadas de recorte de WebGL (de -1 a 1, con
 * `y` hacia arriba): `[x0, y0, x1, y1]`, donde (x0, y0) es la esquina sudeste
 * de la imagen (fila 0, columna 0) y (x1, y1) la noroeste.
 */
export function imageClipRect(
  transform: ViewTransform,
  image: ImageSize,
  viewport: ViewportSize,
): readonly [x0: number, y0: number, x1: number, y1: number] {
  const rect = imageScreenRect(transform, image);
  const width = viewport.width > 0 ? viewport.width : 1;
  const height = viewport.height > 0 ? viewport.height : 1;
  return [
    (rect.left / width) * 2 - 1,
    1 - ((rect.top + rect.height) / height) * 2,
    ((rect.left + rect.width) / width) * 2 - 1,
    1 - (rect.top / height) * 2,
  ];
}

/**
 * Acerca o aleja por un factor dejando quieto el punto de la imagen que esta
 * bajo `anchor` (el cursor, o el punto medio de un pellizco), en pixeles de
 * pantalla. Si el acercamiento ya esta en su limite, la vista no cambia.
 */
export function zoomAround(
  view: ViewState,
  image: ImageSize,
  viewport: ViewportSize,
  factor: number,
  anchor: Point,
): ViewState {
  if (!(factor > 0) || !Number.isFinite(factor)) return view;
  const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  const under = screenToImage(viewTransform(view, image, viewport), anchor.x, anchor.y);
  const scale = fitScale(image, viewport) * zoom;
  return clampView(
    {
      centerX: under.x - (anchor.x - viewport.width / 2) / scale,
      centerY: under.y + (anchor.y - viewport.height / 2) / scale,
      zoom,
    },
    image,
    viewport,
  );
}

/** Acerca o aleja alrededor del centro del visor. */
export function zoomAtCenter(
  view: ViewState,
  image: ImageSize,
  viewport: ViewportSize,
  factor: number,
): ViewState {
  return zoomAround(view, image, viewport, factor, {
    x: viewport.width / 2,
    y: viewport.height / 2,
  });
}

/**
 * Desplaza la vista como un arrastre: la imagen se mueve `dx` pixeles de
 * pantalla a la derecha y `dy` hacia abajo.
 */
export function panByScreen(
  view: ViewState,
  image: ImageSize,
  viewport: ViewportSize,
  dx: number,
  dy: number,
): ViewState {
  const scale = fitScale(image, viewport) * view.zoom;
  return clampView(
    { centerX: view.centerX - dx / scale, centerY: view.centerY + dy / scale, zoom: view.zoom },
    image,
    viewport,
  );
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Pellizco con dos dedos: `before` y `after` son las posiciones en pantalla de
 * los dos punteros antes y despues del movimiento. Acerca segun cuanto se
 * separaron y desplaza segun cuanto se movio su punto medio.
 */
export function pinchView(
  view: ViewState,
  image: ImageSize,
  viewport: ViewportSize,
  before: readonly [Point, Point],
  after: readonly [Point, Point],
): ViewState {
  const startDistance = distance(before[0], before[1]);
  const factor = startDistance > 0 ? distance(after[0], after[1]) / startDistance : 1;
  const from = midpoint(before[0], before[1]);
  const to = midpoint(after[0], after[1]);
  const zoomed = zoomAround(view, image, viewport, factor > 0 ? factor : 1, from);
  return panByScreen(zoomed, image, viewport, to.x - from.x, to.y - from.y);
}

// ---- Rueda ---------------------------------------------------------------

/** Lo que hace falta de un `WheelEvent`. */
export interface WheelInput {
  readonly deltaY: number;
  /** 0 pixeles, 1 lineas, 2 paginas (`WheelEvent.deltaMode`). */
  readonly deltaMode: number;
  /** Los paneles tactiles mandan el pellizco como rueda con Control apretado. */
  readonly ctrlKey: boolean;
}

const WHEEL_LINE_PIXELS = 16;
const WHEEL_PAGE_PIXELS = 400;
const WHEEL_SPEED = 0.002;
const WHEEL_PINCH_SPEED = 0.01;
const WHEEL_MAX_STEP = 2;

/**
 * Factor de acercamiento de un movimiento de rueda: hacia arriba acerca. Una
 * muesca de un mouse comun (100 pixeles) cambia el acercamiento un 22 %. Un
 * solo evento nunca pasa del doble ni de la mitad.
 */
export function wheelZoomFactor(input: WheelInput): number {
  const unit =
    input.deltaMode === 1 ? WHEEL_LINE_PIXELS : input.deltaMode === 2 ? WHEEL_PAGE_PIXELS : 1;
  const speed = input.ctrlKey ? WHEEL_PINCH_SPEED : WHEEL_SPEED;
  const factor = Math.exp(-input.deltaY * unit * speed);
  if (!Number.isFinite(factor)) return input.deltaY > 0 ? 1 / WHEEL_MAX_STEP : WHEEL_MAX_STEP;
  return clamp(factor, 1 / WHEEL_MAX_STEP, WHEEL_MAX_STEP);
}

// ---- Teclado -------------------------------------------------------------

/** Accion sobre la vista que pide una tecla. */
export type ViewAction =
  | {
      readonly type: "pan";
      /** Desplazamiento de la mirada, en fracciones del lado menor del visor. */
      readonly right: number;
      readonly up: number;
    }
  | { readonly type: "zoom"; readonly factor: number }
  | { readonly type: "reset" };

/** Paso de las flechas: un octavo del lado menor del visor. Con Mayusculas, la mitad. */
export const KEY_PAN_STEP = 0.125;
export const KEY_PAN_STEP_LARGE = 0.5;

/** Paso de las teclas de acercamiento. */
export const KEY_ZOOM_STEP = 1.25;

/**
 * Accion de una tecla (`KeyboardEvent.key`), o null si el visor no la usa.
 *
 *   flechas       desplazan la mirada; con Mayusculas, mas lejos
 *   + o =         acerca
 *   - o _         aleja
 *   0 o Inicio    vuelve a la vista de partida
 */
export function viewActionForKey(key: string, shiftKey = false): ViewAction | null {
  const step = shiftKey ? KEY_PAN_STEP_LARGE : KEY_PAN_STEP;
  switch (key) {
    case "ArrowLeft":
      return { type: "pan", right: -step, up: 0 };
    case "ArrowRight":
      return { type: "pan", right: step, up: 0 };
    case "ArrowUp":
      return { type: "pan", right: 0, up: step };
    case "ArrowDown":
      return { type: "pan", right: 0, up: -step };
    case "+":
    case "=":
      return { type: "zoom", factor: KEY_ZOOM_STEP };
    case "-":
    case "_":
      return { type: "zoom", factor: 1 / KEY_ZOOM_STEP };
    case "0":
    case "Home":
      return { type: "reset" };
    default:
      return null;
  }
}

/** Aplica una accion de teclado. `home` es la vista a la que vuelve `reset`. */
export function applyViewAction(
  view: ViewState,
  image: ImageSize,
  viewport: ViewportSize,
  action: ViewAction,
  home: ViewState,
): ViewState {
  switch (action.type) {
    case "pan": {
      // Mirar a la derecha es mover la imagen a la izquierda.
      const side = Math.min(viewport.width, viewport.height);
      return panByScreen(view, image, viewport, -action.right * side, action.up * side);
    }
    case "zoom":
      return zoomAtCenter(view, image, viewport, action.factor);
    default:
      return clampView(home, image, viewport);
  }
}

// ---- Densidad de pixeles -------------------------------------------------

/** Lado maximo del canvas en pixeles fisicos. */
export const MAX_BACKING_SIDE = 4096;

/**
 * Tamano del canvas en pixeles fisicos para un visor en pixeles CSS y una
 * densidad de pantalla (`devicePixelRatio`). Nunca menos de 1 ni mas de
 * `maxSide` por lado.
 */
export function backingStoreSize(
  viewport: ViewportSize,
  pixelRatio: number,
  maxSide = MAX_BACKING_SIDE,
): ViewportSize {
  const ratio = pixelRatio > 0 && Number.isFinite(pixelRatio) ? pixelRatio : 1;
  const side = (css: number): number => {
    const pixels = Number.isFinite(css) ? Math.round(css * ratio) : 0;
    return clamp(pixels, 1, maxSide);
  };
  return { width: side(viewport.width), height: side(viewport.height) };
}
