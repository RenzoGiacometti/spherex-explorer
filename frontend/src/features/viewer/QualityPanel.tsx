import { useTranslation } from "react-i18next";
import { GlassPanel, type NoticeItem, QualityNoticeList } from "@/components";
import { formatInteger } from "@/lib/format";

export interface QualityPanelProps {
  /** Los avisos del campo, ya en frases (`useQualityNotices`). */
  readonly notices: readonly NoticeItem[];
}

/**
 * Panel Avisos de calidad (DESIGN.md, "Aviso de calidad"): la cantidad en el
 * encabezado, en mono, y una frase por aviso con el icono `alert`. No hay
 * colores de estado. El primero es el de la fuente saturada, cuando la hay.
 */
export function QualityPanel({ notices }: QualityPanelProps) {
  const { t } = useTranslation("viewer");
  return (
    <GlassPanel title={t("panel.quality")} icon="alert" aside={formatInteger(notices.length)}>
      <QualityNoticeList notices={notices} emptyText={t("quality.none")} />
    </GlassPanel>
  );
}
