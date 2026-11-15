// Esfera celeste vista desde adentro, con three.js (SPEC.md, Etapa 4).
//
// La camara esta en el centro y la textura de todo el cielo va pegada por
// dentro de una esfera. La malla no es la SphereGeometry de three.js: cada
// vertice se calcula con `raDecToVector` y su coordenada de textura con la
// misma convencion (skyMath.ts), asi la imagen y los marcadores no pueden
// quedar desalineados ni espejados entre si.
//
// La clase no sabe de React ni de punteros: guarda la vista, la anima
// (inercia, deriva, vuelo a un punto, orientacion del telefono) y dibuja solo
// cuando algo cambio. Los gestos estan en skyControls.ts.
//
// Niveles de detalle, de lejos a cerca:
//
// 1. El mapa de 4k, con el que arranca.
// 2. El mismo mapa en 8k (`detailTextureUrl`): se pide cuando el campo de
//    vision baja de DETAIL_FOV y reemplaza al de 4k con un fundido.
// 3. Los parches (`patches`): la imagen real de SPHEREx de cada campo
//    precalculado, sobre el plano tangente en el centro del campo. Aparecen
//    cuando ocupan suficientes pixeles, y `flyToPatch` termina el
//    acercamiento sobre uno de ellos.

import {
  Box2,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  ImageBitmapLoader,
  LinearFilter,
  LinearMipmapLinearFilter,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import {
  clamp,
  DEG,
  QUAT_IDENTITY,
  type Quat,
  quatAngle,
  quatNormalize,
  quatRotate,
  quatSlerp,
  raDecToVector,
  type SkyPosition,
  slerpDirection,
  textureUvToRaDec,
  type Vec3,
  vectorToRaDec,
  wrapDegrees,
} from "./skyMath";

/**
 * Vista con el norte arriba: centro y campo de vision en grados. El campo se
 * mide sobre el lado mas largo de la ventana, para que un telefono en vertical
 * y un monitor apaisado muestren una porcion parecida de cielo.
 */
export interface SkyView {
  readonly ra: number;
  readonly dec: number;
  readonly fov: number;
}

/**
 * Limite del acercamiento a mano (rueda, pellizco, teclado). Con 1,5 grados un
 * parche de 10 minutos de arco ocupa cerca de un decimo del lado largo de la
 * ventana. Mas cerca solo llegan los vuelos a un parche.
 */
export const MIN_FOV = 1.5;
export const MAX_FOV = 120;
export const DEFAULT_FOV = 100;

/** Limite del acercamiento de un vuelo a un parche. */
const FLIGHT_MIN_FOV = 0.05;

/**
 * Por debajo de este campo de vision se pide el mapa de 8k. El de 4k tiene
 * 11,4 pixeles por grado: con 70 grados en una ventana de 1920 px la pantalla
 * ya muestra 27 pixeles por grado y la imagen se ve blanda.
 */
export const DETAIL_FOV = 70;
/** Lado mayor del mapa de 8k: la tarjeta tiene que admitir texturas de este tamano. */
const DETAIL_TEXTURE_SIZE = 8192;
/** Duracion del fundido del mapa de 4k al de 8k, en milisegundos. */
const DETAIL_FADE_MS = 900;
/**
 * Subir el mapa de 8k entero a la tarjeta congela la pagina unos 0,3 segundos
 * (medido en una GeForce GTX 1070). Por eso sube de a franjas de estas filas,
 * repartidas en varios cuadros.
 */
const DETAIL_STRIP_ROWS = 128;
/** Milisegundos por cuadro que se le dan a la subida de franjas. */
const DETAIL_UPLOAD_BUDGET_MS = 4;
/**
 * Tiempo sin gestos, en milisegundos, que se espera para pedir el mapa de 8k
 * despues de un vuelo, y para subirlo de una vez donde no se puede por franjas.
 */
const QUIET_MS = 250;

/** La vista con el norte arriba no llega al polo: ahi el "arriba" no esta definido. */
const MAX_DEC = 88;

const SPHERE_RADIUS = 100;

/**
 * Muy cerca, el mapa ya no tiene mas detalle y queda como una mancha borrosa.
 * Por debajo de este campo de vision se lo va apagando, hasta DEEP_SKY_DIM en
 * el limite del acercamiento, para que lo que se destaque sean los parches.
 */
const DEEP_SKY_FOV = 6;
const DEEP_SKY_DIM = 0.55;

/** Las lineas (constelaciones) van entre el mapa y los parches. */
const LINE_RADIUS = SPHERE_RADIUS * 0.99;
/** Opacidad de las lineas: son una referencia, no tienen que competir con el cielo. */
const LINE_OPACITY = 0.6;

/** Los parches van apenas por delante de la esfera. */
const PATCH_RADIUS = SPHERE_RADIUS * 0.98;
/** Un parche empieza a verse cuando su lado ocupa estos pixeles, y se ve entero con estos otros. */
const PATCH_FADE_START_PX = 32;
const PATCH_FADE_END_PX = 96;
/** Tiempo minimo del fundido de un parche, en segundos: no aparece de golpe en un vuelo rapido. */
const PATCH_FADE_TIME = 0.25;
/** Por debajo de este campo de vision se piden las imagenes de los parches que estan a la vista. */
const PATCH_PRELOAD_FOV = 30;
/** Al final de un vuelo a un parche, la imagen ocupa esta fraccion del lado corto de la ventana. */
const PATCH_FIT = 0.86;
/** Tiempo que se le suma a un vuelo a un parche: el acercamiento es mucho mas largo. */
const PATCH_FLIGHT_EXTRA_MS = 900;
/** Espera maxima al llegar, si la imagen del parche todavia no termino de aparecer. */
const PATCH_HOLD_MS = 800;
const SEGMENTS_U = 96;
const SEGMENTS_V = 48;

/** Tiempo en que la velocidad de la inercia cae a 1/e, en segundos. */
const INERTIA_TIME = 0.4;
/** Por debajo de esta velocidad (grados por segundo) la inercia se corta. */
const INERTIA_MIN_SPEED = 0.4;
/** Con la vista muy cerca el corte se mide en pixeles por segundo, o la inercia no llegaria a verse. */
const INERTIA_MIN_SPEED_PX = 8;
const INERTIA_MAX_SPEED = 400;
/** Con que rapidez la camara sigue al sensor de orientacion (1/s). */
const ORIENTATION_FOLLOW = 14;
/** Por debajo de este angulo (grados) entre la camara y el sensor, la camara ya llego. */
const ORIENTATION_REST = 1e-3;
/** Tiempo, en segundos, en que la vista vuelve al norte arriba al salir de la orientacion libre. */
const SETTLE_TIME = 0.45;
/** Hacia donde mira la camara en sus propios ejes. */
const CAMERA_FORWARD: Vec3 = [0, 0, -1];

export interface FlyOptions {
  /** Campo de vision al llegar. Por defecto, el actual. */
  readonly fov?: number;
  /** Duracion en milisegundos. Por defecto depende de la distancia. */
  readonly duration?: number;
  /** Avance del vuelo, de 0 a 1, en cada cuadro. */
  readonly onProgress?: (progress: number) => void;
}

/** Imagen de un campo que se dibuja sobre el cielo (patches.ts). */
export interface SkyPatchSpec extends SkyPosition {
  readonly id: string;
  readonly url: string;
  /** Lados sobre el plano tangente, en grados de la proyeccion TAN: este-oeste y norte-sur. */
  readonly widthDeg: number;
  readonly heightDeg: number;
}

/** Opciones del vuelo a un parche. */
export interface PatchFlyOptions extends Omit<FlyOptions, "fov"> {
  /**
   * Franja, en pixeles, que tiene que quedar libre arriba y abajo de la imagen
   * al llegar (la barra superior de quien usa la esfera). Por defecto, nada.
   */
  readonly inset?: number | undefined;
}

export interface SkySceneOptions {
  /** Elemento que contiene al canvas; la escena lo crea y lo agrega al principio. */
  readonly container: HTMLElement;
  readonly textureUrl: string;
  /**
   * El mismo mapa con el doble de resolucion (8192 px de ancho). Se pide recien
   * cuando la vista se acerca, y solo si la tarjeta admite texturas de ese
   * tamano. Sin el, la esfera se queda con `textureUrl`.
   */
  readonly detailTextureUrl?: string | undefined;
  /** Imagenes de campos que aparecen al acercarse. */
  readonly patches?: readonly SkyPatchSpec[] | undefined;
  readonly canvasClassName?: string;
  readonly initialView?: SkyView;
  /** Grados por segundo de la deriva inicial; 0 la apaga. */
  readonly driftRate?: number;
  /** Sin animaciones: sin inercia ni deriva, y los vuelos son saltos. */
  readonly reducedMotion?: boolean;
  /** Despues de cada cuadro dibujado. */
  readonly onFrame?: (scene: SkyScene) => void;
  readonly onTextureLoad?: () => void;
  readonly onTextureError?: () => void;
}

interface Flight {
  readonly fromDirection: Vec3;
  readonly toDirection: Vec3;
  readonly fromFov: number;
  readonly toFov: number;
  readonly duration: number;
  /** Fraccion del vuelo en la que termina el giro. */
  readonly turnEnd: number;
  /** Fraccion del vuelo en la que empieza el acercamiento. */
  readonly zoomStart: number;
  /** Parche al que va el vuelo: al llegar se espera a que su imagen se vea entera. */
  readonly patch: PatchLayer | null;
  readonly onProgress: ((progress: number) => void) | undefined;
  readonly resolve: (arrived: boolean) => void;
  start: number | null;
  arrivedAt: number | null;
}

/** Un parche en la escena. La imagen se pide recien cuando hace falta. */
interface PatchLayer {
  readonly spec: SkyPatchSpec;
  readonly direction: Vec3;
  /** Lado menor en grados: con el se mide cuanto ocupa en pantalla. */
  readonly sizeDeg: number;
  readonly geometry: BufferGeometry;
  readonly material: MeshBasicMaterial;
  readonly mesh: Mesh;
  texture: Texture | null;
  state: "idle" | "loading" | "ready" | "failed";
  opacity: number;
}

/**
 * Mapa de 8k. `decoded`: la imagen ya esta en memoria. `uploading`: sube a la
 * tarjeta de a franjas. `fading`: se dibuja encima del de 4k con opacidad
 * creciente. `done`: reemplazo al de 4k.
 */
export type SkyDetailState =
  | "idle"
  | "loading"
  | "decoded"
  | "uploading"
  | "fading"
  | "done"
  | "failed";

/**
 * Rectangulo plano, tangente a la esfera en el centro del campo. La camara esta
 * en el centro de la esfera, asi que lo ve en proyeccion gnomonica, que es la
 * TAN del campo: cada pixel de la imagen cae en su lugar del cielo.
 *
 * La imagen tiene el norte arriba y el este a la izquierda: su esquina superior
 * izquierda va al noreste. Los ejes este y norte salen de derivar
 * `raDecToVector`, la misma funcion que ubica la malla y los marcadores.
 */
function buildPatchGeometry(patch: SkyPatchSpec): BufferGeometry {
  const ra = patch.ra * DEG;
  const dec = patch.dec * DEG;
  const center = raDecToVector(patch.ra, patch.dec);
  const east: Vec3 = [-Math.sin(ra), 0, -Math.cos(ra)];
  const north: Vec3 = [-Math.sin(dec) * Math.cos(ra), Math.cos(dec), Math.sin(dec) * Math.sin(ra)];
  // En TAN, un grado de la proyeccion es pi/180 del radio sobre el plano tangente.
  const halfEast = (PATCH_RADIUS * patch.widthDeg * DEG) / 2;
  const halfNorth = (PATCH_RADIUS * patch.heightDeg * DEG) / 2;
  // [este, norte, u, v], con v = 1 en el borde superior de la imagen.
  const corners: readonly (readonly [number, number, number, number])[] = [
    [1, 1, 0, 1],
    [-1, 1, 1, 1],
    [1, -1, 0, 0],
    [-1, -1, 1, 0],
  ];
  const positions = new Float32Array(12);
  const uvs = new Float32Array(8);
  corners.forEach(([e, n, u, v], index) => {
    for (let axis = 0; axis < 3; axis += 1) {
      positions[index * 3 + axis] =
        (center[axis] as number) * PATCH_RADIUS +
        (east[axis] as number) * e * halfEast +
        (north[axis] as number) * n * halfNorth;
    }
    uvs[index * 2] = u;
    uvs[index * 2 + 1] = v;
  });
  const geometry = new BufferGeometry();
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  return geometry;
}

/** Curva suave de 0 a 1 entre dos bordes. */
function smoothstep(from: number, to: number, value: number): number {
  const t = clamp((value - from) / (to - from), 0, 1);
  return t * t * (3 - 2 * t);
}

function buildSkyGeometry(): BufferGeometry {
  const columns = SEGMENTS_U + 1;
  const rows = SEGMENTS_V + 1;
  const positions = new Float32Array(columns * rows * 3);
  const uvs = new Float32Array(columns * rows * 2);
  let p = 0;
  let t = 0;
  for (let row = 0; row < rows; row += 1) {
    const v = row / SEGMENTS_V;
    for (let column = 0; column < columns; column += 1) {
      const u = column / SEGMENTS_U;
      const { ra, dec } = textureUvToRaDec(u, v);
      const [x, y, z] = raDecToVector(ra, dec);
      positions[p] = x * SPHERE_RADIUS;
      positions[p + 1] = y * SPHERE_RADIUS;
      positions[p + 2] = z * SPHERE_RADIUS;
      p += 3;
      uvs[t] = u;
      uvs[t + 1] = v;
      t += 2;
    }
  }
  const indices: number[] = [];
  for (let row = 0; row < SEGMENTS_V; row += 1) {
    for (let column = 0; column < SEGMENTS_U; column += 1) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  return geometry;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}

/** Duracion de un vuelo segun la distancia angular: de 0,9 a 2,6 segundos. */
function flightDuration(from: Vec3, to: Vec3): number {
  const cosine = clamp(from[0] * to[0] + from[1] * to[1] + from[2] * to[2], -1, 1);
  const degrees = Math.acos(cosine) / DEG;
  return clamp(900 + degrees * 12, 900, 2600);
}

export class SkyScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(60, 1, 0.1, SPHERE_RADIUS * 4);
  private readonly geometry: BufferGeometry;
  private readonly material: MeshBasicMaterial;
  private readonly mesh: Mesh;
  private texture: Texture | null = null;

  // Mapa de 8k: se pide al acercarse y reemplaza al de 4k con un fundido.
  private readonly detailUrl: string | undefined;
  private detailState: SkyDetailState = "idle";
  private detailTexture: Texture | null = null;
  private detailBitmap: ImageBitmap | null = null;
  /** Envuelve a `detailBitmap` para copiarlo de a franjas; nunca sube entero a la tarjeta. */
  private detailSource: Texture | null = null;
  /** Primera fila del mapa de 8k que todavia no subio. */
  private detailRow = 0;
  private readonly stripRegion = new Box2();
  private readonly stripTarget = new Vector2();
  private detailMaterial: MeshBasicMaterial | null = null;
  private detailMesh: Mesh | null = null;
  private detailFadeStart = 0;
  /** Momento del ultimo gesto, en el reloj de `performance.now()`. */
  private lastInput = 0;
  /** Momento en que llego el ultimo vuelo: justo despues no se pide el mapa de 8k. */
  private flightEndedAt = -QUIET_MS;
  /** Cuanto se oscurece el cielo, de 0 a 1. Los parches no se oscurecen. */
  private skyDim = 0;

  private readonly patches: PatchLayer[] = [];

  // Lineas sobre el cielo (figuras de las constelaciones).
  private lineGeometry: BufferGeometry | null = null;
  private lineMaterial: LineBasicMaterial | null = null;
  private lineMesh: LineSegments | null = null;

  private readonly onFrame: ((scene: SkyScene) => void) | undefined;
  private readonly reducedMotion: boolean;

  private width = 1;
  private height = 1;

  // Vista con el norte arriba.
  private ra: number;
  private dec: number;
  private fov: number;

  // Orientacion libre (ventana al cielo): la camara toma el cuaternion del
  // sensor tal cual, sin pasar por ascension recta, declinacion ni `lookAt`,
  // asi que no hay un "arriba" de referencia que falle en los polos.
  private free = false;
  private freeQuat: Quat = QUAT_IDENTITY;
  private targetQuat: Quat = QUAT_IDENTITY;
  // Al salir de la orientacion libre la vista gira hasta el norte arriba en
  // vez de saltar: orientacion de la que sale y segundos que le quedan.
  private settleFrom: Quat | null = null;
  private settleLeft = 0;

  private velocityRa = 0;
  private velocityDec = 0;
  private driftRate: number;
  private flight: Flight | null = null;

  private readonly forward = new Vector3(1, 0, 0);
  private readonly scratch = new Vector3();

  private dirty = true;
  private disposed = false;
  private frameHandle = 0;
  private lastTime: number | null = null;

  /** Lanza un error si el navegador no puede crear el contexto WebGL. */
  constructor(options: SkySceneOptions) {
    const view = options.initialView ?? { ra: 0, dec: 0, fov: DEFAULT_FOV };
    this.ra = wrapDegrees(view.ra);
    this.dec = clamp(view.dec, -MAX_DEC, MAX_DEC);
    this.fov = clamp(view.fov, MIN_FOV, MAX_FOV);
    this.onFrame = options.onFrame;
    this.reducedMotion = options.reducedMotion ?? false;
    this.driftRate = this.reducedMotion ? 0 : (options.driftRate ?? 0);

    // Fondo transparente: lo que no cubre la esfera deja ver el negro de la pagina.
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = this.renderer.domElement;
    if (options.canvasClassName !== undefined) canvas.className = options.canvasClassName;
    canvas.setAttribute("aria-hidden", "true");
    options.container.prepend(canvas);

    this.geometry = buildSkyGeometry();
    // La camara mira la cara interior; con las dos caras no importa el orden de los triangulos.
    this.material = new MeshBasicMaterial({
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    // Hasta que llega la textura no se dibuja nada: queda el negro del lienzo.
    this.mesh.visible = false;
    this.scene.add(this.mesh);

    this.detailUrl =
      this.renderer.capabilities.maxTextureSize >= DETAIL_TEXTURE_SIZE
        ? options.detailTextureUrl
        : undefined;

    for (const spec of options.patches ?? []) {
      const geometry = buildPatchGeometry(spec);
      const material = new MeshBasicMaterial({
        side: DoubleSide,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0,
      });
      const mesh = new Mesh(geometry, material);
      mesh.visible = false;
      // Despues del cielo y del mapa de 8k que se esta fundiendo.
      mesh.renderOrder = 2;
      this.scene.add(mesh);
      this.patches.push({
        spec,
        direction: raDecToVector(spec.ra, spec.dec),
        sizeDeg: Math.min(spec.widthDeg, spec.heightDeg),
        geometry,
        material,
        mesh,
        texture: null,
        state: "idle",
        opacity: 0,
      });
    }

    new TextureLoader().load(
      options.textureUrl,
      (texture) => {
        if (this.disposed) {
          texture.dispose();
          return;
        }
        texture.colorSpace = SRGBColorSpace;
        texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        this.texture = texture;
        this.material.map = texture;
        this.material.needsUpdate = true;
        this.mesh.visible = true;
        this.dirty = true;
        options.onTextureLoad?.();
      },
      undefined,
      () => {
        if (!this.disposed) options.onTextureError?.();
      },
    );

    this.applyCamera();
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  // ---- Tamano y lectura ---------------------------------------------------

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.applyCamera();
    this.dirty = true;
  }

  /** Pide un cuadro nuevo aunque la vista no haya cambiado (por ejemplo, cambiaron los marcadores). */
  invalidate(): void {
    this.dirty = true;
  }

  /** Centro de lo que se ve y campo de vision. En orientacion libre el centro sale del sensor. */
  getView(): SkyView {
    if (!this.free) return { ra: this.ra, dec: this.dec, fov: this.fov };
    const center = vectorToRaDec(quatRotate(this.freeQuat, CAMERA_FORWARD));
    return { ra: center.ra, dec: center.dec, fov: this.fov };
  }

  /** Campo de vision vertical en grados, que es el que usa la camara. */
  private verticalFov(): number {
    const aspect = this.width / this.height;
    if (aspect <= 1) return this.fov;
    return (2 * Math.atan(Math.tan((this.fov * DEG) / 2) / aspect)) / DEG;
  }

  /** Grados de cielo por pixel de pantalla en el centro de la vista. */
  degreesPerPixel(): number {
    return this.verticalFov() / this.height;
  }

  /**
   * Posicion en pantalla (pixeles CSS desde la esquina superior izquierda) de
   * un punto del cielo. Devuelve false si queda detras o fuera de la vista.
   */
  project(position: SkyPosition, out: { x: number; y: number }): boolean {
    const [x, y, z] = raDecToVector(position.ra, position.dec);
    this.scratch.set(x, y, z);
    if (this.scratch.dot(this.forward) < 0.05) return false;
    this.scratch.project(this.camera);
    out.x = (this.scratch.x + 1) * 0.5 * this.width;
    out.y = (1 - this.scratch.y) * 0.5 * this.height;
    return Math.abs(this.scratch.x) <= 1.15 && Math.abs(this.scratch.y) <= 1.15;
  }

  /**
   * Dibuja lineas sobre el cielo, o las saca con null. Cada linea es una lista
   * plana RA, Dec, RA, Dec... en grados, y sus puntos se unen con tramos
   * rectos: vistos desde el centro de la esfera son arcos de circulo maximo.
   * `color` es un color CSS (sin el, blanco); las lineas de WebGL miden siempre un pixel.
   */
  setLines(lines: readonly (readonly number[])[] | null, color?: string): void {
    if (this.lineMesh !== null) this.scene.remove(this.lineMesh);
    this.lineGeometry?.dispose();
    this.lineMaterial?.dispose();
    this.lineGeometry = null;
    this.lineMaterial = null;
    this.lineMesh = null;
    this.dirty = true;
    if (lines === null || this.disposed) return;

    const positions: number[] = [];
    for (const line of lines) {
      for (let index = 0; index + 3 < line.length; index += 2) {
        const from = raDecToVector(line[index] as number, line[index + 1] as number);
        const to = raDecToVector(line[index + 2] as number, line[index + 3] as number);
        positions.push(
          from[0] * LINE_RADIUS,
          from[1] * LINE_RADIUS,
          from[2] * LINE_RADIUS,
          to[0] * LINE_RADIUS,
          to[1] * LINE_RADIUS,
          to[2] * LINE_RADIUS,
        );
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
    const material = new LineBasicMaterial({
      transparent: true,
      opacity: LINE_OPACITY,
      depthTest: false,
      depthWrite: false,
    });
    if (color !== undefined) material.color.set(color);
    const mesh = new LineSegments(geometry, material);
    mesh.frustumCulled = false;
    // Sobre el mapa (y el de 8k que se esta fundiendo), debajo de los parches.
    mesh.renderOrder = 1.5;
    this.scene.add(mesh);
    this.lineGeometry = geometry;
    this.lineMaterial = material;
    this.lineMesh = mesh;
  }

  /**
   * Punto del cielo que se ve en una posicion de la pantalla (pixeles CSS desde
   * la esquina superior izquierda). Es la inversa de `project`.
   */
  unproject(x: number, y: number): SkyPosition {
    this.scratch
      .set((x / this.width) * 2 - 1, 1 - (y / this.height) * 2, 0.5)
      .unproject(this.camera);
    // La camara esta en el centro de la esfera: el punto es una direccion.
    return vectorToRaDec([this.scratch.x, this.scratch.y, this.scratch.z]);
  }

  // ---- Movimiento con el norte arriba -------------------------------------
  //
  // El arrastre, la rueda y el teclado mueven una vista que siempre tiene el
  // norte arriba (ascension recta y declinacion del centro), que es como se ve
  // un campo en el visor. Esa referencia tiene un limite conocido cerca de los
  // polos celestes, que no es un salto sino un tope:
  //
  // - La declinacion del centro no pasa de MAX_DEC: no se puede cruzar el polo
  //   arrastrando, hay que rodearlo.
  // - Por encima de unos 78 grados, el arrastre horizontal mueve el cielo mas
  //   despacio que el dedo (`cosDecLimit`), porque girar alrededor del polo lo
  //   que pide el dedo haria dar vueltas la imagen.
  //
  // Sacarlo pide un arrastre de orientacion libre (el cielo sigue al dedo con un
  // cuaternion, como en la ventana al cielo) y decidir cuando y como vuelve el
  // norte arriba, del que dependen los vuelos y los parches. Queda anotado.

  setView(view: Partial<SkyView>): void {
    if (view.ra !== undefined) this.ra = wrapDegrees(view.ra);
    if (view.dec !== undefined) this.dec = clamp(view.dec, -MAX_DEC, MAX_DEC);
    if (view.fov !== undefined) this.fov = clamp(view.fov, MIN_FOV, MAX_FOV);
    this.dirty = true;
  }

  /**
   * Arrastre: el cielo sigue al puntero. Arrastrar a la derecha trae lo que
   * estaba a la izquierda, que es el este: la ascension recta del centro crece.
   */
  rotateByPixels(dx: number, dy: number): void {
    if (this.free) return;
    this.lastInput = performance.now();
    const scale = this.degreesPerPixel();
    this.ra = wrapDegrees(this.ra + (dx * scale) / this.cosDecLimit());
    this.dec = clamp(this.dec + dy * scale, -MAX_DEC, MAX_DEC);
    this.dirty = true;
  }

  /** Gira en grados de cielo: positivo en `east` lleva la vista hacia el este. */
  rotateByDegrees(east: number, north: number): void {
    if (this.free) return;
    this.lastInput = performance.now();
    this.ra = wrapDegrees(this.ra + east / this.cosDecLimit());
    this.dec = clamp(this.dec + north, -MAX_DEC, MAX_DEC);
    this.dirty = true;
  }

  /** Multiplica el campo de vision: menos de 1 acerca. */
  zoomBy(factor: number): void {
    this.lastInput = performance.now();
    // Despues de un vuelo a un parche la vista esta mas cerca que el limite: se puede alejar sin salto.
    this.fov = clamp(this.fov * factor, Math.min(MIN_FOV, this.fov), MAX_FOV);
    this.dirty = true;
  }

  /**
   * Oscurece el cielo, de 0 (normal) a 1 (negro), sin tocar los parches. Es el
   * final del acercamiento a un campo: queda la imagen sola sobre el negro, que
   * es como abre el visor.
   */
  setSkyDim(amount: number): void {
    const dim = clamp(amount, 0, 1);
    if (dim === this.skyDim) return;
    this.skyDim = dim;
    this.dirty = true;
  }

  /** Brillo del mapa en este cuadro: lo apagan el pedido de `setSkyDim` y la cercania. */
  private applySkyBrightness(): void {
    const depth = 1 - smoothstep(MIN_FOV, DEEP_SKY_FOV, this.fov);
    const brightness = 1 - Math.max(this.skyDim, DEEP_SKY_DIM * depth);
    this.material.color.setScalar(brightness);
    this.detailMaterial?.color.setScalar(brightness);
    // Las lineas se van con el cielo al llegar a un campo, pero no con la cercania.
    if (this.lineMaterial !== null) this.lineMaterial.opacity = LINE_OPACITY * (1 - this.skyDim);
  }

  /** Suelta el arrastre con una velocidad en pixeles por segundo: la inercia la va frenando. */
  fling(vx: number, vy: number): void {
    if (this.free || this.reducedMotion) return;
    const scale = this.degreesPerPixel();
    this.velocityRa = clamp(
      (vx * scale) / this.cosDecLimit(),
      -INERTIA_MAX_SPEED,
      INERTIA_MAX_SPEED,
    );
    this.velocityDec = clamp(vy * scale, -INERTIA_MAX_SPEED, INERTIA_MAX_SPEED);
  }

  /** Frena todo lo que se mueve solo: inercia, deriva y vuelo. La persona tomo el control. */
  stopMotion(): void {
    this.velocityRa = 0;
    this.velocityDec = 0;
    this.driftRate = 0;
    this.cancelFlight();
  }

  /** Cerca del polo un pixel abarca mucha ascension recta: se limita para que no salte. */
  private cosDecLimit(): number {
    return Math.max(0.2, Math.cos(this.dec * DEG));
  }

  // ---- Vuelo a un punto ---------------------------------------------------

  /**
   * Lleva el centro de la vista a un punto por el camino mas corto, con
   * aceleracion y frenado. La promesa da true al llegar y false si el vuelo se
   * interrumpio (otro vuelo, un arrastre o el cierre de la escena).
   */
  flyTo(position: SkyPosition, options: FlyOptions = {}): Promise<boolean> {
    const fov = clamp(options.fov ?? this.fov, MIN_FOV, MAX_FOV);
    return this.startFlight(position, fov, options, null);
  }

  /**
   * Vuela al campo de un parche y sigue acercando hasta que su imagen ocupa
   * casi todo el lado corto de la ventana. La promesa da true cuando la imagen
   * ya se ve entera (o no se pudo cargar), y false si el vuelo se interrumpio o
   * el parche no existe.
   */
  flyToPatch(id: string, options: PatchFlyOptions = {}): Promise<boolean> {
    const layer = this.patches.find((candidate) => candidate.spec.id === id);
    if (layer === undefined) return Promise.resolve(false);
    this.loadPatch(layer);
    // Lado de la imagen al llegar: casi todo el lado corto, sin meterse en la
    // franja reservada arriba y abajo.
    const short = Math.min(this.width, this.height);
    const inset = Math.max(0, options.inset ?? 0);
    const side = Math.max(48, Math.min(PATCH_FIT * short, this.height - 2 * inset));
    const fov = this.fovToFit((layer.sizeDeg * short) / side);
    return this.startFlight(layer.spec, fov, options, layer);
  }

  /** Campo de vision (sobre el lado largo) con el que `degrees` ocupa justo el lado corto. */
  private fovToFit(degrees: number): number {
    const long = Math.max(this.width, this.height);
    const short = Math.min(this.width, this.height);
    const fov = (2 * Math.atan(Math.tan((degrees * DEG) / 2) * (long / short))) / DEG;
    return clamp(fov, FLIGHT_MIN_FOV, MAX_FOV);
  }

  private startFlight(
    position: SkyPosition,
    fov: number,
    options: FlyOptions,
    patch: PatchLayer | null,
  ): Promise<boolean> {
    this.cancelFlight();
    this.setFreeOrientation(null);
    this.velocityRa = 0;
    this.velocityDec = 0;
    this.driftRate = 0;

    const target = {
      ra: wrapDegrees(position.ra),
      dec: clamp(position.dec, -MAX_DEC, MAX_DEC),
      fov,
    };
    const fromDirection = raDecToVector(this.ra, this.dec);
    const toDirection = raDecToVector(target.ra, target.dec);
    let duration = this.reducedMotion
      ? 0
      : (options.duration ??
        flightDuration(fromDirection, toDirection) + (patch === null ? 0 : PATCH_FLIGHT_EXTRA_MS));

    if (duration <= 0 && patch === null) {
      this.ra = target.ra;
      this.dec = target.dec;
      this.fov = target.fov;
      this.dirty = true;
      options.onProgress?.(1);
      return Promise.resolve(true);
    }
    // Sin animaciones el vuelo a un parche es un salto, pero igual espera a la imagen.
    if (duration <= 0) duration = 1;
    return new Promise((resolve) => {
      this.flight = {
        fromDirection,
        toDirection,
        fromFov: this.fov,
        toFov: target.fov,
        duration,
        // Hacia un parche el campo de vision termina cientos de veces mas chico:
        // el giro tiene que terminar antes, o el campo queda fuera de la vista
        // hasta el ultimo cuadro.
        turnEnd: patch === null ? 1 : 0.55,
        zoomStart: patch === null ? 0.2 : 0.15,
        patch,
        onProgress: options.onProgress,
        resolve,
        start: null,
        arrivedAt: null,
      };
    });
  }

  cancelFlight(): void {
    const flight = this.flight;
    if (flight === null) return;
    this.flight = null;
    flight.resolve(false);
  }

  isFlying(): boolean {
    return this.flight !== null;
  }

  // ---- Orientacion libre (ventana al cielo) -------------------------------

  /**
   * Con una orientacion, la camara deja el norte arriba y sigue al sensor: es
   * el cuaternion de la camara en el sistema de la escena
   * (`deviceToSceneQuaternion`, skyMath.ts). Con null vuelve a la vista con el
   * norte arriba, centrada en lo que se estaba mirando.
   */
  setFreeOrientation(orientation: Quat | null): void {
    if (orientation === null) {
      if (!this.free) return;
      const center = vectorToRaDec(quatRotate(this.freeQuat, CAMERA_FORWARD));
      this.free = false;
      this.ra = center.ra;
      this.dec = clamp(center.dec, -MAX_DEC, MAX_DEC);
      // El norte arriba puede quedar muy girado respecto de como se sostenia el
      // telefono (cerca de un polo, hasta media vuelta): se llega girando.
      if (!this.reducedMotion) {
        this.settleFrom = this.freeQuat;
        this.settleLeft = SETTLE_TIME;
      }
      this.dirty = true;
      return;
    }
    this.targetQuat = quatNormalize(orientation);
    if (!this.free) {
      // Primer dato del sensor: sin transicion desde la vista anterior.
      this.free = true;
      this.cancelFlight();
      this.velocityRa = 0;
      this.velocityDec = 0;
      this.driftRate = 0;
      this.freeQuat = this.targetQuat;
      this.settleFrom = null;
    }
    this.dirty = true;
  }

  // ---- Cuadro -------------------------------------------------------------

  private readonly frame = (time: number): void => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.frame);
    const dt = this.lastTime === null ? 0 : Math.min(0.1, (time - this.lastTime) / 1000);
    this.lastTime = time;

    let changed = this.dirty;
    if (this.advanceFlight(time)) changed = true;
    if (this.advanceInertia(dt)) changed = true;
    if (this.advanceDrift(dt)) changed = true;
    if (this.advanceOrientation(dt)) changed = true;
    if (this.advanceSettle(dt)) changed = true;
    if (this.advanceDetail(time)) changed = true;
    if (this.advancePatches(dt)) changed = true;
    if (!changed) return;

    this.dirty = false;
    this.applyCamera();
    this.applySkyBrightness();
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.(this);
  };

  private advanceFlight(time: number): boolean {
    const flight = this.flight;
    if (flight === null) return false;
    if (flight.start === null) flight.start = time;
    const progress = clamp((time - flight.start) / flight.duration, 0, 1);
    const eased = easeInOutCubic(clamp(progress / flight.turnEnd, 0, 1));
    const center = vectorToRaDec(slerpDirection(flight.fromDirection, flight.toDirection, eased));
    this.ra = center.ra;
    this.dec = clamp(center.dec, -MAX_DEC, MAX_DEC);
    // El acercamiento arranca despues que el giro: primero se ve adonde se va.
    const zoom = easeInOutCubic(
      clamp((progress - flight.zoomStart) / (1 - flight.zoomStart), 0, 1),
    );
    this.fov = flight.fromFov * (flight.toFov / flight.fromFov) ** zoom;
    flight.onProgress?.(progress);
    if (progress >= 1) {
      const patch = flight.patch;
      if (patch !== null && patch.state !== "failed" && patch.opacity < 0.99) {
        // Llego antes que la imagen: se queda en el lugar hasta que se vea entera.
        if (flight.arrivedAt === null) flight.arrivedAt = time;
        if (time - flight.arrivedAt < PATCH_HOLD_MS) return true;
      }
      this.flight = null;
      this.flightEndedAt = time;
      flight.resolve(true);
    }
    return true;
  }

  private advanceInertia(dt: number): boolean {
    if (this.velocityRa === 0 && this.velocityDec === 0) return false;
    this.ra = wrapDegrees(this.ra + this.velocityRa * dt);
    this.dec = clamp(this.dec + this.velocityDec * dt, -MAX_DEC, MAX_DEC);
    const decay = Math.exp(-dt / INERTIA_TIME);
    this.velocityRa *= decay;
    this.velocityDec *= decay;
    const slowest = Math.min(INERTIA_MIN_SPEED, INERTIA_MIN_SPEED_PX * this.degreesPerPixel());
    if (Math.hypot(this.velocityRa, this.velocityDec) < slowest) {
      this.velocityRa = 0;
      this.velocityDec = 0;
    }
    return true;
  }

  /** Deriva lenta hasta la primera interaccion: el centro avanza hacia el este, como el cielo real. */
  private advanceDrift(dt: number): boolean {
    if (this.driftRate === 0 || this.free || this.flight !== null) return false;
    this.ra = wrapDegrees(this.ra + this.driftRate * dt);
    return true;
  }

  private advanceOrientation(dt: number): boolean {
    if (!this.free) return false;
    if (quatAngle(this.freeQuat, this.targetQuat) < ORIENTATION_REST) return false;
    // Filtro pasabajos: el sensor tiembla y la camara lo sigue con un retardo
    // corto. Interpolando cuaterniones el giro es uno solo y por el camino mas
    // corto, mire adonde mire la camara.
    const blend = dt === 0 ? 1 : 1 - Math.exp(-dt * ORIENTATION_FOLLOW);
    this.freeQuat = quatSlerp(this.freeQuat, this.targetQuat, blend);
    return true;
  }

  /** Vuelta al norte arriba despues de la orientacion libre. */
  private advanceSettle(dt: number): boolean {
    if (this.settleFrom === null) return false;
    this.settleLeft -= dt;
    if (this.settleLeft <= 0 || this.free) this.settleFrom = null;
    return true;
  }

  // ---- Mapa de 8k ---------------------------------------------------------

  /** En que paso esta el reemplazo del mapa de 4k por el de 8k. */
  getDetailState(): SkyDetailState {
    return this.detailState;
  }

  private advanceDetail(time: number): boolean {
    switch (this.detailState) {
      case "idle":
        // Durante un vuelo, o con el cielo ya apagado al llegar a un campo, no se
        // pide: lo que sigue es el visor, que tiene su propia descarga.
        if (
          this.detailUrl !== undefined &&
          this.texture !== null &&
          this.skyDim === 0 &&
          this.fov < DETAIL_FOV &&
          this.flight === null &&
          time - this.flightEndedAt > QUIET_MS
        ) {
          this.loadDetail(this.detailUrl);
        }
        return false;
      case "decoded": {
        const texture = this.detailTexture;
        if (texture === null) return false;
        if (this.detailSource === null) {
          // Sin ImageBitmap no hay subida por franjas: sube de una vez, en un momento sin gestos.
          if (!this.isQuiet(time)) return false;
          this.renderer.initTexture(texture);
          this.showDetail(time);
          return true;
        }
        // Reserva la memoria de la textura, con todos sus niveles y sin datos.
        this.renderer.initTexture(texture);
        // Los niveles reducidos se calculan una sola vez, con la ultima franja.
        texture.generateMipmaps = false;
        this.detailState = "uploading";
        return false;
      }
      case "uploading":
        return this.uploadDetailStrips(time);
      case "fading": {
        const material = this.detailMaterial;
        if (material === null) return false;
        const opacity = this.reducedMotion
          ? 1
          : clamp((time - this.detailFadeStart) / DETAIL_FADE_MS, 0, 1);
        material.opacity = opacity;
        if (opacity >= 1) this.finishDetail();
        return true;
      }
      default:
        return false;
    }
  }

  /** Sin gestos recientes, sin vuelo y sin inercia: un cuadro lento no se nota. */
  private isQuiet(time: number): boolean {
    return (
      time - this.lastInput > QUIET_MS &&
      this.flight === null &&
      this.velocityRa === 0 &&
      this.velocityDec === 0
    );
  }

  private loadDetail(url: string): void {
    this.detailState = "loading";
    const fail = (): void => {
      // La esfera sigue con el mapa de 4k: no es un error que haya que mostrar.
      this.detailState = "failed";
    };
    const ready = (texture: Texture): void => {
      texture.colorSpace = SRGBColorSpace;
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      texture.needsUpdate = true;
      this.detailTexture = texture;
      this.detailState = "decoded";
    };
    if (typeof createImageBitmap === "function") {
      // La imagen se decodifica fuera del hilo principal, asi el arrastre no se frena.
      // Queda como viene, con la fila 0 en el borde norte: pedirle al navegador que
      // la invierta congela la pagina 0,15 segundos. La vuelta la da la textura.
      const loader = new ImageBitmapLoader();
      loader.setOptions({ premultiplyAlpha: "none" });
      loader.load(
        url,
        (bitmap) => {
          if (this.disposed) {
            bitmap.close();
            return;
          }
          // Textura de destino del mismo tamano y sin datos: las franjas se copian
          // del ImageBitmap con `copyTextureToTexture`.
          const texture = new DataTexture(null, bitmap.width, bitmap.height);
          texture.source.dataReady = false;
          texture.generateMipmaps = true;
          texture.minFilter = LinearMipmapLinearFilter;
          texture.magFilter = LinearFilter;
          // La fila 0 de la textura es el norte y la malla espera v = 1 ahi: v' = 1 - v.
          texture.repeat.set(1, -1);
          texture.offset.set(0, 1);
          this.detailBitmap = bitmap;
          this.detailSource = new Texture(bitmap);
          this.detailRow = 0;
          ready(texture);
        },
        undefined,
        fail,
      );
    } else {
      new TextureLoader().load(
        url,
        (texture) => {
          if (this.disposed) texture.dispose();
          else ready(texture);
        },
        undefined,
        fail,
      );
    }
  }

  /**
   * Sube las franjas del mapa de 8k que entran en el tiempo de este cuadro.
   * Con la ultima se calculan los niveles reducidos y empieza el fundido.
   */
  private uploadDetailStrips(time: number): boolean {
    const texture = this.detailTexture;
    const source = this.detailSource;
    const bitmap = this.detailBitmap;
    if (texture === null || source === null || bitmap === null) return false;
    const started = performance.now();
    do {
      const from = this.detailRow;
      const to = Math.min(bitmap.height, from + DETAIL_STRIP_ROWS);
      const last = to >= bitmap.height;
      if (last) texture.generateMipmaps = true;
      this.stripRegion.min.set(0, from);
      this.stripRegion.max.set(bitmap.width, to);
      this.stripTarget.set(0, from);
      this.renderer.copyTextureToTexture(source, texture, this.stripRegion, this.stripTarget);
      this.detailRow = to;
      if (last) {
        // La copia en memoria ya no hace falta: la imagen quedo en la tarjeta.
        source.dispose();
        bitmap.close();
        this.detailSource = null;
        this.detailBitmap = null;
        this.showDetail(time);
        return true;
      }
    } while (performance.now() - started < DETAIL_UPLOAD_BUDGET_MS);
    return false;
  }

  /** Con el mapa de 8k ya en la tarjeta, lo empieza a fundir sobre el de 4k. */
  private showDetail(time: number): void {
    const texture = this.detailTexture;
    if (texture === null) return;

    const material = new MeshBasicMaterial({
      map: texture,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0,
    });
    const mesh = new Mesh(this.geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    this.detailMaterial = material;
    this.detailMesh = mesh;
    this.detailFadeStart = time;
    this.detailState = "fading";
  }

  /** Fin del fundido: el mapa de 8k pasa a ser el de la esfera y el de 4k se libera. */
  private finishDetail(): void {
    const texture = this.detailTexture;
    if (texture === null) return;
    this.texture?.dispose();
    this.texture = texture;
    this.detailTexture = null;
    this.material.map = texture;
    this.material.needsUpdate = true;
    if (this.detailMesh !== null) this.scene.remove(this.detailMesh);
    this.detailMaterial?.dispose();
    this.detailMesh = null;
    this.detailMaterial = null;
    this.detailState = "done";
  }

  // ---- Parches ------------------------------------------------------------

  private loadPatch(layer: PatchLayer): void {
    if (layer.state !== "idle") return;
    layer.state = "loading";
    new TextureLoader().load(
      layer.spec.url,
      (texture) => {
        if (this.disposed) {
          texture.dispose();
          return;
        }
        texture.colorSpace = SRGBColorSpace;
        // Ampliada, la imagen muestra sus pixeles como cuadrados, igual que el visor.
        texture.magFilter = NearestFilter;
        layer.texture = texture;
        layer.material.map = texture;
        layer.material.needsUpdate = true;
        layer.state = "ready";
        this.dirty = true;
      },
      undefined,
      () => {
        layer.state = "failed";
      },
    );
  }

  /** Opacidad de cada parche segun cuanto ocupa en pantalla. */
  private advancePatches(dt: number): boolean {
    if (this.patches.length === 0) return false;
    const view: Vec3 = this.free
      ? quatRotate(this.freeQuat, CAMERA_FORWARD)
      : raDecToVector(this.ra, this.dec);
    const scale = this.degreesPerPixel();
    // Mitad de la diagonal de la ventana, con margen: lo que queda mas lejos no se ve.
    const reach = Math.cos(Math.min(180, this.fov * 0.75 + 1) * DEG);
    let changed = false;
    for (const layer of this.patches) {
      const d = layer.direction;
      const inView = view[0] * d[0] + view[1] * d[1] + view[2] * d[2] >= reach;
      const target = inView
        ? smoothstep(PATCH_FADE_START_PX, PATCH_FADE_END_PX, layer.sizeDeg / scale)
        : 0;
      if (inView && layer.state === "idle" && (target > 0 || this.fov < PATCH_PRELOAD_FOV)) {
        this.loadPatch(layer);
      }
      const goal = layer.state === "ready" ? target : 0;
      if (goal === layer.opacity) continue;
      const step = this.reducedMotion ? 1 : dt / PATCH_FADE_TIME;
      layer.opacity =
        goal > layer.opacity
          ? Math.min(goal, layer.opacity + step)
          : Math.max(goal, layer.opacity - step);
      layer.material.opacity = layer.opacity;
      layer.mesh.visible = layer.opacity > 0.002;
      changed = true;
    }
    return changed;
  }

  private applyCamera(): void {
    this.camera.fov = this.verticalFov();
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    const orientation = this.camera.quaternion;
    if (this.free) {
      const [x, y, z, w] = this.freeQuat;
      orientation.set(x, y, z, w);
    } else {
      // Vista con el norte arriba: el polo celeste es la referencia del "arriba".
      // La declinacion no pasa de MAX_DEC, asi que la referencia nunca degenera.
      const [x, y, z] = raDecToVector(this.ra, this.dec);
      this.forward.set(x, y, z);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(this.forward);
      const from = this.settleFrom;
      if (from !== null) {
        const left = clamp(this.settleLeft / SETTLE_TIME, 0, 1);
        const blended = quatSlerp(
          [orientation.x, orientation.y, orientation.z, orientation.w],
          from,
          easeInOutCubic(left),
        );
        orientation.set(blended[0], blended[1], blended[2], blended[3]);
      }
    }
    // Hacia donde mira la camara de verdad, para ubicar los marcadores.
    this.forward.set(0, 0, -1).applyQuaternion(orientation);
    this.camera.updateMatrixWorld();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.cancelFlight();
    this.geometry.dispose();
    this.material.dispose();
    this.texture?.dispose();
    this.detailMaterial?.dispose();
    this.detailTexture?.dispose();
    this.detailSource?.dispose();
    this.detailBitmap?.close();
    for (const layer of this.patches) {
      layer.geometry.dispose();
      layer.material.dispose();
      layer.texture?.dispose();
    }
    this.lineGeometry?.dispose();
    this.lineMaterial?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
