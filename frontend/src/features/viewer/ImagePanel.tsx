import { useTranslation } from "react-i18next";
import { GlassPanel, SegmentedControl, type SegmentedOption, Slider } from "@/components";
import { useLanguage } from "@/i18n/useLanguage";
import { WIDE_FIELD_ENABLED } from "@/lib/deploy";
import { formatArcminutes, formatInteger, formatPercent } from "@/lib/format";
import { DEFAULT_VIEW_FOV, fieldFovForView, VIEW_FOVS, type ViewFov } from "@/lib/fov";
import { useUrlState } from "@/state/urlState";
import { MAX_CONTRAST, MIN_CONTRAST, STRETCH_KINDS, type StretchKind } from "@/viewer/stretch";
import { FlagsControl } from "./FlagsControl";
import { GaiaControl } from "./GaiaControl";
import type { ViewerController } from "./useViewerController";

export interface ImagePanelProps {
  readonly controller: ViewerController;
}

/** Pasos del deslizador de contraste: de a 1 %. */
const CONTRAST_STEPS = 100;

/**
 * Panel Imagen: contraste, estirado, campo de vision, capa de flags y capa de
 * Gaia (deshabilitada, con su explicacion, en los campos sin contexto). El
 * contraste mueve el corte alto entre los dos extremos de la escala del
 * detector (`contrastCuts`). Las vistas de 5 y 10 minutos comparten cubo (5 es
 * un acercamiento al doble); la de 30 abre el escalon amplio, que es otro campo.
 */
export function ImagePanel({ controller }: ImagePanelProps) {
  const { t } = useTranslation("viewer");
  const language = useLanguage();
  const fov = useUrlState((state) => state.fov);
  const update = useUrlState((state) => state.update);
  const { contrast, stretch } = controller;

  const span = MAX_CONTRAST - MIN_CONTRAST;
  const position = Math.round(((contrast - MIN_CONTRAST) / span) * CONTRAST_STEPS);

  const stretchOptions: SegmentedOption<StretchKind>[] = STRETCH_KINDS.map((kind) => ({
    value: kind,
    label: t(`image.stretchOption.${kind}`),
    ariaLabel: t(`image.stretchName.${kind}`),
  }));

  // Sin el campo amplio quedan las vistas del escalon base: 5' y 10'.
  const sides = WIDE_FIELD_ENABLED
    ? VIEW_FOVS
    : VIEW_FOVS.filter((side) => fieldFovForView(side) === fieldFovForView(DEFAULT_VIEW_FOV));
  const fovOptions: SegmentedOption<ViewFov>[] = sides.map((side) => ({
    value: side,
    label: formatArcminutes(side, language),
    ariaLabel: t("image.fovOption", { n: formatInteger(side * 60) }),
  }));
  const side = formatArcminutes(fov, language);

  function changeFov(next: ViewFov): void {
    // Otro escalon es otro campo, con sus propias epocas: la elegida ya no vale.
    const sameField = fieldFovForView(next) === fieldFovForView(fov);
    update(sameField ? { fov: next } : { fov: next, epoch: null, ref: null });
  }

  return (
    <GlassPanel title={t("panel.image")} icon="contrast">
      <Slider
        label={t("image.contrast")}
        value={position}
        onChange={(next) => controller.setContrast(MIN_CONTRAST + (next / CONTRAST_STEPS) * span)}
        min={0}
        max={CONTRAST_STEPS}
        step={1}
        valueText={formatPercent(position / CONTRAST_STEPS, language)}
      />
      {/*
       * La capa de flags va segunda y no al final: en una ventana de 900 px de
       * alto el final del panel queda debajo de la linea de tiempo, y el
       * conmutador tiene que verse sin desplazar la columna.
       */}
      <FlagsControl layer={controller.flags} />
      <GaiaControl gaia={controller.gaia} />
      <SegmentedControl
        label={t("image.stretch")}
        options={stretchOptions}
        value={stretch}
        onChange={controller.setStretch}
        showLabel
      />
      <SegmentedControl
        label={t("image.fov")}
        options={fovOptions}
        value={fov}
        onChange={changeFov}
        showLabel
        valueText={t("image.fovValue", { side })}
      />
    </GlassPanel>
  );
}
