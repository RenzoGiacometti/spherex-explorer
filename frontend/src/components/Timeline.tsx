import {
  type CSSProperties,
  type RefObject,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { formatInteger } from "@/lib/format";
import a11y from "./a11y.module.css";
import { classNames } from "./classNames";
import styles from "./Timeline.module.css";
import { EPOCH_STOP_WIDTH_PX, layoutEpochs, minEpochGap } from "./timelineLayout";

/**
 * Estado de una epoca en la banda que se esta mirando. Son los mismos nombres
 * que entrega la capa de datos (`EpochLoadState` de src/data/selectors.ts), asi
 * que lo que da `selectTimeline` se pasa tal cual:
 * - `loaded`: imagen completa.
 * - `provisional`: la imagen se armo con parte de sus exposiciones.
 * - `unloaded`: sin cargar; todavia no hay imagen.
 * - `empty`: sin datos; la epoca no tiene exposiciones en esta banda y no va a
 *   haber imagen.
 */
export type EpochStatus = "loaded" | "provisional" | "unloaded" | "empty";

/** Los aspectos de una marca: los estados de la epoca y la epoca actual. */
export type EpochMarkerState = EpochStatus | "current";

export const EPOCH_MARKER_STATES: readonly EpochMarkerState[] = [
  "loaded",
  "provisional",
  "unloaded",
  "empty",
  "current",
];

/**
 * Los cuatro estados que nombra DESIGN.md ("Linea de tiempo"). Son los que
 * explican las referencias por defecto; `empty` se agrega cuando el campo tiene
 * alguna epoca sin datos en la banda.
 */
export const EPOCH_LEGEND_STATES: readonly EpochMarkerState[] = [
  "loaded",
  "provisional",
  "unloaded",
  "current",
];

export interface EpochMarkerProps {
  readonly state: EpochMarkerState;
  readonly className?: string | undefined;
}

/**
 * Marca de epoca (`timeline-epoch*` de DESIGN.md). Es solo el dibujo: punto
 * blanco de 8 px (cargada), anillo punteado de 8 px (provisoria), punto hueco
 * de 8 px (sin cargar) y punto ambar de 12 px con anillo (actual). El texto
 * que la acompana lo pone quien la usa.
 *
 * Sin datos: una cruz de 8 px en `text-dim`. DESIGN.md todavia no define ese
 * estado; el dibujo es provisorio y sigue el criterio de la banda sin datos
 * (atenuada, sin color nuevo).
 */
export function EpochMarker({ state, className }: EpochMarkerProps) {
  if (state === "empty") {
    return (
      <svg
        className={classNames(styles.marker, styles.empty, className)}
        width={8}
        height={8}
        viewBox="0 0 8 8"
        aria-hidden="true"
        focusable="false"
        data-state={state}
      >
        {/* El disco tapa la linea base: la cruz no queda atravesada. */}
        <circle className={styles.emptyFill} cx="4" cy="4" r="4" />
        <path className={styles.emptyCross} d="M1.75 1.75l4.5 4.5M6.25 1.75l-4.5 4.5" />
      </svg>
    );
  }
  if (state === "provisional") {
    // El punteado se dibuja en SVG: un borde `dotted` de 1 px no se distingue a 8 px.
    return (
      <svg
        className={classNames(styles.marker, styles.provisional, className)}
        width={8}
        height={8}
        viewBox="0 0 8 8"
        aria-hidden="true"
        focusable="false"
        data-state={state}
      >
        <circle className={styles.provisionalFill} cx="4" cy="4" r="4" />
        <circle className={styles.provisionalRing} cx="4" cy="4" r="3.25" />
      </svg>
    );
  }
  return (
    <span
      className={classNames(styles.marker, styles[state], className)}
      aria-hidden="true"
      data-state={state}
    />
  );
}

export interface TimelineEpoch {
  /** Numero de epoca, desde 1. */
  readonly epoch: number;
  /**
   * Fecha con la que se ubica la marca, en cualquier unidad creciente; lo
   * natural es el `mjd_start` de la epoca.
   */
  readonly time: number;
  /** Lo que se lee debajo de la marca: el mes de inicio, "2025-06". */
  readonly dateLabel: string;
  readonly status: EpochStatus;
}

export interface TimelineTrackProps {
  /** Nombre accesible de la pista. */
  readonly label: string;
  /** Epocas en orden de fecha. Un campo tiene 3 o 4. */
  readonly epochs: ReadonlyArray<TimelineEpoch>;
  /** Numero de la epoca actual, o `null` si no hay ninguna. */
  readonly current: number | null;
  readonly onSelect: (epoch: number) => void;
  readonly disabled?: boolean;
  readonly className?: string | undefined;
}

/**
 * Ancho en pixeles de un elemento que esta siempre montado, y sus cambios.
 * null hasta medirlo o si no tiene layout (jsdom).
 */
function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number | null] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = (): void => {
      const measured = element.clientWidth;
      setWidth(measured > 0 ? measured : null);
    };
    // Antes de pintar: las marcas no se ven saltar de lugar.
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

/** El ancho de la parada llega al CSS desde la misma constante que usa la separacion. */
const TRACK_STYLE = { "--epoch-stop-width": `${EPOCH_STOP_WIDTH_PX}px` } as CSSProperties;

/**
 * Pista de la linea de tiempo: linea base con una marca por epoca, ubicada
 * segun su fecha, y el mes de inicio debajo. La epoca actual va en ambar
 * aunque sea provisoria; lo provisorio se lee en el rotulo de la imagen y en
 * el nombre accesible de la marca.
 *
 * Cada marca es un boton de radio nativo: se entra con Tab y las flechas
 * pasan a la epoca anterior o siguiente. Una epoca sin datos en la banda
 * tambien se puede elegir, igual que una banda sin datos en la epoca actual.
 *
 * Dos marcas nunca quedan mas cerca que el ancho de una parada, para que no se
 * pisen ni las fechas ni las areas que reciben el toque. Eso depende del ancho
 * de la pista, que se mide en el navegador.
 */
export function TimelineTrack({
  label,
  epochs,
  current,
  onSelect,
  disabled = false,
  className,
}: TimelineTrackProps) {
  const { t } = useTranslation("components");
  const groupName = useId();
  const [stopsRef, trackWidth] = useElementWidth<HTMLDivElement>();
  const positions = layoutEpochs(
    epochs.map((item) => item.time),
    minEpochGap(trackWidth),
  );

  return (
    <fieldset
      className={classNames(styles.track, className)}
      style={TRACK_STYLE}
      disabled={disabled}
    >
      <legend className={a11y.visuallyHidden}>{label}</legend>
      {/*
       * Las capas posicionadas cuelgan de este div y no del fieldset: dentro de
       * un fieldset, Chrome y Edge resuelven con alto 0 una capa absoluta con
       * top y bottom en 0, y el radio que recibe el toque quedaba sin alto.
       */}
      <div className={styles.rail}>
        <span className={styles.baseline} aria-hidden="true" />
        <div ref={stopsRef} className={styles.stops}>
          {epochs.map((item, index) => {
            const isCurrent = item.epoch === current;
            return (
              <label
                key={item.epoch}
                className={classNames(styles.stop, isCurrent && styles.currentStop)}
                style={{ left: `${((positions[index] ?? 0.5) * 100).toFixed(3)}%` }}
              >
                <input
                  type="radio"
                  className={styles.input}
                  name={groupName}
                  value={String(item.epoch)}
                  checked={isCurrent}
                  aria-label={t("timeline.epoch", {
                    n: formatInteger(item.epoch),
                    date: item.dateLabel,
                    state: t(`timeline.state.${item.status}`),
                  })}
                  onChange={() => {
                    // Una pista deshabilitada no avisa cambios, tampoco ante un evento sintetico.
                    if (!disabled) onSelect(item.epoch);
                  }}
                />
                <span className={styles.markerBox}>
                  <EpochMarker state={isCurrent ? "current" : item.status} />
                </span>
                <span className={styles.date} aria-hidden="true">
                  {item.dateLabel}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </fieldset>
  );
}

export interface EpochLegendProps {
  /**
   * Estados que se explican. Por defecto, los cuatro de DESIGN.md
   * (`EPOCH_LEGEND_STATES`); con una epoca sin datos conviene sumar `empty`.
   */
  readonly states?: readonly EpochMarkerState[];
  readonly className?: string | undefined;
}

/** Referencias de la linea de tiempo: cada marca con su nombre. */
export function EpochLegend({ states = EPOCH_LEGEND_STATES, className }: EpochLegendProps) {
  const { t } = useTranslation("components");
  return (
    <ul className={classNames(styles.legend, className)} aria-label={t("timeline.legend")}>
      {states.map((state) => (
        <li key={state} className={styles.legendItem}>
          <span className={styles.legendMarker}>
            <EpochMarker state={state} />
          </span>
          <span>{t(`timeline.state.${state}`)}</span>
        </li>
      ))}
    </ul>
  );
}
