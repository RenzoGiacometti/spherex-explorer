// Pagina de desarrollo del medidor: /?dev=measure con `pnpm dev`.
//
// Arma el visor de escritorio con los paneles que hacen falta para medir
// (banda, imagen, linea de tiempo) y le suma la capa y el panel del medidor,
// contra el backend real: App.tsx ya abre el campo que diga la URL.
//
//   /?dev=measure&ra=269.4463&dec=4.7683&name=Barnard%27s+Star&band=3
//   /?dev=measure&ra=133.7598&dec=-7.2422&name=WISE+J085510.83-071442.5&band=6
//
// Parametros propios, ademas de los del visor (ra, dec, name, band, epoch, fov, lang):
//
//   mark   1 arranca con la marca por clic activada
//   auto   1 marca sola cada epoca en la posicion de catalogo de /track, para
//          comprobar el medidor de punta a punta sin puntero
//
// Deja el estado en el DOM, para comprobarlo desde afuera:
//
//   main[data-dev-page="measure"]  data-phase, data-band, data-epoch, data-marks,
//                                  data-auto (idle | running | done)
//   [data-measure-result]          data-model, data-displacement, data-motion,
//                                  data-motion-east, data-motion-north, data-motion-sigma
//   [data-measure-catalog]         data-catalog-motion, data-catalog-sigmas
//   [data-measure="mark"]          data-epoch, data-method, data-x, data-y

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, GlassPanel, QuickLink, QuickLinkList } from "@/components";
import type { DevPage } from "@/dev/devPages";
import { BandPanel } from "@/features/viewer/BandPanel";
import { ImageAnnotations } from "@/features/viewer/ImageAnnotations";
import { ImagePanel } from "@/features/viewer/ImagePanel";
import { StageStatus } from "@/features/viewer/StageStatus";
import { TimelineDock } from "@/features/viewer/TimelineDock";
import { useStageInsets } from "@/features/viewer/useStageInsets";
import { useViewerController } from "@/features/viewer/useViewerController";
import page from "@/features/viewer/ViewerPage.module.css";
import { useFieldStore } from "@/state/fieldStore";
import { useUrlState } from "@/state/urlState";
import type { ImageSize } from "@/viewer/compose";
import { ImageViewer, type ViewerOverlay } from "@/viewer/ImageViewer";
import { homeZoomForViewFov } from "@/viewer/view";
import { MeasureLayer } from "./MeasureLayer";
import { MeasurePanel } from "./MeasurePanel";
import styles from "./measureDev.module.css";
import { useMeasureTexts } from "./texts";
import { useMeasure } from "./useMeasure";

/** Objetos de prueba con movimiento propio alto (CLAUDE.md), centrados en su posicion de 2026. */
const TEST_OBJECTS = [
  {
    name: "Barnard's Star",
    href: "?dev=measure&ra=269.4463&dec=4.7683&name=Barnard%27s+Star&band=3&mark=1",
  },
  {
    name: "WISE 0855",
    href: "?dev=measure&ra=133.7598&dec=-7.2422&name=WISE+J085510.83-071442.5&band=6&mark=1",
  },
] as const;

type AutoStatus = "idle" | "running" | "done";

function MeasureDevPage() {
  const t = useMeasureTexts();
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const hasField = useUrlState((state) => state.ra !== null && state.dec !== null);
  const fov = useUrlState((state) => state.fov);
  const band = useUrlState((state) => state.band);
  const phase = useFieldStore((state) => state.phase);
  const gridShape = useFieldStore((state) => state.meta?.grid?.shape);
  const track = useFieldStore((state) => state.target.track);

  const controller = useViewerController();
  const { view, scene } = controller;
  const measure = useMeasure(view.current);
  const { setActive, pick } = measure;

  const viewerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const insets = useStageInsets(viewerRef, stageRef);
  const helpId = useId();

  const height = gridShape?.[0];
  const width = gridShape?.[1];
  const imageSize = useMemo<ImageSize | undefined>(
    () => (width === undefined || height === undefined ? undefined : { width, height }),
    [width, height],
  );

  // `mark=1`: la marca por clic arranca activada.
  useEffect(() => {
    if (params.get("mark") === "1") setActive(true);
  }, [params, setActive]);

  // ---- Marca automatica en las posiciones de catalogo ---------------------------

  const [auto, setAuto] = useState<AutoStatus>(params.get("auto") === "1" ? "running" : "idle");
  /** Cuantas epocas de la trayectoria ya se marcaron. */
  const [autoStep, setAutoStep] = useState(0);
  const imageEpochs = view.imageEpochs;
  const selectEpoch = controller.selectEpoch;
  const current = view.current;

  useEffect(() => {
    if (auto !== "running" || track === null || phase !== "ready") return;
    // Solo las epocas que tienen imagen en esta banda y posicion en la trayectoria.
    const targets = track.positions.filter((position) => imageEpochs.includes(position.epoch));
    const target = targets[autoStep];
    if (target === undefined) {
      setAuto("done");
      return;
    }
    if (current !== target.epoch) {
      selectEpoch(target.epoch);
      return;
    }
    pick({ x: target.x, y: target.y });
    setAutoStep(autoStep + 1);
  }, [auto, autoStep, track, phase, imageEpochs, current, selectEpoch, pick]);

  if (!hasField) {
    return (
      <main className={styles.empty} data-dev-page="measure" data-phase="idle">
        <GlassPanel title={t("dev.title")} icon="target">
          <p className={styles.text}>{t("dev.empty")}</p>
          <QuickLinkList label={t("dev.links")}>
            {TEST_OBJECTS.map((item) => (
              <QuickLink key={item.name} href={item.href}>
                {item.name}
              </QuickLink>
            ))}
          </QuickLinkList>
        </GlassPanel>
      </main>
    );
  }

  return (
    <main
      className={page.page}
      data-layout="desktop"
      data-dev-page="measure"
      data-phase={phase}
      data-band={band}
      data-epoch={view.current ?? undefined}
      data-marks={measure.marks.length}
      data-auto={auto}
    >
      <div className={page.top} />

      <div className={page.left}>
        <BandPanel currentEpoch={view.current} />
        <ImagePanel controller={controller} />
      </div>

      <div ref={viewerRef} className={page.viewer}>
        <ImageViewer
          scene={scene}
          imageSize={imageSize}
          homeZoom={homeZoomForViewFov(fov)}
          insets={insets}
          ariaLabel={t("dev.viewerLabel")}
          ariaDescribedBy={helpId}
        >
          {(overlay: ViewerOverlay) => (
            <>
              <ImageAnnotations overlay={overlay} controller={controller} />
              <MeasureLayer overlay={overlay} measure={measure} />
            </>
          )}
        </ImageViewer>
      </div>
      <p id={helpId} hidden>
        {t("panel.hint")}
      </p>

      <div ref={stageRef} className={page.stage}>
        <StageStatus controller={controller} />
      </div>

      <div className={page.right}>
        <MeasurePanel measure={measure} />
        <Button
          icon="target"
          disabled={track === null || track.positions.length === 0 || auto === "running"}
          onClick={() => {
            setAutoStep(0);
            setAuto("running");
          }}
        >
          {t("dev.auto")}
        </Button>
      </div>

      <div className={page.dock}>
        <TimelineDock controller={controller} />
      </div>
    </main>
  );
}

export const devPage: DevPage = { Component: MeasureDevPage };
