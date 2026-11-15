import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Language } from "@/i18n/languages";
import { useLanguage } from "@/i18n/useLanguage";
import { formatBand, formatDecimal, formatInteger, formatWavelength, MICRO } from "@/lib/format";
import {
  fluxDomain,
  linearScale,
  nearestBin,
  niceTicks,
  tickDecimals,
  valueDecimals,
  WAVE_MAX_UM,
  WAVE_MIN_UM,
  WAVE_TICKS,
} from "./chartScale";
import { bandCenter, MOLECULE_BANDS, MOLECULE_FORMULA } from "./molecules";
import styles from "./SpectrumChart.module.css";
import { type SpectrumT, useSpectrumTexts } from "./texts";
import type { SpectrumBin, SpectrumDocument } from "./types";

export interface SpectrumChartProps {
  readonly spectrum: SpectrumDocument;
  /** Nombre del objeto, para el nombre accesible del grafico. */
  readonly name: string;
  /** Dibuja tambien cada exposicion, ademas de los promedios por canal. */
  readonly showExposures?: boolean;
  /** Longitud de onda por la que va el recorrido sonoro, um; mueve el cursor. */
  readonly playhead?: number | null;
}

const MARGIN = { top: 40, right: 12, bottom: 34, left: 52 } as const;
const DEFAULT_WIDTH = 640;
const WIDE_HEIGHT = 320;
const NARROW_HEIGHT = 260;
const NARROW_WIDTH = 520;
/** Separacion minima entre dos formulas en el mismo renglon, px. */
const LABEL_GAP_PX = 36;

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
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

function readoutText(bin: SpectrumBin, language: Language, t: SpectrumT): string {
  const decimals = valueDecimals(bin.error_mjy);
  const value = t("chart.readout", {
    wavelength: formatWavelength(bin.wavelength_um, language),
    flux: formatDecimal(bin.flux_mjy, language, decimals),
    error: formatDecimal(bin.error_mjy, language, decimals),
  });
  const origin = t("chart.readoutBand", {
    band: formatBand(bin.detector),
    n: formatInteger(bin.n),
  });
  return `${value} · ${origin}`;
}

/**
 * Grafico del espectro (DESIGN.md, "Espectro"): puntos blancos con barras de
 * error, grilla fina, bandas moleculares como franjas con su formula encima y
 * un cursor de lectura en ambar con el valor en monoespaciada.
 */
export function SpectrumChart({
  spectrum,
  name,
  showExposures = true,
  playhead = null,
}: SpectrumChartProps) {
  const t = useSpectrumTexts();
  const language = useLanguage();
  const [wrapperRef, width] = useWidth();
  const clipId = `spectrum-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [active, setActive] = useState<number | null>(null);

  const bins = spectrum.binned;
  const height = width < NARROW_WIDTH ? NARROW_HEIGHT : WIDE_HEIGHT;
  const plot = {
    left: MARGIN.left,
    right: width - MARGIN.right,
    top: MARGIN.top,
    bottom: height - MARGIN.bottom,
  };

  const x = useMemo(
    () => linearScale([WAVE_MIN_UM, WAVE_MAX_UM], [plot.left, plot.right]),
    [plot.left, plot.right],
  );
  const yDomain = useMemo(() => fluxDomain(bins), [bins]);
  const y = useMemo(
    () => linearScale(yDomain, [plot.bottom, plot.top]),
    [yDomain, plot.bottom, plot.top],
  );
  const yTicks = useMemo(() => niceTicks(yDomain, height < WIDE_HEIGHT ? 4 : 5), [yDomain, height]);
  const yDecimals = tickDecimals(yTicks);

  // Un cambio de espectro deja el cursor apuntando a un canal que ya no existe.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se reinicia al cambiar de espectro
  useEffect(() => {
    setActive(null);
  }, [spectrum]);

  // Formulas en dos renglones cuando dos bandas quedan pegadas.
  const bandLabels = useMemo(() => {
    const lastX: number[] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    return MOLECULE_BANDS.map((band) => {
      const centre = x(bandCenter(band));
      const row = centre - (lastX[0] ?? 0) >= LABEL_GAP_PX ? 0 : 1;
      lastX[row] = centre;
      return { band, centre, row };
    });
  }, [x]);

  const layers = useMemo(() => {
    const exposures = showExposures
      ? spectrum.points.map((point) => (
          <circle
            key={`${point.exposure}-${point.detector}`}
            className={styles.exposure}
            cx={x(point.wavelength_um)}
            cy={y(point.flux_mjy)}
            r={1.6}
          />
        ))
      : null;
    const averages = bins.map((bin) => {
      const cx = x(bin.wavelength_um);
      return (
        <g key={`${bin.detector}-${bin.wavelength_um}`}>
          <line
            className={styles.errorBar}
            x1={cx}
            x2={cx}
            y1={y(bin.flux_mjy - bin.error_mjy)}
            y2={y(bin.flux_mjy + bin.error_mjy)}
          />
          <circle className={styles.point} cx={cx} cy={y(bin.flux_mjy)} r={2.6} />
        </g>
      );
    });
    return { exposures, averages };
  }, [bins, showExposures, spectrum.points, x, y]);

  // Detectores sin ningun punto: se rotulan en el lugar, para que el hueco no parezca flujo cero.
  const missing = spectrum.detectors
    .filter((detector) => detector.n_points === 0)
    .map((detector) => ({
      detector: detector.detector,
      centre: x((Math.max(detector.wave_min_um, WAVE_MIN_UM) + detector.wave_max_um) / 2),
      reason: detector.n_saturated > 0 ? t("chart.saturatedBand") : t("chart.noDataBand"),
    }));

  const playing = playhead !== null;
  const shownIndex = playing ? nearestBin(bins, playhead) : active;
  const shown = shownIndex === null || shownIndex < 0 ? null : (bins[shownIndex] ?? null);
  const cursorX = playing ? x(playhead) : shown === null ? null : x(shown.wavelength_um);

  const readout = shown === null ? t("chart.hint") : readoutText(shown, language, t);

  const onPointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    if (playing || bins.length === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const scale = bounds.width > 0 ? width / bounds.width : 1;
    const index = nearestBin(bins, x.invert((event.clientX - bounds.left) * scale));
    setActive(index < 0 ? null : index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (bins.length === 0) return;
    const last = bins.length - 1;
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
      {/* El cursor de lectura es un deslizador sobre la longitud de onda: las flechas lo mueven de
          canal en canal y el lector de pantalla anuncia el valor. Un <input type="range"> no sirve
          porque los canales no estan a pasos iguales. */}
      <div
        ref={wrapperRef}
        className={styles.plot}
        role="slider"
        tabIndex={0}
        aria-label={t("chart.label", { name, points: formatInteger(spectrum.points.length) })}
        aria-orientation="horizontal"
        aria-valuemin={WAVE_MIN_UM}
        aria-valuemax={WAVE_MAX_UM}
        aria-valuenow={shown === null ? WAVE_MIN_UM : shown.wavelength_um}
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

          {bandLabels.map(({ band, centre, row }) => (
            <g key={`${band.molecule}-${band.min}`}>
              <rect
                className={styles.band}
                x={x(band.min)}
                y={plot.top}
                width={Math.max(0, x(band.max) - x(band.min))}
                height={Math.max(0, plot.bottom - plot.top)}
              />
              <line
                className={styles.bandTop}
                x1={x(band.min)}
                x2={x(band.max)}
                y1={plot.top}
                y2={plot.top}
              />
              <text className={styles.bandLabel} x={centre} y={plot.top - 8 - row * 15}>
                {MOLECULE_FORMULA[band.molecule]}
              </text>
            </g>
          ))}

          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                className={tick === 0 ? styles.zero : styles.grid}
                x1={plot.left}
                x2={plot.right}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text className={styles.tickY} x={plot.left - 8} y={y(tick)}>
                {formatDecimal(tick, language, yDecimals)}
              </text>
            </g>
          ))}
          {WAVE_TICKS.map((tick) => (
            <g key={tick}>
              <line
                className={styles.grid}
                x1={x(tick)}
                x2={x(tick)}
                y1={plot.top}
                y2={plot.bottom}
              />
              <text className={styles.tickX} x={x(tick)} y={plot.bottom + 16}>
                {formatInteger(tick)}
              </text>
            </g>
          ))}
          <line
            className={styles.axis}
            x1={plot.left}
            x2={plot.right}
            y1={plot.bottom}
            y2={plot.bottom}
          />
          <text className={styles.axisTitleX} x={plot.right} y={height - 4}>
            {`${t("chart.axisX")} (${MICRO}m)`}
          </text>
          <text className={styles.axisTitleY} x={4} y={12}>
            {`${t("chart.axisY")} (mJy)`}
          </text>

          {missing.map((item) => (
            <text
              key={item.detector}
              className={styles.missing}
              x={item.centre}
              y={(plot.top + plot.bottom) / 2}
            >
              <tspan x={item.centre}>{formatBand(item.detector)}</tspan>
              <tspan x={item.centre} dy={14}>
                {item.reason}
              </tspan>
            </text>
          ))}

          <g clipPath={`url(#${clipId})`}>
            {layers.exposures}
            {layers.averages}
          </g>

          {cursorX === null ? null : (
            <line
              className={styles.cursor}
              x1={cursorX}
              x2={cursorX}
              y1={plot.top}
              y2={plot.bottom}
            />
          )}
          {shown === null ? null : (
            <circle
              className={styles.cursorPoint}
              cx={x(shown.wavelength_um)}
              cy={Math.min(plot.bottom, Math.max(plot.top, y(shown.flux_mjy)))}
              r={5}
            />
          )}
        </svg>
      </div>
    </div>
  );
}
