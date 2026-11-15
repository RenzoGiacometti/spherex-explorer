import { useTranslation } from "react-i18next";
import { GlassPanel, QualityNotice, SegmentedControl, type SegmentedOption } from "@/components";
import { formatInteger } from "@/lib/format";
import { VIEW_MODES, type ViewMode } from "@/state/urlState";
import { epochMonth } from "./epochText";
import { HoldButton } from "./HoldButton";
import styles from "./panels.module.css";
import type { ViewerController } from "./useViewerController";

export interface ModePanelProps {
  readonly controller: ViewerController;
  /**
   * `panel` (por defecto) es el panel de escritorio, con encabezado y un
   * renglon que explica el modo. `compact` es el del celular: va en la zona
   * del pulgar, sin encabezado, con los modos abajo de todo y lo que cada modo
   * suma (la epoca de referencia, el boton de mantener) encima.
   */
  readonly variant?: "panel" | "compact";
}

/** Modos que comparan la epoca actual (A) con una de referencia (B). */
const PAIR_MODES: readonly ViewMode[] = ["difference", "redcyan", "hold"];

/**
 * Panel Modo: los modos de la URL y, para los que comparan, la epoca de
 * referencia (B). La epoca actual (A) se elige en la linea de tiempo. El viaje
 * entre misiones queda deshabilitado en un campo sin contexto, y la cortina
 * visible/infrarrojo en uno sin placa optica: sin parrafos que lo expliquen.
 */
export function ModePanel({ controller, variant = "panel" }: ModePanelProps) {
  const { t } = useTranslation("viewer");
  const { mode, entries, view, journey, curtain } = controller;
  const usesPair = PAIR_MODES.includes(mode);
  const compact = variant === "compact";

  const modeOptions: SegmentedOption<ViewMode>[] = VIEW_MODES.map((item) => ({
    value: item,
    label: t(`mode.${item}`),
    // El viaje entre misiones necesita el contexto del campo, y la cortina, una placa optica.
    disabled:
      (item === "journey" && !journey.available) || (item === "curtain" && !curtain.available),
  }));

  const referenceOptions: SegmentedOption<number>[] = entries.map((entry) => {
    const number = formatInteger(entry.epoch.epoch);
    const month = epochMonth(entry.epoch);
    return {
      value: entry.epoch.epoch,
      label: number,
      // En el celular va el numero solo: la fecha de cada epoca esta en la linea de tiempo.
      detail: compact ? undefined : month,
      ariaLabel: t("comparison.referenceOption", { n: number, date: month }),
      // B no puede ser la misma epoca que A.
      disabled: entry.epoch.epoch === view.current,
      noData: entry.plane?.status === "empty",
    };
  });

  const monthOf = (epoch: number | null): string | null => {
    const entry = entries.find((item) => item.epoch.epoch === epoch);
    return entry ? epochMonth(entry.epoch) : null;
  };
  const monthA = monthOf(view.current);
  const monthB = monthOf(view.reference);

  // Que epoca es A y cual es B, a la derecha del encabezado, cuando el modo las compara.
  const pair =
    usesPair && monthA !== null && monthB !== null
      ? t("comparison.pair", { a: monthA, b: monthB })
      : undefined;

  const modes = (
    <SegmentedControl
      label={t("comparison.group")}
      options={modeOptions}
      value={mode}
      onChange={controller.setMode}
      columns={compact ? 3 : 2}
    />
  );
  const issue =
    usesPair && view.issue !== null ? (
      <QualityNotice className={compact ? styles.stripNotice : undefined}>
        {t(`comparison.issue.${view.issue}`)}
      </QualityNotice>
    ) : null;
  const hasReference = usesPair && referenceOptions.length > 0;

  if (compact) {
    return (
      <GlassPanel label={t("panel.mode")} className={styles.strip}>
        {issue}
        {/* En el celular el panel de avisos esta en el cajon: este se repite aca, donde se compara. */}
        {view.provisional ? (
          <QualityNotice className={styles.stripNotice}>
            {t("comparison.provisional")}
          </QualityNotice>
        ) : null}
        {hasReference ? (
          <div className={styles.inlineControl}>
            <span className={styles.inlineLabel} aria-hidden="true">
              {t("comparison.referenceShort")}
            </span>
            <SegmentedControl
              className={styles.inlineOptions}
              label={t("comparison.reference")}
              options={referenceOptions}
              value={view.reference}
              onChange={controller.setReference}
            />
          </div>
        ) : null}
        {/* Lo que mas se usa va mas abajo, cerca del pulgar: el boton de mantener y los modos. */}
        {mode === "hold" ? <HoldButton controller={controller} /> : null}
        {modes}
      </GlassPanel>
    );
  }

  return (
    <GlassPanel title={t("panel.mode")} icon="blink" aside={pair}>
      {modes}
      {/* El parpadeo no necesita explicacion: el renglon queda para los modos que combinan epocas. */}
      {mode === "blink" ? null : (
        <p className={styles.hint}>
          {t(`comparison.hint.${mode}`, { n: formatInteger(view.imageEpochs.length) })}
        </p>
      )}

      {hasReference ? (
        <SegmentedControl
          label={t("comparison.reference")}
          options={referenceOptions}
          value={view.reference}
          onChange={controller.setReference}
          showLabel
        />
      ) : null}

      {mode === "hold" ? <HoldButton controller={controller} /> : null}

      {issue}
    </GlassPanel>
  );
}
