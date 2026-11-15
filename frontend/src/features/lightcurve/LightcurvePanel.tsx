import { useEffect, useMemo, useState } from "react";
import {
  DataGroup,
  DataRow,
  GlassPanel,
  QualityNotice,
  SegmentedControl,
  Toggle,
} from "@/components";
import type { Language } from "@/i18n/languages";
import { useLanguage } from "@/i18n/useLanguage";
import {
  EN_DASH,
  formatArcseconds,
  formatBand,
  formatDec,
  formatDecimal,
  formatInteger,
  formatPercent,
  formatRa,
  formatWaveRange,
} from "@/lib/format";
import { LightcurveChart } from "./LightcurveChart";
import styles from "./LightcurvePanel.module.css";
import { type LightcurveT, useLightcurveTexts } from "./texts";
import {
  detectorsOf,
  type LightcurveDocument,
  type LightcurveMethod,
  type LightcurveSeries,
  type LightcurveWarning,
  seriesOf,
} from "./types";

export interface LightcurvePanelProps {
  /** Documento de GET /api/lightcurve, ya validado con `parseLightcurve`. */
  readonly lightcurve: LightcurveDocument;
  /** Nombre a mostrar. Por defecto, el del documento. */
  readonly name?: string | undefined;
  /** Banda (detector, 1 a 6) con la que abre el panel. Por defecto, la primera que tenga curva. */
  readonly initialBand?: number | undefined;
  readonly className?: string | undefined;
}

/** Lado de un pixel nativo de SPHEREx, en segundos de arco (SPEC.md, seccion 2). */
const NATIVE_PIXEL_ARCSEC = 6.15;

/** Ancho de celular de DESIGN.md ("Responsive Behavior"). */
const PHONE_QUERY = "(max-width: 599px)";

/** Si la ventana tiene ancho de celular. Ahi las seis bandas, con su rango, no entran en un renglon. */
function usePhoneWidth(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(PHONE_QUERY).matches === true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || window.matchMedia === undefined) return;
    const query = window.matchMedia(PHONE_QUERY);
    const update = (): void => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
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

function firstBandWithCurve(lightcurve: LightcurveDocument): number | null {
  const detectors = detectorsOf(lightcurve);
  const withCurve = detectors.find((detector) =>
    seriesOf(lightcurve, detector).some((series) => series.preferred && series.status === "ok"),
  );
  return withCurve ?? detectors[0] ?? null;
}

function noticeText(warning: LightcurveWarning, language: Language, t: LightcurveT): string | null {
  const bands = formatBandList(warning.detectors ?? []);
  switch (warning.code) {
    case "saturated_source":
      return t("notice.saturated", { bands });
    case "wings_unstable":
      return t("notice.unstable", {
        bands,
        scatter: formatPercent(warning.scatter ?? Number.NaN, language),
      });
    case "wings_unvalidated":
      return t("notice.unvalidated", { bands });
    case "offset_source":
      return t("notice.offset", {
        bands,
        offset: formatArcseconds(warning.offset_arcsec ?? Number.NaN, language),
      });
    default:
      return null;
  }
}

function summaryText(lightcurve: LightcurveDocument, t: LightcurveT): string {
  const { verdict, detectors, marginal_detectors: marginal } = lightcurve.variability;
  if (verdict === "variable") return t("summary.variable", { bands: formatBandList(detectors) });
  if (verdict === "marginal") return t("summary.marginal", { bands: formatBandList(marginal) });
  return t(`summary.${verdict}`);
}

function reasonText(series: LightcurveSeries, language: Language, t: LightcurveT): string {
  if (series.status === "unstable") {
    return t("reason.unstable", {
      scatter: formatPercent(series.scatter?.excess ?? Number.NaN, language),
    });
  }
  if (series.status === "blended") {
    return t("reason.blended", {
      offset: formatArcseconds(series.offset_arcsec ?? Number.NaN, language),
    });
  }
  return t("reason.insufficient", {
    n: formatInteger(series.n_measured),
    total: formatInteger(series.n_exposures),
  });
}

function verdictText(series: LightcurveSeries, language: Language, t: LightcurveT): string | null {
  const variability = series.variability;
  if (variability === null) return null;
  return t(`verdict.${variability.verdict}`, {
    amplitude: formatPercent(variability.amplitude, language),
    error: formatPercent(variability.amplitude_error, language),
    significance: formatDecimal(variability.significance, language, 1),
  });
}

/**
 * Panel de curva de luz: brillo relativo contra fecha por banda, con barras de
 * error, selector de banda y el rotulo "variacion relativa" cuando la medida
 * viene de las alas de una fuente saturada. Recibe el documento ya cargado;
 * pedirlo queda para quien lo integra (`fetchLightcurve`).
 *
 * Una banda sin curva no muestra grafico: muestra por que no la hay.
 */
export function LightcurvePanel({
  lightcurve,
  name,
  initialBand,
  className,
}: LightcurvePanelProps) {
  const t = useLightcurveTexts();
  const language = useLanguage();
  const detectors = useMemo(() => detectorsOf(lightcurve), [lightcurve]);
  const [band, setBand] = useState<number | null>(
    () => initialBand ?? firstBandWithCurve(lightcurve),
  );
  const [method, setMethod] = useState<LightcurveMethod | null>(null);
  const [showExposures, setShowExposures] = useState(true);
  const phone = usePhoneWidth();

  // Con otro documento (otro objeto) la banda elegida puede no existir o no tener curva.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se reinicia al cambiar de documento
  useEffect(() => {
    setBand(initialBand ?? firstBandWithCurve(lightcurve));
    setMethod(null);
  }, [lightcurve]);

  const title = name ?? lightcurve.target.name ?? t("panel.unnamed");
  const available = band === null ? [] : seriesOf(lightcurve, band);
  const series = available.find((item) => item.method === method) ?? available[0] ?? null;
  // El selector de medicion aparece solo si hay dos formas de medir esa banda y las dos dan curva.
  const alternatives = available.filter((item) => item.status === "ok");

  const notices = lightcurve.warnings
    .map((warning) => ({ code: warning.code, text: noticeText(warning, language, t) }))
    .filter((notice): notice is { code: string; text: string } => notice.text !== null);

  const relativeNote =
    series === null || series.status !== "ok"
      ? null
      : series.relative_only && series.annulus !== null
        ? t("relative.wings", {
            inner: formatArcseconds(series.annulus.inner_px * NATIVE_PIXEL_ARCSEC, language, 0),
            outer: formatArcseconds(series.annulus.outer_px * NATIVE_PIXEL_ARCSEC, language, 0),
          })
        : series.reference_mjy === null
          ? null
          : t("relative.aperture", {
              reference: formatDecimal(
                series.reference_mjy,
                language,
                series.reference_mjy < 10 ? 2 : 0,
              ),
            });

  return (
    <GlassPanel
      title={t("panel.title")}
      icon="blink"
      aside={summaryText(lightcurve, t)}
      padding="roomy"
      className={className}
    >
      <div className={styles.heading}>
        <p className={styles.name}>{title}</p>
        <p className={styles.position}>
          {`${formatRa(lightcurve.target.ra, { language })} ${formatDec(lightcurve.target.dec, { language })}`}
        </p>
      </div>

      {detectors.length === 0 ? null : (
        <SegmentedControl
          label={t("panel.band")}
          showLabel
          options={detectors.map((detector) => {
            const preferred = seriesOf(lightcurve, detector)[0];
            return {
              value: detector,
              label: formatBand(detector),
              detail:
                preferred === undefined
                  ? undefined
                  : formatWaveRange(preferred.wave_min_um, preferred.wave_max_um, language),
              noData: preferred === undefined || preferred.status !== "ok",
            };
          })}
          value={band}
          onChange={(next) => {
            setBand(next);
            setMethod(null);
          }}
          columns={Math.min(phone ? 3 : 6, detectors.length)}
          noDataLabel={t("panel.noCurve")}
        />
      )}

      {alternatives.length > 1 && series !== null ? (
        <SegmentedControl
          label={t("panel.method")}
          showLabel
          options={alternatives.map((item) => ({
            value: item.method,
            label: t(`panel.${item.method}`),
          }))}
          value={series.method}
          onChange={setMethod}
          columns={alternatives.length}
        />
      ) : null}

      {series === null ? null : series.status === "ok" ? (
        <>
          {series.relative_only ? (
            <p className={styles.relative}>
              <span className={styles.tag}>{t("relative.tag")}</span>
              <span>{relativeNote}</span>
            </p>
          ) : relativeNote === null ? null : (
            <p className={styles.note}>{relativeNote}</p>
          )}
          <LightcurveChart
            series={series}
            epochs={lightcurve.epochs}
            name={title}
            showExposures={showExposures}
          />
          <div className={styles.legend}>
            <span className={styles.legendItem}>
              <span className={styles.swatchBinned} aria-hidden="true" />
              {t("chart.legendBinned")}
            </span>
            <span className={styles.legendItem}>
              <span className={styles.swatchLevel} aria-hidden="true" />
              {t("chart.legendEpoch")}
            </span>
            <span className={styles.legendItem}>
              <span className={styles.swatchExposure} aria-hidden="true" />
              {t("chart.legendExposure")}
            </span>
          </div>
          <Toggle
            label={t("chart.showExposures")}
            checked={showExposures}
            onChange={setShowExposures}
          />
          <p className={styles.verdict}>{verdictText(series, language, t)}</p>
          <section className={styles.epochs}>
            <h3 className={styles.subtitle}>{t("epochs.title")}</h3>
            <DataGroup>
              {series.epochs.map((epoch) => (
                <DataRow
                  key={epoch.epoch}
                  label={t("epochs.row", {
                    epoch: formatInteger(epoch.epoch),
                    date: epoch.date,
                    n: formatInteger(epoch.n),
                  })}
                  value={t("epochs.value", {
                    value: formatDecimal(epoch.value, language, 2),
                    error: formatDecimal(epoch.error, language, 2),
                  })}
                />
              ))}
            </DataGroup>
          </section>
        </>
      ) : (
        <QualityNotice as="div">{reasonText(series, language, t)}</QualityNotice>
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

      <p className={styles.footnote}>
        {t("panel.footnote", {
          channels: formatInteger(lightcurve.provenance.channels_per_detector ?? 17),
        })}
        {series?.control == null
          ? null
          : ` ${t("panel.controlNote", {
              control: series.control.name,
              floor: formatPercent(series.control.epoch_floor, language, 1),
            })}`}
      </p>
    </GlassPanel>
  );
}
