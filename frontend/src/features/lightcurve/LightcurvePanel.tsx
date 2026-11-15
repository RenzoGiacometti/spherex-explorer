import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DataGroup,
  DataRow,
  GlassPanel,
  IconButton,
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
import type { LightcurveT } from "./texts";
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
  /** Con esto el panel lleva su boton de cerrar, junto al nombre. */
  readonly onClose?: (() => void) | undefined;
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

/** Dice si la serie que se muestra de esa banda tiene curva. */
export function bandHasCurve(lightcurve: LightcurveDocument, detector: number): boolean {
  return seriesOf(lightcurve, detector).some(
    (series) => series.preferred && series.status === "ok",
  );
}

function firstBandWithCurve(lightcurve: LightcurveDocument): number | null {
  const detectors = detectorsOf(lightcurve);
  const withCurve = detectors.find((detector) => bandHasCurve(lightcurve, detector));
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
 *
 * Arriba, en un recuadro como el de los avisos destacados del espectro, va lo
 * que cambia como se lee el panel: que la curva es variacion relativa medida en
 * las alas, o que no hay curva y por que.
 */
export function LightcurvePanel({
  lightcurve,
  name,
  initialBand,
  onClose,
  className,
}: LightcurvePanelProps) {
  const { t } = useTranslation("lightcurve");
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

  const curve = series !== null && series.status === "ok" ? series : null;
  // Medida en las alas de una fuente saturada: variacion relativa, no flujo absoluto.
  const wingsNote =
    curve === null || (curve.method !== "wings" && !curve.relative_only)
      ? null
      : curve.annulus === null
        ? t("relative.wingsNoRing")
        : t("relative.wings", {
            inner: formatArcseconds(curve.annulus.inner_px * NATIVE_PIXEL_ARCSEC, language, 0),
            outer: formatArcseconds(curve.annulus.outer_px * NATIVE_PIXEL_ARCSEC, language, 0),
          });
  const apertureNote =
    curve === null || wingsNote !== null || curve.reference_mjy === null
      ? null
      : t("relative.aperture", {
          reference: formatDecimal(curve.reference_mjy, language, curve.reference_mjy < 10 ? 2 : 0),
        });
  // Sin curva: en la banda elegida, o en ninguna (documento `empty` o sin series).
  const anyCurve =
    lightcurve.status !== "empty" &&
    detectors.some((detector) => bandHasCurve(lightcurve, detector));
  const noCurve =
    curve !== null
      ? null
      : {
          lead:
            anyCurve && band !== null
              ? t("noCurve.band", { band: formatBand(band) })
              : t("noCurve.all"),
          reason: series === null ? t("noCurve.empty") : reasonText(series, language, t),
        };

  return (
    <GlassPanel
      title={t("panel.title")}
      icon="blink"
      aside={summaryText(lightcurve, t)}
      padding="roomy"
      className={className}
    >
      <div className={styles.top}>
        <div className={styles.heading}>
          <p className={styles.name}>{title}</p>
          <p className={styles.position}>
            {`${formatRa(lightcurve.target.ra, { language })} ${formatDec(lightcurve.target.dec, { language })}`}
          </p>
        </div>
        {onClose === undefined ? null : (
          <IconButton icon="close" size="sm" label={t("panel.close")} onClick={onClose} />
        )}
      </div>

      {/* Variacion relativa y "sin curva": antes de todo lo demas, para que se lean primero. */}
      {wingsNote === null && noCurve === null ? null : (
        <ul
          className={styles.prominent}
          data-lightcurve-notices="prominent"
          data-lightcurve-curve={noCurve === null ? "wings" : "none"}
        >
          {wingsNote === null ? null : (
            <QualityNotice as="li">
              <span className={styles.tag}>{t("relative.tag")}</span> {wingsNote}
            </QualityNotice>
          )}
          {noCurve === null ? null : (
            <QualityNotice as="li">
              <span className={styles.tag}>{noCurve.lead}</span> {noCurve.reason}
            </QualityNotice>
          )}
        </ul>
      )}

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

      {curve === null ? null : (
        <>
          {apertureNote === null ? null : <p className={styles.note}>{apertureNote}</p>}
          <LightcurveChart
            series={curve}
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
          <p className={styles.verdict}>{verdictText(curve, language, t)}</p>
          <section className={styles.epochs}>
            <h3 className={styles.subtitle}>{t("epochs.title")}</h3>
            <DataGroup>
              {curve.epochs.map((epoch) => (
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
