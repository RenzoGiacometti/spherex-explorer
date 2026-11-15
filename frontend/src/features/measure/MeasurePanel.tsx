import { useTranslation } from "react-i18next";
import { Button, DataGroup, DataRow, GlassPanel, QualityNotice, Toggle } from "@/components";
import { useLanguage } from "@/i18n/useLanguage";
import {
  formatArcseconds,
  formatBand,
  formatDec,
  formatDecimal,
  formatDegrees,
  formatInteger,
  formatMjdDate,
  formatRa,
  NO_VALUE,
} from "@/lib/format";
import styles from "./MeasurePanel.module.css";
import type { Mark } from "./marks";
import type { Measure } from "./useMeasure";

/** Hasta cuantos errores de diferencia se dice que la medicion coincide con el catalogo. */
export const AGREEMENT_SIGMAS = 2.5;

export interface MeasurePanelProps {
  readonly measure: Measure;
  readonly className?: string | undefined;
  /**
   * En el visor el panel es la herramienta "Medir": apagada (`measure.active`
   * en false) queda solo el conmutador con un renglon que dice para que sirve.
   * Sin esto (la pagina de desarrollo) se ve siempre entero.
   */
  readonly collapsible?: boolean;
  /**
   * `compact` es el del celular: apagada, la herramienta es una tira con el
   * conmutador solo, sin encabezado, como las demas de la zona del pulgar.
   */
  readonly variant?: "panel" | "compact";
}

/** Numero con signo explicito, para las componentes este y norte. */
function signed(value: number, text: string): string {
  return value > 0 && !text.startsWith("+") ? `+${text}` : text;
}

function markDetailKey(mark: Mark): "marks.centroid" | "marks.wingsPending" | "marks.wings" {
  if (mark.method === "centroid") return "marks.centroid";
  return mark.needsCoverage ? "marks.wingsPending" : "marks.wings";
}

/**
 * Panel del medidor de movimiento propio: el conmutador que activa la marca
 * con clic, las marcas hechas y, con dos o mas, el desplazamiento, el
 * movimiento propio con su error, la posicion predicha a cinco anios y la
 * comparacion con el catalogo. Todo valor va en mono, con su unidad.
 *
 * Los avisos que cambian como se lee el resultado van arriba, en un recuadro
 * como el de los avisos destacados del espectro: que con dos marcas de
 * estaciones opuestas no se separa la paralaje, y que una marca tiene otra
 * fuente a menos de 12 segundos de arco (neighbor.ts).
 */
export function MeasurePanel({
  measure,
  className,
  collapsible = false,
  variant = "panel",
}: MeasurePanelProps) {
  const { t } = useTranslation("measure");
  const language = useLanguage();
  const { marks, fit, comparison, catalogName, failure } = measure;

  const currentMarked = marks.some((mark) => mark.epoch === measure.epoch);
  const currentText =
    measure.epochDate === null || !measure.canMark
      ? t("panel.currentNone")
      : t(currentMarked ? "panel.currentMarked" : "panel.currentUnmarked", {
          date: measure.epochDate,
        });

  const saturated = marks.some((mark) => mark.method === "wings");
  const pendingCoverage = marks.some((mark) => mark.needsCoverage);
  const arcsec = (value: number, decimals = 2): string =>
    formatArcseconds(value, language, decimals);

  const collapsed = collapsible && !measure.active;
  const seasonNotice = fit?.seasonUnresolved === true;
  /** Marcas con otra fuente cerca, de la mas cercana a la mas lejana. */
  const crowded = marks
    .filter((mark) => mark.neighborArcsec !== null)
    .sort((a, b) => (a.neighborArcsec ?? 0) - (b.neighborArcsec ?? 0));
  const closest = crowded[0];
  const toggle = (
    <Toggle label={t("panel.toggle")} checked={measure.active} onChange={measure.setActive} />
  );
  const aside =
    measure.epochCount === 0
      ? undefined
      : t("panel.count", {
          marked: formatInteger(marks.length),
          total: formatInteger(measure.epochCount),
        });

  if (collapsed && variant === "compact") {
    return (
      <GlassPanel label={t("panel.title")} className={className}>
        <div data-measure-tool="off">{toggle}</div>
      </GlassPanel>
    );
  }
  if (collapsed) {
    return (
      <GlassPanel
        title={t("panel.title")}
        icon="target"
        aside={marks.length === 0 ? undefined : aside}
        className={className}
      >
        <div data-measure-tool="off">{toggle}</div>
        <p className={styles.hint}>{t("panel.off")}</p>
      </GlassPanel>
    );
  }

  return (
    <GlassPanel title={t("panel.title")} icon="target" aside={aside} className={className}>
      <div data-measure-tool={measure.active ? "on" : "off"}>{toggle}</div>
      <p className={styles.hint}>{t("panel.hint")}</p>

      {/* Lo que cambia como se lee el resultado va arriba, en un recuadro: no al pie del panel. */}
      {seasonNotice || closest !== undefined ? (
        <ul
          className={styles.prominent}
          aria-label={t("notice.title")}
          data-measure-notices="prominent"
        >
          {seasonNotice ? (
            <QualityNotice as="li">
              <span data-measure-notice="season">
                {t(saturated ? "notice.seasonWings" : "notice.season")}
              </span>
            </QualityNotice>
          ) : null}
          {closest === undefined ? null : (
            <QualityNotice as="li">
              <span
                data-measure-notice="neighbor"
                data-neighbor-arcsec={(closest.neighborArcsec ?? 0).toFixed(1)}
              >
                {crowded.length === 1
                  ? t("notice.neighbor", {
                      distance: arcsec(closest.neighborArcsec ?? 0, 0),
                      date: formatMjdDate(closest.mjd),
                    })
                  : t("notice.neighborMany", {
                      n: formatInteger(crowded.length),
                      distance: arcsec(closest.neighborArcsec ?? 0, 0),
                    })}
              </span>
            </QualityNotice>
          )}
        </ul>
      ) : null}

      <DataGroup>
        <DataRow label={t("panel.current")} value={currentText} />
      </DataGroup>

      {/* Sin puntero tambien se puede marcar: se centra el objeto con las flechas y se marca ahi. */}
      <div className={styles.actions}>
        <Button
          icon="target"
          className={styles.action}
          disabled={!measure.canMark}
          disabledReason={t("panel.markCenterDisabled")}
          onClick={measure.pickAtViewCenter}
        >
          {t("panel.markCenter")}
        </Button>
        {marks.length === 0 ? null : (
          <Button icon="close" className={styles.action} onClick={measure.clear}>
            {t("panel.clear")}
          </Button>
        )}
      </div>

      {/* El resultado del ultimo clic se anuncia: quien no ve la imagen se entera de si dejo marca. */}
      <div
        aria-live="polite"
        data-measure-failure={failure ?? undefined}
        data-measure-pending={measure.measuring ? "true" : undefined}
      >
        {failure === null ? null : <QualityNotice>{t(`failure.${failure}`)}</QualityNotice>}
        {measure.measuring ? <p className={styles.hint}>{t("panel.measuring")}</p> : null}
      </div>

      {marks.length === 0 ? null : (
        <section className={styles.block} aria-label={t("marks.title")} data-measure-marks>
          <h3 className={styles.heading}>{t("marks.title")}</h3>
          <DataGroup>
            {marks.map((mark) => (
              <DataRow
                key={mark.epoch}
                label={t("marks.label", {
                  date: formatMjdDate(mark.mjd),
                  band: formatBand(mark.detector),
                })}
                value={t(markDetailKey(mark), { sigma: arcsec(mark.sigmaArcsec) })}
              />
            ))}
          </DataGroup>
        </section>
      )}

      {marks.length === 1 ? <p className={styles.hint}>{t("panel.needTwo")}</p> : null}
      {marks.length >= 2 && fit === null ? (
        <p className={styles.hint}>{t("panel.sameDate")}</p>
      ) : null}

      {fit === null ? null : (
        <section
          className={styles.block}
          aria-label={t("result.title")}
          data-measure-result
          data-model={fit.model}
          data-displacement={fit.displacement.total.toFixed(3)}
          data-motion={fit.motion.total.toFixed(3)}
          data-motion-east={fit.motion.east.toFixed(3)}
          data-motion-north={fit.motion.north.toFixed(3)}
          data-motion-sigma={fit.motionSigma.toFixed(3)}
        >
          <h3 className={styles.heading}>{t("result.title")}</h3>
          <DataGroup>
            <DataRow
              label={t("result.displacement")}
              value={t("result.withError", {
                value: arcsec(fit.displacement.total),
                sigma: arcsec(fit.displacementSigma),
              })}
            />
            <DataRow
              label={t("result.interval")}
              value={t("result.years", { value: formatDecimal(fit.baselineYears, language, 2) })}
            />
            <DataRow
              label={t("result.motion")}
              value={
                <strong className={styles.strong}>
                  {t("result.perYear", {
                    value: formatDecimal(fit.motion.total, language, 2),
                    sigma: formatDecimal(fit.motionSigma, language, 2),
                  })}
                </strong>
              }
            />
            <DataRow
              label={t("result.components")}
              value={t("result.componentsValue", {
                east: signed(fit.motion.east, formatDecimal(fit.motion.east, language, 2)),
                north: signed(fit.motion.north, formatDecimal(fit.motion.north, language, 2)),
              })}
            />
            <DataRow
              label={t("result.angle")}
              value={formatDegrees(fit.motion.positionAngle, language, 0)}
            />
            <DataRow
              label={t("result.predictionPosition", { date: formatMjdDate(fit.prediction.mjd) })}
              value={
                <span className={styles.position}>
                  <span>{formatRa(fit.prediction.ra, { language })}</span>
                  <span>{formatDec(fit.prediction.dec, { language })}</span>
                </span>
              }
            />
            <DataRow
              label={t("result.predictionError")}
              value={arcsec(fit.prediction.sigmaArcsec, 1)}
            />
          </DataGroup>
        </section>
      )}

      {fit === null || comparison === null || catalogName === null ? null : (
        <section
          className={styles.block}
          aria-label={t("catalog.title")}
          data-measure-catalog={comparison.status}
          data-catalog-motion={
            comparison.status === "compared" ? comparison.motion.total.toFixed(3) : undefined
          }
          data-catalog-sigmas={
            comparison.status === "compared" ? comparison.differenceSigmas.toFixed(2) : undefined
          }
        >
          <h3 className={styles.heading}>{t("catalog.title")}</h3>
          {comparison.status === "mismatch" ? (
            <QualityNotice>
              {t("catalog.mismatch", {
                offset: arcsec(comparison.maxOffsetArcsec, 0),
                name: catalogName,
              })}
            </QualityNotice>
          ) : (
            <>
              <DataGroup>
                <DataRow
                  label={t("catalog.motion", { name: catalogName })}
                  value={t("catalog.motionValue", {
                    value: formatDecimal(comparison.motion.total, language, 2),
                  })}
                />
                <DataRow
                  label={t("catalog.difference")}
                  value={t("catalog.differenceValue", {
                    value: formatDecimal(comparison.difference, language, 2),
                    sigmas: Number.isFinite(comparison.differenceSigmas)
                      ? formatDecimal(comparison.differenceSigmas, language, 1)
                      : NO_VALUE,
                  })}
                />
              </DataGroup>
              <p className={styles.verdict}>
                {t(
                  comparison.differenceSigmas <= AGREEMENT_SIGMAS
                    ? "catalog.agrees"
                    : "catalog.differs",
                )}
              </p>
              <p className={styles.hint}>{t("catalog.note")}</p>
            </>
          )}
        </section>
      )}

      {/* Los de estaciones opuestas y de fuente vecina van arriba, en el recuadro. */}
      {(fit === null || fit.scatterFactor <= 1.05) &&
      !saturated &&
      fit?.model !== "seasonal" ? null : (
        <div className={styles.notices}>
          {fit !== null && fit.scatterFactor > 1.05 ? (
            <QualityNotice>
              {t("notice.scatter", { factor: formatDecimal(fit.scatterFactor, language, 1) })}
            </QualityNotice>
          ) : null}
          {saturated ? <QualityNotice>{t("notice.wings")}</QualityNotice> : null}
          {pendingCoverage ? <QualityNotice>{t("notice.coverage")}</QualityNotice> : null}
          {fit?.model === "seasonal" ? <p className={styles.hint}>{t("notice.seasonal")}</p> : null}
        </div>
      )}
    </GlassPanel>
  );
}
