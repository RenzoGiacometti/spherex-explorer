import { type KeyboardEvent, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  EPOCH_LEGEND_STATES,
  EpochLegend,
  GlassPanel,
  IconButton,
  LanguageSelector,
  type NoticeItem,
} from "@/components";
import type { Language } from "@/i18n/languages";
import { useLanguage } from "@/i18n/useLanguage";
import { useUrlState } from "@/state/urlState";
import { ImagePanel } from "./ImagePanel";
import { MetadataPanel } from "./MetadataPanel";
import { QualityPanel } from "./QualityPanel";
import { useHasEmptyEpoch } from "./TimelineDock";
import styles from "./ToolsDrawer.module.css";
import type { ViewerController } from "./useViewerController";

/** Con que se abrio el cajon: decide que queda arriba. */
export type ToolsSection = "tools" | "notices";

export interface ToolsDrawerProps {
  readonly controller: ViewerController;
  readonly notices: readonly NoticeItem[];
  /** `notices` deja los avisos de calidad arriba de todo. */
  readonly section: ToolsSection;
  readonly onClose: () => void;
}

/**
 * Cajon de herramientas del celular (DESIGN.md, "Responsive Behavior"): lo que
 * no es de uso frecuente. Contraste, estirado, campo de vision y capa de flags;
 * avisos de calidad; metadatos; referencias de la linea de tiempo e idioma.
 *
 * Ocupa el lugar de los controles de abajo, sin tapar la imagen: el contraste
 * se ajusta mirandola. Se cierra con su boton o con Escape, y el foco vuelve a
 * donde estaba.
 */
export function ToolsDrawer({ controller, notices, section, onClose }: ToolsDrawerProps) {
  const { t } = useTranslation("viewer");
  const language = useLanguage();
  const update = useUrlState((state) => state.update);
  const hasEmpty = useHasEmptyEpoch();
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Al abrir, el foco pasa al cajon: lo que sigue con Tab son sus controles.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onClose();
  }

  const image = <ImagePanel key="image" controller={controller} />;
  const quality = <QualityPanel key="quality" notices={notices} />;

  return (
    // No es modal: la imagen y la barra de arriba siguen en uso mientras esta abierto.
    <section
      role="dialog"
      aria-label={t("panel.tools")}
      className={styles.drawer}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.header}>
        <h2 ref={headingRef} tabIndex={-1} className={styles.title}>
          {t("panel.tools")}
        </h2>
        <IconButton icon="close" label={t("tools.close")} onClick={onClose} />
      </div>
      <div className={styles.body}>
        {section === "notices" ? [quality, image] : [image, quality]}
        <MetadataPanel currentEpoch={controller.view.current} />
        <GlassPanel title={t("panel.legend")} icon="info">
          <EpochLegend
            states={hasEmpty ? [...EPOCH_LEGEND_STATES, "empty"] : EPOCH_LEGEND_STATES}
          />
        </GlassPanel>
        <GlassPanel title={t("panel.language")} icon="globe">
          <LanguageSelector
            value={language}
            onChange={(next: Language) => update({ lang: next })}
          />
        </GlassPanel>
      </div>
    </section>
  );
}
