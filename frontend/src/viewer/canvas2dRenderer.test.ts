import { describe, expect, it, vi } from "vitest";
import { createCanvas2dRenderer } from "./canvas2dRenderer";
import { toCssHex } from "./colors";
import { composeScene, type Scene } from "./compose";
import { type PlaneImage, toPlaneImage } from "./planeImage";
import { createRenderer, type Frame } from "./renderer";
import { createFake2d, createFakeCanvasContexts, createFakeGl } from "./testSupport";
import { homeView, viewTransform } from "./view";

const WIDTH = 5;
const HEIGHT = 3;
const IMAGE = { width: WIDTH, height: HEIGHT };
/** El visor es apaisado: la imagen de 5 x 3 queda centrada con margen a los costados. */
const VIEWPORT = { width: 700, height: 300 };

function plane(seed: number): PlaneImage {
  const values = Float32Array.from({ length: WIDTH * HEIGHT }, (_, index) => seed + index);
  values[1] = Number.NaN;
  values[2] = Number.POSITIVE_INFINITY;
  return toPlaneImage(values, [HEIGHT, WIDTH]);
}

function scene(planes: PlaneImage[], extra: Partial<Scene> = {}): Scene {
  return {
    mode: "single",
    planes,
    stretch: "asinh",
    cuts: { low: 0, high: 20 },
    noDataColor: [0.2, 0.4, 0.6],
    ...extra,
  };
}

function frame(content: Scene | null, pixelRatio = 1, zoom = 1): Frame {
  return {
    scene: content,
    transform: viewTransform(homeView(IMAGE, zoom), IMAGE, VIEWPORT),
    viewport: VIEWPORT,
    pixelRatio,
  };
}

/** Un canvas con contextos 2D simulados: el del visor y el de la imagen compuesta. */
function setup() {
  const contexts = createFakeCanvasContexts();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string,
  ) {
    return contexts.getContext(this, kind);
  } as never);
  const canvas = document.createElement("canvas");
  const renderer = createCanvas2dRenderer(canvas);
  if (renderer === null) throw new Error("no se creo el dibujo");
  const target = contexts.fake2d(canvas);
  if (target === undefined) throw new Error("no se pidio el contexto 2D");
  /** Contexto del canvas aparte donde se arma la imagen. */
  const buffer = () => {
    const source = target.drawImages.at(-1)?.source as HTMLCanvasElement;
    const fake = contexts.fake2d(source);
    if (fake === undefined) throw new Error("no se compuso ninguna imagen");
    return { canvas: source, fake };
  };
  return { canvas, renderer, target, buffer };
}

describe("createCanvas2dRenderer", () => {
  it("devuelve null si el canvas no da un contexto 2D", () => {
    const canvas = document.createElement("canvas");
    canvas.getContext = (() => null) as never;
    expect(createCanvas2dRenderer(canvas)).toBeNull();
    canvas.getContext = (() => {
      throw new Error("sin canvas");
    }) as never;
    expect(createCanvas2dRenderer(canvas)).toBeNull();
  });

  it("informa que dibuja con canvas 2D", () => {
    const { renderer } = setup();
    expect(renderer.info).toEqual({
      kind: "canvas2d",
      version: null,
      shadingLanguageVersion: null,
      gpu: null,
    });
  });

  it("dibuja la composicion de referencia, con el norte en la primera fila", () => {
    const { renderer, buffer } = setup();
    const content = scene([plane(0)]);
    renderer.draw(frame(content));
    const composed = buffer();
    expect([composed.canvas.width, composed.canvas.height]).toEqual([WIDTH, HEIGHT]);
    expect(composed.fake.lastImageData?.width).toBe(WIDTH);
    expect(composed.fake.lastImageData?.height).toBe(HEIGHT);
    expect(Array.from(composed.fake.lastImageData?.data ?? [])).toEqual(
      Array.from(composeScene(content, { rowOrder: "north-first" })),
    );
  });

  it("copia la imagen sin suavizado al rectangulo que le toca", () => {
    const { canvas, renderer, target } = setup();
    renderer.draw(frame(scene([plane(0)]), 2));
    expect([canvas.width, canvas.height]).toEqual([1400, 600]);
    // 100 pixeles CSS por pixel de imagen: 500 x 300, centrada en 700 de ancho.
    expect(target.drawImages).toHaveLength(1);
    expect(target.drawImages[0]).toMatchObject({
      left: 100,
      top: 0,
      width: 500,
      height: 300,
      // De pixeles CSS a pixeles fisicos.
      transform: [2, 0, 0, 2, 0, 0],
      smoothing: false,
    });
  });

  it("sigue a la vista: con acercamiento 2 la imagen ocupa el doble", () => {
    const { renderer, target } = setup();
    renderer.draw(frame(scene([plane(0)]), 1, 2));
    expect(target.drawImages[0]).toMatchObject({ left: -150, top: -150, width: 1000, height: 600 });
  });

  it("pinta el fondo con el color de vacio", () => {
    const { renderer, target } = setup();
    const content = scene([plane(0)]);
    renderer.draw(frame(content));
    expect(target.fills).toEqual([toCssHex(content.noDataColor)]);
  });

  it("no vuelve a componer si la escena es la misma", () => {
    const { renderer, buffer } = setup();
    const only = plane(0);
    renderer.draw(frame(scene([only])));
    // Otra vista y otro objeto de escena con lo mismo: se reusa la imagen.
    renderer.draw(frame(scene([only]), 1, 3));
    expect(buffer().fake.putCount).toBe(1);

    renderer.draw(frame(scene([only], { stretch: "log" })));
    expect(buffer().fake.putCount).toBe(2);
    renderer.draw(frame(scene([plane(7)], { stretch: "log" })));
    expect(buffer().fake.putCount).toBe(3);
  });

  it("forget descarta la imagen compuesta con ese plano", () => {
    const { renderer, buffer } = setup();
    const only = plane(0);
    renderer.draw(frame(scene([only])));
    renderer.forget(plane(3));
    renderer.draw(frame(scene([only])));
    expect(buffer().fake.putCount).toBe(1);
    renderer.forget(only);
    renderer.draw(frame(scene([only])));
    expect(buffer().fake.putCount).toBe(2);
  });

  it("sin escena solo limpia", () => {
    const { renderer, target } = setup();
    renderer.draw(frame(null));
    expect(target.clearCount).toBe(1);
    expect(target.fills).toEqual([]);
    expect(target.drawImages).toEqual([]);
  });

  it("rechaza una escena que no es valida", () => {
    const { renderer } = setup();
    expect(() => renderer.draw(frame(scene([])))).toThrow(RangeError);
  });

  it("ante una escena que no es valida limpia el canvas: no queda a la vista el cuadro anterior", () => {
    const { renderer, target } = setup();
    renderer.draw(frame(scene([plane(0)])));
    expect(target.drawImages).toHaveLength(1);
    const clears = target.clearCount;
    const fills = target.fills.length;

    const other = toPlaneImage(new Float32Array(2 * HEIGHT), [HEIGHT, 2]);
    const invalid = scene([plane(0), other], { mode: "difference" });
    expect(() => renderer.draw(frame(invalid))).toThrow(RangeError);

    // Limpia y no pinta nada: ni el fondo ni la imagen.
    expect(target.clearCount).toBe(clears + 1);
    expect(target.fills).toHaveLength(fills);
    expect(target.drawImages).toHaveLength(1);
  });

  it("despues de una escena que no es valida, readPixels no lanza: lee el canvas limpio", () => {
    const { renderer, target } = setup();
    renderer.draw(frame(scene([plane(0)])));
    expect(() => renderer.draw(frame(scene([])))).toThrow(RangeError);

    const snapshot = renderer.readPixels();
    expect(snapshot?.width).toBe(700);
    expect(snapshot?.height).toBe(300);
    expect(target.drawImages).toHaveLength(1);

    // Y el dibujo sigue sirviendo.
    renderer.draw(frame(scene([plane(1)])));
    expect(target.drawImages).toHaveLength(2);
  });

  it("puede pedir el contexto preparado para leer pixeles seguido", () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    getContext.mockImplementation((() => createFake2d().context) as never);

    createCanvas2dRenderer(document.createElement("canvas"), { willReadFrequently: true });
    expect(getContext.mock.calls.at(-1)).toEqual(["2d", { willReadFrequently: true }]);

    // El visor no lee pixeles: por defecto no lo pide.
    createCanvas2dRenderer(document.createElement("canvas"));
    expect(getContext.mock.calls.at(-1)).toEqual(["2d"]);
  });

  it("readPixels devuelve las filas de abajo hacia arriba, como WebGL", () => {
    const { renderer, target } = setup();
    expect(renderer.readPixels()).toBeNull();
    const small = { width: 2, height: 2 };
    renderer.draw({
      scene: null,
      transform: { scale: 1, originX: 0, originY: 0 },
      viewport: small,
      pixelRatio: 1,
    });
    // Arriba: 1 y 2. Abajo: 3 y 4.
    target.pixels = new Uint8ClampedArray([1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255, 4, 4, 4, 255]);
    const snapshot = renderer.readPixels();
    expect(snapshot?.width).toBe(2);
    expect(snapshot?.height).toBe(2);
    expect(Array.from(snapshot?.data ?? [])).toEqual([
      3, 3, 3, 255, 4, 4, 4, 255, 1, 1, 1, 255, 2, 2, 2, 255,
    ]);
  });

  it("despues de dispose no dibuja mas", () => {
    const { renderer, target } = setup();
    renderer.dispose();
    renderer.draw(frame(scene([plane(0)])));
    expect(target.drawImages).toEqual([]);
    expect(renderer.readPixels()).toBeNull();
  });
});

describe("createRenderer", () => {
  it("prefiere WebGL2", () => {
    const canvas = document.createElement("canvas");
    const fake = createFakeGl(canvas);
    canvas.getContext = ((kind: string) => (kind === "webgl2" ? fake.gl : null)) as never;
    expect(createRenderer(canvas)?.info.kind).toBe("webgl2");
  });

  it("sin WebGL2 dibuja con canvas 2D sobre el mismo canvas", () => {
    const canvas = document.createElement("canvas");
    const fake = createFake2d();
    const getContext = vi.fn((kind: string) => (kind === "2d" ? fake.context : null));
    canvas.getContext = getContext as never;
    expect(createRenderer(canvas)?.info.kind).toBe("canvas2d");
    expect(getContext.mock.calls.map((call) => call[0])).toEqual(["webgl2", "2d"]);
  });

  it("con canvas2d pedido ni intenta WebGL2", () => {
    const canvas = document.createElement("canvas");
    const fake = createFake2d();
    const getContext = vi.fn((kind: string) => (kind === "2d" ? fake.context : null));
    canvas.getContext = getContext as never;
    expect(createRenderer(canvas, "canvas2d")?.info.kind).toBe("canvas2d");
    expect(getContext.mock.calls.map((call) => call[0])).toEqual(["2d"]);
  });

  it("devuelve null si WebGL2 tomo el canvas y despues fallo", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const canvas = document.createElement("canvas");
    const fake = createFakeGl(canvas);
    fake.failCompile = true;
    // Como en un navegador: un canvas con contexto WebGL no da uno 2D.
    canvas.getContext = ((kind: string) => (kind === "webgl2" ? fake.gl : null)) as never;
    expect(createRenderer(canvas)).toBeNull();
  });
});
