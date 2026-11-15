import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Language } from "@/i18n/languages";
import { useLanguage } from "@/i18n/useLanguage";
import { formatBand, formatDecimal, formatInteger } from "@/lib/format";
import {
  layoutSegments,
  linearScale,
  nearestMark,
  niceTicks,
  readableMarks,
  tickDecimals,
  timeToX,
  valueDomain,
} from "./chartLayout";
import styles from "./LightcurveChart.module.css";
import { type LightcurveT, useLightcurveTexts } from "./texts";
import type { LightcurveBin, LightcurveEpoch, LightcurveSeries } from "./types";

export interface LightcurveChartProps {
  /** Serie a dibujar; tiene que tener curva (`status: "ok"`). */
  readonly series: LightcurveSeries;
  /** Pasadas del relevamiento del documento: definen los tramos del eje del tiempo. */
  readonly epochs: readonly LightcurveEpoch[];
  /** Nombre del objeto, para el nombre accesible del grafico. */
  readonly name: string;
  /** Dibuja tambien cada exposicion. */
  readonly showExposures?: boolean;
}

const MARGIN = { top: 14, right: 12, bottom: 44, left: 52 } as const;
const DEFAULT_WIDTH = 640;
const WIDE_HEIGHT = 300;
const NARROW_HEIGHT = 250;
const NARROW_WIDTH = 520;
/** Un tramo necesita este ancho para llevar tambien la fecha de fin. */
const TWO_LABELS_PX = 190;

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = (): void => {
      const next = Math.round(element.clientWidth);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function readoutText(mark: LightcurveBin, language: Language, t: LightcurveT): string {
  return t("chart.readout", {
    date: mark.date,
    value: formatDecimal(mark.value, language, 2),
    error: formatDecimal(mark.error, language, 2),
    n: formatInteger(mark.n),
  });
}

/**
 * Grafico de la curva de luz, con el mismo lenguaje que el del espectro
 * (DESIGN.md): puntos blancos con barras de error en blanco al 45 %, grilla
 * fina, ejes en monoespaciada y cursor de lectura en ambar. El eje del tiempo
 * va cortado en un tramo por pasada del relevamiento.
 */
export function LightcurveChart({
  series,
  epochs,
  name,
  showExposures = true,
}: LightcurveChartProps) {
  const t = useLightcurveTexts();
  const language = useLanguage();
  const [wrapperRef, width] = useWidth();
  const clipId = `lightcurve-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [active, setActive] = useState<number | null>(null);

  const height = width < NARROW_WIDTH ? NARROW_HEIGHT : WIDE_HEIGHT;
  const plot = {
    left: MARGIN.left,
    right: width - MARGIN.right,
    top: MARGIN.top,
    bottom: height - MARGIN.bottom,
  };

  // Solo las pasadas en las que esta serie tiene medidas.
  const shownEpochs = useMemo(() => {
    const present = new Set(series.points.map((point) => point.epoch));
    return epochs.filter((epoch) => present.has(epoch.epoch));
  }, [epochs, series.points]);
  const segments = useMemo(
    () => layoutSegments(shownEpochs, plot.left, plot.right),
    [shownEpochs, plot.left, plot.right],
  );

  const marks = readableMarks(series.bins, series.epochs);
  const yDomain = useMemo(
    () => valueDomain([...series.bins, ...series.epochs]),
    [series.bins, series.epochs],
  );
  const y = useMemo(
    () => linearScale(yDomain, [plot.bottom, plot.top]),
    [yDomain, plot.bottom, plot.top],
  );
  const yTicks = useMemo(() => niceTicks(yDomain, height < WIDE_HEIGHT ? 4 : 5), [yDomain, height]);
  const yDecimals = tickDecimals(yTicks);
  const markX = useMemo(
    () => marks.map((mark) => timeToX(segments, mark.epoch, mark.mjd)),
    [marks, segments],
  );

  // Un cambio de serie deja el cursor apuntando a una marca que ya no existe.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se reinicia al cambiar de serie
  useEffect(() => {
    setActive(null);
  }, [series]);

  const layers = useMemo(() => {
    const exposures = showExposures
      ? series.points.map((point) => {
          const cx = timeToX(segments, point.epoch, point.mjd);
          return cx === null ? null : (
            <circle
              key={`${point.mjd}-${point.channel}`}
              className={styles.exposure}
              cx={cx}
              cy={y(point.value)}
              r={1.6}
            />
          );
        })
      : null;
    const levels = series.epochs.map((epoch) => {
      const segment = segments.find((item) => item.epoch === epoch.epoch);
      return segment === undefined ? null : (
        <line
          key={epoch.epoch}
          className={styles.level}
          x1={segment.left}
          x2={segment.right}
          y1={y(epoch.value)}
          y2={y(epoch.value)}
        />
      );
    });
    const medians = marks.map((mark, index) => {
      const cx = markX[index];
      return cx === null || cx === undefined ? null : (
        <g key={`${mark.epoch}-${mark.mjd}`}>
          <line
            className={styles.errorBar}
            x1={cx}
            x2={cx}
            y1={y(mark.value - mark.error)}
            y2={y(mark.value + mark.error)}
          />
          <circle className={styles.point} cx={cx} cy={y(mark.value)} r={3} />
        </g>
      );
    });
    return { exposures, levels, medians };
  }, [marks, markX, segments, series.epochs, series.points, showExposures, y]);

  const shown = active === null ? null : (marks[active] ?? null);
  const cursorX = active === null ? null : (markX[active] ?? null);
  const readout = shown === null ? t("chart.hint") : readoutText(shown, language, t);

  const onPointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    if (marks.length === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const scale = bounds.width > 0 ? width / bounds.width : 1;
    const index = nearestMark(markX, (event.clientX - bounds.left) * scale);
    setActive(index < 0 ? null : index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (marks.length === 0) return;
    const last = marks.length - 1;
    let next: number | null | undefined;
    if (event.key === "ArrowRight") next = active === null ? 0 : Math.min(last, active + 1);
    else if (event.key === "ArrowLeft") next = active === null ? last : Math.max(0, active - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape") next = null;
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
  };

  return (
    <div className={styles.chart}>
      <p className={shown === null ? styles.hint : styles.readout}>{readout}</p>
      {/* El cursor de lectura es un deslizador sobre las tandas: las flechas lo mueven de una a
          otra y el lector de pantalla anuncia el valor. */}
      <div
        ref={wrapperRef}
        className={styles.plot}
        role="slider"
        tabIndex={0}
        aria-label={t("chart.label", {
          name,
          band: formatBand(series.detector),
          epochs: formatInteger(shownEpochs.length),
          points: formatInteger(series.points.length),
        })}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, marks.length - 1)}
        aria-valuenow={active ?? 0}
        aria-valuetext={readout}
        onKeyDown={onKeyDown}
      >
        <svg
          className={styles.svg}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden="true"
          onPointerMove={onPointerMove}
          onPointerDown={onPointerMove}
          onPointerLeave={() => setActive(null)}
        >
          <defs>
            <clipPath id={clipId}>
              <rect
                x={plot.left}
                y={plot.top}
                width={Math.max(0, plot.right - plot.left)}
                height={Math.max(0, plot.bottom - plot.top)}
              />
            </clipPath>
          </defs>

          {segments.map((segment) => (
            <g key={segment.epoch}>
              <rect
                className={styles.segment}
                x={segment.left}
                y={plot.top}
                width={Math.max(0, segment.right - segment.left)}
                height={Math.max(0, plot.bottom - plot.top)}
              />
              <line
                className={styles.axis}
                x1={segment.left}
                x2={segment.right}
                y1={plot.bottom}
                y2={plot.bottom}
              />
              <text className={styles.tickStart} x={segment.left} y={plot.bottom + 16}>
                {segment.start}
              </text>
              {segment.right - segment.left >= TWO_LABELS_PX && segment.end !== segment.start ? (
                <text className={styles.tickEnd} x={segment.right} y={plot.bottom + 16}>
                  {segment.end}
                </text>
              ) : null}
              <text
                className={styles.segmentLabel}
                x={(segment.left + segment.right) / 2}
                y={plot.bottom + 34}
              >
                {t("chart.pass", { epoch: formatInteger(segment.epoch) })}
              </text>
            </g>
          ))}

          {yTicks.map((tick) => (
            <g key={tick}>
              {segments.map((segment) => (
                <line
                  key={segment.epoch}
                  className={Math.abs(tick - 1) < 1e-9 ? styles.unity : styles.grid}
                  x1={segment.left}
                  x2={segment.right}
                  y1={y(tick)}
                  y2={y(tick)}
                />
              ))}
              <text className={styles.tickY} x={plot.left - 8} y={y(tick)}>
                {formatDecimal(tick, language, yDecimals)}
              </text>
            </g>
          ))}
          <text className={styles.axisTitleY} x={4} y={10}>
            {t("chart.axisY")}
          </text>

          <g clipPath={`url(#${clipId})`}>
            {layers.exposures}
            {layers.levels}
            {layers.medians}
          </g>

          {cursorX === null || shown === null ? null : (
            <>
              <line
                className={styles.cursor}
                x1={cursorX}
                x2={cursorX}
                y1={plot.top}
                y2={plot.bottom}
              />
              <circle
                className={styles.cursorPoint}
                cx={cursorX}
                cy={Math.min(plot.bottom, Math.max(plot.top, y(shown.value)))}
                r={5.5}
              />
            </>
          )}
        </svg>
      </div>
    </div>
  );
}
