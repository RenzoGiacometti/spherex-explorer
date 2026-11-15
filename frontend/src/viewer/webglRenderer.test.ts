import { describe, expect, it, vi } from "vitest";
import type { Scene } from "./compose";
import { type PlaneImage, toPlaneImage } from "./planeImage";
import type { Frame, RendererOptions } from "./renderer";
import { createFakeGl, type FakeGl, type GlObject } from "./testSupport";
import { homeView, viewTransform } from "./view";
import { createWebglRenderer } from "./webglRenderer";

// El ancho impar del cubo base, a escala: 5 columnas por 3 filas.
const WIDTH = 5;
const HEIGHT = 3;
const IMAGE = { width: WIDTH, height: HEIGHT };
const VIEWPORT = { width: 500, height: 300 };

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
    stretch: "linear",
    cuts: { low: -1, high: 9 },
    noDataColor: [0.1, 0.2, 0.3],
    ...extra,
  };
}

function frame(content: Scene | null, pixelRatio = 1): Frame {
  return {
    scene: content,
    transform: viewTransform(homeView(IMAGE), IMAGE, VIEWPORT),
    viewport: VIEWPORT,
    pixelRatio,
  };
}

function setup(options: RendererOptions = {}) {
  const canvas = document.createElement("canvas");
  const fake = createFakeGl(canvas);
  const getContext = vi.fn((kind: string) => (kind === "webgl2" ? fake.gl : null));
  canvas.getContext = getContext as never;
  const renderer = createWebglRenderer(canvas, options);
  if (renderer === null) throw new Error("no se creo el dibujo");
  return { canvas, fake, renderer, getContext };
}

/** Subidas de textura: formato interno, tipo y datos de cada `texImage2D`. */
function uploads(fake: FakeGl) {
  return fake.callsTo("texImage2D").map((call) => ({
    internalFormat: call.args[2],
    width: call.args[3],
    height: call.args[4],
    format: call.args[6],
    type: call.args[7],
    data: call.args[8],
  }));
}

/** Ultimo valor que se le dio a un uniform. */
function uniform(fake: FakeGl, name: string): unknown[] | undefined {
  const matching = fake.calls.filter((entry) => {
    const location = entry.args[0] as { kind?: string; name?: string } | null;
    return (
      entry.name.startsWith("uniform") && location?.kind === "uniform" && location.name === name
    );
  });
  return matching.at(-1)?.args.slice(1);
}

describe("createWebglRenderer", () => {
  it("devuelve null si el navegador no da WebGL2", () => {
    const canvas = document.createElement("canvas");
    canvas.getContext = (() => null) as never;
    expect(createWebglRenderer(canvas)).toBeNull();
  });

  it("devuelve null si getContext falla o el contexto ya esta perdido", () => {
    const throwing = document.createElement("canvas");
    throwing.getContext = (() => {
      throw new Error("sin WebGL");
    }) as never;
    expect(createWebglRenderer(throwing)).toBeNull();

    const canvas = document.createElement("canvas");
    const fake = createFakeGl(canvas);
    fake.lost = true;
    canvas.getContext = (() => fake.gl) as never;
    expect(createWebglRenderer(canvas)).toBeNull();
  });

  it("devuelve null y avisa si el shader no compila", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const canvas = document.createElement("canvas");
    const fake = createFakeGl(canvas);
    fake.failCompile = true;
    canvas.getContext = (() => fake.gl) as never;
    expect(createWebglRenderer(canvas)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("pide un contexto sin suavizado ni buffer de profundidad", () => {
    const { getContext } = setup();
    expect(getContext).toHaveBeenCalledWith(
      "webgl2",
      expect.objectContaining({ antialias: false, depth: false, preserveDrawingBuffer: false }),
    );
  });

  it("informa con que se dibuja", () => {
    const { renderer } = setup();
    expect(renderer.info).toEqual({
      kind: "webgl2",
      version: "WebGL 2.0 (simulado)",
      shadingLanguageVersion: "WebGL GLSL ES 3.00 (simulado)",
      gpu: "simulado",
    });
  });

  it("el shader usa las constantes de stretch.ts y lee texeles exactos", () => {
    const { fake } = setup();
    const sources = fake.callsTo("shaderSource").map((call) => String(call.args[1]));
    expect(sources).toHaveLength(2);
    const fragment = sources.find((source) => source.includes("outColor")) ?? "";
    expect(fragment).toContain("#version 300 es");
    expect(fragment).toContain("const float LOG_A = 1000.0;");
    expect(fragment).toContain("const float ASINH_A = 0.1;");
    expect(fragment).toContain("const int MODE_SINGLE = 0;");
    expect(fragment).toContain("const int MODE_DIFFERENCE = 1;");
    expect(fragment).toContain("const int MODE_SUM = 2;");
    expect(fragment).toContain("const int STRETCH_LOG = 1;");
    expect(fragment).toContain("const int STRETCH_ASINH = 2;");
    expect(fragment).toContain("texelFetch");
    // texture() filtraria; el visor lee cada texel sin interpolar.
    expect(fragment).not.toMatch(/\btexture\(/);
  });
});

describe("texturas", () => {
  it("sube los valores como R32F y la mascara como R8, con filtro NEAREST", () => {
    const { fake, renderer } = setup();
    const only = plane(0);
    renderer.draw(frame(scene([only])));

    expect(uploads(fake)).toEqual([
      {
        internalFormat: fake.constant("R32F"),
        width: WIDTH,
        height: HEIGHT,
        format: fake.constant("RED"),
        type: fake.constant("FLOAT"),
        data: only.values,
      },
      {
        internalFormat: fake.constant("R8"),
        width: WIDTH,
        height: HEIGHT,
        format: fake.constant("RED"),
        type: fake.constant("UNSIGNED_BYTE"),
        data: only.mask,
      },
    ]);

    const filters = fake
      .callsTo("texParameteri")
      .filter(
        (call) =>
          call.args[1] === fake.constant("TEXTURE_MIN_FILTER") ||
          call.args[1] === fake.constant("TEXTURE_MAG_FILTER"),
      );
    expect(filters).toHaveLength(4);
    for (const call of filters) expect(call.args[2]).toBe(fake.constant("NEAREST"));
  });

  it("pone UNPACK_ALIGNMENT en 1 antes de subir nada: el ancho es impar", () => {
    const { fake, renderer } = setup();
    renderer.draw(frame(scene([plane(0)])));
    const alignment = fake.calls.findIndex(
      (call) =>
        call.name === "pixelStorei" &&
        call.args[0] === fake.constant("UNPACK_ALIGNMENT") &&
        call.args[1] === 1,
    );
    const firstUpload = fake.calls.findIndex((call) => call.name === "texImage2D");
    expect(alignment).toBeGreaterThanOrEqual(0);
    expect(alignment).toBeLessThan(firstUpload);
  });

  it("no usa UNPACK_FLIP_Y_WEBGL: la fila 0 (sur) queda abajo", () => {
    const { fake, renderer } = setup();
    renderer.draw(frame(scene([plane(0)])));
    const flips = fake
      .callsTo("pixelStorei")
      .filter((call) => call.args[0] === fake.constant("UNPACK_FLIP_Y_WEBGL"));
    expect(flips).toEqual([]);
  });

  it("cambiar de plano no sube ni recrea nada: el parpadeo solo cambia de textura", () => {
    const { fake, renderer } = setup();
    const first = plane(0);
    const second = plane(10);
    renderer.draw(frame(scene([first])));
    renderer.draw(frame(scene([second])));
    const created = {
      textures: fake.callsTo("createTexture").length,
      uploads: fake.callsTo("texImage2D").length,
      programs: fake.callsTo("createProgram").length,
      shaders: fake.callsTo("createShader").length,
    };
    expect(created).toEqual({ textures: 4, uploads: 4, programs: 1, shaders: 2 });

    for (let round = 0; round < 20; round += 1) {
      renderer.draw(frame(scene([round % 2 === 0 ? first : second])));
    }
    expect(fake.callsTo("createTexture")).toHaveLength(created.textures);
    expect(fake.callsTo("texImage2D")).toHaveLength(created.uploads);
    expect(fake.callsTo("createProgram")).toHaveLength(created.programs);
    expect(fake.callsTo("createShader")).toHaveLength(created.shaders);
    expect(fake.callsTo("deleteTexture")).toEqual([]);
    expect(fake.callsTo("drawArrays")).toHaveLength(22);
  });

  it("cambiar de modo, estirado o cortes tampoco sube nada", () => {
    const { fake, renderer } = setup();
    const planes = [plane(0), plane(10)];
    renderer.draw(frame(scene(planes, { mode: "difference" })));
    const before = fake.callsTo("texImage2D").length;
    renderer.draw(frame(scene(planes, { mode: "redcyan", stretch: "asinh" })));
    renderer.draw(frame(scene(planes, { mode: "sum", cuts: { low: 0, high: 3 } })));
    renderer.draw(frame(scene([planes[1] as PlaneImage])));
    expect(fake.callsTo("texImage2D")).toHaveLength(before);
  });

  it("descarta las texturas que hace mas que no se usan al pasar el tope", () => {
    const { fake, renderer } = setup({ maxPlanes: 4 });
    const planes = [0, 1, 2, 3, 4, 5].map((seed) => plane(seed));
    for (const item of planes) renderer.draw(frame(scene([item])));
    // Seis planos con tope de cuatro: se borraron las dos texturas de los dos primeros.
    expect(fake.callsTo("deleteTexture")).toHaveLength(4);
    expect(fake.liveTextures.size).toBe(8);

    // Los cuatro ultimos siguen guardados; el primero hay que subirlo de nuevo.
    const before = fake.callsTo("texImage2D").length;
    renderer.draw(frame(scene([planes[5] as PlaneImage])));
    renderer.draw(frame(scene([planes[2] as PlaneImage])));
    expect(fake.callsTo("texImage2D")).toHaveLength(before);
    renderer.draw(frame(scene([planes[0] as PlaneImage])));
    expect(fake.callsTo("texImage2D")).toHaveLength(before + 2);
  });

  it("forget suelta las texturas de un plano", () => {
    const { fake, renderer } = setup();
    const first = plane(0);
    const second = plane(10);
    renderer.draw(frame(scene([first])));
    renderer.draw(frame(scene([second])));
    renderer.forget(first);
    expect(fake.callsTo("deleteTexture")).toHaveLength(2);
    expect(fake.liveTextures.size).toBe(2);
    // Olvidar dos veces, o un plano que nunca se dibujo, no hace nada.
    renderer.forget(first);
    renderer.forget(plane(99));
    expect(fake.callsTo("deleteTexture")).toHaveLength(2);

    renderer.draw(frame(scene([first])));
    expect(fake.callsTo("texImage2D")).toHaveLength(6);
  });
});

describe("dibujo", () => {
  it("ajusta el canvas a los pixeles fisicos del visor", () => {
    const { canvas, fake, renderer } = setup();
    renderer.draw(frame(scene([plane(0)]), 2));
    expect([canvas.width, canvas.height]).toEqual([1000, 600]);
    expect(fake.callsTo("viewport").at(-1)?.args).toEqual([0, 0, 1000, 600]);
    renderer.draw(frame(scene([plane(0)]), 1));
    expect([canvas.width, canvas.height]).toEqual([500, 300]);
  });

  it("limpia con el color de vacio y dibuja un cuadrado", () => {
    const { fake, renderer } = setup();
    renderer.draw(frame(scene([plane(0)])));
    expect(fake.callsTo("clearColor").at(-1)?.args).toEqual([0.1, 0.2, 0.3, 1]);
    expect(fake.callsTo("drawArrays").at(-1)?.args).toEqual([
      fake.constant("TRIANGLE_STRIP"),
      0,
      4,
    ]);
  });

  it("pasa al shader el modo, el estirado, los cortes y el rectangulo de la imagen", () => {
    const { fake, renderer } = setup();
    renderer.draw(frame(scene([plane(0), plane(1), plane(2)], { mode: "sum", stretch: "asinh" })));
    expect(uniform(fake, "u_mode")).toEqual([2]);
    expect(uniform(fake, "u_count")).toEqual([3]);
    expect(uniform(fake, "u_stretch")).toEqual([2]);
    expect(uniform(fake, "u_size")).toEqual([WIDTH, HEIGHT]);
    // Corte bajo y ancho.
    expect(uniform(fake, "u_cuts")).toEqual([-1, 10]);
    expect(uniform(fake, "u_noData")).toEqual([0.1, 0.2, 0.3]);
    // La imagen de 5 x 3 entra justa en un visor de 500 x 300.
    expect(uniform(fake, "u_rect")).toEqual([-1, -1, 1, 1]);
    expect(uniform(fake, "u_highlightColor")).toEqual([0, 0, 0, 0]);

    renderer.draw(frame(scene([plane(0), plane(1)], { mode: "redcyan", stretch: "log" })));
    expect(uniform(fake, "u_mode")).toEqual([3]);
    expect(uniform(fake, "u_stretch")).toEqual([1]);
    expect(uniform(fake, "u_count")).toEqual([2]);
  });

  it("deja una textura en cada unidad: las que la escena no usa repiten el primer plano", () => {
    const { fake, renderer } = setup();
    renderer.draw(frame(scene([plane(0), plane(1)], { mode: "difference" })));
    const base = fake.constant("TEXTURE0");
    const bound = new Map<number, GlObject>();
    let unit = -1;
    for (const call of fake.calls) {
      if (call.name === "activeTexture") unit = (call.args[0] as number) - base;
      if (call.name === "bindTexture") bound.set(unit, call.args[1] as GlObject);
    }
    // Valores en 0 a 3, mascaras en 4 a 7 y resaltado en 8.
    for (let index = 0; index <= 8; index += 1) {
      expect(bound.get(index)?.kind, `unidad ${index}`).toBe("texture");
    }
    expect(bound.get(2)).toBe(bound.get(0));
    expect(bound.get(3)).toBe(bound.get(0));
    expect(bound.get(1)).not.toBe(bound.get(0));
    expect(bound.get(6)).toBe(bound.get(4));
    expect(bound.get(8)).toBe(bound.get(4));
  });

  it("sube la mascara de resaltado una sola vez y pasa su color", () => {
    const { fake, renderer } = setup();
    const only = plane(0);
    const mask = new Uint8Array(WIDTH * HEIGHT);
    const highlight = { mask, color: [1, 0.5, 0, 0.4] as const };
    renderer.draw(frame(scene([only], { highlight })));
    renderer.draw(frame(scene([only], { highlight, stretch: "log" })));
    const maskUploads = uploads(fake).filter((upload) => upload.data === mask);
    expect(maskUploads).toHaveLength(1);
    expect(maskUploads[0]?.internalFormat).toBe(fake.constant("R8"));
    expect(uniform(fake, "u_highlightColor")).toEqual([1, 0.5, 0, 0.4]);

    // Con opacidad 0 no hay resaltado: ni se sube la mascara.
    const other = new Uint8Array(WIDTH * HEIGHT);
    renderer.draw(frame(scene([only], { highlight: { mask: other, color: [1, 1, 1, 0] } })));
    expect(uploads(fake).filter((upload) => upload.data === other)).toEqual([]);
    expect(uniform(fake, "u_highlightColor")).toEqual([0, 0, 0, 0]);
  });

  it("sin trama, el ancho de franja va en 0: el resaltado es un color liso", () => {
    const { fake, renderer } = setup();
    const mask = new Uint8Array(WIDTH * HEIGHT);
    renderer.draw(frame(scene([plane(0)])));
    expect(uniform(fake, "u_hatchStripe")).toEqual([0]);
    renderer.draw(frame(scene([plane(0)], { highlight: { mask, color: [1, 1, 1, 0.5] } })));
    expect(uniform(fake, "u_hatchStripe")).toEqual([0]);
    renderer.draw(
      frame(scene([plane(0)], { highlight: { mask, color: [1, 1, 1, 0.5], alternate: null } })),
    );
    expect(uniform(fake, "u_hatchStripe")).toEqual([0]);
  });

  it("con trama pasa los dos colores, el ancho de franja y el alto del canvas", () => {
    const { fake, renderer } = setup();
    const only = plane(0);
    const mask = new Uint8Array(WIDTH * HEIGHT).fill(1);
    const highlight = { mask, color: [1, 1, 1, 1] as const, alternate: [0, 0.25, 0.5] as const };

    renderer.draw(frame(scene([only], { highlight })));
    expect(uploads(fake).filter((upload) => upload.data === mask)).toHaveLength(1);
    expect(uniform(fake, "u_highlightColor")).toEqual([1, 1, 1, 1]);
    expect(uniform(fake, "u_hatchAlternate")).toEqual([0, 0.25, 0.5]);
    // 1 px CSS: con densidad 1, un pixel fisico.
    expect(uniform(fake, "u_hatchStripe")).toEqual([1]);
    expect(uniform(fake, "u_bufferHeight")).toEqual([VIEWPORT.height]);

    // Con el doble de densidad la franja mide 2 pixeles fisicos y el canvas el doble.
    renderer.draw(frame(scene([only], { highlight }), 2));
    expect(uniform(fake, "u_hatchStripe")).toEqual([2]);
    expect(uniform(fake, "u_bufferHeight")).toEqual([2 * VIEWPORT.height]);

    // Al apagar la trama vuelve el color liso.
    renderer.draw(frame(scene([only], { highlight: { mask, color: [1, 1, 1, 0.5] } }), 2));
    expect(uniform(fake, "u_hatchStripe")).toEqual([0]);
  });

  it("una trama transparente no es un resaltado: no se sube ni se dibuja", () => {
    const { fake, renderer } = setup();
    const mask = new Uint8Array(WIDTH * HEIGHT).fill(1);
    renderer.draw(
      frame(scene([plane(0)], { highlight: { mask, color: [1, 1, 1, 0], alternate: [0, 0, 0] } })),
    );
    expect(uploads(fake).filter((upload) => upload.data === mask)).toEqual([]);
    expect(uniform(fake, "u_highlightColor")).toEqual([0, 0, 0, 0]);
    expect(uniform(fake, "u_hatchStripe")).toEqual([0]);
  });

  it("el shader cuenta la trama en pixeles fisicos desde la esquina superior izquierda", () => {
    const { fake } = setup();
    const fragment = fake
      .callsTo("shaderSource")
      .map((call) => String(call.args[1]))
      .find((source) => source.includes("u_hatchStripe"));
    // La misma cuenta que hatchBand: (x + y desde arriba) / franja, y su paridad.
    expect(fragment).toContain("((pixel.x + u_bufferHeight - 1 - pixel.y) / u_hatchStripe) % 2");
    expect(fragment).toContain("ivec2 pixel = ivec2(gl_FragCoord.xy);");
    expect(fragment).toContain("band == 0 ? u_highlightColor.rgb : u_hatchAlternate");
  });

  it("sin escena deja el canvas transparente y no dibuja", () => {
    const { fake, renderer } = setup();
    renderer.draw(frame(null));
    expect(fake.callsTo("clearColor").at(-1)?.args).toEqual([0, 0, 0, 0]);
    expect(fake.callsTo("clear")).toHaveLength(1);
    expect(fake.callsTo("drawArrays")).toEqual([]);
  });

  it("rechaza una escena que no es valida", () => {
    const { renderer } = setup();
    expect(() => renderer.draw(frame(scene([])))).toThrow(RangeError);
    expect(() => renderer.draw(frame(scene([plane(0)], { mode: "difference" })))).toThrow(
      RangeError,
    );
  });

  it("ante una escena que no es valida limpia el canvas: no queda a la vista el cuadro anterior", () => {
    const { fake, renderer } = setup();
    renderer.draw(frame(scene([plane(0)])));
    expect(fake.callsTo("drawArrays")).toHaveLength(1);
    const clears = fake.callsTo("clear").length;
    const uploads = fake.callsTo("texImage2D").length;

    // Planos de distinto tamano: no se sube ni se dibuja nada de esa escena.
    const other = toPlaneImage(new Float32Array(2 * HEIGHT), [HEIGHT, 2]);
    const invalid = scene([plane(0), other], { mode: "difference" });
    expect(() => renderer.draw(frame(invalid))).toThrow(RangeError);
    expect(fake.callsTo("drawArrays")).toHaveLength(1);
    expect(fake.callsTo("texImage2D")).toHaveLength(uploads);
    // Queda transparente, como sin escena.
    expect(fake.callsTo("clear")).toHaveLength(clears + 1);
    expect(fake.callsTo("clearColor").at(-1)?.args).toEqual([0, 0, 0, 0]);
  });

  it("despues de una escena que no es valida, readPixels no lanza: lee el canvas limpio", () => {
    const { fake, renderer } = setup();
    renderer.draw(frame(scene([plane(0)])));
    expect(() => renderer.draw(frame(scene([])))).toThrow(RangeError);

    const snapshot = renderer.readPixels();
    expect(snapshot?.width).toBe(500);
    expect(snapshot?.height).toBe(300);
    // El ultimo cuadro es el canvas limpio, no la escena anterior ni la rechazada.
    expect(fake.callsTo("drawArrays")).toHaveLength(1);
    expect(fake.callsTo("clearColor").at(-1)?.args).toEqual([0, 0, 0, 0]);

    // Y el dibujo sigue sirviendo.
    renderer.draw(frame(scene([plane(1)])));
    expect(fake.callsTo("drawArrays")).toHaveLength(2);
  });

  it("readPixels vuelve a dibujar el ultimo cuadro y lee el buffer completo", () => {
    const { fake, renderer } = setup();
    expect(renderer.readPixels()).toBeNull();
    renderer.draw(frame(scene([plane(0)]), 2));
    const snapshot = renderer.readPixels();
    expect(fake.callsTo("drawArrays")).toHaveLength(2);
    expect(snapshot?.width).toBe(1000);
    expect(snapshot?.height).toBe(600);
    expect(snapshot?.data).toHaveLength(1000 * 600 * 4);
    const call = fake.callsTo("readPixels").at(-1);
    expect(call?.args.slice(0, 6)).toEqual([
      0,
      0,
      1000,
      600,
      fake.constant("RGBA"),
      fake.constant("UNSIGNED_BYTE"),
    ]);
  });
});

describe("perdida y recuperacion del contexto", () => {
  it("deja que el navegador devuelva el contexto y avisa", () => {
    const onContextLost = vi.fn();
    const { canvas } = setup({ onContextLost });
    const event = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(event);
    // Sin preventDefault el navegador no intenta recuperar el contexto.
    expect(event.defaultPrevented).toBe(true);
    expect(onContextLost).toHaveBeenCalledTimes(1);
  });

  it("mientras esta perdido no dibuja, y al volver recrea todo y dibuja lo ultimo", () => {
    const onContextRestored = vi.fn();
    const { canvas, fake, renderer } = setup({ onContextRestored });
    const first = plane(0);
    const second = plane(10);
    renderer.draw(frame(scene([first])));
    expect(fake.callsTo("drawArrays")).toHaveLength(1);

    fake.lost = true;
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    renderer.draw(frame(scene([second])));
    expect(fake.callsTo("drawArrays")).toHaveLength(1);
    expect(renderer.readPixels()).toBeNull();
    // Lo que habia en el contexto ya no existe: no se borra nada.
    renderer.forget(first);
    expect(fake.callsTo("deleteTexture")).toEqual([]);

    fake.lost = false;
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(onContextRestored).toHaveBeenCalledTimes(1);
    expect(fake.callsTo("createProgram")).toHaveLength(2);
    expect(fake.callsTo("drawArrays")).toHaveLength(2);
    // Se dibujo el ultimo cuadro pedido, con sus texturas subidas de nuevo.
    const lastUploads = uploads(fake).slice(-2);
    expect(lastUploads[0]?.data).toBe(second.values);
    expect(lastUploads[1]?.data).toBe(second.mask);

    // El plano anterior se vuelve a subir cuando haga falta.
    const before = fake.callsTo("texImage2D").length;
    renderer.draw(frame(scene([first])));
    expect(fake.callsTo("texImage2D")).toHaveLength(before + 2);
  });

  it("si lo ultimo que se pidio no era valido, al volver el contexto avisa igual y no lanza", () => {
    const onContextRestored = vi.fn();
    const { canvas, fake, renderer } = setup({ onContextRestored });
    renderer.draw(frame(scene([plane(0)])));
    expect(() => renderer.draw(frame(scene([])))).toThrow(RangeError);

    fake.lost = true;
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    fake.lost = false;
    expect(() => canvas.dispatchEvent(new Event("webglcontextrestored"))).not.toThrow();

    expect(onContextRestored).toHaveBeenCalledTimes(1);
    // Se volvio a dibujar lo ultimo, que era el canvas limpio.
    expect(fake.callsTo("drawArrays")).toHaveLength(1);
    expect(fake.callsTo("clearColor").at(-1)?.args).toEqual([0, 0, 0, 0]);
  });

  it("si al volver el contexto no se puede dibujar lo ultimo, avisa igual que volvio", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onContextRestored = vi.fn();
    const { canvas, fake, renderer } = setup({ onContextRestored });
    renderer.draw(frame(scene([plane(0)])));
    fake.lost = true;
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    fake.lost = false;
    // El navegador devuelve el contexto pero no deja crear texturas.
    fake.failTextures = true;

    expect(() => canvas.dispatchEvent(new Event("webglcontextrestored"))).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(onContextRestored).toHaveBeenCalledTimes(1);

    // Quien escucha el aviso puede pedir otro cuadro cuando el contexto ya responde.
    fake.failTextures = false;
    renderer.draw(frame(scene([plane(0)])));
    expect(fake.callsTo("drawArrays")).toHaveLength(2);
  });

  it("si no se puede recrear, avisa y sigue sin dibujar", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onContextRestored = vi.fn();
    const { canvas, fake, renderer } = setup({ onContextRestored });
    renderer.draw(frame(scene([plane(0)])));
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    fake.failCompile = true;
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(onContextRestored).not.toHaveBeenCalled();
    renderer.draw(frame(scene([plane(0)])));
    expect(fake.callsTo("drawArrays")).toHaveLength(1);
  });
});

describe("liberacion de recursos", () => {
  it("dispose borra texturas, programa y geometria, y deja de escuchar al canvas", () => {
    const onContextLost = vi.fn();
    const { canvas, fake, renderer } = setup({ onContextLost });
    const mask = new Uint8Array(WIDTH * HEIGHT).fill(1);
    renderer.draw(
      frame(scene([plane(0), plane(1)], { mode: "sum", highlight: { mask, color: [1, 1, 1, 1] } })),
    );
    expect(fake.liveTextures.size).toBe(5);

    renderer.dispose();
    expect(fake.liveTextures.size).toBe(0);
    expect(fake.callsTo("deleteProgram")).toHaveLength(1);
    expect(fake.callsTo("deleteBuffer")).toHaveLength(1);
    expect(fake.callsTo("deleteVertexArray")).toHaveLength(1);

    const calls = fake.calls.length;
    renderer.draw(frame(scene([plane(0)])));
    renderer.dispose();
    expect(renderer.readPixels()).toBeNull();
    expect(fake.calls).toHaveLength(calls);

    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(onContextLost).not.toHaveBeenCalled();
  });

  it("el mismo canvas se puede volver a usar despues de dispose", () => {
    const { canvas, fake, renderer } = setup();
    renderer.draw(frame(scene([plane(0)])));
    renderer.dispose();
    const again = createWebglRenderer(canvas);
    expect(again).not.toBeNull();
    again?.draw(frame(scene([plane(0)])));
    expect(fake.callsTo("createProgram")).toHaveLength(2);
    expect(fake.callsTo("drawArrays")).toHaveLength(2);
  });
});
