// Recorrido guiado sobre el visor: una tarjeta con la consigna del paso y un
// anillo que resalta el control (DESIGN.md: vidrio para la tarjeta, blanco para
// el anillo; el acento no entra en ninguno de sus cuatro usos).
//
// Va montado al lado de la pantalla del visor, no adentro, y no le pasa ni le
// pide nada: mira la URL y lo que el visor publica en el documento
// (viewerDom.ts). Los controles del visor siguen andando como siempre; el
// recorrido espera a que la persona haga lo que pide cada paso. Lo unico que
// cambia por su cuenta va por la URL: el estirado, al elegir B6, y las epocas
// que se comparan, al activar rojo/cian.
//
// El clic sobre la imagen lo toma por la regla del visor
// (features/viewer/imageClick.ts, con el nombre "guide") mientras pide marcar
// el objeto, para que ese clic le responda al recorrido y no abra el espectro.
// Lo suelta al entrar al ultimo paso, y ahi hace un clic sobre la mira: el
// clic por defecto del visor abre el panel del objeto.
//
// Mientras se busca, la mira y el rastro que el visor dibuja sobre el objeto
// quedan ocultos: el recorrido consiste en encontrarlo. Aparecen en el cierre,
// o al saltarlo.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, GlassPanel } from "@/components";
import a11y from "@/components/a11y.module.css";
// La regla del clic no sale por el indice del visor: se importa de su archivo.
import { useImageClickTool } from "@/features/viewer/imageClick";
import { formatInteger } from "@/lib/format";
import { useUrlState } from "@/state/urlState";
import type { ImageClick } from "@/viewer/ImageViewer";
import styles from "./guide.module.css";
import { useGuideStore } from "./guideStore";
import {
  ensureVisible,
  findStepControl,
  type Highlight,
  measureHighlight,
  sameHighlight,
} from "./highlight";
import { isHit } from "./locate";
import {
  isOnTourField,
  isStepDone,
  isTargetRevealed,
  stepDwell,
  stepNumber,
  TOUR_MODE,
  TOUR_PLAY_MODE,
  TOUR_STEPS,
  TOUR_STRETCH,
  type TourSignals,
  type TourStep,
} from "./tour";
import {
  clickImageAt,
  findImageRoot,
  findViewerPage,
  isPlaying,
  readPixelsPerArcsec,
  readTargetPoint,
} from "./viewerDom";

/**
 * Atributo de `<html>` que oculta la mira y el rastro del visor mientras dura
 * el recorrido. La regla esta en guide.module.css.
 */
const HIDE_TARGET_ATTRIBUTE = "data-guide-hides-target";

/** Nombre con el que el recorrido toma el clic sobre la imagen (`data-click` del visor). */
const CLICK_TOOL_ID = "guide";

/**
 * Espera antes del clic que abre el espectro, en ms: el visor avisa un clic
 * recien cuando ya no puede ser un doble (350 ms); con este margen el del
 * recorrido tampoco se toma por el segundo de un doble clic de la persona.
 */
const OPEN_SPECTRUM_DELAY_MS = 150;

/**
 * Recorrido guiado "Encontra a WISE 0855". Se monta una vez, junto a la
 * pantalla del visor o por encima de las dos pantallas; no dibuja nada hasta
 * que `startTour` lo inicia. Termina solo si se sale del campo del recorrido.
 *
 * Conviene montarlo antes que la pantalla: asi sus botones (Saltar) son lo
 * primero que encuentra el tabulador. En pantalla va fijo, encima de todo.
 */
export function GuideTour() {
  const active = useGuideStore((state) => state.active);
  const onTourField = useUrlState((state) => isOnTourField(state.ra, state.dec));

  // Otro campo, o la entrada: el recorrido no sigue.
  useEffect(() => {
    if (active && !onTourField) useGuideStore.getState().end();
  }, [active, onTourField]);

  // Si se desmonta junto con el visor, lo mismo. Se mira la URL en ese momento
  // porque React, en desarrollo, desmonta y vuelve a montar cada componente.
  useEffect(
    () => () => {
      const { ra, dec } = useUrlState.getState();
      if (!isOnTourField(ra, dec)) useGuideStore.getState().end();
    },
    [],
  );

  return active && onTourField ? <TourOverlay /> : null;
}

function TourOverlay() {
  const { t } = useTranslation("guide");
  const { t: tViewer } = useTranslation("viewer");
  const { t: tComponents } = useTranslation("components");

  const step = useGuideStore((state) => state.step);
  const missed = useGuideStore((state) => state.missed);
  const completeStep = useGuideStore((state) => state.completeStep);
  const miss = useGuideStore((state) => state.miss);
  const end = useGuideStore((state) => state.end);
  const band = useUrlState((state) => state.band);
  const mode = useUrlState((state) => state.mode);

  const [playing, setPlaying] = useState(false);
  const [highlight, setHighlight] = useState<Highlight | null>(null);
  const playingRef = useRef(false);
  const highlightRef = useRef<Highlight | null>(null);

  // Los controles se buscan por su nombre, en el idioma activo.
  const bandGroup = tViewer("band.group");
  const modeGroup = tViewer("comparison.group");
  const playLabel = tComponents("transport.play");

  // ---- Lo que se lee de la pantalla ----------------------------------------

  // Cuadro a cuadro: los paneles cambian de lugar por motivos que no avisan
  // (otro idioma, un renglon que aparece, el desplazamiento de la pagina) y la
  // mira sigue al acercamiento. Solo se vuelve a dibujar cuando algo cambio.
  useEffect(() => {
    const labels = { bandGroup, modeGroup, play: playLabel };
    let frame = 0;
    let scrolled = false;

    const tick = (): void => {
      frame = window.requestAnimationFrame(tick);
      const page = findViewerPage();

      const nowPlaying = isPlaying(page);
      if (nowPlaying !== playingRef.current) {
        playingRef.current = nowPlaying;
        setPlaying(nowPlaying);
      }

      const control = page === null ? null : findStepControl(step, page, labels);
      if (control !== null && !scrolled) {
        scrolled = true;
        ensureVisible(control);
      }
      const next = page === null ? null : measureHighlight(step, page, control);
      if (!sameHighlight(highlightRef.current, next)) {
        highlightRef.current = next;
        setHighlight(next);
      }
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [step, bandGroup, modeGroup, playLabel]);

  // ---- Avance ---------------------------------------------------------------

  // Un paso cumplido queda cumplido: pausar enseguida despues de reproducir no
  // lo deshace.
  const signals: TourSignals = { band, mode, playing };
  const [reached, setReached] = useState<TourStep | null>(null);
  if (reached !== step && isStepDone(step, signals)) setReached(step);
  const stepReached = reached === step;

  // El paso siguiente espera un momento, para que se vea lo que cambio.
  const dwell = stepDwell(step, signals);
  useEffect(() => {
    if (!stepReached) return;
    const timer = window.setTimeout(() => completeStep(step), dwell);
    return () => window.clearTimeout(timer);
  }, [stepReached, step, dwell, completeStep]);

  // Lo que cada paso necesita encontrar listo al empezar.
  useEffect(() => {
    const url = useUrlState.getState();
    // Solo el parpadeo se reproduce: en otro modo el boton esta deshabilitado.
    if (step === "play" && url.mode !== TOUR_PLAY_MODE && url.mode !== TOUR_MODE) {
      url.update({ mode: TOUR_PLAY_MODE });
    }
  }, [step]);

  // ---- Lo que el recorrido cambia en el visor -------------------------------

  // Los dos cambios van por la URL, como los haria la persona desde los
  // paneles: quedan a la vista y se pueden deshacer. Las medidas que los
  // justifican estan en tour.ts.

  // Apenas se elige B6, el estirado pasa a lineal: el fondo queda oscuro y el
  // objeto se despega en el parpadeo (el visor ya abre en lineal la diferencia
  // y el rojo/cian, pero el parpadeo, en asinh).
  const bandReached = step === "band" && stepReached;
  useEffect(() => {
    if (bandReached) useUrlState.getState().update({ stretch: TOUR_STRETCH });
  }, [bandReached]);

  // Apenas se activa rojo/cian, la comparacion queda como la arma el visor por
  // su cuenta: la ultima epoca (A) contra la mas lejana de las bien cubiertas
  // (B). Solo hay que soltar lo que se haya elegido a mano.
  const comparisonReached = step === "redcyan" && stepReached;
  useEffect(() => {
    if (!comparisonReached) return;
    const url = useUrlState.getState();
    if (url.epoch !== null || url.ref !== null) url.update({ epoch: null, ref: null });
  }, [comparisonReached]);

  // ---- El clic sobre la imagen ----------------------------------------------

  // Mientras se busca el objeto, y en el cierre, el clic es del recorrido: uno
  // cerca de donde esta el objeto cumple el paso. El visor ya descarto los
  // arrastres y los dobles clics. `screen` viene en pixeles de la imagen en
  // pantalla; la mira se lee en pixeles de la ventana.
  const handleImageClick = (click: ImageClick): void => {
    const page = findViewerPage();
    const image = findImageRoot(page)?.getBoundingClientRect();
    const target = readTargetPoint(page);
    const hit =
      image !== undefined &&
      target !== null &&
      isHit(
        { x: image.left + click.screen.x, y: image.top + click.screen.y },
        target,
        readPixelsPerArcsec(page),
      );
    if (hit) completeStep(step);
    else if (step === "locate") miss();
  };
  const claimsClick = step === "locate" || step === "closing";
  useImageClickTool(CLICK_TOOL_ID, claimsClick ? handleImageClick : null);

  // Ultimo paso: con el clic ya suelto, uno sobre la mira abre el panel del
  // objeto (espectro y curva de luz), como si lo hiciera la persona.
  useEffect(() => {
    if (step !== "spectrum") return;
    const timer = window.setTimeout(() => {
      const page = findViewerPage();
      const target = readTargetPoint(page);
      if (target !== null) clickImageAt(page, target);
    }, OPEN_SPECTRUM_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [step]);

  // ---- La mira del visor ----------------------------------------------------

  // Oculta hasta el cierre. Antes de pintar, para que no llegue a verse.
  const hidesTarget = !isTargetRevealed(step);
  useLayoutEffect(() => {
    if (!hidesTarget) return;
    const root = document.documentElement;
    root.setAttribute(HIDE_TARGET_ATTRIBUTE, "");
    return () => root.removeAttribute(HIDE_TARGET_ATTRIBUTE);
  }, [hidesTarget]);

  // ---- Dibujo ---------------------------------------------------------------

  const progress = { n: formatInteger(stepNumber(step)), total: formatInteger(TOUR_STEPS.length) };
  // Con el paso cumplido el anillo se va: lo que queda por mirar es la imagen.
  const ring = highlight !== null && highlight.step === step && !stepReached ? highlight : null;

  return (
    <>
      {ring === null ? null : (
        <div
          className={styles.ring}
          data-shape={ring.shape}
          style={{ left: ring.left, top: ring.top, width: ring.width, height: ring.height }}
          aria-hidden="true"
        />
      )}
      <div className={styles.card} data-guide-step={step}>
        <GlassPanel
          as="aside"
          title={t("tour.title")}
          icon="target"
          aside={
            <>
              <span aria-hidden="true">{t("tour.progress", progress)}</span>
              <span className={a11y.visuallyHidden}>{t("tour.progressLabel", progress)}</span>
            </>
          }
        >
          {/* Cada consigna nueva se anuncia a quien no ve la pantalla. */}
          <div className={styles.message} role="status">
            <p className={styles.text}>{t(`tour.step.${step}`)}</p>
            {step === "locate" && missed ? <p className={styles.hint}>{t("tour.miss")}</p> : null}
          </div>
          <div className={styles.actions}>
            {/* Tambien es la salida de quien usa el teclado, que no puede marcar un punto de la imagen. */}
            {step === "locate" ? (
              <Button onClick={() => completeStep("locate")}>{t("tour.reveal")}</Button>
            ) : null}
            {step === "closing" ? (
              <Button onClick={() => completeStep("closing")}>{t("tour.openSpectrum")}</Button>
            ) : null}
            <Button onClick={end}>
              {isTargetRevealed(step) ? t("tour.finish") : t("tour.skip")}
            </Button>
          </div>
        </GlassPanel>
      </div>
    </>
  );
}
