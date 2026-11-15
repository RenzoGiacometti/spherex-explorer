import { describe, expect, it, vi } from "vitest";
import { createCanvas2dRenderer } from "./canvas2dRenderer";
import { toCssHex } from "./colors";
import { composeScene, hatchBand, type Scene } from "./compose";
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
  /** Contexto del canvas aparte donde se arma la imagen: el ultimo que se copio con pixeles propios. */
  const buffer = () => {
    for (const drawn of [...target.drawImages].reverse()) {
      const source = drawn.source as HTMLCanvasElement;
      const fake = contexts.fake2d(source);
      if (fake?.lastImageData) return { canvas: source, fake };
    }
    throw new Error("no se compuso ninguna imagen");
  };
  /** La capa de la trama: el canvas que se copio encima de la imagen, y como se armo. */
  const hatchLayer = () => {
    const drawn = target.drawImages.at(-1);
    const layerCanvas = drawn?.source as HTMLCanvasElement;
    const layer = contexts.fake2d(layerCanvas);
    if (drawn === undefined || layer === undefined) throw new Error("no se dibujo la trama");
    const tileCanvas = layer.patterns.at(-1)?.source as HTMLCanvasElement;
    const maskCanvas = layer.drawImages.at(-1)?.source as HTMLCanvasElement;
    const tile = contexts.fake2d(tileCanvas);
    const mask = contexts.fake2d(maskCanvas);
    if (tile === undefined || mask === undefined) throw new Error("la trama no tiene baldosa");
    return { drawn, canvas: layerCanvas, layer, tileCanvas, tile, maskCanvas, mask };
  };
  return { canvas, renderer, target, buffer, hatchLayer };
}

/** Los cuatro bytes del pixel (x, y) de una imagen, con `y` desde arriba. */
function bytesAt(
  image: { width: number; data: Uint8ClampedArray },
  x: number,
  y: number,
): number[] {
  const offset = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(offset, offset + 4));
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

  describe("trama del resaltado", () => {
    const TEXT = [1, 1, 1, 1] as const;
    const VOID = [0, 0, 0] as const;

    /** Marca la columna 0 de la fila sur y la columna 4 de la fila norte. */
    function hatchMask(): Uint8Array {
      const mask = new Uint8Array(WIDTH * HEIGHT);
      mask[0] = 1;
      mask[(HEIGHT - 1) * WIDTH + 4] = 1;
      return mask;
    }

    it("se copia encima de la imagen, del tamano del canvas y sin escalar", () => {
      const { canvas, renderer, target, hatchLayer } = setup();
      const highlight = { mask: hatchMask(), color: TEXT, alternate: VOID };
      renderer.draw(frame(scene([plane(0)], { highlight }), 2));

      expect(target.drawImages).toHaveLength(2);
      const { drawn, canvas: layerCanvas } = hatchLayer();
      expect([layerCanvas.width, layerCanvas.height]).toEqual([canvas.width, canvas.height]);
      expect(drawn).toMatchObject({
        left: 0,
        top: 0,
        width: canvas.width,
        height: canvas.height,
        // En pixeles fisicos: la trama no se amplia con la densidad.
        transform: [1, 0, 0, 1, 0, 0],
        composite: "source-over",
      });
    });

    it("la imagen de abajo es la composicion sin resaltado", () => {
      const { renderer, buffer } = setup();
      const only = plane(0);
      const highlight = { mask: hatchMask(), color: TEXT, alternate: VOID };
      renderer.draw(frame(scene([only], { highlight })));
      expect(Array.from(buffer().fake.lastImageData?.data ?? [])).toEqual(
        Array.from(composeScene(scene([only]), { rowOrder: "north-first" })),
      );
    });

    it("llena la capa con la baldosa de hatchBand y deja solo lo que cae sobre la mascara", () => {
      const { renderer, hatchLayer } = setup();
      const highlight = { mask: hatchMask(), color: TEXT, alternate: VOID };
      renderer.draw(frame(scene([plane(0)], { highlight }), 2));
      const { layer, tileCanvas, tile, maskCanvas, mask } = hatchLayer();

      // Con densidad 2 cada franja mide 2 pixeles fisicos: la baldosa es de 4 x 4.
      expect([tileCanvas.width, tileCanvas.height]).toEqual([4, 4]);
      expect(layer.patterns.at(-1)?.repetition).toBe("repeat");
      expect(layer.fills.at(-1)).toBe("pattern");
      const tilePixels = tile.lastImageData;
      if (!tilePixels) throw new Error("la baldosa no tiene pixeles");
      for (let y = 0; y < 4; y += 1) {
        for (let x = 0; x < 4; x += 1) {
          const wanted = hatchBand(x, y, 2) === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255];
          expect(bytesAt(tilePixels, x, y), `baldosa (${x}, ${y})`).toEqual(wanted);
        }
      }

      // La mascara, a tamano de imagen y con el norte arriba: opaca solo donde marca.
      expect([maskCanvas.width, maskCanvas.height]).toEqual([WIDTH, HEIGHT]);
      const maskPixels = mask.lastImageData;
      if (!maskPixels) throw new Error("la mascara no tiene pixeles");
      const opaque: string[] = [];
      for (let y = 0; y < HEIGHT; y += 1) {
        for (let x = 0; x < WIDTH; x += 1) {
          if (bytesAt(maskPixels, x, y)[3] === 255) opaque.push(`${x},${y}`);
          else expect(bytesAt(maskPixels, x, y)[3]).toBe(0);
        }
      }
      // La fila sur del plano es la de abajo de la imagen.
      expect(opaque).toEqual(["4,0", `0,${HEIGHT - 1}`]);

      // Se amplia igual que la imagen, sin suavizado, y recorta lo que hay debajo.
      expect(layer.drawImages).toHaveLength(1);
      expect(layer.drawImages[0]).toMatchObject({
        left: 100,
        top: 0,
        width: 500,
        height: 300,
        transform: [2, 0, 0, 2, 0, 0],
        smoothing: false,
        composite: "destination-in",
      });
    });

    it("con densidad 1 la baldosa es un damero de 2 x 2", () => {
      const { renderer, hatchLayer } = setup();
      const highlight = { mask: hatchMask(), color: TEXT, alternate: [0, 0.2, 0.4] as const };
      renderer.draw(frame(scene([plane(0)], { highlight })));
      const { tileCanvas, tile } = hatchLayer();
      expect([tileCanvas.width, tileCanvas.height]).toEqual([2, 2]);
      const pixels = tile.lastImageData;
      if (!pixels) throw new Error("la baldosa no tiene pixeles");
      expect(bytesAt(pixels, 0, 0)).toEqual([255, 255, 255, 255]);
      expect(bytesAt(pixels, 1, 0)).toEqual([0, 51, 102, 255]);
      expect(bytesAt(pixels, 0, 1)).toEqual([0, 51, 102, 255]);
      expect(bytesAt(pixels, 1, 1)).toEqual([255, 255, 255, 255]);
    });

    it("no vuelve a armar la mascara ni la baldosa si son las mismas", () => {
      const { renderer, hatchLayer } = setup();
      const only = plane(0);
      const highlight = { mask: hatchMask(), color: TEXT, alternate: VOID };
      renderer.draw(frame(scene([only], { highlight })));
      // Otra vista: la trama se recorta de nuevo, con lo mismo.
      renderer.draw(frame(scene([only], { highlight }), 1, 2));
      const same = hatchLayer();
      expect(same.mask.putCount).toBe(1);
      expect(same.tile.putCount).toBe(1);
      expect(same.layer.drawImages.at(-1)).toMatchObject({ left: -150, width: 1000 });

      // Otra mascara (otra epoca) u otra densidad si.
      renderer.draw(frame(scene([only], { highlight: { ...highlight, mask: hatchMask() } })));
      expect(hatchLayer().mask.putCount).toBe(2);
      expect(hatchLayer().tile.putCount).toBe(1);
      renderer.draw(frame(scene([only], { highlight }), 2));
      expect(hatchLayer().tile.putCount).toBe(2);
    });

    it("sin trama no hay segunda copia: ni con resaltado liso ni con uno transparente", () => {
      const { renderer, target } = setup();
      const mask = hatchMask();
      renderer.draw(frame(scene([plane(0)], { highlight: { mask, color: [1, 1, 1, 0.5] } })));
      expect(target.drawImages).toHaveLength(1);
      renderer.draw(
        frame(scene([plane(0)], { highlight: { mask, color: [1, 1, 1, 0], alternate: VOID } })),
      );
      expect(target.drawImages).toHaveLength(2);
    });
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
