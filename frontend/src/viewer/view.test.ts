// @vitest-environment node
import { describe, expect, it } from "vitest";
import { VIEW_FOVS } from "@/lib/fov";
import {
  applyViewAction,
  backingStoreSize,
  clampView,
  fitScale,
  homeView,
  homeZoomForViewFov,
  imageClipRect,
  imageScreenRect,
  imageToScreen,
  KEY_PAN_STEP,
  KEY_PAN_STEP_LARGE,
  KEY_ZOOM_STEP,
  MAX_BACKING_SIDE,
  MAX_ZOOM,
  MIN_ZOOM,
  panByScreen,
  pinchView,
  screenToImage,
  svgTransform,
  type ViewState,
  viewActionForKey,
  viewTransform,
  wheelZoomFactor,
  zoomAround,
  zoomAtCenter,
} from "./view";

/** El cubo base: 195 x 195 pixeles. */
const IMAGE = { width: 195, height: 195 };
/** Un visor cuadrado donde cada pixel de imagen ocupa 4 de pantalla. */
const SQUARE = { width: 780, height: 780 };
/** Un visor apaisado: la altura es la que limita. */
const WIDE = { width: 1200, height: 780 };

const HOME = homeView(IMAGE);

describe("encuadre", () => {
  it("la imagen entera entra justa en el lado que limita", () => {
    expect(fitScale(IMAGE, SQUARE)).toBe(4);
    expect(fitScale(IMAGE, WIDE)).toBe(4);
    expect(fitScale(IMAGE, { width: 390, height: 1000 })).toBe(2);
    expect(fitScale({ width: 293, height: 293 }, { width: 586, height: 600 })).toBe(2);
  });

  it("un visor sin tamano no divide por cero", () => {
    expect(fitScale(IMAGE, { width: 0, height: 0 })).toBe(1);
    expect(fitScale(IMAGE, { width: Number.NaN, height: 100 })).toBe(1);
    expect(fitScale({ width: 0, height: 0 }, SQUARE)).toBe(1);
  });

  it("la vista de partida esta centrada", () => {
    expect(HOME).toEqual({ centerX: 97, centerY: 97, zoom: 1 });
    expect(homeView({ width: 4, height: 2 }, 2)).toEqual({ centerX: 1.5, centerY: 0.5, zoom: 2 });
    expect(homeView(IMAGE, 99).zoom).toBe(MAX_ZOOM);
    expect(homeView(IMAGE, 0.1).zoom).toBe(MIN_ZOOM);
  });

  it("la vista de 5 minutos es el cubo base con acercamiento 2; las de 10 y 30 encuadran el cubo", () => {
    const [five, ten, thirty] = VIEW_FOVS;
    expect(homeZoomForViewFov(five)).toBe(2);
    expect(homeZoomForViewFov(ten)).toBe(1);
    expect(homeZoomForViewFov(thirty)).toBe(1);
    expect(homeZoomForViewFov(0)).toBe(1);
    expect(homeZoomForViewFov(Number.NaN)).toBe(1);
  });
});

describe("de imagen a pantalla", () => {
  const transform = viewTransform(HOME, IMAGE, SQUARE);

  it("el centro de la imagen cae en el centro del visor", () => {
    expect(transform.scale).toBe(4);
    expect(imageToScreen(transform, 97, 97)).toEqual({ x: 390, y: 390 });
  });

  it("el este (columna 0) queda a la izquierda y el oeste a la derecha", () => {
    expect(imageToScreen(transform, 0, 97).x).toBe(2);
    expect(imageToScreen(transform, 194, 97).x).toBe(778);
    // Los bordes de la imagen coinciden con los del visor.
    expect(imageToScreen(transform, -0.5, 97).x).toBe(0);
    expect(imageToScreen(transform, 194.5, 97).x).toBe(780);
  });

  it("el norte (fila mas alta) queda arriba y el sur (fila 0) abajo", () => {
    expect(imageToScreen(transform, 97, 194).y).toBe(2);
    expect(imageToScreen(transform, 97, 0).y).toBe(778);
    expect(imageToScreen(transform, 97, 194.5).y).toBe(0);
    expect(imageToScreen(transform, 97, -0.5).y).toBe(780);
  });

  it("de pantalla a imagen es la inversa", () => {
    const zoomed = viewTransform({ centerX: 60.25, centerY: 130.5, zoom: 3.7 }, IMAGE, WIDE);
    for (const [x, y] of [
      [0, 0],
      [97.3, 96],
      [194, 12.75],
    ] as const) {
      const screen = imageToScreen(zoomed, x, y);
      const back = screenToImage(zoomed, screen.x, screen.y);
      expect(back.x).toBeCloseTo(x, 10);
      expect(back.y).toBeCloseTo(y, 10);
    }
    expect(screenToImage(transform, 390, 390)).toEqual({ x: 97, y: 97 });
  });

  it("en un visor apaisado la imagen queda centrada con margen a los costados", () => {
    const wide = viewTransform(HOME, IMAGE, WIDE);
    expect(imageScreenRect(wide, IMAGE)).toEqual({ left: 210, top: 0, width: 780, height: 780 });
    expect(imageScreenRect(transform, IMAGE)).toEqual({ left: 0, top: 0, width: 780, height: 780 });
  });

  it("con acercamiento 2 se ve la mitad central", () => {
    const zoomed = viewTransform(homeView(IMAGE, 2), IMAGE, SQUARE);
    expect(zoomed.scale).toBe(8);
    expect(imageScreenRect(zoomed, IMAGE)).toEqual({
      left: -390,
      top: -390,
      width: 1560,
      height: 1560,
    });
    expect(screenToImage(zoomed, 0, 780)).toEqual({ x: 48.25, y: 48.25 });
  });

  it("da el rectangulo de la imagen en coordenadas de recorte de WebGL", () => {
    expect(imageClipRect(transform, IMAGE, SQUARE)).toEqual([-1, -1, 1, 1]);
    const [x0, y0, x1, y1] = imageClipRect(viewTransform(HOME, IMAGE, WIDE), IMAGE, WIDE);
    expect(x0).toBeCloseTo(-0.65, 12);
    expect(x1).toBeCloseTo(0.65, 12);
    expect(y0).toBe(-1);
    expect(y1).toBe(1);
    expect(imageClipRect(viewTransform(homeView(IMAGE, 2), IMAGE, SQUARE), IMAGE, SQUARE)).toEqual([
      -2, -2, 2, 2,
    ]);
  });

  it("da la matriz para dibujar con SVG en pixeles de imagen", () => {
    expect(svgTransform(transform)).toBe("matrix(4 0 0 -4 2 778)");
  });
});

describe("limites de la vista", () => {
  it("con acercamiento 1 no hay desplazamiento: la imagen queda centrada", () => {
    expect(clampView({ centerX: 10, centerY: 180, zoom: 1 }, IMAGE, SQUARE)).toEqual(HOME);
    expect(clampView({ centerX: 10, centerY: 180, zoom: 1 }, IMAGE, WIDE)).toEqual(HOME);
  });

  it("acercado, el centro llega hasta donde el borde de la imagen toca el del visor", () => {
    // Con acercamiento 2 se ven 97,5 pixeles: el centro va de 48,25 a 145,75.
    const clamped = clampView({ centerX: -50, centerY: 500, zoom: 2 }, IMAGE, SQUARE);
    expect(clamped).toEqual({ centerX: 48.25, centerY: 145.75, zoom: 2 });
    // El borde este de la imagen toca el izquierdo del visor y el norte, el de arriba.
    const rect = imageScreenRect(viewTransform(clamped, IMAGE, SQUARE), IMAGE);
    expect(rect.left).toBe(0);
    expect(rect.top).toBe(0);
  });

  it("en el eje donde el visor ve mas que la imagen, queda centrada", () => {
    // Visor apaisado con acercamiento 1,2: a lo ancho entra toda, a lo alto no.
    const clamped = clampView({ centerX: 10, centerY: 10, zoom: 1.2 }, IMAGE, WIDE);
    expect(clamped.centerX).toBe(97);
    expect(clamped.centerY).toBeCloseTo(-0.5 + 780 / (2 * 4.8), 10);
  });

  it("el acercamiento queda entre el minimo y el maximo", () => {
    expect(clampView({ ...HOME, zoom: 0.2 }, IMAGE, SQUARE).zoom).toBe(MIN_ZOOM);
    expect(clampView({ ...HOME, zoom: 500 }, IMAGE, SQUARE).zoom).toBe(MAX_ZOOM);
    expect(clampView({ ...HOME, zoom: Number.NaN }, IMAGE, SQUARE).zoom).toBe(MIN_ZOOM);
  });

  it("un centro que no es un numero vuelve al medio", () => {
    expect(clampView({ centerX: Number.NaN, centerY: Number.NaN, zoom: 4 }, IMAGE, SQUARE)).toEqual(
      { centerX: 97, centerY: 97, zoom: 4 },
    );
  });
});

describe("acercamiento alrededor de un punto", () => {
  it("deja quieto el punto de la imagen que esta bajo el cursor", () => {
    const start: ViewState = { centerX: 97, centerY: 97, zoom: 4 };
    const anchor = { x: 300, y: 500 };
    const under = screenToImage(viewTransform(start, IMAGE, SQUARE), anchor.x, anchor.y);
    const zoomed = zoomAround(start, IMAGE, SQUARE, 1.5, anchor);
    expect(zoomed.zoom).toBe(6);
    const after = imageToScreen(viewTransform(zoomed, IMAGE, SQUARE), under.x, under.y);
    expect(after.x).toBeCloseTo(anchor.x, 9);
    expect(after.y).toBeCloseTo(anchor.y, 9);
  });

  it("acercar y alejar por el mismo factor vuelve a la misma vista", () => {
    const start: ViewState = { centerX: 80, centerY: 110, zoom: 4 };
    const anchor = { x: 200, y: 600 };
    const back = zoomAround(
      zoomAround(start, IMAGE, SQUARE, 2, anchor),
      IMAGE,
      SQUARE,
      0.5,
      anchor,
    );
    expect(back.centerX).toBeCloseTo(start.centerX, 9);
    expect(back.centerY).toBeCloseTo(start.centerY, 9);
    expect(back.zoom).toBeCloseTo(start.zoom, 12);
  });

  it("desde la vista de partida acerca hacia el cursor", () => {
    // Cursor en el cuarto superior izquierdo: nordeste de la imagen.
    const zoomed = zoomAround(HOME, IMAGE, SQUARE, 2, { x: 195, y: 195 });
    expect(zoomed.zoom).toBe(2);
    expect(zoomed.centerX).toBeLessThan(97);
    expect(zoomed.centerY).toBeGreaterThan(97);
  });

  it("no pasa de los limites, y en el limite la vista no se mueve", () => {
    const atMax: ViewState = { centerX: 60, centerY: 60, zoom: MAX_ZOOM };
    expect(zoomAround(atMax, IMAGE, SQUARE, 3, { x: 10, y: 10 })).toEqual(atMax);
    expect(zoomAround(HOME, IMAGE, SQUARE, 0.5, { x: 10, y: 10 })).toEqual(HOME);
  });

  it("ignora un factor que no sirve", () => {
    for (const factor of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(zoomAround(HOME, IMAGE, SQUARE, factor, { x: 1, y: 1 })).toBe(HOME);
    }
  });

  it("zoomAtCenter no mueve el centro", () => {
    const start: ViewState = { centerX: 80, centerY: 110, zoom: 4 };
    const zoomed = zoomAtCenter(start, IMAGE, SQUARE, 2);
    expect(zoomed).toEqual({ centerX: 80, centerY: 110, zoom: 8 });
  });
});

describe("desplazamiento", () => {
  const start: ViewState = { centerX: 97, centerY: 97, zoom: 4 };

  it("arrastrar a la derecha lleva la mirada hacia el este", () => {
    // Con acercamiento 4 hay 16 pixeles de pantalla por pixel de imagen.
    const moved = panByScreen(start, IMAGE, SQUARE, 32, 0);
    expect(moved).toEqual({ centerX: 95, centerY: 97, zoom: 4 });
  });

  it("arrastrar hacia abajo lleva la mirada hacia el norte", () => {
    const moved = panByScreen(start, IMAGE, SQUARE, 0, 32);
    expect(moved).toEqual({ centerX: 97, centerY: 99, zoom: 4 });
  });

  it("el punto agarrado sigue al puntero", () => {
    const grabbed = { x: 250, y: 410 };
    const under = screenToImage(viewTransform(start, IMAGE, SQUARE), grabbed.x, grabbed.y);
    const moved = panByScreen(start, IMAGE, SQUARE, 40, -25);
    const after = imageToScreen(viewTransform(moved, IMAGE, SQUARE), under.x, under.y);
    expect(after.x).toBeCloseTo(grabbed.x + 40, 9);
    expect(after.y).toBeCloseTo(grabbed.y - 25, 9);
  });

  it("no pasa del borde de la imagen", () => {
    const moved = panByScreen(start, IMAGE, SQUARE, 100000, -100000);
    const rect = imageScreenRect(viewTransform(moved, IMAGE, SQUARE), IMAGE);
    expect(rect.left).toBeCloseTo(0, 9);
    expect(rect.top + rect.height).toBeCloseTo(780, 9);
  });
});

describe("pellizco", () => {
  const start: ViewState = { centerX: 97, centerY: 97, zoom: 2 };

  it("separar los dedos al doble duplica el acercamiento y deja quieto el punto medio", () => {
    const before = [
      { x: 300, y: 400 },
      { x: 400, y: 400 },
    ] as const;
    const after = [
      { x: 250, y: 400 },
      { x: 450, y: 400 },
    ] as const;
    const under = screenToImage(viewTransform(start, IMAGE, SQUARE), 350, 400);
    const pinched = pinchView(start, IMAGE, SQUARE, before, after);
    expect(pinched.zoom).toBe(4);
    const now = imageToScreen(viewTransform(pinched, IMAGE, SQUARE), under.x, under.y);
    expect(now.x).toBeCloseTo(350, 9);
    expect(now.y).toBeCloseTo(400, 9);
  });

  it("mover los dos dedos juntos desplaza sin acercar", () => {
    const before = [
      { x: 300, y: 400 },
      { x: 400, y: 400 },
    ] as const;
    const after = [
      { x: 316, y: 392 },
      { x: 416, y: 392 },
    ] as const;
    const pinched = pinchView(start, IMAGE, SQUARE, before, after);
    expect(pinched).toEqual(panByScreen(start, IMAGE, SQUARE, 16, -8));
  });

  it("juntar los dedos aleja hasta el minimo", () => {
    const before = [
      { x: 100, y: 100 },
      { x: 500, y: 500 },
    ] as const;
    const after = [
      { x: 290, y: 290 },
      { x: 310, y: 310 },
    ] as const;
    expect(pinchView(start, IMAGE, SQUARE, before, after)).toEqual(HOME);
  });

  it("dos dedos en el mismo punto no rompen nada", () => {
    const same = [
      { x: 100, y: 100 },
      { x: 100, y: 100 },
    ] as const;
    expect(pinchView(start, IMAGE, SQUARE, same, same)).toEqual(start);
  });
});

describe("rueda", () => {
  const wheel = (deltaY: number, deltaMode = 0, ctrlKey = false) => ({
    deltaY,
    deltaMode,
    ctrlKey,
  });

  it("hacia arriba acerca y hacia abajo aleja, por el mismo factor", () => {
    const up = wheelZoomFactor(wheel(-100));
    const down = wheelZoomFactor(wheel(100));
    expect(up).toBeGreaterThan(1);
    expect(down).toBeLessThan(1);
    expect(up * down).toBeCloseTo(1, 12);
    // Una muesca de un mouse comun: 22 %.
    expect(up).toBeCloseTo(Math.exp(0.2), 12);
  });

  it("sin movimiento no cambia nada", () => {
    expect(wheelZoomFactor(wheel(0))).toBe(1);
  });

  it("entiende lineas y paginas", () => {
    expect(wheelZoomFactor(wheel(-3, 1))).toBeCloseTo(Math.exp(3 * 16 * 0.002), 12);
    expect(wheelZoomFactor(wheel(-1, 2))).toBe(2);
  });

  it("el pellizco del panel tactil (rueda con Control) es mas sensible", () => {
    expect(wheelZoomFactor(wheel(-10, 0, true))).toBeGreaterThan(wheelZoomFactor(wheel(-10)));
    expect(wheelZoomFactor(wheel(-10, 0, true))).toBeCloseTo(Math.exp(0.1), 12);
  });

  it("un solo evento no pasa del doble ni de la mitad", () => {
    expect(wheelZoomFactor(wheel(-100000))).toBe(2);
    expect(wheelZoomFactor(wheel(100000))).toBe(0.5);
    expect(wheelZoomFactor(wheel(Number.POSITIVE_INFINITY))).toBe(0.5);
    expect(wheelZoomFactor(wheel(Number.NEGATIVE_INFINITY))).toBe(2);
  });
});

describe("teclado", () => {
  it("las flechas desplazan la mirada", () => {
    expect(viewActionForKey("ArrowLeft")).toEqual({ type: "pan", right: -KEY_PAN_STEP, up: 0 });
    expect(viewActionForKey("ArrowRight")).toEqual({ type: "pan", right: KEY_PAN_STEP, up: 0 });
    expect(viewActionForKey("ArrowUp")).toEqual({ type: "pan", right: 0, up: KEY_PAN_STEP });
    expect(viewActionForKey("ArrowDown")).toEqual({ type: "pan", right: 0, up: -KEY_PAN_STEP });
  });

  it("con Mayusculas el paso es mas largo", () => {
    expect(viewActionForKey("ArrowRight", true)).toEqual({
      type: "pan",
      right: KEY_PAN_STEP_LARGE,
      up: 0,
    });
  });

  it("mas y menos acercan y alejan; 0 e Inicio vuelven a la vista de partida", () => {
    expect(viewActionForKey("+")).toEqual({ type: "zoom", factor: KEY_ZOOM_STEP });
    expect(viewActionForKey("=")).toEqual({ type: "zoom", factor: KEY_ZOOM_STEP });
    expect(viewActionForKey("-")).toEqual({ type: "zoom", factor: 1 / KEY_ZOOM_STEP });
    expect(viewActionForKey("_")).toEqual({ type: "zoom", factor: 1 / KEY_ZOOM_STEP });
    expect(viewActionForKey("0")).toEqual({ type: "reset" });
    expect(viewActionForKey("Home")).toEqual({ type: "reset" });
  });

  it("las demas teclas no son del visor", () => {
    for (const key of ["a", "Enter", " ", "Tab", "Escape", "PageDown"]) {
      expect(viewActionForKey(key), key).toBeNull();
    }
  });

  it("aplica el desplazamiento: flecha derecha mira hacia el oeste, flecha arriba hacia el norte", () => {
    const start: ViewState = { centerX: 97, centerY: 97, zoom: 4 };
    // Un octavo de 780 son 97,5 pixeles de pantalla; a 16 por pixel, 6,09375 de imagen.
    const right = applyViewAction(start, IMAGE, SQUARE, { type: "pan", right: 0.125, up: 0 }, HOME);
    expect(right).toEqual({ centerX: 97 + 6.09375, centerY: 97, zoom: 4 });
    const up = applyViewAction(start, IMAGE, SQUARE, { type: "pan", right: 0, up: 0.125 }, HOME);
    expect(up).toEqual({ centerX: 97, centerY: 97 + 6.09375, zoom: 4 });
  });

  it("aplica el acercamiento alrededor del centro y la vuelta a la vista de partida", () => {
    const start: ViewState = { centerX: 80, centerY: 110, zoom: 4 };
    expect(applyViewAction(start, IMAGE, SQUARE, { type: "zoom", factor: 1.25 }, HOME)).toEqual({
      centerX: 80,
      centerY: 110,
      zoom: 5,
    });
    const home = homeView(IMAGE, 2);
    expect(applyViewAction(start, IMAGE, SQUARE, { type: "reset" }, home)).toEqual(home);
  });
});

describe("densidad de pixeles", () => {
  it("el canvas tiene los pixeles fisicos del visor", () => {
    expect(backingStoreSize({ width: 800, height: 600 }, 1)).toEqual({ width: 800, height: 600 });
    expect(backingStoreSize({ width: 800, height: 600 }, 2)).toEqual({ width: 1600, height: 1200 });
    expect(backingStoreSize({ width: 333, height: 200.4 }, 1.5)).toEqual({
      width: 500,
      height: 301,
    });
  });

  it("nunca menos de 1 ni mas del tope por lado", () => {
    expect(backingStoreSize({ width: 0, height: -5 }, 2)).toEqual({ width: 1, height: 1 });
    expect(backingStoreSize({ width: 3000, height: 100 }, 3)).toEqual({
      width: MAX_BACKING_SIDE,
      height: 300,
    });
    expect(backingStoreSize({ width: 3000, height: 100 }, 3, 2048).width).toBe(2048);
  });

  it("una densidad que no sirve cuenta como 1", () => {
    for (const ratio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(backingStoreSize({ width: 10, height: 20 }, ratio)).toEqual({ width: 10, height: 20 });
    }
    expect(backingStoreSize({ width: Number.NaN, height: 20 }, 1)).toEqual({
      width: 1,
      height: 20,
    });
  });
});
