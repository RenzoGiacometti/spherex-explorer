import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, GlassPanel, IconButton, QualityNotice, Toggle } from "@/components";
import type { Language } from "@/i18n/languages";
import { useLanguage } from "@/i18n/useLanguage";
import {
  EN_DASH,
  formatArcminutes,
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
import type { SpectrumT } from "./texts";
import type { SpectrumDocument, SpectrumWarning } from "./types";

export interface SpectrumPanelProps {
  /** Documento de GET /api/spectrum, ya validado con `parseSpectrum`. */
  readonly spectrum: SpectrumDocument;
  /** Nombre a mostrar. Por defecto, el del documento. */
  readonly name?: string | undefined;
  /** Con esto el panel lleva su boton de cerrar, junto al nombre. */
  readonly onClose?: (() => void) | undefined;
  /**
   * Pide el espectro de otra posicion del cielo (grados ICRS). Con esto, el
   * estado `no_source` ofrece ver la fuente guardada mas cercana.
   */
  readonly onRequestPosition?:
    | ((position: { readonly ra: number; readonly dec: number }) => void)
    | undefined;
  readonly className?: string | undefined;
}

/**
 * Avisos que cambian como se lee el espectro: van arriba, antes del grafico.
 * `saturated_source` tiene la forma del aviso del campo (contrato, seccion 5).
 * `snapped_source` va primero: dice de que fuente es el espectro.
 */
const PROMINENT_CODES: readonly string[] = ["snapped_source", "saturated_source", "offset_source"];

/**
 * Distancia desde la que se avisa que el espectro es de una fuente guardada y
 * no del punto elegido. A menos de un segundo de arco es el mismo punto: el
 * pixel de SPHEREx mide 6,15.
 */
export const SNAP_NOTICE_MIN_ARCSEC = 1;

/** Distancia entre dos puntos del campo: segundos de arco, o minutos desde 60. */
function formatOffset(arcsec: number, language: Language): string {
  return arcsec < 60
    ? formatArcseconds(arcsec, language)
    : formatArcminutes(arcsec / 3600, language, 1);
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
    case "snapped_source": {
      const offset = warning.offset_arcsec;
      if (offset === undefined || !(offset >= SNAP_NOTICE_MIN_ARCSEC)) return null;
      return t("notice.snapped", { offset: formatOffset(offset, language) });
    }
    case "saturated_source":
      // Las cantidades son un agregado del espectro: el aviso del contrato no las trae.
      return warning.n_exposures === undefined || warning.n_total === undefined
        ? t("notice.saturatedNoCount", { bands })
        : t("notice.saturated", { bands, ...counts });
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
 * Una fuente saturada no muestra grafico: muestra el aviso. Tampoco hay
 * grafico con `no_source`: el campo solo tiene espectros guardados de sus
 * fuentes mas brillantes y el punto elegido no esta cerca de ninguna. Ahi el
 * panel lo explica y ofrece ver la mas cercana.
 */
export function SpectrumPanel({
  spectrum,
  name,
  onClose,
  onRequestPosition,
  className,
}: SpectrumPanelProps) {
  const { t } = useTranslation("spectrum");
  const language = useLanguage();
  const [showExposures, setShowExposures] = useState(true);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const playback = useRef<SoundPlayback | null>(null);

  const noSource = spectrum.status === "no_source";
  const nearest = spectrum.nearest ?? null;
  const savedSources = spectrum.saved_sources ?? 0;
  const isSavedSource =
    !noSource &&
    (spectrum.source === "precomputed" ||
      spectrum.warnings.some((warning) => warning.code === "snapped_source"));
  const title =
    name ??
    spectrum.target.name ??
    // Una fuente guardada del campo no tiene nombre de catalogo.
    (isSavedSource ? t("panel.savedSource") : t("panel.unnamed"));
  const hasPoints = !noSource && spectrum.binned.length > 0;
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
  const prominent = notices
    .filter((notice) => PROMINENT_CODES.includes(notice.code))
    .sort((a, b) => PROMINENT_CODES.indexOf(a.code) - PROMINENT_CODES.indexOf(b.code));
  const minor = notices.filter((notice) => !PROMINENT_CODES.includes(notice.code));

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
      <div className={styles.top}>
        <div className={styles.heading}>
          <p className={styles.name}>{title}</p>
          <p className={styles.position}>
            {`${formatRa(spectrum.target.ra, { language })} ${formatDec(spectrum.target.dec, { language })}`}
          </p>
        </div>
        {onClose === undefined ? null : (
          <IconButton icon="close" size="sm" label={t("panel.close")} onClick={onClose} />
        )}
      </div>

      {/* Fuente guardada, fuente saturada y luz de otra fuente: antes del grafico, para que se lean primero. */}
      {prominent.length === 0 ? null : (
        <ul className={styles.prominent} data-spectrum-notices="prominent">
          {prominent.map((notice) => (
            <QualityNotice key={notice.code} as="li">
              {notice.text}
            </QualityNotice>
          ))}
        </ul>
      )}

      {noSource ? (
        <div className={styles.empty} data-spectrum-body="no-source">
          <p className={styles.lead}>{t("panel.noSourceTitle")}</p>
          <p className={styles.note}>
            {savedSources >= 2
              ? t("panel.noSourceBody", { n: formatInteger(savedSources) })
              : t("panel.noSourceBodyNoCount")}
            {nearest === null
              ? null
              : ` ${t("panel.noSourceNearest", { offset: formatOffset(nearest.offset_arcsec, language) })}`}
          </p>
          {nearest === null || onRequestPosition === undefined ? null : (
            <Button
              className={styles.action}
              onClick={() => onRequestPosition({ ra: nearest.ra, dec: nearest.dec })}
            >
              {t("panel.noSourceShow")}
            </Button>
          )}
        </div>
      ) : hasPoints ? (
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
            {spectrum.status !== "saturated"
              ? t("panel.emptyBody", { n: formatInteger(spectrum.provenance.n_exposures) })
              : saturated?.n_exposures === undefined
                ? t("panel.saturatedBodyNoCount")
                : t("panel.saturatedBody", {
                    n: formatInteger(saturated.n_exposures),
                    total: formatInteger(saturated.n_total ?? spectrum.provenance.n_exposures),
                  })}
          </p>
        </div>
      )}

      {minor.length === 0 ? null : (
        <ul className={styles.notices}>
          {minor.map((notice) => (
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

      {/* Sin fuente guardada no se midio nada: no hay apertura que contar. */}
      {noSource ? null : (
        <p className={styles.footnote}>
          {t("panel.footnote", {
            radius: formatArcseconds(spectrum.aperture.radius_arcsec, language),
          })}
        </p>
      )}
    </GlassPanel>
  );
}
