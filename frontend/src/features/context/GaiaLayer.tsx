import { useMemo } from "react";
import { classNames, GlassPanel, Slider, Toggle } from "@/components";
import { useLanguage } from "@/i18n/useLanguage";
import { formatDecimal, formatInteger } from "@/lib/format";
import type { GridWcs } from "@/lib/wcs";
import type { FrameLayout } from "./FrameCanvas";
import styles from "./GaiaLayer.module.css";
import {
  ARROW_YEAR_STEPS,
  arrowPath,
  arrowYearsForStep,
  type GaiaMarker,
  gaiaMarkers,
} from "./gaia";
import type { GaiaCatalog } from "./schema";
import { useContextTexts } from "./texts";

/** Fuentes que se dibujan como mucho: las mas brillantes. Mas que esto tapa la imagen. */
export const DEFAULT_GAIA_LIMIT = 400;

/** Radio de la marca de una fuente, en pixeles de pantalla. */
const RING_RADIUS = 3.5;

export interface GaiaLayerProps {
  readonly catalog: GaiaCatalog;
  /** Grilla del campo: WCS y forma `[ny, nx]`. */
  readonly grid: GridWcs & { readonly shape: readonly [number, number] };
  /** Tamano de la imagen en pantalla, como lo entrega `FrameCanvas`. */
  readonly layout: FrameLayout;
  /** Fecha del cuadro que se esta mirando (anio juliano): las fuentes se dibujan donde estaban. */
  readonly year: number;
  /** Largo de las flechas, en anios de movimiento propio. */
  readonly arrowYears: number;
  /** Magnitud G mas debil que se dibuja; sin limite si es null. */
  readonly maxGMag?: number | null;
  /** Cantidad maxima de fuentes. */
  readonly limit?: number;
  /** Indice, en el catalogo, de la fuente destacada: va en ambar. */
  readonly highlightIndex?: number | null;
  readonly className?: string | undefined;
}

interface DrawnMarker {
  readonly marker: GaiaMarker;
  readonly x: number;
  readonly y: number;
  readonly arrow: string | null;
}

/**
 * Capa de Gaia: un anillo por fuente, en la posicion que tenia en la fecha del
 * cuadro, y una flecha que marca hacia donde va y cuanto se mueve en
 * `arrowYears` anios. Va sobre la imagen, como anotacion directa (nivel 1 de
 * DESIGN.md): sin fondo y sin recibir el puntero.
 *
 * Cada trazo blanco va montado sobre uno negro mas ancho, igual que el contorno
 * de una fuente saturada, para que se lea tambien sobre una estrella brillante.
 * La fuente destacada (el objeto del campo) va en ambar: es un marcador, el
 * uso 1 del acento.
 */
export function GaiaLayer({
  catalog,
  grid,
  layout,
  year,
  arrowYears,
  maxGMag = null,
  limit = DEFAULT_GAIA_LIMIT,
  highlightIndex = null,
  className,
}: GaiaLayerProps) {
  const t = useContextTexts();
  const markers = useMemo(
    () => gaiaMarkers(catalog, grid, { year, arrowYears, maxGMag, limit }),
    [catalog, grid, year, arrowYears, maxGMag, limit],
  );
  const drawn = useMemo<DrawnMarker[]>(
    () =>
      markers.map((marker) => {
        const center = layout.toScreen(marker.x, marker.y);
        const tip = marker.tip === null ? null : layout.toScreen(marker.tip.x, marker.tip.y);
        return {
          marker,
          x: center.x,
          y: center.y,
          arrow: tip === null ? null : arrowPath(center, tip),
        };
      }),
    [markers, layout],
  );

  const shapes = (kind: "under" | "over") =>
    drawn.map(({ marker, x, y, arrow }) => (
      <g
        key={marker.sourceId}
        className={classNames(
          kind === "under" ? styles.under : styles.over,
          kind === "over" && marker.index === highlightIndex && styles.highlight,
        )}
      >
        <circle cx={x.toFixed(1)} cy={y.toFixed(1)} r={RING_RADIUS} />
        {arrow === null ? null : <path d={arrow} />}
      </g>
    ));

  return (
    <svg
      className={classNames(styles.layer, className)}
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={t("gaia.layer", { count: formatInteger(drawn.length) })}
      data-gaia-sources={drawn.length}
    >
      {shapes("under")}
      {shapes("over")}
    </svg>
  );
}

export interface GaiaControlsProps {
  readonly visible: boolean;
  readonly onVisibleChange: (visible: boolean) => void;
  /** Paso del largo de las flechas: indice en `ARROW_YEAR_STEPS`. */
  readonly arrowStep: number;
  readonly onArrowStepChange: (step: number) => void;
  /** Magnitud G limite y el recorrido que ofrece el catalogo del campo. */
  readonly maxGMag: number;
  readonly onMaxGMagChange: (magnitude: number) => void;
  readonly magRange: readonly [number, number];
  /** Fuentes dibujadas y fuentes del catalogo. */
  readonly shown: number;
  readonly total: number;
  /** Anio al que estan llevadas las posiciones. */
  readonly year: number;
  readonly className?: string | undefined;
}

/**
 * Controles de la capa de Gaia: prenderla, elegir el largo de las flechas (en
 * anios de movimiento) y hasta que magnitud se dibuja.
 */
export function GaiaControls({
  visible,
  onVisibleChange,
  arrowStep,
  onArrowStepChange,
  maxGMag,
  onMaxGMagChange,
  magRange,
  shown,
  total,
  year,
  className,
}: GaiaControlsProps) {
  const t = useContextTexts();
  const language = useLanguage();
  const [magMin, magMax] = magRange;
  const arrowYears = arrowYearsForStep(arrowStep);
  return (
    <GlassPanel
      title={t("gaia.title")}
      icon="target"
      aside={t("gaia.count", { shown: formatInteger(shown), total: formatInteger(total) })}
      className={className}
    >
      <Toggle label={t("gaia.show")} checked={visible} onChange={onVisibleChange} />
      <Slider
        label={t("gaia.arrowScale")}
        min={0}
        max={ARROW_YEAR_STEPS.length - 1}
        step={1}
        value={arrowStep}
        valueText={
          arrowYears === 1
            ? t("gaia.arrowYear")
            : t("gaia.arrowYears", { years: formatInteger(arrowYears) })
        }
        disabled={!visible}
        onChange={onArrowStepChange}
      />
      <Slider
        label={t("gaia.magnitude")}
        min={Math.ceil(magMin)}
        max={Math.ceil(magMax)}
        step={0.5}
        value={maxGMag}
        valueText={formatDecimal(maxGMag, language, 1)}
        disabled={!visible}
        onChange={onMaxGMagChange}
      />
      <p className={styles.note}>
        {t("gaia.epochNote", { year: formatDecimal(year, language, 1) })}
      </p>
    </GlassPanel>
  );
}
