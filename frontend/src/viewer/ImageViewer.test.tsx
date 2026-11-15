import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { Scene } from "./compose";
import { ImageViewer, type ImageViewerHandle, type ViewerOverlay } from "./ImageViewer";
import { type PlaneImage, toPlaneImage } from "./planeImage";
import type { RendererInfo } from "./renderer";
import { createFakeCanvasContexts, type FakeCanvasOptions } from "./testSupport";
import { imageToScreen, KEY_ZOOM_STEP } from "./view";

// El cubo base, 195 x 195, en un visor de 780 x 780: 4 pixeles de pantalla por pixel.
const SIDE = 195;
const IMAGE = { width: SIDE, height: SIDE };
const LABEL = "campo de prueba";

function plane(value: number): PlaneImage {
  return toPlaneImage(new Float32Array(SIDE * SIDE).fill(value), [SIDE, SIDE]);
}

const PLANE = plane(1);

function scene(planes: PlaneImage[] = [PLANE], extra: Partial<Scene> = {}): Scene {
  return {
    mode: "single",
    planes,
    stretch: "linear",
    cuts: { low: 0, high: 2 },
    noDataColor: [0, 0, 0],
    ...extra,
  };
}

const SCENE = scene();

/** ResizeObserver simulado: `resize` avisa a todos los que estan observando. */
class FakeResizeObserver {
  static active = new Set<FakeResizeObserver>();
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(): void {
    FakeResizeObserver.active.add(this);
  }

  unobserve(): void {
    FakeResizeObserver.active.delete(this);
  }

  disconnect(): void {
    FakeResizeObserver.active.delete(this);
  }

  static resize(width: number, height: number): void {
    const entry = { contentRect: { width, height } } as ResizeObserverEntry;
    act(() => {
      for (const observer of FakeResizeObserver.active) {
        observer.callback([entry], observer as unknown as ResizeObserver);
      }
    });
  }
}

/** Prepara el navegador simulado: canvas, ResizeObserver y un visor de 780 x 780. */
function setup(options: FakeCanvasOptions = {}) {
  FakeResizeObserver.active.clear();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  const contexts = createFakeCanvasContexts(options);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string,
  ) {
    return contexts.getContext(this, kind);
  } as never);
  return contexts;
}

function root(): HTMLElement {
  return screen.getByLabelText(LABEL);
}

function canvasOf(element: HTMLElement): HTMLCanvasElement {
  const canvas = element.querySelector("canvas");
  if (canvas === null) throw new Error("el visor no tiene canvas");
  return canvas;
}

/** Hijo de prueba: escribe la transformacion vigente en el DOM. */
function probe(overlay: ViewerOverlay) {
  const center = imageToScreen(overlay.transform, 97, 97);
  return (
    <output
      data-testid="overlay"
      data-scale={overlay.transform.scale}
      data-zoom={overlay.view.zoom}
      data-center-x={overlay.view.centerX}
      data-center-y={overlay.view.centerY}
      data-screen-x={center.x}
      data-screen-y={center.y}
    />
  );
}

interface OverlayData {
  scale: number;
  zoom: number;
  centerX: number;
  centerY: number;
  screenX: number;
  screenY: number;
}

function overlayData(): OverlayData {
  const element = screen.getByTestId("overlay");
  return {
    scale: Number(element.dataset.scale),
    zoom: Number(element.dataset.zoom),
    centerX: Number(element.dataset.centerX),
    centerY: Number(element.dataset.centerY),
    screenX: Number(element.dataset.screenX),
    screenY: Number(element.dataset.screenY),
  };
}

/** Evento de puntero. jsdom no trae PointerEvent: se arma sobre un MouseEvent. */
function pointer(
  type: string,
  init: { x: number; y: number; id?: number; pointerType?: string; button?: number },
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x,
    clientY: init.y,
    button: init.button ?? 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: init.id ?? 1 },
    pointerType: { value: init.pointerType ?? "mouse" },
  });
  return event;
}

/**
 * jsdom no implementa la captura de punteros. Pone una simulada y la devuelve,
 * para saber si el visor la pidio.
 */
function stubPointerCapture() {
  const capture = vi.fn<(pointerId: number) => void>();
  const prototype = HTMLElement.prototype as { setPointerCapture?: unknown };
  const had = Object.hasOwn(prototype, "setPointerCapture");
  const previous = prototype.setPointerCapture;
  prototype.setPointerCapture = capture;
  onTestFinished(() => {
    if (had) prototype.setPointerCapture = previous;
    else delete prototype.setPointerCapture;
  });
  return capture;
}

function renderViewer(props: Partial<Parameters<typeof ImageViewer>[0]> = {}) {
  const result = render(
    <ImageViewer scene={SCENE} ariaLabel={LABEL} {...props}>
      {props.children ?? probe}
    </ImageViewer>,
  );
  FakeResizeObserver.resize(780, 780);
  return result;
}

describe("ImageViewer: accesibilidad", () => {
  it("lleva el nombre que recibe, rol application por defecto y admite foco", () => {
    setup();
    renderViewer();
    const element = root();
    expect(element.getAttribute("role")).toBe("application");
    expect(element.getAttribute("aria-label")).toBe(LABEL);
    expect(element.tabIndex).toBe(0);
    element.focus();
    expect(document.activeElement).toBe(element);
  });

  it("el rol y la descripcion llegan por props", () => {
    setup();
    renderViewer({ role: "img", ariaDescribedBy: "ayuda", className: "extra" });
    const element = screen.getByRole("img", { name: LABEL });
    expect(element.getAttribute("aria-describedby")).toBe("ayuda");
    expect(element.className).toContain("extra");
  });
});

describe("ImageViewer: dibujo", () => {
  it("sin WebGL2 dibuja con canvas 2D, a los pixeles del visor", () => {
    const contexts = setup();
    renderViewer();
    const element = root();
    expect(element.dataset.renderer).toBe("canvas2d");
    const canvas = canvasOf(element);
    expect([canvas.width, canvas.height]).toEqual([780, 780]);
    const drawn = contexts.fake2d(canvas)?.drawImages.at(-1);
    expect(drawn).toMatchObject({ left: 0, top: 0, width: 780, height: 780, smoothing: false });
  });

  it("con WebGL2 dibuja con WebGL2", () => {
    const contexts = setup({ webgl2: true });
    renderViewer();
    const element = root();
    expect(element.dataset.renderer).toBe("webgl2");
    const gl = contexts.fakeGl(canvasOf(element));
    expect(gl?.callsTo("drawArrays").length).toBeGreaterThanOrEqual(1);
    // Una textura de valores y una de mascara para el unico plano.
    expect(gl?.callsTo("texImage2D")).toHaveLength(2);
  });

  it("con renderer canvas2d no usa WebGL2 aunque este", () => {
    const contexts = setup({ webgl2: true });
    renderViewer({ renderer: "canvas2d" });
    const element = root();
    expect(element.dataset.renderer).toBe("canvas2d");
    expect(contexts.fakeGl(canvasOf(element))).toBeUndefined();
  });

  it("si WebGL2 toma el canvas y falla, pasa a canvas 2D con un canvas nuevo", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const contexts = setup({ webgl2: true, failCompile: true });
    renderViewer();
    const element = root();
    expect(element.dataset.renderer).toBe("canvas2d");
    const canvas = canvasOf(element);
    expect(contexts.fakeGl(canvas)).toBeUndefined();
    expect(contexts.fake2d(canvas)?.drawImages.length).toBeGreaterThanOrEqual(1);
  });

  it("cambiar de plano no recrea nada: el parpadeo solo cambia de textura", () => {
    const contexts = setup({ webgl2: true });
    const other = plane(2);
    const { rerender } = renderViewer();
    const element = root();
    const gl = contexts.fakeGl(canvasOf(element));
    const show = (content: Scene) =>
      rerender(
        <ImageViewer scene={content} ariaLabel={LABEL}>
          {probe}
        </ImageViewer>,
      );
    show(scene([other]));
    const uploads = gl?.callsTo("texImage2D").length;
    const draws = gl?.callsTo("drawArrays").length ?? 0;
    expect(uploads).toBe(4);
    for (let round = 0; round < 10; round += 1) show(scene([round % 2 === 0 ? PLANE : other]));
    expect(gl?.callsTo("texImage2D")).toHaveLength(4);
    expect(gl?.callsTo("createProgram")).toHaveLength(1);
    expect(gl?.callsTo("drawArrays")).toHaveLength(draws + 10);
    expect(canvasOf(element)).toBe(gl?.gl.canvas);
  });

  it("no vuelve a dibujar si no cambio nada", () => {
    const contexts = setup({ webgl2: true });
    const { rerender } = renderViewer();
    const gl = contexts.fakeGl(canvasOf(root()));
    const draws = gl?.callsTo("drawArrays").length;
    rerender(
      <ImageViewer scene={SCENE} ariaLabel={LABEL}>
        {probe}
      </ImageViewer>,
    );
    expect(gl?.callsTo("drawArrays")).toHaveLength(draws ?? -1);
  });

  it("sin escena no dibuja imagen ni capa de encima", () => {
    const contexts = setup();
    renderViewer({ scene: null });
    expect(screen.queryByTestId("overlay")).toBeNull();
    expect(contexts.fake2d(canvasOf(root()))?.drawImages).toEqual([]);
  });

  it("sin escena pero con el tamano de la imagen ya se puede dibujar encima", () => {
    setup();
    renderViewer({ scene: null, imageSize: IMAGE });
    expect(overlayData()).toMatchObject({ scale: 4, screenX: 390, screenY: 390 });
  });

  it("una escena que no es valida no rompe la pagina: avisa y no dibuja", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const contexts = setup();
    renderViewer({ scene: scene([PLANE, PLANE]) });
    expect(error).toHaveBeenCalled();
    expect(contexts.fake2d(canvasOf(root()))?.drawImages).toEqual([]);
  });

  it("al desmontar libera el dibujo", () => {
    const contexts = setup({ webgl2: true });
    const { unmount } = renderViewer();
    const gl = contexts.fakeGl(canvasOf(root()));
    unmount();
    expect(gl?.callsTo("deleteProgram")).toHaveLength(1);
    expect(gl?.liveTextures.size).toBe(0);
    expect(FakeResizeObserver.active.size).toBe(0);
  });

  it("avisa con que se dibuja", () => {
    setup();
    const onRendererChange = vi.fn<(info: RendererInfo | null) => void>();
    renderViewer({ onRendererChange });
    expect(onRendererChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "canvas2d" }),
    );
  });
});

describe("ImageViewer: vista", () => {
  it("encuadra la imagen entera y entrega la transformacion a lo que se dibuja encima", () => {
    setup();
    renderViewer();
    expect(overlayData()).toEqual({
      scale: 4,
      zoom: 1,
      centerX: 97,
      centerY: 97,
      screenX: 390,
      screenY: 390,
    });
  });

  it("con homeZoom 2 (la vista de 5 minutos) arranca acercado al doble", () => {
    setup();
    renderViewer({ homeZoom: 2 });
    expect(overlayData()).toMatchObject({ scale: 8, zoom: 2, centerX: 97, centerY: 97 });
  });

  it("sigue el tamano del visor", () => {
    const contexts = setup();
    renderViewer();
    FakeResizeObserver.resize(390, 600);
    expect(overlayData()).toMatchObject({ scale: 2, screenX: 195, screenY: 300 });
    const canvas = canvasOf(root());
    expect([canvas.width, canvas.height]).toEqual([390, 600]);
    expect(contexts.fake2d(canvas)?.drawImages.at(-1)).toMatchObject({
      left: 0,
      top: 105,
      width: 390,
      height: 390,
    });
  });

  it("dibuja a la densidad de pixeles de la pantalla", () => {
    const contexts = setup();
    vi.stubGlobal("devicePixelRatio", 2);
    renderViewer();
    const canvas = canvasOf(root());
    expect([canvas.width, canvas.height]).toEqual([1560, 1560]);
    // La transformacion que recibe lo que se dibuja encima sigue en pixeles CSS.
    expect(overlayData().scale).toBe(4);
    expect(contexts.fake2d(canvas)?.drawImages.at(-1)).toMatchObject({
      width: 780,
      transform: [2, 0, 0, 2, 0, 0],
    });
  });

  it("vuelve a dibujar cuando el navegador avisa que cambio la densidad", () => {
    setup();
    const listeners = new Set<() => void>();
    const queries: string[] = [];
    vi.stubGlobal("matchMedia", (query: string) => {
      queries.push(query);
      return {
        addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      };
    });
    renderViewer();
    const canvas = canvasOf(root());
    expect(canvas.width).toBe(780);
    expect(queries.at(-1)).toBe("(resolution: 1dppx)");

    // La ventana pasa a una pantalla con el doble de densidad.
    vi.stubGlobal("devicePixelRatio", 2);
    act(() => {
      for (const listener of [...listeners]) listener();
    });
    expect(canvas.width).toBe(1560);
    expect(queries.at(-1)).toBe("(resolution: 2dppx)");
    expect(listeners.size).toBe(1);
  });

  it("si el aviso no llega, toma la densidad nueva en el dibujo siguiente", () => {
    setup();
    renderViewer();
    const canvas = canvasOf(root());
    expect(canvas.width).toBe(780);
    vi.stubGlobal("devicePixelRatio", 3);
    fireEvent.keyDown(root(), { key: "+" });
    expect(canvas.width).toBe(2340);
  });

  it("sin ResizeObserver mide el visor y escucha el cambio de tamano de la ventana", () => {
    setup();
    vi.stubGlobal("ResizeObserver", undefined);
    let width = 780;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => 780);
    render(
      <ImageViewer scene={SCENE} ariaLabel={LABEL}>
        {probe}
      </ImageViewer>,
    );
    expect(overlayData().scale).toBe(4);
    width = 390;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(overlayData().scale).toBe(2);
  });

  it("avisa cada vez que cambia la transformacion", () => {
    setup();
    const onOverlayChange = vi.fn<(overlay: ViewerOverlay | null) => void>();
    renderViewer({ onOverlayChange });
    expect(onOverlayChange.mock.lastCall?.[0]?.transform.scale).toBe(4);
    fireEvent.keyDown(root(), { key: "+" });
    expect(onOverlayChange.mock.lastCall?.[0]?.view.zoom).toBe(KEY_ZOOM_STEP);
  });

  it("al cambiar homeZoom vuelve a la vista de partida", () => {
    setup();
    const { rerender } = renderViewer();
    fireEvent.keyDown(root(), { key: "+" });
    expect(overlayData().zoom).toBe(KEY_ZOOM_STEP);
    rerender(
      <ImageViewer scene={SCENE} ariaLabel={LABEL} homeZoom={2}>
        {probe}
      </ImageViewer>,
    );
    expect(overlayData()).toMatchObject({ zoom: 2, centerX: 97, centerY: 97 });
  });

  it("quedarse un momento sin escena no mueve la vista", () => {
    setup();
    const { rerender } = renderViewer();
    fireEvent.keyDown(root(), { key: "+" });
    fireEvent.keyDown(root(), { key: "ArrowUp" });
    const before = overlayData();
    // Cambio de banda mientras carga: todavia no hay plano para mostrar.
    rerender(
      <ImageViewer scene={null} ariaLabel={LABEL}>
        {probe}
      </ImageViewer>,
    );
    expect(screen.queryByTestId("overlay")).toBeNull();
    rerender(
      <ImageViewer scene={scene([plane(3)])} ariaLabel={LABEL}>
        {probe}
      </ImageViewer>,
    );
    expect(overlayData()).toEqual(before);
  });

  it("otra imagen de otro tamano vuelve a encuadrar", () => {
    setup();
    const { rerender } = renderViewer();
    fireEvent.keyDown(root(), { key: "+" });
    // El cubo amplio: 293 x 293.
    const wide = toPlaneImage(new Float32Array(293 * 293), [293, 293]);
    rerender(
      <ImageViewer scene={scene([wide])} ariaLabel={LABEL}>
        {probe}
      </ImageViewer>,
    );
    expect(overlayData()).toMatchObject({ zoom: 1, centerX: 146, centerY: 146, scale: 780 / 293 });
  });

  it("cambiar de plano no mueve la vista", () => {
    setup();
    const { rerender } = renderViewer();
    fireEvent.keyDown(root(), { key: "+" });
    fireEvent.keyDown(root(), { key: "ArrowRight" });
    const before = overlayData();
    rerender(
      <ImageViewer scene={scene([plane(5)])} ariaLabel={LABEL}>
        {probe}
      </ImageViewer>,
    );
    expect(overlayData()).toEqual(before);
  });
});

describe("ImageViewer: teclado", () => {
  it("mas y menos acercan y alejan alrededor del centro", () => {
    setup();
    renderViewer();
    const element = root();
    fireEvent.keyDown(element, { key: "+" });
    fireEvent.keyDown(element, { key: "=" });
    expect(overlayData().zoom).toBeCloseTo(KEY_ZOOM_STEP ** 2, 12);
    expect(overlayData()).toMatchObject({ centerX: 97, centerY: 97 });
    fireEvent.keyDown(element, { key: "-" });
    expect(overlayData().zoom).toBeCloseTo(KEY_ZOOM_STEP, 12);
  });

  it("las flechas desplazan la mirada cuando la imagen esta acercada", () => {
    setup();
    renderViewer({ homeZoom: 4 });
    const element = root();
    // Un octavo de 780 pixeles de pantalla, a 16 por pixel de imagen.
    const step = 780 / 8 / 16;
    fireEvent.keyDown(element, { key: "ArrowRight" });
    expect(overlayData()).toMatchObject({ centerX: 97 + step, centerY: 97 });
    fireEvent.keyDown(element, { key: "ArrowUp" });
    expect(overlayData()).toMatchObject({ centerX: 97 + step, centerY: 97 + step });
    fireEvent.keyDown(element, { key: "ArrowLeft" });
    fireEvent.keyDown(element, { key: "ArrowDown" });
    expect(overlayData()).toMatchObject({ centerX: 97, centerY: 97 });
  });

  it("0 e Inicio vuelven a la vista de partida", () => {
    setup();
    renderViewer({ homeZoom: 2 });
    const element = root();
    fireEvent.keyDown(element, { key: "+" });
    fireEvent.keyDown(element, { key: "ArrowRight" });
    fireEvent.keyDown(element, { key: "0" });
    expect(overlayData()).toMatchObject({ zoom: 2, centerX: 97, centerY: 97 });
    fireEvent.keyDown(element, { key: "+" });
    fireEvent.keyDown(element, { key: "Home" });
    expect(overlayData()).toMatchObject({ zoom: 2, centerX: 97, centerY: 97 });
  });

  it("cancela solo las teclas que usa, y deja pasar los atajos del navegador", () => {
    setup();
    renderViewer();
    const element = root();
    // fireEvent devuelve false cuando el evento se cancelo.
    expect(fireEvent.keyDown(element, { key: "+" })).toBe(false);
    expect(fireEvent.keyDown(element, { key: "a" })).toBe(true);
    expect(fireEvent.keyDown(element, { key: "Tab" })).toBe(true);
    const zoom = overlayData().zoom;
    expect(fireEvent.keyDown(element, { key: "0", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(element, { key: "+", metaKey: true })).toBe(true);
    expect(overlayData().zoom).toBe(zoom);
  });

  it("las teclas de un hijo interactivo de la capa de encima no mueven la vista ni se cancelan", () => {
    setup();
    renderViewer({
      homeZoom: 4,
      children: (overlay) => (
        <>
          {probe(overlay)}
          <button type="button" style={{ pointerEvents: "auto" }}>
            marcador
          </button>
        </>
      ),
    });
    const marker = screen.getByRole("button", { name: "marcador" });
    for (const key of ["+", "-", "0", "ArrowRight", "ArrowUp", "Home"]) {
      expect(fireEvent.keyDown(marker, { key }), key).toBe(true);
    }
    expect(overlayData()).toMatchObject({ zoom: 4, centerX: 97, centerY: 97 });
    // Desde el visor siguen funcionando.
    expect(fireEvent.keyDown(root(), { key: "ArrowRight" })).toBe(false);
    expect(overlayData().centerX).toBeGreaterThan(97);
  });
});

describe("ImageViewer: rueda", () => {
  it("acerca alrededor del cursor y no deja que la pagina se desplace", () => {
    setup();
    renderViewer({ homeZoom: 2 });
    const element = root();
    // El punto de la imagen bajo el cursor (200, 500) con acercamiento 2.
    const under = { x: (200 + 386) / 8, y: (1166 - 500) / 8 };
    const notCancelled = fireEvent.wheel(element, { deltaY: -100, clientX: 200, clientY: 500 });
    expect(notCancelled).toBe(false);

    const data = overlayData();
    expect(data.zoom).toBeCloseTo(2 * Math.exp(0.2), 10);
    // Ese punto sigue bajo el cursor.
    const originX = 390 - data.centerX * data.scale;
    const originY = 390 + data.centerY * data.scale;
    expect(originX + under.x * data.scale).toBeCloseTo(200, 8);
    expect(originY - under.y * data.scale).toBeCloseTo(500, 8);
  });

  it("hacia abajo aleja, hasta encuadrar la imagen entera", () => {
    setup();
    renderViewer({ homeZoom: 2 });
    const element = root();
    for (let step = 0; step < 10; step += 1) {
      fireEvent.wheel(element, { deltaY: 100, clientX: 10, clientY: 10 });
    }
    expect(overlayData()).toMatchObject({ zoom: 1, centerX: 97, centerY: 97 });
  });
});

describe("ImageViewer: arrastre y pellizco", () => {
  it("arrastrar desplaza la imagen con el puntero", () => {
    setup();
    renderViewer({ homeZoom: 4 });
    const element = root();
    fireEvent(element, pointer("pointerdown", { x: 300, y: 300 }));
    expect(element.dataset.dragging).toBe("true");
    fireEvent(element, pointer("pointermove", { x: 332, y: 300 }));
    // 32 pixeles de pantalla a la derecha son 2 de imagen hacia el este.
    expect(overlayData()).toMatchObject({ centerX: 95, centerY: 97 });
    fireEvent(element, pointer("pointermove", { x: 332, y: 348 }));
    expect(overlayData()).toMatchObject({ centerX: 95, centerY: 100 });
    fireEvent(element, pointer("pointerup", { x: 332, y: 348 }));
    expect(element.dataset.dragging).toBeUndefined();

    // Sin boton apretado, mover el puntero no hace nada.
    fireEvent(element, pointer("pointermove", { x: 100, y: 100 }));
    expect(overlayData()).toMatchObject({ centerX: 95, centerY: 100 });
  });

  it("solo arrastra el boton principal del mouse", () => {
    setup();
    renderViewer({ homeZoom: 4 });
    const element = root();
    fireEvent(element, pointer("pointerdown", { x: 300, y: 300, button: 2 }));
    fireEvent(element, pointer("pointermove", { x: 400, y: 300 }));
    expect(overlayData()).toMatchObject({ centerX: 97, centerY: 97 });
    expect(element.dataset.dragging).toBeUndefined();
  });

  it("con la imagen entera en pantalla no hay nada que desplazar", () => {
    setup();
    renderViewer();
    const element = root();
    fireEvent(element, pointer("pointerdown", { x: 300, y: 300 }));
    fireEvent(element, pointer("pointermove", { x: 500, y: 100 }));
    expect(overlayData()).toMatchObject({ zoom: 1, centerX: 97, centerY: 97 });
  });

  it("separar dos dedos acerca alrededor de su punto medio", () => {
    setup();
    renderViewer({ homeZoom: 2 });
    const element = root();
    const touch = (type: string, id: number, x: number, y: number) =>
      fireEvent(element, pointer(type, { id, x, y, pointerType: "touch" }));
    touch("pointerdown", 1, 340, 390);
    touch("pointerdown", 2, 440, 390);
    // Cada dedo se aleja 50 pixeles: la separacion pasa de 100 a 200.
    touch("pointermove", 1, 290, 390);
    touch("pointermove", 2, 490, 390);
    const data = overlayData();
    expect(data.zoom).toBeCloseTo(4, 10);
    // El punto medio (390, 390) es el centro del visor: el centro no se movio.
    expect(data.centerX).toBeCloseTo(97, 8);
    expect(data.centerY).toBeCloseTo(97, 8);

    // Al levantar un dedo, el otro sigue arrastrando.
    touch("pointerup", 2, 490, 390);
    touch("pointermove", 1, 306, 390);
    expect(overlayData().centerX).toBeCloseTo(96, 8);
    touch("pointerup", 1, 306, 390);
    expect(element.dataset.dragging).toBeUndefined();
  });

  it("captura el puntero que empieza sobre la imagen, para no perder el arrastre", () => {
    setup();
    const capture = stubPointerCapture();
    renderViewer({ homeZoom: 4 });
    const element = root();
    fireEvent(canvasOf(element), pointer("pointerdown", { x: 300, y: 300, id: 7 }));
    expect(capture).toHaveBeenCalledWith(7);
    expect(element.dataset.dragging).toBe("true");
  });

  it("un hijo interactivo de la capa de encima se queda con su puntero: ni arrastre ni captura", () => {
    setup();
    const capture = stubPointerCapture();
    const onClick = vi.fn();
    renderViewer({
      homeZoom: 4,
      children: (overlay) => (
        <>
          {probe(overlay)}
          <button type="button" style={{ pointerEvents: "auto" }} onClick={onClick}>
            marcador
          </button>
        </>
      ),
    });
    const element = root();
    const marker = screen.getByRole("button", { name: "marcador" });

    // Con la captura en la raiz el navegador le mandaria el clic a la raiz.
    fireEvent(marker, pointer("pointerdown", { x: 300, y: 300 }));
    expect(capture).not.toHaveBeenCalled();
    expect(element.dataset.dragging).toBeUndefined();
    fireEvent(marker, pointer("pointermove", { x: 340, y: 300 }));
    fireEvent(marker, pointer("pointerup", { x: 340, y: 300 }));
    expect(overlayData()).toMatchObject({ centerX: 97, centerY: 97 });
    fireEvent.click(marker);
    expect(onClick).toHaveBeenCalledTimes(1);

    // Dos toques o dos clics seguidos sobre el hijo tampoco son del visor.
    fireEvent.keyDown(element, { key: "+" });
    const zoomed = overlayData().zoom;
    for (let tap = 0; tap < 2; tap += 1) {
      fireEvent(marker, pointer("pointerdown", { x: 300, y: 300, pointerType: "touch" }));
      fireEvent(marker, pointer("pointerup", { x: 300, y: 300, pointerType: "touch" }));
    }
    fireEvent.doubleClick(marker);
    expect(overlayData().zoom).toBe(zoomed);

    // Y la imagen sigue arrastrandose desde cualquier otro lado.
    fireEvent(element, pointer("pointerdown", { x: 300, y: 300 }));
    expect(capture).toHaveBeenCalledTimes(1);
    fireEvent(element, pointer("pointermove", { x: 332, y: 300 }));
    expect(overlayData().centerX).toBeLessThan(97);
  });

  it("un gesto cancelado suelta el arrastre", () => {
    setup();
    renderViewer({ homeZoom: 4 });
    const element = root();
    fireEvent(element, pointer("pointerdown", { x: 300, y: 300, pointerType: "touch" }));
    fireEvent(element, pointer("pointercancel", { x: 300, y: 300, pointerType: "touch" }));
    expect(element.dataset.dragging).toBeUndefined();
    fireEvent(element, pointer("pointermove", { x: 400, y: 300, pointerType: "touch" }));
    expect(overlayData()).toMatchObject({ centerX: 97, centerY: 97 });
  });
});

describe("ImageViewer: volver a la vista de partida", () => {
  it("con doble clic", () => {
    setup();
    renderViewer({ homeZoom: 2 });
    const element = root();
    fireEvent.keyDown(element, { key: "+" });
    fireEvent.keyDown(element, { key: "ArrowRight" });
    fireEvent.doubleClick(element);
    expect(overlayData()).toMatchObject({ zoom: 2, centerX: 97, centerY: 97 });
  });

  it("con doble toque", () => {
    setup();
    renderViewer({ homeZoom: 2 });
    const element = root();
    fireEvent.keyDown(element, { key: "+" });
    const tap = (x: number, y: number) => {
      fireEvent(element, pointer("pointerdown", { x, y, pointerType: "touch" }));
      fireEvent(element, pointer("pointerup", { x, y, pointerType: "touch" }));
    };
    tap(200, 200);
    expect(overlayData().zoom).toBeCloseTo(2 * KEY_ZOOM_STEP, 12);
    tap(204, 198);
    expect(overlayData()).toMatchObject({ zoom: 2, centerX: 97, centerY: 97 });
  });

  it("dos toques lejos uno del otro no cuentan como doble toque", () => {
    setup();
    renderViewer({ homeZoom: 2 });
    const element = root();
    fireEvent.keyDown(element, { key: "+" });
    for (const [x, y] of [
      [100, 100],
      [600, 600],
    ] as const) {
      fireEvent(element, pointer("pointerdown", { x, y, pointerType: "touch" }));
      fireEvent(element, pointer("pointerup", { x, y, pointerType: "touch" }));
    }
    expect(overlayData().zoom).toBeCloseTo(2 * KEY_ZOOM_STEP, 12);
  });

  it("desde afuera, por ref", () => {
    setup();
    const ref = createRef<ImageViewerHandle>();
    renderViewer({ ref });
    expect(ref.current?.getOverlay()?.transform.scale).toBe(4);
    act(() => ref.current?.zoomBy(2));
    expect(overlayData().zoom).toBe(2);
    expect(ref.current?.getOverlay()?.view.zoom).toBe(2);
    act(() => ref.current?.resetView());
    expect(overlayData().zoom).toBe(1);
  });
});
