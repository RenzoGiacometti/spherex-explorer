import { type MouseEvent, type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { classNames } from "@/components";
// Mapa estelar de NASA SVS, guardado en el repositorio: fuente y licencia en assets/FUENTES.md.
import skyTextureUrl from "./assets/cielo-nasa-svs-4k.jpg";
import { type FlyOptions, SkyScene, type SkyView } from "./SkyScene";
import styles from "./SkySphere.module.css";
import { attachSkyControls, type SkyControls } from "./skyControls";
import type { Pointing, SkyPosition } from "./skyMath";

export interface SkyMarker extends SkyPosition {
  readonly id: string;
  /** Nombre que aparece al pasar el cursor, escrito como en el catalogo. */
  readonly label: string;
  /** Link al visor. Sin el, el marcador es solo una marca (pagina de prueba). */
  readonly href?: string | undefined;
  /** Nombre accesible del link: "Abrir Barnard's Star en el visor". */
  readonly openLabel?: string | undefined;
  /** `probe` es la marca de comprobacion de la pagina de prueba: blanca y sin interaccion. */
  readonly kind?: "target" | "probe";
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
  getView(): SkyView | null;
  setView(view: Partial<SkyView>): void;
  /** Orientacion que marca el sensor del telefono, o null para volver al arrastre. */
  setFreeOrientation(pointing: Pointing | null): void;
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
    className,
  } = props;

  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SkyScene | null>(null);
  const controlsRef = useRef<SkyControls | null>(null);
  const elementsRef = useRef(new Map<string, HTMLElement>());
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
    function placeMarkers(scene: SkyScene): void {
      for (const marker of propsRef.current.markers) {
        const element = elementsRef.current.get(marker.id);
        if (element === undefined) continue;
        if (scene.project(marker, point)) {
          element.style.transform = `translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px)`;
          if (element.hidden) element.hidden = false;
        } else if (!element.hidden) {
          element.hidden = true;
        }
      }
      propsRef.current.onViewChange?.(scene.getView());
    }

    let scene: SkyScene;
    try {
      scene = new SkyScene({
        container: stage,
        textureUrl: skyTextureUrl,
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

    const controls = attachSkyControls(stage, scene, {
      onDragChange: (dragging) => {
        stage.dataset.dragging = String(dragging);
      },
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

  // Marcadores nuevos: hay que ubicarlos aunque la vista no se haya movido.
  // biome-ignore lint/correctness/useExhaustiveDependencies: el efecto no lee `markers`, corre cuando cambian
  useEffect(() => {
    sceneRef.current?.invalidate();
  }, [markers]);

  useImperativeHandle(
    ref,
    () => ({
      flyTo: (position, options) =>
        sceneRef.current?.flyTo(position, options) ?? Promise.resolve(false),
      getView: () => sceneRef.current?.getView() ?? null,
      setView: (view) => sceneRef.current?.setView(view),
      setFreeOrientation: (pointing) => sceneRef.current?.setFreeOrientation(pointing),
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
    </div>
  );
}
