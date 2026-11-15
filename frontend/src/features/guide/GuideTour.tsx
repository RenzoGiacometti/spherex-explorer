// Recorrido guiado sobre el visor: una tarjeta con la consigna del paso y un
// anillo que resalta el control (DESIGN.md: vidrio para la tarjeta, blanco para
// el anillo; el acento no entra en ninguno de sus cuatro usos).
//
// Va montado al lado de la pantalla del visor, no adentro, y no le pasa ni le
// pide nada: mira la URL y lo que el visor publica en el documento
// (viewerDom.ts). Los controles del visor siguen andando como siempre; el
// recorrido espera a que la persona haga lo que pide cada paso. Lo unico que
// cambia por su cuenta es la comparacion, al activar rojo/cian: la epoca de
// referencia y el estirado (viewerControls.ts).
//
// Mientras dura, la mira y el rastro que el visor dibuja sobre el objeto quedan
// ocultos: el recorrido consiste en encontrarlo. Aparecen en el cierre, o al
// saltarlo.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, GlassPanel } from "@/components";
import a11y from "@/components/a11y.module.css";
import { formatInteger } from "@/lib/format";
import { useFieldStore } from "@/state/fieldStore";
import { useUrlState } from "@/state/urlState";
import styles from "./guide.module.css";
import { useGuideStore } from "./guideStore";
import {
  ensureVisible,
  findStepControl,
  type Highlight,
  measureHighlight,
  sameHighlight,
} from "./highlight";
import { isHit, isTap, type ScreenPoint } from "./locate";
import {
  isOnTourField,
  isStepDone,
  pickReferenceEpoch,
  stepDwell,
  stepNumber,
  TOUR_MODE,
  TOUR_PLAY_MODE,
  TOUR_STEPS,
  TOUR_STRETCH,
  type TourSignals,
  type TourStep,
} from "./tour";
import { prepareComparison } from "./viewerControls";
import {
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
  const referenceGroup = tViewer("comparison.reference");
  const stretchGroup = tViewer("image.stretch");
  const toolsOpenLabel = tViewer("tools.open");
  const toolsCloseLabel = tViewer("tools.close");

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

  // ---- La comparacion -------------------------------------------------------

  // Apenas se activa rojo/cian, el recorrido deja lista la comparacion en la
  // que el objeto se distingue (tour.ts): la ultima epoca contra la mas lejana
  // de las bien armadas, con el estirado lineal. Lo hace por los controles del
  // visor, asi que queda a la vista y la persona lo puede cambiar.
  const comparisonReached = step === "redcyan" && stepReached;
  useEffect(() => {
    if (!comparisonReached) return;
    const url = useUrlState.getState();
    // Sin epoca fija la actual (A) es la ultima.
    if (url.epoch !== null) url.update({ epoch: null });
    void prepareComparison({
      labels: {
        referenceGroup,
        stretchGroup,
        toolsOpen: toolsOpenLabel,
        toolsClose: toolsCloseLabel,
      },
      stretch: TOUR_STRETCH,
      pickReference: (current) => {
        const { meta, band: shown } = useFieldStore.getState();
        const epochs = (meta?.planes ?? [])
          .filter((plane) => plane.detector === shown)
          .map((plane) => ({ epoch: plane.epoch, exposures: plane.n_used }));
        return pickReferenceEpoch(epochs, current);
      },
      cancelled: () => !useGuideStore.getState().active,
    });
  }, [comparisonReached, referenceGroup, stretchGroup, toolsOpenLabel, toolsCloseLabel]);

  // ---- Ubicar el objeto -----------------------------------------------------

  // Un clic o un toque sobre la imagen, cerca de donde esta el objeto. Se
  // escucha en la ventana, en la fase de captura: el visor captura el puntero
  // para el arrastre, y un arrastre no cuenta.
  useEffect(() => {
    if (step !== "locate") return;
    let down: (ScreenPoint & { readonly id: number }) | null = null;

    const onPointerDown = (event: PointerEvent): void => {
      const image = findImageRoot(findViewerPage());
      const onImage =
        image !== null && event.target instanceof Node && image.contains(event.target);
      down =
        onImage && event.isPrimary && event.button === 0
          ? { id: event.pointerId, x: event.clientX, y: event.clientY }
          : null;
    };

    const onPointerUp = (event: PointerEvent): void => {
      const start = down;
      down = null;
      if (start === null || start.id !== event.pointerId) return;
      const tap = { x: event.clientX, y: event.clientY };
      if (!isTap(start, tap)) return;
      const page = findViewerPage();
      const target = readTargetPoint(page);
      if (target !== null && isHit(tap, target, readPixelsPerArcsec(page))) completeStep("locate");
      else miss();
    };

    const onPointerCancel = (): void => {
      down = null;
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
    };
  }, [step, completeStep, miss]);

  // ---- La mira del visor ----------------------------------------------------

  // Oculta hasta el cierre. Antes de pintar, para que no llegue a verse.
  const hidesTarget = step !== "closing";
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
            <Button onClick={end}>{step === "closing" ? t("tour.finish") : t("tour.skip")}</Button>
          </div>
        </GlassPanel>
      </div>
    </>
  );
}
