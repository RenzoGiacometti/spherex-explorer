import { useTranslation } from "react-i18next";
import { GlassPanel, SegmentedControl, type SegmentedOption } from "@/components";
import { findPlane } from "@/data/planeKey";
import { useLanguage } from "@/i18n/useLanguage";
import { formatBand, formatWavelength, formatWaveRange } from "@/lib/format";
import { useFieldStore } from "@/state/fieldStore";
import { BANDS, type Band, useUrlState } from "@/state/urlState";
import styles from "./panels.module.css";

export interface BandPanelProps {
  /** Epoca actual: una banda sin datos en esa epoca se muestra atenuada. */
  readonly currentEpoch: number | null;
  /**
   * `panel` (por defecto) es el panel de escritorio: dos filas de tres, con el
   * rango de cada banda. `compact` es la tira del celular: las seis en una
   * fila, con el nombre solo; el rango de la banda elegida se lee sobre la imagen.
   */
  readonly variant?: "panel" | "compact";
}

/**
 * Panel Banda: B1 a B6 con el rango real de cada detector, que sale de los
 * metadatos del campo y no de una lista fija (DESIGN.md, "Selector de banda").
 * Elegir una banda cambia la URL; el store del campo la sigue.
 */
export function BandPanel({ currentEpoch, variant = "panel" }: BandPanelProps) {
  const { t } = useTranslation("viewer");
  const language = useLanguage();
  const band = useUrlState((state) => state.band);
  const update = useUrlState((state) => state.update);
  const detectors = useFieldStore((state) => state.meta?.detectors);
  const planes = useFieldStore((state) => state.meta?.planes);
  const compact = variant === "compact";

  const options: SegmentedOption<Band>[] = BANDS.map((detector) => {
    const info = detectors?.find((item) => item.detector === detector);
    const name = formatBand(detector);
    return {
      value: detector,
      label: name,
      // Antes de `listed` todavia no se conocen los rangos: va el nombre solo.
      detail:
        info && !compact
          ? formatWaveRange(info.wave_min_um, info.wave_max_um, language)
          : undefined,
      ariaLabel: info
        ? t("band.option", {
            band: name,
            min: formatWavelength(info.wave_min_um, language),
            max: formatWavelength(info.wave_max_um, language),
          })
        : undefined,
      noData:
        currentEpoch !== null && findPlane(planes, currentEpoch, detector)?.status === "empty",
    };
  });

  const selector = (
    <SegmentedControl
      label={t("band.group")}
      options={options}
      value={band}
      onChange={(next) => update({ band: next })}
      columns={compact ? BANDS.length : 3}
    />
  );

  if (compact) {
    return (
      <GlassPanel label={t("panel.band")} className={styles.strip}>
        {selector}
      </GlassPanel>
    );
  }
  return (
    <GlassPanel title={t("panel.band")} icon="bands" aside={t("band.unit")}>
      {selector}
    </GlassPanel>
  );
}
