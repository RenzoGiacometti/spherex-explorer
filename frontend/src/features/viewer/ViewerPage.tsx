// Pantalla del visor: lo que se ve cuando la URL trae `ra` y `dec`.
//
// La imagen ocupa toda la ventana y los controles flotan encima en paneles de
// vidrio (DESIGN.md, "Estructura"). Hay tres armados (`data-layout`):
//
//   desktop  barra superior    salida, marca, objeto y coordenadas, idioma
//            columna izquierda Banda, Modo, Imagen (con la capa de flags)
//            zona libre        la imagen se encuadra aca
//            columna derecha   Metadatos y Avisos de calidad
//            muelle inferior   transporte, linea de tiempo y estado de la carga
//
//   phone    menos de 600 px (DESIGN.md, "Responsive Behavior"): arriba, la
//            salida, el objeto y la cantidad de avisos; la imagen; y en el 45 %
//            inferior, modo, banda y linea de tiempo con el transporte. Lo
//            demas va en el cajon de herramientas, que ocupa ese mismo lugar.
//
//   embed    `embed=1` en la URL: solo la imagen con sus anotaciones y una
//            franja con el transporte y el enlace al visor completo.
//
// Sobre la imagen, en los tres, van las anotaciones (ImageAnnotations.tsx).
//
// El estado sale de tres lugares: la URL (campo, banda, modo, epoca), el store
// del campo (metadatos e imagenes) y useViewerController (reproductor, epoca
// de referencia, contraste, capa de flags). App.tsx mantiene el store al dia
// con la URL.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { contractGridShape } from "@/data/gridShape";
import { useFieldStore } from "@/state/fieldStore";
import { useUrlState } from "@/state/urlState";
import type { ImageSize } from "@/viewer/compose";
import { ImageViewer, type ViewerOverlay } from "@/viewer/ImageViewer";
import { homeZoomForViewFov } from "@/viewer/view";
import { BandPanel } from "./BandPanel";
import { EmbedBar } from "./EmbedBar";
import { ImageAnnotations } from "./ImageAnnotations";
import { ImagePanel } from "./ImagePanel";
import { MetadataPanel } from "./MetadataPanel";
import { ModePanel } from "./ModePanel";
import { QualityPanel } from "./QualityPanel";
import { StageStatus } from "./StageStatus";
import { TimelineDock } from "./TimelineDock";
import { ToolsDrawer, type ToolsSection } from "./ToolsDrawer";
import { TopBar } from "./TopBar";
import { PHONE_QUERY, useMediaQuery } from "./useMediaQuery";
import { useQualityNotices } from "./useQualityNotices";
import { useStageInsets } from "./useStageInsets";
import { useViewerController } from "./useViewerController";
import styles from "./ViewerPage.module.css";

/** Como se arma la pantalla. */
export type ViewerLayout = "desktop" | "phone" | "embed";

export function ViewerPage() {
  const { t } = useTranslation("viewer");
  const fov = useUrlState((state) => state.fov);
  const embed = useUrlState((state) => state.embed);
  const phone = useMediaQuery(PHONE_QUERY);
  const layout: ViewerLayout = embed ? "embed" : phone ? "phone" : "desktop";

  const gridShape = useFieldStore((state) => state.meta?.grid?.shape);
  const requestFov = useFieldStore((state) => state.request?.fov);
  const controller = useViewerController();
  const { view, scene, source } = controller;
  const notices = useQualityNotices(view.provisional);

  const viewerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const insets = useStageInsets(viewerRef, stageRef);
  const helpId = useId();

  // ---- Cajon de herramientas del celular -----------------------------------

  const [tools, setTools] = useState<ToolsSection | null>(null);
  // Solo existe en el celular: si la ventana se agranda, se da por cerrado.
  const openSection = layout === "phone" ? tools : null;
  /** Lo que tenia el foco al abrir el cajon: lo recupera al cerrarlo. */
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  const openTools = useCallback((section: ToolsSection) => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTools(section);
  }, []);
  const closeTools = useCallback(() => setTools(null), []);

  useEffect(() => {
    const open = openSection !== null;
    // Recien despues de dibujar: mientras el cajon esta abierto, lo que lo abrio no se puede enfocar.
    if (wasOpenRef.current && !open && openerRef.current?.isConnected) openerRef.current.focus();
    wasOpenRef.current = open;
  }, [openSection]);

  // Antes de `listed` no hay grilla: la forma sale de la tabla del contrato,
  // asi lo que se dibuja encima ya tiene donde ubicarse.
  const shape = gridShape ?? (requestFov === undefined ? null : contractGridShape(requestFov));
  const height = shape?.[0];
  const width = shape?.[1];
  const imageSize = useMemo<ImageSize | undefined>(
    () => (width === undefined || height === undefined ? undefined : { width, height }),
    [width, height],
  );

  return (
    <main
      className={styles.page}
      data-layout={layout}
      data-mode={controller.mode}
      data-source={source}
      data-scene={scene?.mode}
      data-epochs={view.composition?.epochs.join(",")}
      data-playing={controller.playing ? "true" : undefined}
      data-flags={controller.flags.status}
    >
      {layout === "embed" ? null : (
        <div className={styles.top}>
          <TopBar
            layout={layout}
            noticeCount={notices.length}
            onOpenNotices={() => openTools("notices")}
            toolsOpen={openSection !== null}
          />
        </div>
      )}

      {layout === "desktop" ? (
        <div className={styles.left}>
          <BandPanel currentEpoch={view.current} />
          <ModePanel controller={controller} />
          <ImagePanel controller={controller} />
        </div>
      ) : null}

      {/*
       * El visor va despues de los controles de la izquierda para que el foco
       * siga el orden de lectura; en pantalla queda debajo de todo, a ventana entera.
       */}
      <div ref={viewerRef} className={styles.viewer}>
        <ImageViewer
          scene={scene}
          imageSize={imageSize}
          homeZoom={homeZoomForViewFov(fov)}
          insets={insets}
          ariaLabel={t("page.viewerLabel")}
          ariaDescribedBy={helpId}
        >
          {(overlay: ViewerOverlay) => (
            <ImageAnnotations overlay={overlay} controller={controller} />
          )}
        </ImageViewer>
      </div>
      <p id={helpId} hidden>
        {t("page.viewerHelp")}
      </p>

      <div ref={stageRef} className={styles.stage}>
        <StageStatus controller={controller} />
      </div>

      {layout === "desktop" ? (
        <div className={styles.right}>
          <MetadataPanel currentEpoch={view.current} />
          <QualityPanel notices={notices} />
        </div>
      ) : null}

      {layout === "desktop" ? (
        <div className={styles.dock}>
          <TimelineDock controller={controller} />
        </div>
      ) : null}

      {layout === "phone" ? (
        <div className={styles.thumb}>
          {/* Siguen en su lugar, sin verse, debajo del cajon: su alto es el del cajon. */}
          <div className={styles.controls} data-covered={openSection === null ? undefined : "true"}>
            <ModePanel controller={controller} variant="compact" />
            <BandPanel currentEpoch={view.current} variant="compact" />
            <TimelineDock
              controller={controller}
              variant="phone"
              onOpenTools={() => openTools("tools")}
              toolsOpen={openSection !== null}
            />
          </div>
          {openSection === null ? null : (
            <ToolsDrawer
              controller={controller}
              notices={notices}
              section={openSection}
              onClose={closeTools}
            />
          )}
        </div>
      ) : null}

      {layout === "embed" ? (
        <div className={styles.dock}>
          <EmbedBar controller={controller} />
        </div>
      ) : null}
    </main>
  );
}
