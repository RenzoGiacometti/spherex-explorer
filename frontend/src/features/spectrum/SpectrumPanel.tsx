import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, GlassPanel, QualityNotice, Toggle } from "@/components";
import type { Language } from "@/i18n/languages";
import { useLanguage } from "@/i18n/useLanguage";
import {
  EN_DASH,
  formatArcseconds,
  formatBand,
  formatDec,
  formatInteger,
  formatRa,
} from "@/lib/format";
import { ChemicalFingerprint } from "./ChemicalFingerprint";
import { WAVE_MAX_UM, WAVE_MIN_UM } from "./chartScale";
import { SpectrumChart } from "./SpectrumChart";
import styles from "./SpectrumPanel.module.css";
import {
  buildSoundPlan,
  canPlaySound,
  playSpectrum,
  SOUND_DURATION_S,
  type SoundPlayback,
} from "./sonify";
import { type SpectrumT, useSpectrumTexts } from "./texts";
import type { SpectrumDocument, SpectrumWarning } from "./types";

export interface SpectrumPanelProps {
  /** Documento de GET /api/spectrum, ya validado con `parseSpectrum`. */
  readonly spectrum: SpectrumDocument;
  /** Nombre a mostrar. Por defecto, el del documento. */
  readonly name?: string | undefined;
  readonly className?: string | undefined;
}

/** "B1" suelto, "B1, B3" salteado y "B1" raya "B4" si son seguidos. */
export function formatBandList(detectors: readonly number[]): string {
  const sorted = [...new Set(detectors)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = 0;
  while (start < sorted.length) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === (sorted[end] ?? 0) + 1) end += 1;
    const first = sorted[start] ?? 0;
    const last = sorted[end] ?? 0;
    if (end - start >= 2) parts.push(`${formatBand(first)}${EN_DASH}${formatBand(last)}`);
    else
      for (let index = start; index <= end; index += 1) parts.push(formatBand(sorted[index] ?? 0));
    start = end + 1;
  }
  return parts.join(", ");
}

function noticeText(warning: SpectrumWarning, language: Language, t: SpectrumT): string | null {
  const bands = formatBandList(warning.detectors ?? []);
  const counts = {
    n: formatInteger(warning.n_exposures ?? 0),
    total: formatInteger(warning.n_total ?? 0),
  };
  switch (warning.code) {
    case "saturated_source":
      return t("notice.saturated", { bands, ...counts });
    case "offset_source":
      return t("notice.offset", {
        bands,
        offset: formatArcseconds(warning.offset_arcsec ?? Number.NaN, language),
      });
    case "masked_exposures":
      return t("notice.masked", counts);
    case "wave_table_version":
      return t("notice.waveTable");
    default:
      return null;
  }
}

/**
 * Panel de espectro: grafico con barras de error y bandas moleculares, boton
 * para escucharlo, avisos de calidad y huella quimica. Recibe el documento ya
 * cargado; pedirlo queda para quien lo integra (`fetchSpectrum`).
 *
 * Una fuente saturada no muestra grafico: muestra el aviso.
 */
export function SpectrumPanel({ spectrum, name, className }: SpectrumPanelProps) {
  const t = useSpectrumTexts();
  const language = useLanguage();
  const [showExposures, setShowExposures] = useState(true);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const playback = useRef<SoundPlayback | null>(null);

  const title = name ?? spectrum.target.name ?? t("panel.unnamed");
  const hasPoints = spectrum.binned.length > 0;
  const plan = useMemo(
    () => buildSoundPlan(spectrum.binned, WAVE_MIN_UM, WAVE_MAX_UM),
    [spectrum.binned],
  );
  const soundAvailable = useMemo(() => canPlaySound(), []);
  const playing = playhead !== null;

  const stop = useCallback((): void => {
    playback.current?.stop();
    playback.current = null;
    setPlayhead(null);
  }, []);

  // Al cambiar de espectro o desmontar el panel, el sonido se corta.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se corta al cambiar de espectro
  useEffect(() => stop, [spectrum, stop]);

  const toggleSound = (): void => {
    if (playing) {
      stop();
      return;
    }
    if (plan === null) return;
    setPlayhead(plan.waveMin);
    playback.current = playSpectrum(plan, {
      onProgress: setPlayhead,
      onEnd: () => {
        playback.current = null;
        setPlayhead(null);
      },
    });
    if (playback.current === null) setPlayhead(null);
  };

  const notices = spectrum.warnings
    // Con la fuente saturada del todo, el aviso ya es el cuerpo del panel.
    .filter((warning) => !(spectrum.status === "saturated" && warning.code === "saturated_source"))
    .map((warning) => ({ code: warning.code, text: noticeText(warning, language, t) }))
    .filter((notice): notice is { code: string; text: string } => notice.text !== null);

  const saturated = spectrum.warnings.find((warning) => warning.code === "saturated_source");
  // Donde la luz es de otra fuente, la huella quimica no se evalua.
  const offsetDetectors = useMemo(
    () => spectrum.warnings.find((warning) => warning.code === "offset_source")?.detectors ?? [],
    [spectrum.warnings],
  );
  const summary = t("panel.summary", {
    points: formatInteger(spectrum.points.length),
    epochs: formatInteger(spectrum.epochs.length),
  });

  return (
    <GlassPanel
      title={t("panel.title")}
      icon="spectrum"
      aside={hasPoints ? summary : undefined}
      padding="roomy"
      className={className}
    >
      <div className={styles.heading}>
        <p className={styles.name}>{title}</p>
        <p className={styles.position}>
          {`${formatRa(spectrum.target.ra, { language })} ${formatDec(spectrum.target.dec, { language })}`}
        </p>
      </div>

      {hasPoints ? (
        <>
          <SpectrumChart
            spectrum={spectrum}
            name={title}
            showExposures={showExposures}
            playhead={playhead}
          />
          <div className={styles.legend}>
            <span className={styles.legendItem}>
              <span className={styles.swatchBinned} aria-hidden="true" />
              {t("chart.legendBinned")}
            </span>
            <span className={styles.legendItem}>
              <span className={styles.swatchExposure} aria-hidden="true" />
              {t("chart.legendExposure")}
            </span>
          </div>
          <div className={styles.controls}>
            <Button
              variant="ghost"
              icon="sound"
              aria-pressed={playing}
              disabled={!soundAvailable || plan === null}
              onClick={toggleSound}
            >
              {playing ? t("listen.stop") : t("listen.play")}
            </Button>
            <Toggle
              label={t("chart.showExposures")}
              checked={showExposures}
              onChange={setShowExposures}
            />
          </div>
          <p className={styles.note}>
            {soundAvailable
              ? t("listen.description", { seconds: formatInteger(SOUND_DURATION_S) })
              : t("listen.unsupported")}
          </p>
        </>
      ) : (
        <div className={styles.empty}>
          <QualityNotice as="div">
            {spectrum.status === "saturated" ? t("panel.saturatedTitle") : t("panel.emptyTitle")}
          </QualityNotice>
          <p className={styles.note}>
            {spectrum.status === "saturated"
              ? t("panel.saturatedBody", {
                  n: formatInteger(saturated?.n_exposures ?? 0),
                  total: formatInteger(saturated?.n_total ?? spectrum.provenance.n_exposures),
                })
              : t("panel.emptyBody", { n: formatInteger(spectrum.provenance.n_exposures) })}
          </p>
        </div>
      )}

      {notices.length === 0 ? null : (
        <ul className={styles.notices}>
          {notices.map((notice) => (
            <QualityNotice key={notice.code} as="li">
              {notice.text}
            </QualityNotice>
          ))}
        </ul>
      )}

      {hasPoints ? (
        <ChemicalFingerprint
          bins={spectrum.binned}
          excludedDetectors={offsetDetectors}
          excludedLabel={formatBandList(offsetDetectors)}
        />
      ) : null}

      <p className={styles.footnote}>
        {t("panel.footnote", {
          radius: formatArcseconds(spectrum.aperture.radius_arcsec, language),
        })}
      </p>
    </GlassPanel>
  );
}
