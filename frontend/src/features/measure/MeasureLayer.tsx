import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import a11y from "@/components/a11y.module.css";
import { useLanguage } from "@/i18n/useLanguage";
import { formatDecimal, formatInteger } from "@/lib/format";
import { skyToPixel } from "@/lib/wcs";
import type { ViewerOverlay } from "@/viewer/ImageViewer";
import { imageToScreen, type Point, screenToImage } from "@/viewer/view";
import styles from "./MeasureLayer.module.css";
import { PREDICTION_YEARS } from "./motion";
import type { Measure } from "./useMeasure";

/** Radio del anillo de una marca y largo de las marcas de la epoca que se ve, en pixeles CSS. */
const MARK_RADIUS = 5;
const TICK_FROM = 8;
const TICK_TO = 13;
/** Radio minimo del circulo de la posicion predicha. */
const PREDICTION_MIN_RADIUS = 6;
/** Separacion entre el circulo de la prediccion y su rotulo. */
const LABEL_GAP = 6;

/** Un clic es un toque corto que casi no se mueve: lo demas es arrastrar la imagen. */
const CLICK_MAX_MOVE = 5;
const CLICK_MAX_MS = 600;

export interface MeasureLayerProps {
  /** Transformacion vigente del visor: llega de `children` de ImageViewer. */
  readonly overlay: ViewerOverlay;
  readonly measure: Measure;
  /**
   * Quien recibe los clics. `own` (por defecto): la capa los escucha en la raiz
   * del visor. `external`: los entrega la pantalla que la monta, llamando a
   * `measure.pick`; es el caso del visor, donde el clic tiene una sola regla
   * (features/viewer/imageClick.ts) y la capa solo dibuja.
   */
  readonly clicks?: "own" | "external";
}

interface Press {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

/**
 * Lo que el medidor dibuja sobre la imagen, y los clics que lo alimentan.
 *
 * - Un anillo en cada marca; el de la epoca que se ve lleva ademas cuatro
 *   marcas, como una mira chica.
 * - La trayectoria ajustada, de la primera marca a la ultima, y en linea
 *   punteada hasta la posicion predicha a cinco anios, con un circulo del
 *   tamano de su error.
 *
 * Todo va en blanco sobre un trazo de vacio, como el rastro: el acento queda
 * para la mira del objeto buscado (DESIGN.md, "Acento").
 *
 * Con `clicks="own"` los clics se escuchan en la raiz del visor y no en un elemento propio: la
 * capa de encima no recibe el puntero, y un elemento que lo recibiera le
 * sacaria al visor el arrastre. Asi, con la marca activada, arrastrar sigue
 * desplazando la imagen y un clic sin arrastre deja la marca.
 */
export function MeasureLayer({ overlay, measure, clicks = "own" }: MeasureLayerProps) {
  const { t } = useTranslation("measure");
  const language = useLanguage();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { transform, viewport } = overlay;
  const { active, pick, marks, fit, grid, epoch, overlayRef } = measure;

  // La transformacion vigente, para los clics y para `pickAtViewCenter`.
  const liveRef = useRef(overlay);
  useLayoutEffect(() => {
    liveRef.current = overlay;
    overlayRef.current = overlay;
    return () => {
      overlayRef.current = null;
    };
  }, [overlay, overlayRef]);

  // La cruz avisa que un clic marca. Va sobre la raiz del visor: es ella la que fija el cursor.
  useEffect(() => {
    if (!active) return;
    const root = svgRef.current?.closest<HTMLElement>("[tabindex]") ?? null;
    if (root === null) return;
    const previousCursor = root.style.cursor;
    root.style.cursor = "crosshair";
    return () => {
      root.style.cursor = previousCursor;
    };
  }, [active]);

  const ownClicks = clicks === "own";
  useEffect(() => {
    if (!active || !ownClicks) return;
    const svg = svgRef.current;
    const layer = svg?.parentElement ?? null;
    // La raiz del visor es el ancestro que recibe el foco (ImageViewer.tsx).
    const root = svg?.closest<HTMLElement>("[tabindex]") ?? null;
    if (svg === null || root === null) return;

    let press: Press | null = null;
    let pointers = 0;

    const onDown = (event: PointerEvent): void => {
      pointers += 1;
      const ownGesture =
        pointers === 1 &&
        (event.pointerType !== "mouse" || event.button === 0) &&
        // Lo que empieza en un hijo interactivo de la capa de encima es de ese hijo.
        !(layer !== null && event.target instanceof Node && layer.contains(event.target));
      press = ownGesture
        ? { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp }
        : null;
    };
    const onUp = (event: PointerEvent): void => {
      pointers = Math.max(0, pointers - 1);
      const start = press;
      press = null;
      if (start === null || start.id !== event.pointerId) return;
      if (event.timeStamp - start.at > CLICK_MAX_MS) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_MAX_MOVE) return;
      const rect = svg.getBoundingClientRect();
      const point = screenToImage(
        liveRef.current.transform,
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
      pick(point);
    };
    const onCancel = (): void => {
      pointers = Math.max(0, pointers - 1);
      press = null;
    };

    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onCancel);
    return () => {
      root.removeEventListener("pointerdown", onDown);
      root.removeEventListener("pointerup", onUp);
      root.removeEventListener("pointercancel", onCancel);
    };
  }, [active, ownClicks, pick]);

  // ---- Trayectoria y prediccion ------------------------------------------------

  const toScreen = (ra: number, dec: number): Point | null => {
    if (grid === null) return null;
    const pixel = skyToPixel(grid, ra, dec);
    return pixel === null ? null : imageToScreen(transform, pixel.x, pixel.y);
  };
  const start = fit === null ? null : toScreen(fit.start.ra, fit.start.dec);
  const end = fit === null ? null : toScreen(fit.end.ra, fit.end.dec);
  const predicted = fit === null ? null : toScreen(fit.prediction.ra, fit.prediction.dec);
  const predictionRadius =
    fit === null || grid === null
      ? 0
      : Math.max(
          PREDICTION_MIN_RADIUS,
          (fit.prediction.sigmaArcsec / grid.pixel_scale_arcsec) * transform.scale,
        );
  // El rotulo va del lado hacia el que avanza el objeto: del otro llega la trayectoria.
  const labelOnLeft = predicted !== null && end !== null && predicted.x < end.x;

  return (
    <>
      <svg
        ref={svgRef}
        className={styles.layer}
        width={viewport.width}
        height={viewport.height}
        aria-hidden="true"
        focusable="false"
        data-measure-layer={active ? "active" : "idle"}
      >
        {start !== null && end !== null ? (
          <g data-measure="trajectory">
            <line className={styles.halo} x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
            <line className={styles.line} x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
          </g>
        ) : null}

        {end !== null && predicted !== null ? (
          <g data-measure="prediction">
            <line className={styles.halo} x1={end.x} y1={end.y} x2={predicted.x} y2={predicted.y} />
            <line
              className={styles.dashed}
              x1={end.x}
              y1={end.y}
              x2={predicted.x}
              y2={predicted.y}
            />
            <circle
              className={styles.halo}
              cx={predicted.x}
              cy={predicted.y}
              r={predictionRadius}
            />
            <circle
              className={styles.dashed}
              cx={predicted.x}
              cy={predicted.y}
              r={predictionRadius}
            />
            <text
              className={styles.label}
              x={predicted.x + (labelOnLeft ? -1 : 1) * (predictionRadius + LABEL_GAP)}
              y={predicted.y + 4}
              textAnchor={labelOnLeft ? "end" : "start"}
            >
              {t("layer.prediction", { years: formatInteger(PREDICTION_YEARS) })}
            </text>
          </g>
        ) : null}

        {marks.map((mark) => {
          const center = imageToScreen(transform, mark.x, mark.y);
          const shown = mark.epoch === epoch;
          return (
            <g
              key={mark.epoch}
              data-measure="mark"
              data-epoch={mark.epoch}
              data-method={mark.method}
              data-x={mark.x.toFixed(3)}
              data-y={mark.y.toFixed(3)}
              transform={`translate(${center.x} ${center.y})`}
              opacity={shown ? 1 : 0.7}
            >
              {[styles.halo, styles.line].map((className) => (
                <g key={className} className={className}>
                  <circle cx={0} cy={0} r={MARK_RADIUS} />
                  {shown ? (
                    <path
                      d={`M0 ${-TICK_TO}V${-TICK_FROM}M0 ${TICK_FROM}V${TICK_TO}M${-TICK_TO} 0H${-TICK_FROM}M${TICK_FROM} 0H${TICK_TO}`}
                    />
                  ) : null}
                </g>
              ))}
            </g>
          );
        })}
      </svg>

      {/* Lo mismo que dicen los dibujos, para quien no los ve. */}
      {marks.length === 0 ? null : (
        <ul className={a11y.visuallyHidden} aria-label={t("layer.summary")}>
          <li>{t("layer.summaryMarks", { n: formatInteger(marks.length) })}</li>
          {fit === null ? null : (
            <>
              <li>
                {t("layer.summaryMotion", {
                  value: formatDecimal(fit.motion.total, language, 2),
                  sigma: formatDecimal(fit.motionSigma, language, 2),
                })}
              </li>
              <li>{t("layer.summaryPrediction", { years: formatInteger(PREDICTION_YEARS) })}</li>
            </>
          )}
        </ul>
      )}
    </>
  );
}
