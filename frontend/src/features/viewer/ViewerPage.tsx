// Pantalla del visor: lo que se ve cuando la URL trae `ra` y `dec`.
//
// La imagen ocupa toda la ventana y los controles flotan encima en paneles de
// vidrio (DESIGN.md, "Estructura"). Hay tres armados (`data-layout`):
//
//   desktop  barra superior    salida, marca, objeto y coordenadas, idioma
//            columna izquierda Banda, Modo, Imagen (con la capa de flags)
//            zona libre        la imagen se encuadra aca
//            columna derecha   Metadatos y Avisos de calidad; arriba de ellos,
//                              el espectro cuando esta abierto (la columna se ensancha)
//            muelle inferior   transporte, linea de tiempo y estado de la carga;
//                              en el modo `journey`, el control del viaje entre misiones
//
//   phone    menos de 600 px (DESIGN.md, "Responsive Behavior"): arriba, la
//            salida, el objeto y la cantidad de avisos; la imagen; y en el 45 %
//            inferior, modo, banda y linea de tiempo con el transporte. Lo
//            demas va en el cajon de herramientas, que ocupa ese mismo lugar.
//            El espectro se abre ahi mismo, en una hoja que sube sobre la parte
//            de abajo de la imagen sin taparla entera.
//
//   embed    `embed=1` en la URL: solo la imagen con sus anotaciones y una
//            franja con el transporte y el enlace al visor completo.
//
// Sobre la imagen, en los tres, van las anotaciones (ImageAnnotations.tsx) y,
// si esta prendida, la capa de Gaia (GaiaOverlay.tsx).
//
// Un clic sobre la imagen pide el espectro de ese punto (useSpectrum.ts) y abre
// SpectrumDock. En `embed` no: ahi solo va la imagen.
//
// El estado sale de tres lugares: la URL (campo, banda, modo, epoca), el store
// del campo (metadatos e imagenes) y useViewerController (reproductor, epoca
// de referencia, contraste, capa de flags). App.tsx mantiene el store al dia
// con la URL.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components";
import { contractGridShape } from "@/data/gridShape";
import { MissionJourney } from "@/features/context";
import { useFieldStore } from "@/state/fieldStore";
import { useUrlState } from "@/state/urlState";
import type { ImageSize } from "@/viewer/compose";
import { type ImageClick, ImageViewer, type ViewerOverlay } from "@/viewer/ImageViewer";
import { homeZoomForViewFov } from "@/viewer/view";
import { BandPanel } from "./BandPanel";
import { EmbedBar } from "./EmbedBar";
import { GaiaOverlay } from "./GaiaOverlay";
import { ImageAnnotations } from "./ImageAnnotations";
import { ImagePanel } from "./ImagePanel";
import { MetadataPanel } from "./MetadataPanel";
import { ModePanel } from "./ModePanel";
import { QualityPanel } from "./QualityPanel";
import { SpectrumDock } from "./SpectrumDock";
import { StageStatus } from "./StageStatus";
import { TimelineDock } from "./TimelineDock";
import { ToolsDrawer, type ToolsSection } from "./ToolsDrawer";
import { TopBar } from "./TopBar";
import { PHONE_QUERY, useMediaQuery } from "./useMediaQuery";
import { useQualityNotices } from "./useQualityNotices";
import { useSpectrum } from "./useSpectrum";
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
  const { view, scene, source, journey } = controller;
  // El control del viaje ocupa el lugar de la linea de tiempo mientras dura el modo.
  const journeyOn = controller.mode === "journey";
  const journeyControl = journeyOn ? (
    <MissionJourney
      frames={journey.frames}
      currentId={journey.currentId}
      onSelect={journey.select}
      playing={journey.playing}
      onPlayingChange={journey.setPlaying}
    />
  ) : null;
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

  // ---- Espectro del punto elegido ------------------------------------------

  // Epoca que se ve, como en las anotaciones: en una comparacion, la actual (A).
  const composition = source === "spherex" ? view.composition : null;
  const shownEpoch = !composition
    ? null
    : composition.mode === "single"
      ? (composition.epochs[0] ?? null)
      : view.current;
  const spectrum = useSpectrum(shownEpoch);
  const { requestAt: requestSpectrum, close: closeSpectrum } = spectrum;
  const spectrumState = spectrum.state;
  const spectrumOpen = layout !== "embed" && spectrumState.status !== "idle";
  // Solo hay algo que medir sobre una imagen de SPHEREx. Mientras se mantiene
  // apretado para ver B, soltar no es un clic.
  const canPick = layout !== "embed" && source === "spherex" && !controller.holding;

  const openTools = useCallback(
    (section: ToolsSection) => {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // En el celular el cajon y el espectro ocupan el mismo lugar: queda uno solo.
      closeSpectrum();
      setTools(section);
    },
    [closeSpectrum],
  );
  const closeTools = useCallback(() => setTools(null), []);

  const handleImageClick = useCallback(
    (click: ImageClick) => {
      setTools(null);
      requestSpectrum(click);
    },
    [requestSpectrum],
  );
  /** Punto que se pidio, para marcarlo sobre la imagen; el objeto buscado ya tiene su mira. */
  const spectrumMark = useMemo(() => {
    if (spectrumState.status === "idle" || spectrumState.point.pixel === null) return null;
    return {
      ...spectrumState.point.pixel,
      radiusPx: spectrumState.status === "ready" ? spectrumState.spectrum.aperture.radius_px : null,
    };
  }, [spectrumState]);

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
      data-playing={controller.playing || journey.playing ? "true" : undefined}
      data-context={journey.status}
      data-journey-frame={journeyOn ? (journey.currentId ?? undefined) : undefined}
      data-flags={controller.flags.status}
      data-spectrum={spectrumOpen ? "open" : undefined}
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
          onImageClick={canPick ? handleImageClick : undefined}
        >
          {(overlay: ViewerOverlay) => (
            <>
              <GaiaOverlay overlay={overlay} gaia={controller.gaia} shown={source !== "none"} />
              <ImageAnnotations
                overlay={overlay}
                controller={controller}
                spectrumMark={spectrumOpen ? spectrumMark : null}
              />
            </>
          )}
        </ImageViewer>
      </div>
      <p id={helpId} hidden>
        {t("page.viewerHelp")}
        {canPick ? ` ${t("page.viewerHelpSpectrum")}` : null}
      </p>

      <div ref={stageRef} className={styles.stage}>
        <StageStatus controller={controller} />
      </div>

      {layout === "desktop" ? (
        <div className={styles.right}>
          <SpectrumDock spectrum={spectrum} />
          <MetadataPanel currentEpoch={view.current} />
          <QualityPanel notices={notices} />
        </div>
      ) : null}

      {layout === "desktop" ? (
        <div className={styles.dock}>
          {journeyControl ?? <TimelineDock controller={controller} />}
        </div>
      ) : null}

      {layout === "phone" ? (
        <div className={styles.thumb}>
          {/* Siguen en su lugar, sin verse, debajo del cajon: su alto es el del cajon. */}
          <div
            className={styles.controls}
            data-covered={openSection === null && !spectrumOpen ? undefined : "true"}
          >
            <ModePanel controller={controller} variant="compact" />
            <BandPanel currentEpoch={view.current} variant="compact" />
            {journeyControl === null ? (
              <TimelineDock
                controller={controller}
                variant="phone"
                onOpenTools={() => openTools("tools")}
                toolsOpen={openSection !== null}
              />
            ) : (
              <>
                {journeyControl}
                {/* El boton de herramientas vive en la linea de tiempo: en el viaje va aparte. */}
                <div className={styles.journeyTools}>
                  <IconButton
                    icon="contrast"
                    shape="square"
                    label={t("tools.open")}
                    aria-expanded={openSection !== null}
                    onClick={() => openTools("tools")}
                  />
                </div>
              </>
            )}
          </div>
          {spectrumOpen ? (
            <div className={styles.sheet}>
              <SpectrumDock spectrum={spectrum} />
            </div>
          ) : null}
          {openSection === null || spectrumOpen ? null : (
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
