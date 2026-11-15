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

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector3,
  WebGLRenderer,
} from "three";
import {
  clamp,
  DEG,
  normalize,
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

export const MIN_FOV = 10;
export const MAX_FOV = 120;
export const DEFAULT_FOV = 100;

/** La vista con el norte arriba no llega al polo: ahi el "arriba" no esta definido. */
const MAX_DEC = 88;

const SPHERE_RADIUS = 100;
const SEGMENTS_U = 96;
const SEGMENTS_V = 48;

/** Tiempo en que la velocidad de la inercia cae a 1/e, en segundos. */
const INERTIA_TIME = 0.4;
/** Por debajo de esta velocidad (grados por segundo) la inercia se corta. */
const INERTIA_MIN_SPEED = 0.4;
const INERTIA_MAX_SPEED = 400;
/** Con que rapidez la camara sigue al sensor de orientacion (1/s). */
const ORIENTATION_FOLLOW = 14;

export interface FlyOptions {
  /** Campo de vision al llegar. Por defecto, el actual. */
  readonly fov?: number;
  /** Duracion en milisegundos. Por defecto depende de la distancia. */
  readonly duration?: number;
  /** Avance del vuelo, de 0 a 1, en cada cuadro. */
  readonly onProgress?: (progress: number) => void;
}

export interface SkySceneOptions {
  /** Elemento que contiene al canvas; la escena lo crea y lo agrega al principio. */
  readonly container: HTMLElement;
  readonly textureUrl: string;
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
  readonly onProgress: ((progress: number) => void) | undefined;
  readonly resolve: (arrived: boolean) => void;
  start: number | null;
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

  private readonly onFrame: ((scene: SkyScene) => void) | undefined;
  private readonly reducedMotion: boolean;

  private width = 1;
  private height = 1;

  // Vista con el norte arriba.
  private ra: number;
  private dec: number;
  private fov: number;

  // Orientacion libre (ventana al cielo): direccion y "arriba" que marca el sensor.
  private free = false;
  private freeForward = new Vector3(1, 0, 0);
  private freeUp = new Vector3(0, 1, 0);
  private targetForward = new Vector3(1, 0, 0);
  private targetUp = new Vector3(0, 1, 0);

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
    const center = vectorToRaDec([this.freeForward.x, this.freeForward.y, this.freeForward.z]);
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

  // ---- Movimiento con el norte arriba -------------------------------------

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
    const scale = this.degreesPerPixel();
    this.ra = wrapDegrees(this.ra + (dx * scale) / this.cosDecLimit());
    this.dec = clamp(this.dec + dy * scale, -MAX_DEC, MAX_DEC);
    this.dirty = true;
  }

  /** Gira en grados de cielo: positivo en `east` lleva la vista hacia el este. */
  rotateByDegrees(east: number, north: number): void {
    if (this.free) return;
    this.ra = wrapDegrees(this.ra + east / this.cosDecLimit());
    this.dec = clamp(this.dec + north, -MAX_DEC, MAX_DEC);
    this.dirty = true;
  }

  /** Multiplica el campo de vision: menos de 1 acerca. */
  zoomBy(factor: number): void {
    this.fov = clamp(this.fov * factor, MIN_FOV, MAX_FOV);
    this.dirty = true;
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
    this.cancelFlight();
    this.setFreeOrientation(null);
    this.velocityRa = 0;
    this.velocityDec = 0;
    this.driftRate = 0;

    const target = {
      ra: wrapDegrees(position.ra),
      dec: clamp(position.dec, -MAX_DEC, MAX_DEC),
      fov: clamp(options.fov ?? this.fov, MIN_FOV, MAX_FOV),
    };
    const fromDirection = raDecToVector(this.ra, this.dec);
    const toDirection = raDecToVector(target.ra, target.dec);
    const duration = this.reducedMotion
      ? 0
      : (options.duration ?? flightDuration(fromDirection, toDirection));

    if (duration <= 0) {
      this.setView(target);
      options.onProgress?.(1);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this.flight = {
        fromDirection,
        toDirection,
        fromFov: this.fov,
        toFov: target.fov,
        duration,
        onProgress: options.onProgress,
        resolve,
        start: null,
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
   * Con una orientacion, la camara deja el norte arriba y sigue al sensor:
   * `forward` es hacia donde mira y `up` el arriba de la pantalla, los dos en
   * el sistema de la escena. Con null vuelve a la vista con el norte arriba,
   * centrada en lo que se estaba mirando.
   */
  setFreeOrientation(pointing: { forward: Vec3; up: Vec3 } | null): void {
    if (pointing === null) {
      if (!this.free) return;
      const center = vectorToRaDec([this.freeForward.x, this.freeForward.y, this.freeForward.z]);
      this.free = false;
      this.ra = center.ra;
      this.dec = clamp(center.dec, -MAX_DEC, MAX_DEC);
      this.dirty = true;
      return;
    }
    const forward = normalize(pointing.forward);
    const up = normalize(pointing.up);
    this.targetForward.set(forward[0], forward[1], forward[2]);
    this.targetUp.set(up[0], up[1], up[2]);
    if (!this.free) {
      // Primer dato del sensor: sin transicion desde la vista anterior.
      this.free = true;
      this.cancelFlight();
      this.velocityRa = 0;
      this.velocityDec = 0;
      this.driftRate = 0;
      this.freeForward.copy(this.targetForward);
      this.freeUp.copy(this.targetUp);
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
    if (!changed) return;

    this.dirty = false;
    this.applyCamera();
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.(this);
  };

  private advanceFlight(time: number): boolean {
    const flight = this.flight;
    if (flight === null) return false;
    if (flight.start === null) flight.start = time;
    const progress = clamp((time - flight.start) / flight.duration, 0, 1);
    const eased = easeInOutCubic(progress);
    const center = vectorToRaDec(slerpDirection(flight.fromDirection, flight.toDirection, eased));
    this.ra = center.ra;
    this.dec = clamp(center.dec, -MAX_DEC, MAX_DEC);
    // El acercamiento arranca despues que el giro: primero se ve adonde se va.
    const zoom = easeInOutCubic(clamp((progress - 0.2) / 0.8, 0, 1));
    this.fov = flight.fromFov * (flight.toFov / flight.fromFov) ** zoom;
    flight.onProgress?.(progress);
    if (progress >= 1) {
      this.flight = null;
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
    if (Math.hypot(this.velocityRa, this.velocityDec) < INERTIA_MIN_SPEED) {
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
    const gap = 1 - this.freeForward.dot(this.targetForward) + (1 - this.freeUp.dot(this.targetUp));
    if (gap < 1e-9) return false;
    // Filtro pasabajos: el sensor tiembla y la camara lo sigue con un retardo corto.
    const blend = dt === 0 ? 1 : 1 - Math.exp(-dt * ORIENTATION_FOLLOW);
    this.freeForward.lerp(this.targetForward, blend).normalize();
    this.freeUp.lerp(this.targetUp, blend).normalize();
    return true;
  }

  private applyCamera(): void {
    this.camera.fov = this.verticalFov();
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    if (this.free) {
      this.forward.copy(this.freeForward);
      this.camera.up.copy(this.freeUp);
    } else {
      const [x, y, z] = raDecToVector(this.ra, this.dec);
      this.forward.set(x, y, z);
      this.camera.up.set(0, 1, 0);
    }
    this.camera.lookAt(this.forward);
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
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
