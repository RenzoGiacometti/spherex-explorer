import { type MouseEvent, type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { classNames } from "@/components";
// Mapa estelar de NASA SVS, guardado en el repositorio: fuente y licencia en assets/FUENTES.md.
import skyTextureUrl from "./assets/cielo-nasa-svs-4k.jpg";
// El mismo mapa en 8k. Importarlo solo trae su URL: la imagen se pide al acercarse.
import skyDetailTextureUrl from "./assets/cielo-nasa-svs-8k.jpg";
import { SKY_PATCHES } from "./patches";
import { type FlyOptions, type PatchFlyOptions, SkyScene, type SkyView } from "./SkyScene";
import styles from "./SkySphere.module.css";
import { attachSkyControls, type SkyControls } from "./skyControls";
import type { Quat, SkyPosition } from "./skyMath";

/** Rectangulo en pixeles del escenario, desde su esquina superior izquierda. */
export interface SkyBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const NO_BOXES: readonly SkyBox[] = [];

/** Caja del nombre de un marcador, en pixeles desde su punto del cielo. */
interface NameShape {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Medio lado de lo que ocupa el anillo de un marcador: mide 12 px y crece a 18
 * al pasarle el cursor.
 */
const RING_REACH = 10;
/** Medio lado de la mira del punto elegido (40 px). */
const PICK_REACH = 20;
/** Aire, en pixeles, entre un nombre de constelacion y lo que no tiene que tocar. */
const LABEL_GAP = 4;
/** Distancia, en pixeles, del punto de una estrella al comienzo de su nombre. */
const STAR_LABEL_OFFSET = 7;
/** Aire entre el nombre de una estrella y lo demas: van apretados, pero sin tocarse. */
const STAR_LABEL_GAP = 2;
/** Cuantas estrellas se nombran: pocas con la vista abierta, mas al acercarse. */
const STAR_LABELS_FAR = 50;
const STAR_LABELS_NEAR = 200;
/** Campo de vision, en grados, desde el que van las pocas y hasta el que van todas. */
const STAR_FOV_FAR = 85;
const STAR_FOV_NEAR = 25;

/** Cuantos nombres de estrellas se muestran con un campo de vision, de los mas brillantes. */
export function starLabelLimit(fov: number): number {
  const t = Math.min(1, Math.max(0, (fov - STAR_FOV_NEAR) / (STAR_FOV_FAR - STAR_FOV_NEAR)));
  return Math.round(STAR_LABELS_NEAR + (STAR_LABELS_FAR - STAR_LABELS_NEAR) * t);
}
/** Duracion, en milisegundos, del corrimiento del cielo de `shiftBy`. */
const SHIFT_MS = 320;

function boxesTouch(a: SkyBox, b: SkyBox, gap = 0): boolean {
  return (
    a.left < b.right + gap &&
    b.left < a.right + gap &&
    a.top < b.bottom + gap &&
    b.top < a.bottom + gap
  );
}

function touchesAny(box: SkyBox, others: readonly SkyBox[], gap = 0): boolean {
  for (const other of others) {
    if (boxesTouch(box, other, gap)) return true;
  }
  return false;
}

/** Marca un elemento con `data-<name>="true"`, o le saca la marca; solo escribe si cambia. */
function setFlag(element: HTMLElement, name: string, on: boolean): void {
  if (on) {
    if (element.dataset[name] !== "true") element.dataset[name] = "true";
  } else if (element.dataset[name] !== undefined) {
    delete element.dataset[name];
  }
}

export interface SkyMarker extends SkyPosition {
  readonly id: string;
  /** Nombre que se lee al lado del anillo, escrito como en el catalogo. */
  readonly label: string;
  /** Link al visor. Sin el, el marcador es solo una marca (pagina de prueba). */
  readonly href?: string | undefined;
  /** Nombre accesible del link: "Abrir Barnard's Star en el visor". */
  readonly openLabel?: string | undefined;
  /** `probe` es la marca de comprobacion de la pagina de prueba: blanca y sin interaccion. */
  readonly kind?: "target" | "probe";
}

/**
 * Texto sobre el cielo, sin interaccion. `area` (por defecto) es el nombre de
 * una constelacion, centrado en su posicion. `star` es el nombre de una
 * estrella: va al costado de su punto, y solo se muestran las de menor `rank`
 * (las mas brillantes) segun cuanto se acerco la vista (`starLabelLimit`).
 */
export interface SkyLabel extends SkyPosition {
  readonly id: string;
  readonly text: string;
  readonly kind?: "area" | "star" | undefined;
  /** Orden de brillo de una estrella, desde 0. */
  readonly rank?: number | undefined;
}

/**
 * `loading`: todavia no llego la textura. `ready`: se ve el cielo.
 * `texture-error`: no hay imagen, pero la esfera gira y los marcadores andan.
 * `no-webgl`: no se pudo crear el contexto; no hay esfera ni marcadores.
 */
export type SkySphereStatus = "loading" | "ready" | "texture-error" | "no-webgl";

export interface SkySphereHandle {
  /** Vuela a un punto; da false si no hay esfera o si el vuelo se interrumpio. */
  flyTo(position: SkyPosition, options?: FlyOptions): Promise<boolean>;
  /**
   * Vuela al campo de un parche (patches.ts) y acerca hasta que su imagen llena
   * la vista. Da true cuando la imagen ya se ve, y false si no hay esfera, no
   * existe el parche o el vuelo se interrumpio.
   */
  flyToPatch(id: string, options?: PatchFlyOptions): Promise<boolean>;
  /** Oscurece el cielo, de 0 a 1, sin tocar los parches. */
  setSkyDim(amount: number): void;
  getView(): SkyView | null;
  /** Orientacion de la camara en el ultimo cuadro; null sin esfera. Para el diagnostico. */
  getOrientation(): Quat | null;
  setView(view: Partial<SkyView>): void;
  /**
   * Donde se ve un punto del cielo, en pixeles desde la esquina del escenario;
   * null si no hay esfera o el punto queda fuera de la vista.
   */
  project(position: SkyPosition): { readonly x: number; readonly y: number } | null;
  /** Sube o baja el cielo esos pixeles (positivo: hacia abajo) con un vuelo corto. */
  shiftBy(dy: number): void;
  /**
   * Vuelve a ubicar marcadores y nombres aunque la vista no haya cambiado: se
   * movio o cambio de tamano la interfaz que los tapa (`occluders`).
   */
  refresh(): void;
  /** Orientacion de la camara que marca el sensor del telefono, o null para volver al arrastre. */
  setFreeOrientation(orientation: Quat | null): void;
}

export interface SkySphereProps {
  readonly ref?: Ref<SkySphereHandle> | undefined;
  /** Nombre accesible de la esfera. */
  readonly label: string;
  /** Nombre accesible de la lista de marcadores. */
  readonly markersLabel: string;
  readonly markers: readonly SkyMarker[];
  /** Clic en un marcador con link. Quien lo usa decide si frena la navegacion del navegador. */
  readonly onMarkerClick?:
    | ((marker: SkyMarker, event: MouseEvent<HTMLAnchorElement>) => void)
    | undefined;
  /** Vista al montar; despues la esfera es duena de su vista. */
  readonly initialView?: SkyView | undefined;
  /** Grados por segundo de la deriva hasta la primera interaccion. Solo se lee al montar. */
  readonly driftRate?: number | undefined;
  /** Marcador que no muestra su nombre: la ventana al cielo ya lo escribe debajo de la mira. */
  readonly unlabelledMarkerId?: string | null | undefined;
  /** En false los gestos no mueven la vista (ventana al cielo). */
  readonly interactive?: boolean | undefined;
  /**
   * Lineas sobre el cielo (figuras de las constelaciones): cada una, una lista
   * plana RA, Dec, RA, Dec... en grados. Van en el gris `text-dim`.
   */
  readonly lines?: readonly (readonly number[])[] | null | undefined;
  /** Textos sobre el cielo, cada uno centrado en su posicion. */
  readonly labels?: readonly SkyLabel[] | undefined;
  /** Punto elegido: la esfera le deja una mira encima. */
  readonly pick?: SkyPosition | null | undefined;
  /**
   * Zonas del escenario tapadas por la interfaz de quien usa la esfera (su
   * buscador, sus tarjetas, su credito). Se piden en cada cuadro que se dibuja.
   * Un marcador cuyo anillo cae en una no se muestra; si lo unico que la toca
   * es su nombre, queda el anillo sin nombre. Tampoco se escribe ahi el nombre
   * de una constelacion.
   */
  readonly occluders?: (() => readonly SkyBox[]) | undefined;
  /** Clic o toque corto sobre el cielo, fuera de los marcadores: el punto que se toco. */
  readonly onSkyTap?: ((position: SkyPosition) => void) | undefined;
  /** Despues de cada cuadro: centro y campo de vision. No conviene guardarlo en estado de React. */
  readonly onViewChange?: ((view: SkyView) => void) | undefined;
  readonly onStatusChange?: ((status: SkySphereStatus) => void) | undefined;
  readonly className?: string | undefined;
}

/**
 * Esfera celeste a pantalla completa: el canvas de three.js y, encima, los
 * marcadores como elementos del DOM, que la escena reubica en cada cuadro.
 * Que los marcadores sean links de verdad los deja abrir en otra pestana,
 * llegar con el teclado y tomar el color del token de acento.
 */
export function SkySphere(props: SkySphereProps) {
  const {
    ref,
    label,
    markersLabel,
    markers,
    onMarkerClick,
    unlabelledMarkerId,
    interactive = true,
    lines,
    labels,
    pick,
    className,
  } = props;

  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SkyScene | null>(null);
  const controlsRef = useRef<SkyControls | null>(null);
  const elementsRef = useRef(new Map<string, HTMLElement>());
  const pickRef = useRef<HTMLSpanElement>(null);
  const labelElementsRef = useRef(new Map<string, HTMLElement>());
  // Lo ultimo que llego por props, para leerlo desde la escena sin volver a crearla.
  const propsRef = useRef(props);
  propsRef.current = props;

  const [status, setStatus] = useState<SkySphereStatus>("loading");

  useEffect(() => {
    propsRef.current.onStatusChange?.(status);
  }, [status]);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;

    const point = { x: 0, y: 0 };
    /** Tamano de cada nombre de constelacion: se mide una vez por texto, no en cada cuadro. */
    const labelSizes = new Map<HTMLElement, { text: string; width: number; height: number }>();
    /** Lugar del nombre de cada marcador respecto de su punto; null si no se muestra. */
    const nameShapes = new Map<HTMLElement, { key: string; shape: NameShape | null }>();

    /**
     * Donde queda el nombre de un marcador respecto de su punto del cielo. Sale
     * de la hoja de estilos: el marcador es un cuadrado centrado en el punto, y
     * el nombre va a su costado y sube medio alto propio (`translateY(-50%)`).
     * Se mide una vez por nombre, no en cada cuadro.
     */
    function nameShape(marker: SkyMarker, element: HTMLElement): NameShape | null {
      const key = `${marker.label}|${element.dataset.unlabelled ?? ""}`;
      const known = nameShapes.get(element);
      if (known !== undefined && known.key === key) return known.shape;
      const name = element.lastElementChild;
      const shape =
        name instanceof HTMLElement && name.offsetWidth > 0
          ? {
              left: name.offsetLeft - element.offsetWidth / 2,
              top: name.offsetTop - element.offsetHeight / 2 - name.offsetHeight / 2,
              width: name.offsetWidth,
              height: name.offsetHeight,
            }
          : null;
      nameShapes.set(element, { key, shape });
      return shape;
    }

    /**
     * Ubica marcadores, mira y nombres, y decide cuales se dibujan. Nada se
     * escribe encima de otra cosa, con este orden de prioridad:
     *
     * 1. La interfaz de quien usa la esfera (`occluders`): lo que queda debajo
     *    no se ve ni se puede tocar.
     * 2. Los marcadores con su nombre y la mira del punto elegido.
     * 3. Los nombres de las constelaciones: el que toca algo de lo anterior no
     *    se escribe.
     * 4. Los nombres de las estrellas, de la mas brillante a la mas debil: cada
     *    uno se escribe solo si no toca nada de lo anterior, tampoco a otra
     *    estrella ya nombrada.
     */
    function placeMarkers(scene: SkyScene): void {
      const covers = propsRef.current.occluders?.() ?? NO_BOXES;
      /** Lo que ya ocupa su lugar sobre el cielo: marcadores con su nombre y la mira. */
      const taken: SkyBox[] = [];

      for (const marker of propsRef.current.markers) {
        const element = elementsRef.current.get(marker.id);
        if (element === undefined) continue;
        if (!scene.project(marker, point)) {
          if (!element.hidden) element.hidden = true;
          continue;
        }
        const { x, y } = point;
        element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        if (element.hidden) element.hidden = false;

        const ring: SkyBox = {
          left: x - RING_REACH,
          top: y - RING_REACH,
          right: x + RING_REACH,
          bottom: y + RING_REACH,
        };
        const covered = touchesAny(ring, covers);
        setFlag(element, "covered", covered);
        if (covered) {
          setFlag(element, "crowded", false);
          continue;
        }
        const shape = nameShape(marker, element);
        if (shape === null) {
          // Sin nombre a la vista (la ventana al cielo lo escribe debajo de la mira).
          setFlag(element, "crowded", false);
          taken.push(ring);
          continue;
        }
        const nameBox: SkyBox = {
          left: x + shape.left,
          top: y + shape.top,
          right: x + shape.left + shape.width,
          bottom: y + shape.top + shape.height,
        };
        const crowded = touchesAny(nameBox, covers);
        setFlag(element, "crowded", crowded);
        taken.push(ring);
        if (!crowded) taken.push(nameBox);
      }

      const pickElement = pickRef.current;
      const picked = propsRef.current.pick ?? null;
      if (pickElement !== null) {
        if (picked !== null && scene.project(picked, point)) {
          pickElement.style.transform = `translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px)`;
          if (pickElement.hidden) pickElement.hidden = false;
          taken.push({
            left: point.x - PICK_REACH,
            top: point.y - PICK_REACH,
            right: point.x + PICK_REACH,
            bottom: point.y + PICK_REACH,
          });
        } else if (!pickElement.hidden) {
          pickElement.hidden = true;
        }
      }

      const starLimit = starLabelLimit(scene.getView().fov);
      // Las constelaciones van primero en la lista y las estrellas despues, por brillo.
      for (const label of propsRef.current.labels ?? []) {
        const element = labelElementsRef.current.get(label.id);
        if (element === undefined) continue;
        const star = label.kind === "star";
        if ((star && (label.rank ?? 0) >= starLimit) || !scene.project(label, point)) {
          if (!element.hidden) element.hidden = true;
          continue;
        }
        const { x, y } = point;
        element.style.transform = star
          ? `translate(${(x + STAR_LABEL_OFFSET).toFixed(1)}px, ${y.toFixed(1)}px) translate(0, -50%)`
          : `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
        if (element.hidden) element.hidden = false;
        let size = labelSizes.get(element);
        if (size === undefined || size.text !== label.text) {
          size = { text: label.text, width: element.offsetWidth, height: element.offsetHeight };
          labelSizes.set(element, size);
        }
        const left = star ? x + STAR_LABEL_OFFSET : x - size.width / 2;
        const box: SkyBox = {
          left,
          top: y - size.height / 2,
          right: left + size.width,
          bottom: y + size.height / 2,
        };
        // Gana lo que ya esta: el rotulo de un marcador, la mira, un nombre anterior.
        const gap = star ? STAR_LABEL_GAP : LABEL_GAP;
        const covered = touchesAny(box, taken, gap) || touchesAny(box, covers, gap);
        setFlag(element, "covered", covered);
        if (!covered) taken.push(box);
      }
      // Que mapa se esta viendo (4k, fundido u 8k), a la vista en el inspector.
      const detail = scene.getDetailState();
      if (stage !== null && stage.dataset.detail !== detail) stage.dataset.detail = detail;
      propsRef.current.onViewChange?.(scene.getView());
    }

    // El mapa de 8k es solo para escritorio: en un telefono o una tableta (puntero
    // grueso) pesa demasiado para la memoria y para la conexion. Tampoco se pide
    // si la persona activo el ahorro de datos. Que la tarjeta admita texturas de
    // ese tamano lo comprueba la escena.
    const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
    const saveData =
      (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData ===
      true;

    let scene: SkyScene;
    try {
      scene = new SkyScene({
        container: stage,
        textureUrl: skyTextureUrl,
        detailTextureUrl: coarsePointer || saveData ? undefined : skyDetailTextureUrl,
        patches: SKY_PATCHES,
        canvasClassName: styles.canvas ?? "",
        ...(propsRef.current.initialView ? { initialView: propsRef.current.initialView } : {}),
        driftRate: propsRef.current.driftRate ?? 0,
        reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
        onFrame: placeMarkers,
        onTextureLoad: () => setStatus("ready"),
        onTextureError: () => setStatus("texture-error"),
      });
    } catch (error) {
      console.warn("esfera: no se pudo crear el contexto WebGL", error);
      setStatus("no-webgl");
      return;
    }
    sceneRef.current = scene;

    // Con la tipografia propia ya cargada los nombres miden otra cosa: se vuelven a medir.
    void document.fonts?.ready.then(() => {
      labelSizes.clear();
      nameShapes.clear();
      scene.invalidate();
    });

    const controls = attachSkyControls(stage, scene, {
      onDragChange: (dragging) => {
        stage.dataset.dragging = String(dragging);
      },
      onTap: (x, y) => propsRef.current.onSkyTap?.(scene.unproject(x, y)),
    });
    controls.setEnabled(propsRef.current.interactive ?? true);
    controlsRef.current = controls;

    scene.setSize(stage.clientWidth, stage.clientHeight);
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box !== undefined) scene.setSize(box.width, box.height);
    });
    observer.observe(stage);

    return () => {
      observer.disconnect();
      controls.detach();
      scene.dispose();
      sceneRef.current = null;
      controlsRef.current = null;
    };
  }, []);

  useEffect(() => {
    controlsRef.current?.setEnabled(interactive);
  }, [interactive]);

  // Lineas de las constelaciones, en el gris del sistema de diseno: el color sale
  // del token, no esta escrito aca.
  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const color = getComputedStyle(stage).getPropertyValue("--color-text-dim").trim();
    sceneRef.current?.setLines(lines ?? null, color === "" ? undefined : color);
  }, [lines]);

  // Marcadores, nombres o punto elegido nuevos: hay que ubicarlos aunque la vista no se haya movido.
  // biome-ignore lint/correctness/useExhaustiveDependencies: el efecto no lee esos valores, corre cuando cambian
  useEffect(() => {
    sceneRef.current?.invalidate();
  }, [markers, labels, pick]);

  useImperativeHandle(
    ref,
    () => ({
      flyTo: (position, options) =>
        sceneRef.current?.flyTo(position, options) ?? Promise.resolve(false),
      flyToPatch: (id, options) =>
        sceneRef.current?.flyToPatch(id, options) ?? Promise.resolve(false),
      setSkyDim: (amount) => sceneRef.current?.setSkyDim(amount),
      getView: () => sceneRef.current?.getView() ?? null,
      getOrientation: () => sceneRef.current?.getOrientation() ?? null,
      setView: (view) => sceneRef.current?.setView(view),
      project: (position) => {
        const out = { x: 0, y: 0 };
        return sceneRef.current?.project(position, out) === true ? out : null;
      },
      shiftBy: (dy) => {
        const scene = sceneRef.current;
        if (scene === null) return;
        // Como en un arrastre: bajar el cielo es mirar mas al norte.
        const view = scene.getView();
        void scene.flyTo(
          { ra: view.ra, dec: view.dec + dy * scene.degreesPerPixel() },
          { duration: SHIFT_MS },
        );
      },
      refresh: () => sceneRef.current?.invalidate(),
      setFreeOrientation: (orientation) => sceneRef.current?.setFreeOrientation(orientation),
    }),
    [],
  );

  function register(id: string, element: HTMLElement | null): void {
    if (element === null) elementsRef.current.delete(id);
    else elementsRef.current.set(id, element);
  }

  return (
    <div
      ref={stageRef}
      className={classNames(styles.stage, className)}
      role="application"
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: la esfera se gira con las flechas y necesita el foco
      tabIndex={0}
      data-status={status}
      data-interactive={interactive}
    >
      {/* Nombres sobre el cielo: debajo de los marcadores y sin recibir el puntero. */}
      <div className={styles.labels} aria-hidden="true">
        {(labels ?? []).map((item) => (
          <span
            key={item.id}
            ref={(element) => {
              if (element === null) labelElementsRef.current.delete(item.id);
              else labelElementsRef.current.set(item.id, element);
            }}
            className={styles.label}
            data-kind={item.kind ?? "area"}
            hidden
          >
            {item.text}
          </span>
        ))}
      </div>
      {/* Sin esfera no hay donde ubicar los marcadores: quien la usa ofrece los links de otra forma. */}
      <nav className={styles.markers} aria-label={markersLabel} hidden={status === "no-webgl"}>
        {markers.map((marker) =>
          marker.href === undefined ? (
            <span
              key={marker.id}
              ref={(element) => register(marker.id, element)}
              className={styles.marker}
              data-kind={marker.kind ?? "target"}
              data-marker={marker.id}
              data-unlabelled={marker.id === unlabelledMarkerId}
              hidden
            >
              <span className={styles.ring} />
              <span className={styles.name}>{marker.label}</span>
            </span>
          ) : (
            <a
              key={marker.id}
              ref={(element) => register(marker.id, element)}
              className={styles.marker}
              data-kind={marker.kind ?? "target"}
              data-marker={marker.id}
              data-unlabelled={marker.id === unlabelledMarkerId}
              href={marker.href}
              aria-label={marker.openLabel}
              draggable={false}
              hidden
              onClick={(event) => onMarkerClick?.(marker, event)}
            >
              <span className={styles.ring} />
              <span className={styles.name}>{marker.label}</span>
            </a>
          ),
        )}
      </nav>
      {/* Mira del punto elegido (DESIGN.md, `reticle`): no recibe el puntero. */}
      <span ref={pickRef} className={styles.pick} aria-hidden="true" hidden>
        <svg
          width={40}
          height={40}
          viewBox="0 0 40 40"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="20" cy="20" r="10" />
          <path d="M20 3v9" />
          <path d="M20 28v9" />
          <path d="M3 20h9" />
          <path d="M28 20h9" />
        </svg>
      </span>
    </div>
  );
}
