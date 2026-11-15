import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  classNames,
  DataGroup,
  DataRow,
  EPOCH_STOP_WIDTH_PX,
  EpochMarker,
  GlassPanel,
  layoutEpochs,
  minEpochGap,
  Transport,
} from "@/components";
import { useLanguage } from "@/i18n/useLanguage";
import {
  EN_DASH,
  formatInteger,
  formatWavelength,
  formatWaveRange,
  MICRO,
  NO_VALUE,
} from "@/lib/format";
import {
  type JourneyFrame,
  journeySpanYears,
  missionGroups,
  orderFrames,
  stepFrame,
  stopLabels,
} from "./journey";
import styles from "./MissionJourney.module.css";

// Punto medio (U+00B7): separa la banda de su longitud de onda, como en el rotulo de imagen.
const SEPARATOR = String.fromCodePoint(0x00b7);

/** Milisegundos que se muestra cada cuadro al reproducir: da tiempo a leer el anio. */
export const DEFAULT_JOURNEY_INTERVAL_MS = 1200;

export interface MissionJourneyProps {
  /** Los cuadros del viaje, en cualquier orden: el control los ordena por fecha. */
  readonly frames: readonly JourneyFrame[];
  /** Identificador del cuadro que se esta mirando, o null si no hay ninguno. */
  readonly currentId: string | null;
  readonly onSelect: (id: string) => void;
  readonly playing: boolean;
  readonly onPlayingChange: (playing: boolean) => void;
  /** Milisegundos por cuadro al reproducir. */
  readonly intervalMs?: number;
  readonly className?: string | undefined;
}

/** Banda y longitud de onda de un cuadro: "Ks, 2,16 um" o "B3, 1,63 a 2,43 um", con sus signos. */
export function frameBandText(frame: JourneyFrame, language: "es" | "en"): string {
  const wave =
    frame.waveUm.length === 2
      ? `${formatWaveRange(frame.waveUm[0], frame.waveUm[1], language)} ${MICRO}m`
      : formatWavelength(frame.waveUm[0], language);
  return `${frame.band} ${SEPARATOR} ${wave}`;
}

/** Fecha de un cuadro: un dia, o el intervalo si la imagen suma varias pasadas. */
export function frameDateText(frame: JourneyFrame): string {
  return frame.dateStart === frame.dateEnd
    ? frame.date
    : `${frame.dateStart} ${EN_DASH} ${frame.dateEnd}`;
}

function useElementWidth(): [RefObject<HTMLDivElement | null>, number | null] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = (): void => setWidth(element.clientWidth > 0 ? element.clientWidth : null);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

const TRACK_STYLE = { "--journey-stop-width": `${EPOCH_STOP_WIDTH_PX}px` } as CSSProperties;

/**
 * Viaje entre misiones: recorre, en orden de fecha, la imagen de 2MASS, la de
 * WISE y las epocas de SPHEREx del mismo campo. Es el control; la imagen la
 * dibuja quien lo usa con el cuadro actual (`FrameCanvas`).
 *
 * - El anio del cuadro actual se lee siempre, en grande.
 * - La pista es la linea de tiempo de DESIGN.md: una marca por cuadro, ubicada
 *   segun su fecha, con el nombre de la mision arriba y el anio abajo. La marca
 *   actual va en ambar (uso 2 del acento). Dos marcas nunca quedan mas cerca
 *   que el ancho de una parada, asi que las tres epocas de SPHEREx, que estan a
 *   meses una de otra, se pueden elegir aunque el viaje abarque 27 anios.
 * - Cada marca es un boton de radio nativo: Tab entra a la pista y las flechas
 *   pasan al cuadro anterior o al siguiente.
 * - El transporte recorre los cuadros y vuelve a empezar.
 */
export function MissionJourney({
  frames,
  currentId,
  onSelect,
  playing,
  onPlayingChange,
  intervalMs = DEFAULT_JOURNEY_INTERVAL_MS,
  className,
}: MissionJourneyProps) {
  const { t } = useTranslation("context");
  const language = useLanguage();
  const groupName = useId();
  const [stopsRef, trackWidth] = useElementWidth();

  const ordered = useMemo(() => orderFrames(frames), [frames]);
  const labels = useMemo(() => stopLabels(ordered), [ordered]);
  const groups = useMemo(() => missionGroups(ordered), [ordered]);
  const positions = layoutEpochs(
    ordered.map((frame) => frame.mjd),
    minEpochGap(trackWidth),
  );
  const current = ordered.find((frame) => frame.id === currentId) ?? null;
  const span = Math.round(journeySpanYears(ordered));

  // Reproduccion: cada cuadro arma el paso al siguiente, asi el intervalo cuenta desde que se lo ve.
  useEffect(() => {
    if (!playing || ordered.length < 2) return;
    const timer = window.setTimeout(() => {
      const next = stepFrame(ordered, currentId, 1);
      if (next !== null) onSelect(next);
    }, intervalMs);
    return () => window.clearTimeout(timer);
  }, [playing, ordered, currentId, intervalMs, onSelect]);

  const step = (delta: number): void => {
    const next = stepFrame(ordered, currentId, delta);
    if (next !== null) onSelect(next);
  };

  if (ordered.length === 0) {
    return (
      <GlassPanel title={t("journey.title")} icon="layers" className={className}>
        <p className={styles.empty}>{t("journey.empty")}</p>
      </GlassPanel>
    );
  }

  const left = (position: number | undefined): string => `${((position ?? 0.5) * 100).toFixed(3)}%`;

  return (
    <GlassPanel
      title={t("journey.title")}
      icon="layers"
      aside={
        span < 1
          ? undefined
          : span === 1
            ? t("journey.spanOne")
            : t("journey.span", { years: formatInteger(span) })
      }
      className={className}
    >
      <div className={styles.readout}>
        <p className={styles.yearBlock}>
          <span className={classNames(styles.yearLabel, "type-label-cap")}>
            {t("journey.year")}
          </span>
          <output className={classNames(styles.year, "type-data-lg")} aria-live="polite">
            {current === null ? NO_VALUE : current.date.slice(0, 4)}
          </output>
        </p>
        <DataGroup className={styles.facts}>
          <DataRow
            label={t("journey.mission")}
            value={current === null ? NO_VALUE : current.mission}
          />
          <DataRow
            label={t("journey.band")}
            value={current === null ? NO_VALUE : frameBandText(current, language)}
          />
          <DataRow
            label={t("journey.observed")}
            value={current === null ? NO_VALUE : frameDateText(current)}
          />
        </DataGroup>
      </div>

      <fieldset className={styles.track} style={TRACK_STYLE}>
        <legend className={styles.visuallyHidden}>{t("journey.track")}</legend>
        <div className={styles.missions} aria-hidden="true">
          <div className={styles.inner}>
            {groups.map((group) => {
              const start = positions[group.first] ?? 0.5;
              const end = positions[group.last] ?? start;
              return (
                <span
                  key={`${group.mission}-${group.first}`}
                  className={classNames(
                    styles.mission,
                    "type-label-cap",
                    current?.mission === group.mission && styles.currentMission,
                  )}
                  style={{ left: left((start + end) / 2) }}
                >
                  {group.mission}
                </span>
              );
            })}
            {groups
              .filter((group) => group.last > group.first)
              .map((group) => (
                <span
                  key={`bracket-${group.mission}-${group.first}`}
                  className={styles.bracket}
                  style={{
                    left: left(positions[group.first]),
                    right: `${((1 - (positions[group.last] ?? 1)) * 100).toFixed(3)}%`,
                  }}
                />
              ))}
          </div>
        </div>
        <div className={styles.rail}>
          <span className={styles.baseline} aria-hidden="true" />
          <div ref={stopsRef} className={styles.stops}>
            {ordered.map((frame, index) => {
              const isCurrent = frame.id === currentId;
              return (
                <label
                  key={frame.id}
                  className={classNames(styles.stop, isCurrent && styles.currentStop)}
                  style={{ left: left(positions[index]) }}
                >
                  <input
                    type="radio"
                    className={styles.input}
                    name={groupName}
                    value={frame.id}
                    checked={isCurrent}
                    aria-label={t("journey.stop", {
                      mission: frame.mission,
                      band: frame.band,
                      date: frameDateText(frame),
                      state: t(
                        frame.image === null ? "journey.state.unloaded" : "journey.state.loaded",
                      ),
                    })}
                    onChange={() => onSelect(frame.id)}
                  />
                  <span className={styles.markerBox}>
                    <EpochMarker
                      state={isCurrent ? "current" : frame.image === null ? "unloaded" : "loaded"}
                    />
                  </span>
                  <span className={styles.date} aria-hidden="true">
                    {labels[index]}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      </fieldset>

      <Transport
        className={styles.transport}
        label={t("journey.transport")}
        playing={playing}
        onPlayingChange={onPlayingChange}
        onPrevious={() => step(-1)}
        onNext={() => step(1)}
        disabled={ordered.length < 2}
        disabledReason={t("journey.transportDisabled")}
      />
    </GlassPanel>
  );
}
