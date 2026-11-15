import { useTranslation } from "react-i18next";
import {
  EPOCH_LEGEND_STATES,
  EpochLegend,
  GlassPanel,
  IconButton,
  SegmentedControl,
  type SegmentedOption,
  type TimelineEpoch,
  TimelineTrack,
  Transport,
} from "@/components";
import { selectTimeline } from "@/data/selectors";
import type { Language } from "@/i18n/languages";
import { useLanguage } from "@/i18n/useLanguage";
import { formatDecimal, formatInteger } from "@/lib/format";
import { useFieldStore } from "@/state/fieldStore";
import { epochMonth } from "./epochText";
import { LoadStatus } from "./LoadStatus";
import styles from "./TimelineDock.module.css";
import { PLAYBACK_SPEEDS, type PlaybackSpeed, type ViewerController } from "./useViewerController";

// Signo de multiplicar (U+00D7): "0,5x" con el signo tipografico.
const TIMES = String.fromCodePoint(0x00d7);

/** Una velocidad como se lee en la interfaz: "0,5" o "2" seguido del signo de multiplicar. */
export function formatSpeed(speed: PlaybackSpeed, language: Language): string {
  return `${formatDecimal(speed, language, speed < 1 ? 1 : 0)}${TIMES}`;
}

/** La velocidad que sigue al tocar el boton del celular: 0,5, 1, 2 y de vuelta a 0,5. */
export function nextSpeed(speed: PlaybackSpeed): PlaybackSpeed {
  const index = PLAYBACK_SPEEDS.indexOf(speed);
  return PLAYBACK_SPEEDS[(index + 1) % PLAYBACK_SPEEDS.length] ?? speed;
}

/** Hay alguna epoca sin datos en la banda: las referencias la explican. */
export function useHasEmptyEpoch(): boolean {
  return useFieldStore((state) => selectTimeline(state).some((item) => item.state === "empty"));
}

export interface TimelineDockProps {
  readonly controller: ViewerController;
  /**
   * `dock` (por defecto) es el muelle de escritorio: transporte, epoca,
   * referencias, velocidad y la pista en una franja. `phone` es el del celular:
   * la pista arriba y, debajo, el transporte con el boton de reproducir de
   * 56 px entre el de herramientas y el de velocidad.
   */
  readonly variant?: "dock" | "phone";
  /** Celular: abre el cajon de herramientas. */
  readonly onOpenTools?: (() => void) | undefined;
  /** Celular: si el cajon esta abierto, para `aria-expanded`. */
  readonly toolsOpen?: boolean | undefined;
}

/**
 * Muelle inferior: transporte, velocidad, la linea de tiempo con las epocas
 * reales del campo (3 o 4) y, debajo, el estado de la carga.
 */
export function TimelineDock({
  controller,
  variant = "dock",
  onOpenTools,
  toolsOpen = false,
}: TimelineDockProps) {
  const { t } = useTranslation("viewer");
  const language = useLanguage();
  const timeline = useFieldStore(selectTimeline);
  const hasEmpty = useHasEmptyEpoch();
  const { view, playing, canPlay, speed } = controller;

  const epochs: TimelineEpoch[] = timeline.map((item) => ({
    epoch: item.epoch.epoch,
    time: item.epoch.mjd_start,
    dateLabel: epochMonth(item.epoch),
    status: item.state,
  }));
  const shown = timeline.find((item) => item.epoch.epoch === view.displayed)?.epoch;

  const position = (
    <p className={styles.position}>
      <span className={styles.positionLabel}>
        {shown
          ? t("timeline.position", {
              n: formatInteger(shown.epoch),
              total: formatInteger(epochs.length),
            })
          : t("timeline.none")}
      </span>
      {shown ? (
        <span className={styles.positionDate}>
          {t("timeline.dateRange", { start: shown.start, end: shown.end })}
        </span>
      ) : null}
    </p>
  );
  const transport = (
    <Transport
      playing={playing}
      onPlayingChange={controller.setPlaying}
      onPrevious={() => controller.step(-1)}
      onNext={() => controller.step(1)}
      disabled={epochs.length === 0}
      playDisabled={!canPlay}
    />
  );
  const track = (
    <TimelineTrack
      label={t("timeline.track")}
      epochs={epochs}
      current={view.displayed}
      onSelect={controller.selectEpoch}
    />
  );

  if (variant === "phone") {
    const speedText = formatSpeed(speed, language);
    return (
      <GlassPanel as="footer" label={t("panel.timeline")} className={styles.phone}>
        {position}
        {track}
        <div className={styles.phoneTransport}>
          <IconButton
            icon="contrast"
            shape="square"
            label={t("tools.open")}
            aria-expanded={toolsOpen}
            onClick={onOpenTools}
          />
          {transport}
          <button
            type="button"
            className={styles.speedButton}
            aria-label={t("timeline.speedCycle", { value: speedText })}
            onClick={() => controller.setSpeed(nextSpeed(speed))}
          >
            {speedText}
          </button>
        </div>
        <div className={styles.status}>
          <LoadStatus />
        </div>
      </GlassPanel>
    );
  }

  const speedOptions: SegmentedOption<PlaybackSpeed>[] = PLAYBACK_SPEEDS.map((value) => ({
    value,
    label: formatSpeed(value, language),
  }));

  return (
    <GlassPanel as="footer" label={t("panel.timeline")} className={styles.dock}>
      <div className={styles.controls}>
        {transport}
        <div className={styles.main}>
          <div className={styles.head}>
            {position}
            <EpochLegend
              className={styles.legend}
              states={hasEmpty ? [...EPOCH_LEGEND_STATES, "empty"] : EPOCH_LEGEND_STATES}
            />
            <div className={styles.speed}>
              <span className={styles.speedLabel} aria-hidden="true">
                {t("timeline.speed")}
              </span>
              <SegmentedControl
                label={t("timeline.speedGroup")}
                options={speedOptions}
                value={speed}
                onChange={controller.setSpeed}
                fit="content"
              />
            </div>
          </div>
          {track}
        </div>
      </div>
      <div className={styles.status}>
        <LoadStatus />
      </div>
    </GlassPanel>
  );
}
