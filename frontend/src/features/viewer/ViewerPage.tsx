// Pantalla del visor: lo que se ve cuando la URL trae `ra` y `dec`.
//
// La imagen ocupa toda la ventana y los controles flotan encima en paneles de
// vidrio (DESIGN.md, "Estructura"). Hay tres armados (`data-layout`):
//
//   desktop  barra superior    salida, marca, objeto y coordenadas, idioma
//            columna izquierda Banda, Modo, Imagen (con la capa de flags)
//            zona libre        la imagen se encuadra aca
//            columna derecha   Metadatos y Avisos de calidad; arriba de ellos,
//                              el espectro y la curva de luz cuando el panel de la
//                              fuente esta abierto (la columna se ensancha), y la
//                              herramienta Medir (features/measure)
//            muelle inferior   transporte, linea de tiempo y estado de la carga;
//                              en el modo `journey`, el control del viaje entre misiones
//
//            En el modo `curtain` la zona libre muestra la cortina
//            visible/infrarrojo (CurtainStage.tsx) en lugar de la imagen del
//            visor. Cada vez que se ve una placa del DSS, en la cortina o en el
//            viaje, su credito va debajo de la imagen (`PlateCaption`).
//
//   phone    menos de 600 px (DESIGN.md, "Responsive Behavior"): arriba, la
//            salida, el objeto y la cantidad de avisos; la imagen; y en el 45 %
//            inferior, modo, banda y linea de tiempo con el transporte. Lo
//            demas va en el cajon de herramientas, que ocupa ese mismo lugar.
//            El espectro se abre ahi mismo, en una hoja que sube sobre la parte
//            de abajo de la imagen sin taparla entera. En los modos que comparan
//            con una epoca de referencia la imagen conserva el alto que tenia
//            en el parpadeo: lo que crece es la zona de controles, que se
//            desplaza. La herramienta Medir
//            va arriba de los controles: apagada es una tira con su
//            conmutador; prendida, su panel, con alto acotado.
//
//   embed    `embed=1` en la URL: solo la imagen con sus anotaciones y una
//            franja con el transporte y el enlace al visor completo.
//
// Sobre la imagen, en los tres, van las anotaciones (ImageAnnotations.tsx) y,
// si esta prendida, la capa de Gaia (GaiaOverlay.tsx).
//
// Que hace un clic sobre la imagen lo decide imageClick.ts, en un solo lugar:
// por defecto pide el espectro de ese punto (useSpectrum.ts) y abre
// SpectrumDock, con la ficha del objeto (features/context, `ObjectCard`) arriba
// de sus pestanas de espectro y curva de luz; si una herramienta tomo el clic,
// va a ella. En `embed` no hay clic: ahi solo va la imagen.
//
// La herramienta Medir (features/measure) es una de esas: prendida toma el clic
// con el id "measure" y cada clic marca la posicion del objeto en la epoca que
// se ve; apagada, el clic vuelve a abrir el espectro. Mide sobre una epoca
// sola, asi que prenderla lleva el visor al modo parpadeo (en pausa) y cambiar
// de modo la apaga. Las marcas se conservan mientras el campo siga abierto.
//
// En el campo de una estrella variable del desafio (challengeVariables.ts) se
// ofrece su curva de luz de entrada (LightcurveOffer.tsx): en la columna
// derecha y, en el celular, con los controles, debajo de la imagen.
//
// El estado sale de tres lugares: la URL (campo, banda, modo, epoca, epoca de
// referencia, estirado, contraste, capas de flags y de Gaia, y el punto elegido
// con su pestana, que escribe useSourceUrl.ts), el store del campo (metadatos e
// imagenes) y useViewerController (reproductor, viaje, cortina). App.tsx
// mantiene el store al dia con la URL.

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components";
import { contractGridShape } from "@/data/gridShape";
import { selectTargetPosition } from "@/data/selectors";
import { MissionJourney, ObjectCard } from "@/features/context";
import { type Measure, MeasureLayer, MeasurePanel, useMeasure } from "@/features/measure";
import { pixelToSky, skyToPixel } from "@/lib/wcs";
import { useFieldStore } from "@/state/fieldStore";
import { useUrlState } from "@/state/urlState";
import type { ImageSize } from "@/viewer/compose";
import { type ImageClick, ImageViewer, type ViewerOverlay } from "@/viewer/ImageViewer";
import { homeZoomForViewFov } from "@/viewer/view";
import { BandPanel } from "./BandPanel";
import { CurtainStage, PlateCaption } from "./CurtainStage";
import { challengeVariableFor } from "./challengeVariables";
import { EmbedBar } from "./EmbedBar";
import { GaiaOverlay } from "./GaiaOverlay";
import { ImageAnnotations } from "./ImageAnnotations";
import { ImagePanel } from "./ImagePanel";
import {
  DEFAULT_IMAGE_CLICK_MODE,
  routeImageClick,
  useImageClickMode,
  useImageClickTool,
} from "./imageClick";
import { LightcurveOffer } from "./LightcurveOffer";
import { MetadataPanel } from "./MetadataPanel";
import { ModePanel } from "./ModePanel";
import { QualityPanel } from "./QualityPanel";
import { type SourceTab, SpectrumDock } from "./SpectrumDock";
import { StageStatus } from "./StageStatus";
import { TimelineDock } from "./TimelineDock";
import { ToolsDrawer, type ToolsSection } from "./ToolsDrawer";
import { TopBar } from "./TopBar";
import { PHONE_QUERY, useMediaQuery } from "./useMediaQuery";
import { useQualityNotices } from "./useQualityNotices";
import { useSourceUrl } from "./useSourceUrl";
import { useSpectrum } from "./useSpectrum";
import { useStageInsets } from "./useStageInsets";
import { useViewerController } from "./useViewerController";
import styles from "./ViewerPage.module.css";

/** `id` con el que la herramienta Medir toma el clic sobre la imagen (`data-click`). */
export const MEASURE_CLICK_TOOL = "measure";

/** Como se arma la pantalla. */
export type ViewerLayout = "desktop" | "phone" | "embed";

export function ViewerPage() {
  const { t } = useTranslation("viewer");
  const { t: tMeasure } = useTranslation("measure");
  const fov = useUrlState((state) => state.fov);
  const embed = useUrlState((state) => state.embed);
  const band = useUrlState((state) => state.band);
  const urlRa = useUrlState((state) => state.ra);
  const urlDec = useUrlState((state) => state.dec);
  const urlName = useUrlState((state) => state.name);
  const phone = useMediaQuery(PHONE_QUERY);
  const layout: ViewerLayout = embed ? "embed" : phone ? "phone" : "desktop";

  const gridShape = useFieldStore((state) => state.meta?.grid?.shape);
  const requestFov = useFieldStore((state) => state.request?.fov);
  const controller = useViewerController();
  const { view, scene, source, journey, gaia } = controller;
  // El control del viaje ocupa el lugar de la linea de tiempo mientras dura el modo.
  const journeyOn = controller.mode === "journey";
  // La cortina se dibuja en la zona libre, en lugar de la imagen del visor.
  const curtainOn = controller.mode === "curtain";
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
  const {
    requestAt: requestSpectrum,
    requestObject: requestSpectrumOfObject,
    requestPosition: requestSpectrumPosition,
    close: closeSpectrum,
  } = spectrum;
  const spectrumState = spectrum.state;
  const spectrumOpen = layout !== "embed" && spectrumState.status !== "idle";
  // Solo hay algo que medir sobre una imagen de SPHEREx. Mientras se mantiene
  // apretado para ver B, soltar no es un clic; en la cortina el puntero mueve el divisor.
  const canPick = layout !== "embed" && source === "spherex" && !controller.holding && !curtainOn;
  /** Quien tiene el clic: "source" (espectro y curva de luz) o la herramienta que lo tomo. */
  const clickMode = useImageClickMode();

  // Pestana del panel de la fuente. Un clic con el panel abierto la conserva;
  // cerrado, el proximo clic vuelve a abrir en el espectro.
  const [sourceTab, setSourceTab] = useState<SourceTab>("spectrum");
  const spectrumIdle = spectrumState.status === "idle";
  useEffect(() => {
    if (spectrumIdle) setSourceTab("spectrum");
  }, [spectrumIdle]);
  // El punto elegido y su pestana van en la URL: el link copiado abre con el panel a la vista.
  useSourceUrl({ enabled: layout !== "embed", spectrum, tab: sourceTab, setTab: setSourceTab });

  // ---- Herramienta Medir ----------------------------------------------------

  const rawMeasure = useMeasure(view.current);
  const { active: measureActive, setActive: setMeasureActive, pick: pickMeasure } = rawMeasure;
  const { mode, setMode, playing, setPlaying } = controller;
  // Se mide sobre una epoca sola: el parpadeo. En `embed` no se ofrece.
  const measuring = layout !== "embed" && measureActive && mode === "blink";
  const toggleMeasure = useCallback(
    (next: boolean) => {
      if (next) {
        if (mode !== "blink") setMode("blink");
        // En pausa: el clic marca la epoca que se ve, y no tiene que cambiar sola.
        if (playing) setPlaying(false);
        // El clic deja de abrir el espectro: el panel de la fuente se cierra.
        closeSpectrum();
        setTools(null);
      }
      setMeasureActive(next);
    },
    [mode, setMode, playing, setPlaying, closeSpectrum, setMeasureActive],
  );
  // Otro modo combina epocas (o muestra otra mision): ahi no hay que marcar.
  useEffect(() => {
    if (measureActive && mode !== "blink") setMeasureActive(false);
  }, [measureActive, mode, setMeasureActive]);
  /** El medidor como lo ve el visor: prendido solo si se puede marcar, y con su conmutador. */
  const measure = useMemo<Measure>(
    () => ({ ...rawMeasure, active: measuring, setActive: toggleMeasure }),
    [rawMeasure, measuring, toggleMeasure],
  );
  useImageClickTool(
    MEASURE_CLICK_TOOL,
    measuring ? (click: ImageClick) => pickMeasure({ x: click.x, y: click.y }) : null,
  );

  // ---- Curva de luz de las variables del desafio ----------------------------

  const fieldReady = useFieldStore(
    (state) => state.fieldId !== null && state.meta?.grid !== undefined,
  );
  const variable = useMemo(
    () =>
      challengeVariableFor({
        name: urlName,
        center: urlRa === null || urlDec === null ? null : { ra: urlRa, dec: urlDec },
      }),
    [urlName, urlRa, urlDec],
  );
  // Se ofrece con el campo ya abierto y mientras el panel de la fuente esta cerrado.
  // Midiendo tampoco: el clic es del medidor y el panel de la fuente esta cerrado.
  const offered = layout !== "embed" && fieldReady && !spectrumOpen && !measuring ? variable : null;
  // En el celular va con los controles, debajo de la imagen. Debajo del cajon o de la hoja del
  // espectro sigue en su lugar, sin verse, como los demas controles: la imagen no cambia de tamano.
  const phoneOffer = layout === "phone" && fieldReady && !measuring ? variable : null;

  // ---- Celular: la imagen no se achica en los modos que comparan -------------

  // La epoca de referencia y el boton de mantener suman alto a los controles. La zona de la imagen
  // conserva el alto que tenia en el parpadeo (o la suma, que tiene los mismos controles) y son
  // los controles los que se desplazan (ViewerPage.module.css, `data-stage-lock`).
  const stageCellRef = useRef<HTMLDivElement | null>(null);
  const [plainStageHeight, setPlainStageHeight] = useState<number | null>(null);
  const pairMode = mode === "difference" || mode === "redcyan" || mode === "hold";
  const plainMode = (mode === "blink" || mode === "sum") && !measuring;
  // Mide despues de cada dibujo: el alto cambia con la ventana y con lo que haya en los controles.
  useLayoutEffect(() => {
    if (layout !== "phone" || !plainMode) return;
    const height = stageCellRef.current?.offsetHeight ?? 0;
    if (height > 0) setPlainStageHeight(height);
  });
  const stageLock = layout === "phone" && pairMode ? plainStageHeight : null;

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

  // Unico lugar que recibe el clic sobre la imagen: imageClick.ts decide a quien va.
  const handleImageClick = useCallback(
    (click: ImageClick) => {
      routeImageClick(click, (sourceClick) => {
        setTools(null);
        requestSpectrum(sourceClick);
      });
    },
    [requestSpectrum],
  );
  /** Abre el panel del objeto del campo directo en la pestana de la curva de luz. */
  const openLightcurve = useCallback(() => {
    if (variable === null) return;
    setTools(null);
    setSourceTab("lightcurve");
    requestSpectrumOfObject(variable);
  }, [variable, requestSpectrumOfObject]);
  /** Punto que se pidio, para marcarlo sobre la imagen; el objeto buscado ya tiene su mira. */
  const spectrumMark = useMemo(() => {
    if (spectrumState.status === "idle" || spectrumState.point.pixel === null) return null;
    return {
      ...spectrumState.point.pixel,
      radiusPx: spectrumState.status === "ready" ? spectrumState.spectrum.aperture.radius_px : null,
    };
  }, [spectrumState]);

  // ---- Ficha del objeto ------------------------------------------------------

  // Va arriba de las pestanas del panel de la fuente, si el campo tiene contexto:
  // las fuentes de Gaia, el pixel elegido y la fecha de la imagen que se ve.
  const cardGrid = gaia.grid;
  const cardPoint = useMemo(() => {
    if (spectrumState.status === "idle" || cardGrid === null) return null;
    const { pixel, query } = spectrumState.point;
    if (pixel !== null) return pixel;
    // El objeto buscado no trae pixel (ya tiene su mira). La ficha busca en Gaia la fuente que
    // esta en ese punto en la fecha de la imagen, asi que va la posicion del objeto en la epoca
    // que se ve y no la de referencia: Barnard se corre 7 segundos de arco entre 2026,0 y su
    // ultima epoca, mas que el radio de busqueda de la ficha.
    const target = selectTargetPosition(useFieldStore.getState(), shownEpoch);
    if (target !== null) return { x: target.x, y: target.y };
    return skyToPixel(cardGrid, query.ra, query.dec);
  }, [spectrumState, cardGrid, shownEpoch]);
  const objectCard =
    cardGrid === null ? null : (
      <ObjectCard
        catalog={gaia.catalog}
        grid={cardGrid}
        point={cardPoint}
        year={gaia.year}
        onPick={(pixel) => requestSpectrumPosition(pixelToSky(cardGrid, pixel.x, pixel.y))}
        // Plegada: arriba del espectro va su resumen, y el grafico queda a la vista.
        collapsible
      />
    );

  // Pie de la placa del DSS que se ve en el viaje: su credito y, si el objeto
  // estaba fuera del campo en esa fecha, el aviso.
  const plateCaption =
    journeyOn && source === "survey" && journey.plate !== null ? (
      <PlateCaption plate={journey.plate} outside={journey.outside} name={urlName} />
    ) : null;

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
      data-curtain={controller.curtain.available ? "available" : undefined}
      data-plate={plateCaption === null ? undefined : (journey.plate?.key ?? undefined)}
      data-flags={controller.flags.status}
      data-spectrum={spectrumOpen ? "open" : undefined}
      data-click={canPick ? clickMode : undefined}
      data-measure={layout === "embed" ? undefined : measuring ? "on" : "off"}
      data-measure-marks={measuring ? rawMeasure.marks.length : undefined}
      data-stage-lock={stageLock === null ? undefined : ""}
      style={
        stageLock === null
          ? undefined
          : ({ "--viewer-stage-lock": `${stageLock}px` } as CSSProperties)
      }
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
          scene={curtainOn ? null : scene}
          imageSize={imageSize}
          homeZoom={homeZoomForViewFov(fov)}
          insets={insets}
          ariaLabel={t("page.viewerLabel")}
          ariaDescribedBy={helpId}
          onImageClick={canPick ? handleImageClick : undefined}
        >
          {(overlay: ViewerOverlay) =>
            // En la cortina la imagen del visor no se ve: sus anotaciones tampoco.
            curtainOn ? null : (
              <>
                <GaiaOverlay overlay={overlay} gaia={controller.gaia} shown={source !== "none"} />
                <ImageAnnotations
                  overlay={overlay}
                  controller={controller}
                  spectrumMark={spectrumOpen ? spectrumMark : null}
                />
                {measuring ? (
                  <MeasureLayer overlay={overlay} measure={measure} clicks="external" />
                ) : null}
              </>
            )
          }
        </ImageViewer>
      </div>
      <p id={helpId} hidden>
        {t("page.viewerHelp")}
        {canPick && clickMode === DEFAULT_IMAGE_CLICK_MODE
          ? ` ${t("page.viewerHelpSpectrum")}`
          : null}
        {measuring ? ` ${tMeasure("panel.hint")}` : null}
      </p>

      <div ref={stageCellRef} className={styles.stage}>
        {/* La zona donde se encuadra la imagen. El pie de la placa va debajo y le saca lugar. */}
        <div ref={stageRef} className={styles.frame}>
          {curtainOn ? <CurtainStage controller={controller} /> : null}
          <StageStatus controller={controller} />
        </div>
        {plateCaption}
      </div>

      {layout === "desktop" ? (
        <div className={styles.right}>
          {offered === null ? null : <LightcurveOffer variable={offered} onOpen={openLightcurve} />}
          <SpectrumDock
            spectrum={spectrum}
            tab={sourceTab}
            onTabChange={setSourceTab}
            band={band}
            header={objectCard}
          />
          <MeasurePanel measure={measure} collapsible />
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
            {/* Fuera de la imagen: sobre ella tapaba la mira del objeto. */}
            {phoneOffer === null ? null : (
              <LightcurveOffer variable={phoneOffer} onOpen={openLightcurve} variant="compact" />
            )}
            <MeasurePanel
              measure={measure}
              collapsible
              variant="compact"
              className={measuring ? styles.measureSheet : styles.measureStrip}
            />
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
              <SpectrumDock
                spectrum={spectrum}
                tab={sourceTab}
                onTabChange={setSourceTab}
                band={band}
                header={objectCard}
              />
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
