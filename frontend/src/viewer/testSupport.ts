// Contextos de canvas simulados, para probar el visor sin navegador. jsdom no
// implementa `getContext`: devuelve null y deja un aviso en la consola.
//
// No dibujan nada: registran lo que se les pide para que un test lo pueda
// revisar. Este archivo no forma parte de la aplicacion; lo importan solo los
// tests (los del visor y los de las pantallas que lo montan).

// ---- WebGL2 ---------------------------------------------------------------

export interface GlCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

/** Objeto creado en el contexto simulado (textura, programa, buffer...). */
export interface GlObject {
  readonly kind: string;
  readonly id: number;
}

export interface FakeGl {
  /** El contexto simulado, para devolver desde `getContext("webgl2")`. */
  readonly gl: WebGL2RenderingContext;
  /** Todas las llamadas, en orden. */
  readonly calls: GlCall[];
  /** Llamadas a un metodo. */
  callsTo(name: string): GlCall[];
  /** Valor numerico de una constante, por ejemplo `constant("R32F")`. */
  constant(name: string): number;
  /** Texturas creadas y todavia no borradas. */
  readonly liveTextures: Set<GlObject>;
  /** Hace que `isContextLost()` devuelva true. */
  lost: boolean;
  /** Hace que los shaders no compilen. */
  failCompile: boolean;
  /** Hace que `createTexture` devuelva null, como un contexto que no da mas texturas. */
  failTextures: boolean;
}

const GL_CONSTANT = /^[A-Z][A-Z0-9_]*$/;

const CREATORS: Record<string, string> = {
  createTexture: "texture",
  createShader: "shader",
  createProgram: "program",
  createBuffer: "buffer",
  createVertexArray: "vertexArray",
};

/**
 * Contexto WebGL2 simulado. Cualquier constante (`gl.R32F`) es un numero
 * propio y cualquier metodo se puede llamar; los que crean objetos devuelven
 * objetos distintos, y los que consultan el estado responden lo razonable.
 */
export function createFakeGl(canvas: HTMLCanvasElement): FakeGl {
  const calls: GlCall[] = [];
  const constants = new Map<string, number>();
  const liveTextures = new Set<GlObject>();
  const methods = new Map<string, (...args: unknown[]) => unknown>();
  let nextId = 1;

  const constant = (name: string): number => {
    let value = constants.get(name);
    if (value === undefined) {
      // Separadas de a 64 para que `TEXTURE0 + unidad` no choque con otra constante.
      value = 0x10000 + constants.size * 64;
      constants.set(name, value);
    }
    return value;
  };

  const state = { lost: false, failCompile: false, failTextures: false };

  function respond(name: string, args: readonly unknown[]): unknown {
    const created = CREATORS[name];
    if (created === "texture" && state.failTextures) return null;
    if (created !== undefined) {
      const object: GlObject = { kind: created, id: nextId };
      nextId += 1;
      if (created === "texture") liveTextures.add(object);
      return object;
    }
    switch (name) {
      case "deleteTexture":
        liveTextures.delete(args[0] as GlObject);
        return undefined;
      case "getShaderParameter":
      case "getProgramParameter":
        return !state.failCompile;
      case "getShaderInfoLog":
      case "getProgramInfoLog":
        return state.failCompile ? "error simulado" : "";
      case "getUniformLocation":
        return { kind: "uniform", name: args[1] };
      case "getParameter":
        if (args[0] === constant("VERSION")) return "WebGL 2.0 (simulado)";
        if (args[0] === constant("SHADING_LANGUAGE_VERSION"))
          return "WebGL GLSL ES 3.00 (simulado)";
        if (args[0] === constant("RENDERER")) return "simulado";
        return null;
      case "getExtension":
        return null;
      case "isContextLost":
        return state.lost;
      default:
        return undefined;
    }
  }

  const gl = new Proxy(
    {},
    {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        if (property === "canvas") return canvas;
        if (property === "drawingBufferWidth") return canvas.width;
        if (property === "drawingBufferHeight") return canvas.height;
        if (GL_CONSTANT.test(property)) return constant(property);
        let method = methods.get(property);
        if (method === undefined) {
          method = (...args: unknown[]) => {
            calls.push({ name: property, args });
            return respond(property, args);
          };
          methods.set(property, method);
        }
        return method;
      },
    },
  ) as WebGL2RenderingContext;

  return {
    gl,
    calls,
    callsTo: (name) => calls.filter((call) => call.name === name),
    constant,
    liveTextures,
    get lost() {
      return state.lost;
    },
    set lost(value: boolean) {
      state.lost = value;
    },
    get failCompile() {
      return state.failCompile;
    },
    set failCompile(value: boolean) {
      state.failCompile = value;
    },
    get failTextures() {
      return state.failTextures;
    },
    set failTextures(value: boolean) {
      state.failTextures = value;
    },
  };
}

// ---- Canvas 2D ------------------------------------------------------------

export interface FakeImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface DrawImageCall {
  readonly source: unknown;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Transformacion vigente al dibujar: [a, b, c, d, e, f]. */
  readonly transform: readonly number[];
  readonly smoothing: boolean;
  /** `globalCompositeOperation` vigente al dibujar. */
  readonly composite: string;
}

/** Trama creada con `createPattern`. */
export interface FakePattern {
  readonly source: unknown;
  readonly repetition: string | null;
}

export interface Fake2d {
  /** El contexto simulado, para devolver desde `getContext("2d")`. */
  readonly context: CanvasRenderingContext2D;
  /** Lo ultimo que se escribio con `putImageData`. */
  lastImageData: FakeImageData | null;
  putCount: number;
  readonly drawImages: DrawImageCall[];
  /** `fillStyle` de cada `fillRect`; si era una trama, la palabra "pattern". */
  readonly fills: string[];
  /** Tramas creadas con `createPattern`, en orden. */
  readonly patterns: FakePattern[];
  clearCount: number;
  /** Pixeles que devuelve `getImageData`, fila por fila desde arriba. */
  pixels: Uint8ClampedArray | null;
}

/** Contexto 2D simulado: registra lo que se dibuja y no dibuja nada. */
export function createFake2d(): Fake2d {
  let transform: readonly number[] = [1, 0, 0, 1, 0, 0];
  const fake: Fake2d = {
    context: null as unknown as CanvasRenderingContext2D,
    lastImageData: null,
    putCount: 0,
    drawImages: [],
    fills: [],
    patterns: [],
    clearCount: 0,
    pixels: null,
  };
  const context = {
    fillStyle: "" as unknown,
    imageSmoothingEnabled: true,
    globalCompositeOperation: "source-over",
    setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
      transform = [a, b, c, d, e, f];
    },
    clearRect() {
      fake.clearCount += 1;
    },
    fillRect() {
      fake.fills.push(typeof context.fillStyle === "string" ? context.fillStyle : "pattern");
    },
    createPattern(source: unknown, repetition: string | null): FakePattern {
      const pattern = { source, repetition };
      fake.patterns.push(pattern);
      return pattern;
    },
    createImageData(width: number, height: number): FakeImageData {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData(image: FakeImageData) {
      fake.lastImageData = image;
      fake.putCount += 1;
    },
    getImageData(_x: number, _y: number, width: number, height: number): FakeImageData {
      return { width, height, data: fake.pixels ?? new Uint8ClampedArray(width * height * 4) };
    },
    drawImage(source: unknown, left: number, top: number, width: number, height: number) {
      fake.drawImages.push({
        source,
        left,
        top,
        width,
        height,
        transform,
        smoothing: context.imageSmoothingEnabled,
        composite: context.globalCompositeOperation,
      });
    },
  };
  (fake as { context: CanvasRenderingContext2D }).context =
    context as unknown as CanvasRenderingContext2D;
  return fake;
}

// ---- Para reemplazar HTMLCanvasElement.prototype.getContext ---------------

export interface FakeCanvasContexts {
  /**
   * Reemplazo de `getContext`. Se instala asi en un test:
   *
   *   vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
   *     function (this: HTMLCanvasElement, kind: string) {
   *       return contexts.getContext(this, kind);
   *     } as never,
   *   );
   */
  getContext(canvas: HTMLCanvasElement, kind: string): unknown;
  /** Contexto 2D simulado de un canvas, si se pidio. */
  fake2d(canvas: HTMLCanvasElement): Fake2d | undefined;
  /** Contexto WebGL2 simulado de un canvas, si se pidio. */
  fakeGl(canvas: HTMLCanvasElement): FakeGl | undefined;
}

export interface FakeCanvasOptions {
  /** Con true el navegador simulado tiene WebGL2. Por defecto no: el visor dibuja con canvas 2D. */
  readonly webgl2?: boolean;
  /** Con true WebGL2 entrega el contexto pero los shaders no compilan. */
  readonly failCompile?: boolean;
}

/**
 * Contextos simulados por canvas. Como en un navegador, un canvas da siempre
 * el mismo contexto y no da uno de otro tipo.
 */
export function createFakeCanvasContexts(options: FakeCanvasOptions = {}): FakeCanvasContexts {
  const contexts2d = new WeakMap<HTMLCanvasElement, Fake2d>();
  const contextsGl = new WeakMap<HTMLCanvasElement, FakeGl>();
  return {
    getContext(canvas, kind) {
      if (kind === "webgl2") {
        if (!options.webgl2 || contexts2d.has(canvas)) return null;
        let fake = contextsGl.get(canvas);
        if (fake === undefined) {
          fake = createFakeGl(canvas);
          fake.failCompile = options.failCompile === true;
          contextsGl.set(canvas, fake);
        }
        return fake.gl;
      }
      if (kind === "2d") {
        if (contextsGl.has(canvas)) return null;
        let fake = contexts2d.get(canvas);
        if (fake === undefined) {
          fake = createFake2d();
          contexts2d.set(canvas, fake);
        }
        return fake.context;
      }
      return null;
    },
    fake2d: (canvas) => contexts2d.get(canvas),
    fakeGl: (canvas) => contextsGl.get(canvas),
  };
}
