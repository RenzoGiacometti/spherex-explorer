// Dibujo con WebGL2.
//
// docs/contrato-cubo.md, seccion 12:
// - Una textura R32F por plano, con filtro NEAREST: el filtrado lineal de
//   texturas de coma flotante necesita una extension que no siempre esta.
// - Los valores no finitos no llegan al shader. `PlaneImage` ya los reemplazo
//   por 0 y su significado va en una mascara de un byte por pixel, que se sube
//   como textura R8.
// - La fila 0 es el sur. Las texturas se suben sin UNPACK_FLIP_Y_WEBGL y la
//   fila 0 queda abajo: norte arriba, este a la izquierda.
//
// El shader hace la misma cuenta que `composeScene` (compose.ts), con las
// constantes de stretch.ts. La pagina de desarrollo /?dev=viewer compara los
// dos resultados pixel por pixel.
//
// Las texturas se guardan por plano. Cambiar de plano (el parpadeo lo hace
// varias veces por segundo) solo cambia que textura se usa: no se sube ni se
// recrea nada.

import { hatchStripe, SCENE_MODES, type Scene, sceneError, sceneHatch, sceneSize } from "./compose";
import type { PlaneImage } from "./planeImage";
import type {
  Frame,
  PixelSnapshot,
  RendererInfo,
  RendererOptions,
  SceneRenderer,
} from "./renderer";
import { ASINH_STRETCH_A, cutSpan, LOG_STRETCH_A, STRETCH_KINDS } from "./stretch";
import { backingStoreSize, imageClipRect } from "./view";

/** Planos por escena que admite el shader. */
const PLANE_SLOTS = 4;

/** Unidades de textura: valores en 0 a 3, mascaras en 4 a 7, resaltado en 8 y una libre para subir. */
const VALUES_UNIT = 0;
const MASK_UNIT = PLANE_SLOTS;
const HIGHLIGHT_UNIT = 2 * PLANE_SLOTS;
const UPLOAD_UNIT = HIGHLIGHT_UNIT + 1;

const DEFAULT_MAX_PLANES = 32;
const MAX_HIGHLIGHTS = 4;

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
};

/** Un numero como literal de coma flotante de GLSL: siempre con punto decimal. */
function glslFloat(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

const VERTEX_SHADER = `#version 300 es
// Un cuadrado de (0, 0) a (1, 1) llevado al rectangulo que ocupa la imagen.
layout(location = 0) in vec2 a_corner;
uniform vec4 u_rect;
out vec2 v_position;

void main() {
  v_position = a_corner;
  gl_Position = vec4(mix(u_rect.xy, u_rect.zw, a_corner), 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

const float LOG_A = ${glslFloat(LOG_STRETCH_A)};
const float ASINH_A = ${glslFloat(ASINH_STRETCH_A)};

const int MASK_VALID = 0;
const int MASK_SATURATED = 2;

const int MODE_SINGLE = ${SCENE_MODES.indexOf("single")};
const int MODE_DIFFERENCE = ${SCENE_MODES.indexOf("difference")};
const int MODE_SUM = ${SCENE_MODES.indexOf("sum")};

const int STRETCH_LOG = ${STRETCH_KINDS.indexOf("log")};
const int STRETCH_ASINH = ${STRETCH_KINDS.indexOf("asinh")};

uniform sampler2D u_values0;
uniform sampler2D u_values1;
uniform sampler2D u_values2;
uniform sampler2D u_values3;
uniform sampler2D u_mask0;
uniform sampler2D u_mask1;
uniform sampler2D u_mask2;
uniform sampler2D u_mask3;
uniform sampler2D u_highlight;

uniform ivec2 u_size;
uniform int u_mode;
uniform int u_count;
uniform int u_stretch;
// Corte bajo y ancho entre cortes.
uniform vec2 u_cuts;
uniform vec3 u_noData;
// Color del resaltado; con alfa 0 no hay resaltado.
uniform vec4 u_highlightColor;
// Trama del resaltado: ancho de cada franja en pixeles fisicos (0 es un color
// liso) y el segundo color.
uniform int u_hatchStripe;
uniform vec3 u_hatchAlternate;
// Alto del canvas en pixeles fisicos, para contar las filas desde arriba.
uniform int u_bufferHeight;

in vec2 v_position;
out vec4 outColor;

float asinhOf(float value) {
  return log(value + sqrt(value * value + 1.0));
}

// Curva del estirado sobre una posicion de 0 a 1.
float stretchUnit(float position) {
  if (u_stretch == STRETCH_LOG) {
    return log(1.0 + LOG_A * position) / log(1.0 + LOG_A);
  }
  if (u_stretch == STRETCH_ASINH) {
    return asinhOf(position / ASINH_A) / asinhOf(1.0 / ASINH_A);
  }
  return position;
}

// Nivel de un valor del plano: recorte entre los cortes y curva.
float level(float value) {
  return stretchUnit(clamp((value - u_cuts.x) / u_cuts.y, 0.0, 1.0));
}

int maskAt(sampler2D mask, ivec2 texel) {
  return int(texelFetch(mask, texel, 0).r * 255.0 + 0.5);
}

void accumulate(sampler2D values, sampler2D mask, ivec2 texel,
                inout float total, inout int valid, inout bool saturated) {
  int flag = maskAt(mask, texel);
  if (flag == MASK_SATURATED) {
    saturated = true;
  } else if (flag == MASK_VALID) {
    total += texelFetch(values, texel, 0).r;
    valid += 1;
  }
}

void main() {
  ivec2 texel = clamp(ivec2(floor(v_position * vec2(u_size))), ivec2(0), u_size - 1);
  vec3 color = u_noData;

  if (u_mode == MODE_SINGLE) {
    int flag = maskAt(u_mask0, texel);
    if (flag == MASK_SATURATED) {
      color = vec3(1.0);
    } else if (flag == MASK_VALID) {
      color = vec3(level(texelFetch(u_values0, texel, 0).r));
    }
  } else if (u_mode == MODE_SUM) {
    float total = 0.0;
    int valid = 0;
    bool saturated = false;
    accumulate(u_values0, u_mask0, texel, total, valid, saturated);
    if (u_count > 1) accumulate(u_values1, u_mask1, texel, total, valid, saturated);
    if (u_count > 2) accumulate(u_values2, u_mask2, texel, total, valid, saturated);
    if (u_count > 3) accumulate(u_values3, u_mask3, texel, total, valid, saturated);
    if (saturated) {
      color = vec3(1.0);
    } else if (valid > 0) {
      color = vec3(level(total / float(valid)));
    }
  } else if (maskAt(u_mask0, texel) == MASK_VALID && maskAt(u_mask1, texel) == MASK_VALID) {
    // Diferencia y rojo/cian: solo donde los dos planos tienen un valor.
    float a = texelFetch(u_values0, texel, 0).r;
    float b = texelFetch(u_values1, texel, 0).r;
    if (u_mode == MODE_DIFFERENCE) {
      // Escala simetrica: el medio rango es el ancho entre cortes.
      float ratio = (b - a) / u_cuts.y;
      float magnitude = stretchUnit(min(abs(ratio), 1.0));
      color = vec3(0.5 + 0.5 * (ratio < 0.0 ? -magnitude : magnitude));
    } else {
      float other = level(b);
      color = vec3(level(a), other, other);
    }
  }

  if (u_highlightColor.a > 0.0 && maskAt(u_highlight, texel) != 0) {
    if (u_hatchStripe > 0) {
      // La misma cuenta que hatchBand (compose.ts): pixeles fisicos desde la
      // esquina superior izquierda del canvas. gl_FragCoord cuenta desde abajo.
      ivec2 pixel = ivec2(gl_FragCoord.xy);
      int band = ((pixel.x + u_bufferHeight - 1 - pixel.y) / u_hatchStripe) % 2;
      color = band == 0 ? u_highlightColor.rgb : u_hatchAlternate;
    } else {
      color = mix(color, u_highlightColor.rgb, u_highlightColor.a);
    }
  }
  // El redondeo a 8 bits se hace aca, igual que en la referencia. Si se deja a
  // la placa, la conversion admite tolerancia y un pixel de cada treinta sale
  // un nivel corrido (medido con ANGLE sobre Direct3D 11).
  outColor = vec4(floor(clamp(color, 0.0, 1.0) * 255.0 + 0.5) / 255.0, 1.0);
}
`;

const SAMPLER_UNITS: ReadonlyArray<readonly [name: string, unit: number]> = [
  ["u_values0", VALUES_UNIT],
  ["u_values1", VALUES_UNIT + 1],
  ["u_values2", VALUES_UNIT + 2],
  ["u_values3", VALUES_UNIT + 3],
  ["u_mask0", MASK_UNIT],
  ["u_mask1", MASK_UNIT + 1],
  ["u_mask2", MASK_UNIT + 2],
  ["u_mask3", MASK_UNIT + 3],
  ["u_highlight", HIGHLIGHT_UNIT],
];

const UNIFORM_NAMES = [
  "u_rect",
  "u_size",
  "u_mode",
  "u_count",
  "u_stretch",
  "u_cuts",
  "u_noData",
  "u_highlightColor",
  "u_hatchStripe",
  "u_hatchAlternate",
  "u_bufferHeight",
] as const;

type UniformName = (typeof UNIFORM_NAMES)[number];

/** Lo que hay que volver a crear si el contexto se pierde. */
interface Resources {
  readonly program: WebGLProgram;
  readonly vertexArray: WebGLVertexArrayObject;
  readonly corners: WebGLBuffer;
  readonly uniforms: Record<UniformName, WebGLUniformLocation | null>;
}

interface PlaneTextures {
  readonly values: WebGLTexture;
  readonly mask: WebGLTexture;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("WebGL2 no pudo crear un shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "";
    gl.deleteShader(shader);
    throw new Error(`el shader no compila: ${log}`);
  }
  return shader;
}

function createResources(gl: WebGL2RenderingContext): Resources {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (program === null) throw new Error("WebGL2 no pudo crear el programa");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  // Una vez enlazado el programa, los shaders sueltos no hacen falta.
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "";
    gl.deleteProgram(program);
    throw new Error(`el programa no enlaza: ${log}`);
  }

  const vertexArray = gl.createVertexArray();
  const corners = gl.createBuffer();
  if (vertexArray === null || corners === null) {
    gl.deleteProgram(program);
    throw new Error("WebGL2 no pudo crear la geometria");
  }
  gl.bindVertexArray(vertexArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // biome-ignore lint/correctness/useHookAtTopLevel: useProgram es de WebGL, no un hook de React
  gl.useProgram(program);
  for (const [name, unit] of SAMPLER_UNITS) {
    gl.uniform1i(gl.getUniformLocation(program, name), unit);
  }
  const uniforms = {} as Record<UniformName, WebGLUniformLocation | null>;
  for (const name of UNIFORM_NAMES) {
    uniforms[name] = gl.getUniformLocation(program, name);
  }

  // Un byte por pixel y anchos impares (195 o 293): sin relleno al final de cada fila.
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  // El resultado tiene que ser el mismo en todas las placas.
  gl.disable(gl.DITHER);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);

  return { program, vertexArray, corners, uniforms };
}

function readInfo(gl: WebGL2RenderingContext): RendererInfo {
  const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  return {
    kind: "webgl2",
    version: text(gl.getParameter(gl.VERSION)),
    shadingLanguageVersion: text(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
    gpu: text(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
  };
}

/**
 * Crea el dibujo con WebGL2 sobre un canvas. Devuelve null si el navegador no
 * da un contexto WebGL2 o si el shader no compila; en el segundo caso el
 * canvas ya quedo ligado a WebGL y el dibujo con canvas 2D necesita otro.
 */
export function createWebglRenderer(
  canvas: HTMLCanvasElement,
  options: RendererOptions = {},
): SceneRenderer | null {
  let context: WebGL2RenderingContext | null = null;
  try {
    context = canvas.getContext("webgl2", CONTEXT_ATTRIBUTES);
  } catch {
    context = null;
  }
  if (context === null || context.isContextLost()) return null;
  const gl = context;

  let resources: Resources | null;
  try {
    resources = createResources(gl);
  } catch (error) {
    console.warn("visor: WebGL2 no esta disponible, se dibuja con canvas 2D", error);
    return null;
  }

  const info = readInfo(gl);
  const maxPlanes = Math.max(PLANE_SLOTS, options.maxPlanes ?? DEFAULT_MAX_PLANES);
  // Los Map conservan el orden de insercion: el primero es el que hace mas que no se usa.
  const planeTextures = new Map<PlaneImage, PlaneTextures>();
  const highlightTextures = new Map<Uint8Array, WebGLTexture>();
  let lastFrame: Frame | null = null;
  let lost = false;
  let disposed = false;

  function createTexture(
    internalFormat: number,
    type: number,
    width: number,
    height: number,
    data: ArrayBufferView,
  ): WebGLTexture {
    const texture = gl.createTexture();
    if (texture === null) throw new Error("WebGL2 no pudo crear una textura");
    gl.activeTexture(gl.TEXTURE0 + UPLOAD_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RED, type, data);
    return texture;
  }

  /** Texturas de un plano: las guardadas o, la primera vez, recien subidas. */
  function texturesFor(plane: PlaneImage): PlaneTextures {
    let textures = planeTextures.get(plane);
    if (textures === undefined) {
      textures = {
        values: createTexture(gl.R32F, gl.FLOAT, plane.width, plane.height, plane.values),
        mask: createTexture(gl.R8, gl.UNSIGNED_BYTE, plane.width, plane.height, plane.mask),
      };
    } else {
      planeTextures.delete(plane);
    }
    // Pasa al final: es el usado mas recientemente.
    planeTextures.set(plane, textures);
    return textures;
  }

  function highlightTextureFor(mask: Uint8Array, width: number, height: number): WebGLTexture {
    let texture = highlightTextures.get(mask);
    if (texture === undefined) {
      texture = createTexture(gl.R8, gl.UNSIGNED_BYTE, width, height, mask);
    } else {
      highlightTextures.delete(mask);
    }
    highlightTextures.set(mask, texture);
    return texture;
  }

  /** Descarta lo que hace mas que no se usa cuando se pasa el tope. */
  function evict(): void {
    for (const [plane, textures] of planeTextures) {
      if (planeTextures.size <= maxPlanes) break;
      gl.deleteTexture(textures.values);
      gl.deleteTexture(textures.mask);
      planeTextures.delete(plane);
    }
    for (const [mask, texture] of highlightTextures) {
      if (highlightTextures.size <= MAX_HIGHLIGHTS) break;
      gl.deleteTexture(texture);
      highlightTextures.delete(mask);
    }
  }

  function bind(unit: number, texture: WebGLTexture): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }

  function drawScene(scene: Scene, frame: Frame, active: Resources): void {
    const image = sceneSize(scene);
    const [red, green, blue] = scene.noDataColor;
    gl.clearColor(red, green, blue, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // biome-ignore lint/correctness/useHookAtTopLevel: useProgram es de WebGL, no un hook de React
    gl.useProgram(active.program);
    gl.bindVertexArray(active.vertexArray);

    // Las unidades que la escena no usa repiten el primer plano, para que
    // ninguna quede sin textura.
    const first = texturesFor(scene.planes[0] as PlaneImage);
    for (let slot = 0; slot < PLANE_SLOTS; slot += 1) {
      const plane = scene.planes[slot];
      const textures = plane === undefined ? first : texturesFor(plane);
      bind(VALUES_UNIT + slot, textures.values);
      bind(MASK_UNIT + slot, textures.mask);
    }
    const highlight = scene.highlight ?? null;
    const highlightOn = highlight !== null && highlight.color[3] > 0;
    bind(
      HIGHLIGHT_UNIT,
      highlightOn ? highlightTextureFor(highlight.mask, image.width, image.height) : first.mask,
    );

    const { uniforms } = active;
    const [x0, y0, x1, y1] = imageClipRect(frame.transform, image, frame.viewport);
    gl.uniform4f(uniforms.u_rect, x0, y0, x1, y1);
    gl.uniform2i(uniforms.u_size, image.width, image.height);
    gl.uniform1i(uniforms.u_mode, SCENE_MODES.indexOf(scene.mode));
    gl.uniform1i(uniforms.u_count, scene.planes.length);
    gl.uniform1i(uniforms.u_stretch, STRETCH_KINDS.indexOf(scene.stretch));
    gl.uniform2f(uniforms.u_cuts, scene.cuts.low, cutSpan(scene.cuts));
    gl.uniform3f(uniforms.u_noData, red, green, blue);
    if (highlightOn) {
      const [r, g, b, a] = highlight.color;
      gl.uniform4f(uniforms.u_highlightColor, r, g, b, a);
    } else {
      gl.uniform4f(uniforms.u_highlightColor, 0, 0, 0, 0);
    }
    const hatch = sceneHatch(scene);
    if (hatch === null) {
      gl.uniform1i(uniforms.u_hatchStripe, 0);
      gl.uniform3f(uniforms.u_hatchAlternate, 0, 0, 0);
    } else {
      // Pixeles fisicos por pixel CSS con los que quedo el canvas, no la
      // densidad pedida: el canvas tiene un lado maximo (`backingStoreSize`).
      const width = frame.viewport.width > 0 ? frame.viewport.width : 1;
      gl.uniform1i(uniforms.u_hatchStripe, hatchStripe(gl.drawingBufferWidth / width));
      const [r, g, b] = hatch.alternate;
      gl.uniform3f(uniforms.u_hatchAlternate, r, g, b);
    }
    gl.uniform1i(uniforms.u_bufferHeight, gl.drawingBufferHeight);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    evict();
  }

  function draw(frame: Frame): void {
    if (disposed) return;
    // Una escena que no es valida no se dibuja ni se recuerda. Se limpia el
    // canvas, para que no quede a la vista el cuadro anterior con los rotulos
    // de afuera ya cambiados, y recien entonces se avisa.
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
    if (lost || resources === null || gl.isContextLost()) return;

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    if (frame.scene === null) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    drawScene(frame.scene, frame, resources);
  }

  function readPixels(): PixelSnapshot | null {
    if (disposed || lastFrame === null || lost || resources === null || gl.isContextLost()) {
      return null;
    }
    // El buffer no se conserva entre cuadros: se dibuja y se lee en el mismo paso.
    paint(lastFrame);
    const width = gl.drawingBufferWidth;
    const height = gl.drawingBufferHeight;
    const data = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return { width, height, data };
  }

  function forget(plane: PlaneImage): void {
    const textures = planeTextures.get(plane);
    if (textures === undefined) return;
    planeTextures.delete(plane);
    if (!lost) {
      gl.deleteTexture(textures.values);
      gl.deleteTexture(textures.mask);
    }
  }

  function onContextLost(event: Event): void {
    // Sin esto el navegador no intenta devolver el contexto.
    event.preventDefault();
    lost = true;
    // Todo lo creado en el contexto dejo de existir: no hay nada que borrar.
    resources = null;
    planeTextures.clear();
    highlightTextures.clear();
    options.onContextLost?.();
  }

  function onContextRestored(): void {
    if (disposed) return;
    try {
      resources = createResources(gl);
    } catch (error) {
      console.warn("visor: no se pudo recuperar el contexto de WebGL2", error);
      return;
    }
    lost = false;
    try {
      if (lastFrame !== null) paint(lastFrame);
    } catch (error) {
      // Se avisa igual que el contexto volvio: quien escucha puede pedir otro cuadro.
      console.warn("visor: no se pudo volver a dibujar el ultimo cuadro", error);
    }
    options.onContextRestored?.();
  }

  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener("webglcontextlost", onContextLost);
    canvas.removeEventListener("webglcontextrestored", onContextRestored);
    if (!lost && resources !== null) {
      for (const textures of planeTextures.values()) {
        gl.deleteTexture(textures.values);
        gl.deleteTexture(textures.mask);
      }
      for (const texture of highlightTextures.values()) gl.deleteTexture(texture);
      gl.deleteBuffer(resources.corners);
      gl.deleteVertexArray(resources.vertexArray);
      gl.deleteProgram(resources.program);
    }
    planeTextures.clear();
    highlightTextures.clear();
    resources = null;
    lastFrame = null;
    // El contexto no se suelta a proposito: el canvas puede volver a usarse
    // (React monta, desmonta y vuelve a montar en desarrollo) y getContext
    // devuelve siempre el mismo.
  }

  return { info, draw, readPixels, forget, dispose };
}
