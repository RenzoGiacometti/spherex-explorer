import {
  type AriaRole,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ImageSize, Scene } from "./compose";
import styles from "./ImageViewer.module.css";
import {
  createRenderer,
  type RendererInfo,
  type RendererKind,
  type SceneRenderer,
} from "./renderer";
import {
  applyViewAction,
  clampView,
  homeView,
  MIN_ZOOM,
  type Point,
  panByScreen,
  pinchView,
  type ScreenRect,
  type ViewportSize,
  type ViewState,
  type ViewTransform,
  viewActionForKey,
  viewTransform,
  wheelZoomFactor,
  zoomAround,
  zoomAtCenter,
} from "./view";

/**
 * Margenes del visor, en pixeles CSS, que quedan tapados por lo que flota
 * encima (la barra superior, las columnas de paneles, la linea de tiempo).
 */
export interface ViewerInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** Lo que hace falta para dibujar encima de la imagen. */
export interface ViewerOverlay {
  /** Transformacion vigente de pixel de imagen a pixel CSS del visor (view.ts). */
  readonly transform: ViewTransform;
  /** Tamano del visor en pixeles CSS. */
  readonly viewport: ViewportSize;
  /**
   * Zona del visor donde se encuadra la imagen, en pixeles CSS: el visor entero
   * o, con `insets`, lo que queda libre entre los paneles. Sirve para ubicar lo
   * que va pegado a un borde (la escala, la rosa, el rotulo de la imagen).
   */
  readonly frame: ScreenRect;
  /** Tamano de la imagen en pixeles. */
  readonly image: ImageSize;
  /** Centro y acercamiento vigentes. */
  readonly view: ViewState;
}

/** Lo que el visor deja manejar desde afuera, por `ref`. */
export interface ImageViewerHandle {
  /** Vuelve a la vista de partida. */
  resetView(): void;
  /** Acerca (factor mayor que 1) o aleja alrededor del centro. */
  zoomBy(factor: number): void;
  /** Transformacion vigente, o null si el visor todavia no tiene tamano o imagen. */
  getOverlay(): ViewerOverlay | null;
}

export interface ImageViewerProps {
  /** Lo que se dibuja. Con null queda el fondo. */
  readonly scene: Scene | null;
  /**
   * Tamano de la imagen cuando todavia no hay escena (`grid.shape` ya se
   * conoce desde `listed`), para poder dibujar encima mientras carga. Con
   * escena no hace falta: manda el tamano de sus planos.
   */
  readonly imageSize?: ImageSize | undefined;
  /**
   * Acercamiento de la vista de partida (`homeZoomForViewFov`): 1 encuadra el
   * cubo entero y 2 es la vista de 5'. Al cambiarlo la vista vuelve a la de partida.
   */
  readonly homeZoom?: number | undefined;
  /**
   * Margenes tapados por lo que flota encima del visor. La imagen se encuadra y
   * se acota dentro de lo que queda libre, asi ningun borde queda debajo de un
   * panel sin poder traerlo a la vista; el dibujo sigue llegando a los bordes
   * del visor. Si no dejan lugar, no se aplican.
   */
  readonly insets?: ViewerInsets | undefined;
  /** Nombre accesible del visor. */
  readonly ariaLabel: string;
  /** Rol del visor. Por defecto `application`: las flechas y otras teclas las maneja el visor. */
  readonly role?: AriaRole | undefined;
  /** `id` del elemento que explica como se usa (teclas, gestos). */
  readonly ariaDescribedBy?: string | undefined;
  readonly className?: string | undefined;
  /** `canvas2d` obliga a dibujar sin WebGL2. Por defecto se intenta WebGL2. */
  readonly renderer?: RendererKind | undefined;
  /** Se llama cada vez que cambia la transformacion vigente. */
  readonly onOverlayChange?: ((overlay: ViewerOverlay | null) => void) | undefined;
  /** Se llama cuando se sabe con que se esta dibujando. */
  readonly onRendererChange?: ((info: RendererInfo | null) => void) | undefined;
  /**
   * Lo que se dibuja encima de la imagen, por ejemplo un SVG con la mira. Recibe
   * la transformacion vigente y se actualiza en el mismo paso que la imagen.
   *
   * La capa no recibe el puntero: arrastrar sobre una marca desplaza la imagen.
   * Un hijo interactivo (un boton, un marcador que se puede elegir) lo vuelve a
   * activar con `pointer-events: auto`; el visor no arrastra ni captura los
   * punteros que empiezan en el, asi que recibe su `click`.
   */
  readonly children?: ((overlay: ViewerOverlay) => ReactNode) | undefined;
  readonly ref?: Ref<ImageViewerHandle> | undefined;
}

const IDENTITY: ViewTransform = { scale: 1, originX: 0, originY: 0 };

/** Dos toques seguidos cuentan como doble toque si caen cerca y pronto. */
const TAP_MAX_MOVE = 10;
const TAP_MAX_MS = 300;
const DOUBLE_TAP_MAX_MS = 350;
const DOUBLE_TAP_MAX_DISTANCE = 30;

interface Tap {
  readonly at: number;
  readonly point: Point;
}

interface PointerStart extends Tap {
  moved: boolean;
}

/** Lo que necesitan las cuentas de view.ts: la vista, la imagen y el tamano de la zona de encuadre. */
interface ViewFrame {
  readonly view: ViewState;
  readonly image: ImageSize;
  readonly viewport: ViewportSize;
}

/** Un margen en pixeles: nunca negativo, y 0 si no es un numero. */
function insetSize(value: number | undefined): number {
  return value !== undefined && value > 0 && Number.isFinite(value) ? value : 0;
}

function currentPixelRatio(): number {
  return typeof window !== "undefined" && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
}

/**
 * Visor de imagenes: dibuja una escena (compose.ts) con WebGL2 o, si no hay,
 * con canvas 2D, y maneja el encuadre.
 *
 * - Rueda: acerca alrededor del cursor. Arrastre: desplaza. Dos dedos:
 *   pellizco. Doble clic o doble toque: vuelve a la vista de partida.
 * - Teclado, con el foco en el visor: flechas, `+`, `-` y `0` o Inicio.
 * - No llama a la API ni lee estado global: recibe planos ya decodificados.
 */
export function ImageViewer({
  scene,
  imageSize,
  homeZoom = MIN_ZOOM,
  insets,
  ariaLabel,
  role = "application",
  ariaDescribedBy,
  className,
  renderer: preferred = "webgl2",
  onOverlayChange,
  onRendererChange,
  children,
  ref,
}: ImageViewerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayLayerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const startsRef = useRef(new Map<number, PointerStart>());
  const lastTapRef = useRef<Tap | null>(null);

  const [viewport, setViewport] = useState<ViewportSize | null>(null);
  const [pixelRatio, setPixelRatio] = useState(currentPixelRatio);
  const [rendererInfo, setRendererInfo] = useState<RendererInfo | null>(null);
  const [dragging, setDragging] = useState(false);
  /** null es la vista de partida. */
  const [view, setView] = useState<ViewState | null>(null);

  // Con que se dibuja: lo pedido o, si WebGL2 fallo despues de tomar el canvas, canvas 2D.
  const [backend, setBackend] = useState<RendererKind>(preferred);
  const [seenPreferred, setSeenPreferred] = useState(preferred);
  if (seenPreferred !== preferred) {
    setSeenPreferred(preferred);
    setBackend(preferred);
  }

  // Con escena manda el tamano de sus planos.
  const firstPlane = scene?.planes[0];
  const imageWidth = firstPlane?.width ?? imageSize?.width ?? 0;
  const imageHeight = firstPlane?.height ?? imageSize?.height ?? 0;
  const viewportWidth = viewport?.width ?? 0;
  const viewportHeight = viewport?.height ?? 0;

  // Zona de encuadre: el visor menos los margenes tapados. Si no dejan lugar, el visor entero.
  const insetLeft = insetSize(insets?.left);
  const insetTop = insetSize(insets?.top);
  const freeWidth = viewportWidth - insetLeft - insetSize(insets?.right);
  const freeHeight = viewportHeight - insetTop - insetSize(insets?.bottom);
  const hasFrame = freeWidth > 0 && freeHeight > 0;
  const frameLeft = hasFrame ? insetLeft : 0;
  const frameTop = hasFrame ? insetTop : 0;
  const frameWidth = hasFrame ? freeWidth : viewportWidth;
  const frameHeight = hasFrame ? freeHeight : viewportHeight;

  // Otra imagen u otra vista de partida: se vuelve a encuadrar. Quedarse un
  // momento sin imagen (un cambio de banda mientras carga) no mueve la vista.
  const hasImage = imageWidth > 0 && imageHeight > 0;
  const homeKey = hasImage ? `${imageWidth}x${imageHeight}@${homeZoom}` : null;
  const [seenHomeKey, setSeenHomeKey] = useState(homeKey);
  if (homeKey !== null && seenHomeKey !== homeKey) {
    setSeenHomeKey(homeKey);
    setView(null);
  }

  const overlay = useMemo<ViewerOverlay | null>(() => {
    if (imageWidth <= 0 || imageHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
      return null;
    }
    const image = { width: imageWidth, height: imageHeight };
    const size = { width: frameWidth, height: frameHeight };
    const current = clampView(view ?? homeView(image, homeZoom), image, size);
    const framed = viewTransform(current, image, size);
    return {
      // La cuenta se hace dentro de la zona de encuadre y se corre a su lugar en el visor.
      transform: {
        scale: framed.scale,
        originX: framed.originX + frameLeft,
        originY: framed.originY + frameTop,
      },
      viewport: { width: viewportWidth, height: viewportHeight },
      frame: { left: frameLeft, top: frameTop, width: frameWidth, height: frameHeight },
      image,
      view: current,
    };
  }, [
    view,
    homeZoom,
    imageWidth,
    imageHeight,
    viewportWidth,
    viewportHeight,
    frameLeft,
    frameTop,
    frameWidth,
    frameHeight,
  ]);

  // Lo ultimo que se mostro, para los gestos y para `getOverlay`.
  const overlayRef = useRef(overlay);
  useLayoutEffect(() => {
    overlayRef.current = overlay;
  }, [overlay]);

  /**
   * Cambia la vista a partir de la vigente. Sin imagen o sin tamano no hace
   * nada. `viewport` es la zona de encuadre: los puntos de pantalla se le pasan
   * con `framePoint`.
   */
  function updateView(change: (current: ViewFrame, home: ViewState) => ViewState): void {
    setView((previous) => {
      const live = overlayRef.current;
      if (live === null) return previous;
      const viewport = { width: live.frame.width, height: live.frame.height };
      const home = homeView(live.image, homeZoom);
      const current = clampView(previous ?? home, live.image, viewport);
      return change({ view: current, image: live.image, viewport }, home);
    });
  }

  /** Un punto del visor medido desde la esquina de la zona de encuadre. */
  function framePoint(point: Point): Point {
    const frame = overlayRef.current?.frame;
    return frame ? { x: point.x - frame.left, y: point.y - frame.top } : point;
  }

  useImperativeHandle(
    ref,
    () => ({
      resetView: () => setView(null),
      zoomBy: (factor: number) => {
        setView((previous) => {
          const live = overlayRef.current;
          if (live === null) return previous;
          const viewport = { width: live.frame.width, height: live.frame.height };
          const current = clampView(
            previous ?? homeView(live.image, homeZoom),
            live.image,
            viewport,
          );
          return zoomAtCenter(current, live.image, viewport, factor);
        });
      },
      getOverlay: () => overlayRef.current,
    }),
    [homeZoom],
  );

  // ---- Tamano del visor y densidad de pixeles ----------------------------

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const update = (width: number, height: number): void => {
      // El zoom del navegador cambia el tamano y la densidad a la vez.
      setPixelRatio(currentPixelRatio());
      setViewport((previous) => {
        if (!(width > 0) || !(height > 0)) return null;
        if (previous !== null && previous.width === width && previous.height === height) {
          return previous;
        }
        return { width, height };
      });
    };
    const measure = (): void => update(root.clientWidth, root.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) update(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // La densidad tambien cambia sin que cambie el tamano, al mover la ventana a otra pantalla.
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`(resolution: ${pixelRatio}dppx)`);
    const onChange = (): void => setPixelRatio(currentPixelRatio());
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [pixelRatio]);

  // ---- Dibujo -------------------------------------------------------------

  // Al cambiar `backend` cambia el canvas (por `key`) y hay que crear otro dibujo.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const created = createRenderer(canvas, backend);
    if (created === null) {
      // WebGL2 tomo el canvas y despues fallo: se prueba canvas 2D con un canvas nuevo.
      setRendererInfo(null);
      setBackend("canvas2d");
      return;
    }
    rendererRef.current = created;
    setRendererInfo(created.info);
    return () => {
      rendererRef.current = null;
      created.dispose();
    };
  }, [backend]);

  // `rendererInfo` y `pixelRatio` no se leen adentro: avisan que hay un dibujo
  // nuevo o que cambio la densidad, y que hay que dibujar otra vez.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ver el comentario de arriba
  useLayoutEffect(() => {
    const renderer = rendererRef.current;
    if (renderer === null || viewportWidth <= 0 || viewportHeight <= 0) return;
    try {
      renderer.draw({
        scene: overlay === null ? null : scene,
        transform: overlay?.transform ?? IDENTITY,
        viewport: { width: viewportWidth, height: viewportHeight },
        // Se lee en el momento: si el aviso del cambio de densidad no llego, el
        // dibujo siguiente igual sale con la densidad correcta.
        pixelRatio: currentPixelRatio(),
      });
    } catch (error) {
      console.error("visor: la escena no se pudo dibujar", error);
    }
  }, [rendererInfo, scene, overlay, viewportWidth, viewportHeight, pixelRatio]);

  useEffect(() => {
    onRendererChange?.(rendererInfo);
  }, [rendererInfo, onRendererChange]);

  useEffect(() => {
    onOverlayChange?.(overlay);
  }, [overlay, onOverlayChange]);

  // ---- Gestos -------------------------------------------------------------

  function localPoint(event: { clientX: number; clientY: number }): Point {
    const rect = rootRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }

  // La rueda se registra a mano: tiene que poder cancelar el desplazamiento de la pagina.
  // biome-ignore lint/correctness/useExhaustiveDependencies: updateView, localPoint y framePoint solo leen refs
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onWheel = (event: WheelEvent): void => {
      if (overlayRef.current === null) return;
      event.preventDefault();
      const anchor = framePoint(localPoint(event));
      const factor = wheelZoomFactor(event);
      updateView((current) =>
        zoomAround(current.view, current.image, current.viewport, factor, anchor),
      );
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [homeZoom]);

  /**
   * Dice si un evento empezo en algo de la capa de encima. La capa no recibe el
   * puntero, asi que solo pasa con un hijo que lo volvio a activar: ese gesto es
   * del hijo y no del visor.
   */
  function startedOnOverlay(event: { target: EventTarget }): boolean {
    const layer = overlayLayerRef.current;
    return layer !== null && event.target instanceof Node && layer.contains(event.target);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // Con la captura en la raiz el navegador le manda el `click` a la raiz y el
    // hijo no lo recibe: un puntero que empieza en un hijo interactivo no se sigue.
    if (startedOnOverlay(event)) return;
    const point = localPoint(event);
    pointersRef.current.set(event.pointerId, point);
    startsRef.current.set(event.pointerId, { at: event.timeStamp, point, moved: false });
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Sin captura el arrastre igual funciona mientras el puntero siga sobre el visor.
    }
    setDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const pointers = pointersRef.current;
    const before = pointers.get(event.pointerId);
    if (before === undefined) return;
    const after = localPoint(event);
    pointers.set(event.pointerId, after);

    const start = startsRef.current.get(event.pointerId);
    if (start && Math.hypot(after.x - start.point.x, after.y - start.point.y) > TAP_MAX_MOVE) {
      start.moved = true;
    }

    if (pointers.size === 1) {
      updateView((current) =>
        panByScreen(
          current.view,
          current.image,
          current.viewport,
          after.x - before.x,
          after.y - before.y,
        ),
      );
      return;
    }
    if (pointers.size === 2) {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
      if (other === undefined) return;
      const fixed = framePoint(other);
      const from = framePoint(before);
      const to = framePoint(after);
      updateView((current) =>
        pinchView(current.view, current.image, current.viewport, [from, fixed], [to, fixed]),
      );
    }
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>): void {
    const pointers = pointersRef.current;
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    const start = startsRef.current.get(event.pointerId);
    startsRef.current.delete(event.pointerId);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // La captura ya se habia soltado.
    }
    if (pointers.size === 0) setDragging(false);

    // Doble toque: los navegadores no siempre mandan `dblclick` con el dedo.
    if (event.type !== "pointerup" || event.pointerType === "mouse" || start === undefined) return;
    const isTap = !start.moved && event.timeStamp - start.at <= TAP_MAX_MS && pointers.size === 0;
    if (!isTap) {
      lastTapRef.current = null;
      return;
    }
    const previous = lastTapRef.current;
    const isDouble =
      previous !== null &&
      event.timeStamp - previous.at <= DOUBLE_TAP_MAX_MS &&
      Math.hypot(start.point.x - previous.point.x, start.point.y - previous.point.y) <=
        DOUBLE_TAP_MAX_DISTANCE;
    if (isDouble) {
      lastTapRef.current = null;
      setView(null);
    } else {
      lastTapRef.current = { at: event.timeStamp, point: start.point };
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    // Con Control, Alt o Meta la tecla es un atajo del navegador (Control + 0, por ejemplo).
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    // Las teclas de un hijo interactivo de la capa de encima (un deslizador, un campo) son suyas.
    if (startedOnOverlay(event)) return;
    const action = viewActionForKey(event.key, event.shiftKey);
    if (action === null || overlayRef.current === null) return;
    event.preventDefault();
    if (action.type === "reset") {
      setView(null);
      return;
    }
    updateView((current, home) =>
      applyViewAction(current.view, current.image, current.viewport, action, home),
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: el rol llega por props; por defecto es application
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: el rol llega por props y admite nombre
    <div
      ref={rootRef}
      className={className === undefined ? styles.root : `${styles.root} ${className}`}
      role={role}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      tabIndex={0}
      data-renderer={rendererInfo?.kind}
      data-dragging={dragging ? "true" : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onDoubleClick={(event) => {
        // Dos clics seguidos sobre un hijo interactivo son del hijo.
        if (!startedOnOverlay(event)) setView(null);
      }}
      onKeyDown={handleKeyDown}
    >
      <canvas key={backend} ref={canvasRef} className={styles.canvas} />
      {overlay !== null && children ? (
        <div ref={overlayLayerRef} className={styles.overlay}>
          {children(overlay)}
        </div>
      ) : null}
    </div>
  );
}
