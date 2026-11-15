import { useTranslation } from "react-i18next";
import { DataGroup, DataRow, GlassPanel } from "@/components";
import { findPlane } from "@/data/planeKey";
import { selectBandInfo } from "@/data/selectors";
import { useLanguage } from "@/i18n/useLanguage";
import {
  formatArcminutes,
  formatArcseconds,
  formatBand,
  formatDec,
  formatInteger,
  formatRa,
  formatWaveRange,
  MICRO,
  NO_VALUE,
} from "@/lib/format";
import { useFieldStore } from "@/state/fieldStore";
import { useUrlState } from "@/state/urlState";
import { findEpoch } from "./epochText";

// Punto medio (U+00B7): separa el nombre de la banda de su rango, como en DESIGN.md.
const SEPARATOR = String.fromCodePoint(0x00b7);

export interface MetadataPanelProps {
  /** Epoca actual (A): de ella son las fechas y las exposiciones del plano. */
  readonly currentEpoch: number | null;
}

/**
 * Panel Metadatos: centro del campo, epoca actual, banda con su rango, escala
 * de pixel, tamano del campo, epocas, exposiciones del plano y fuente. Lo que
 * todavia no se conoce (antes de `listed`) va con una raya.
 */
export function MetadataPanel({ currentEpoch }: MetadataPanelProps) {
  const { t } = useTranslation("viewer");
  const language = useLanguage();
  const ra = useUrlState((state) => state.ra);
  const dec = useUrlState((state) => state.dec);
  const band = useUrlState((state) => state.band);

  const phase = useFieldStore((state) => state.phase);
  const status = useFieldStore((state) => state.meta?.status);
  const grid = useFieldStore((state) => state.meta?.grid);
  const epochs = useFieldStore((state) => state.meta?.epochs);
  const planes = useFieldStore((state) => state.meta?.planes);
  const source = useFieldStore((state) => state.meta?.provenance?.source);
  const bandInfo = useFieldStore(selectBandInfo);

  const epoch = findEpoch(epochs, currentEpoch);
  const plane = currentEpoch === null ? undefined : findPlane(planes, currentEpoch, band);

  const bandText = bandInfo
    ? `${formatBand(band)} ${SEPARATOR} ${formatWaveRange(bandInfo.waveMinUm, bandInfo.waveMaxUm, language)} ${MICRO}m`
    : formatBand(band);
  const fieldSide = grid ? formatArcminutes(grid.fov, language) : null;
  // Mientras el POST esta en camino todavia no hay documento con su estado.
  const statusKey = phase === "requesting" ? "requesting" : status;

  return (
    <GlassPanel title={t("panel.metadata")} icon="info">
      <DataGroup>
        <DataRow
          label={t("metadata.ra")}
          value={ra === null ? NO_VALUE : formatRa(ra, { language })}
        />
        <DataRow
          label={t("metadata.dec")}
          value={dec === null ? NO_VALUE : formatDec(dec, { language })}
        />
        <DataRow
          label={t("metadata.epoch")}
          value={epoch ? t("timeline.dateRange", { start: epoch.start, end: epoch.end }) : NO_VALUE}
        />
        <DataRow label={t("metadata.band")} value={bandText} />
        <DataRow
          label={t("metadata.pixelScale")}
          value={grid ? formatArcseconds(grid.pixel_scale_arcsec, language, 3) : NO_VALUE}
        />
        <DataRow
          label={t("metadata.field")}
          value={fieldSide === null ? NO_VALUE : t("image.fovValue", { side: fieldSide })}
        />
        <DataRow
          label={t("metadata.epochs")}
          value={epochs ? formatInteger(epochs.length) : NO_VALUE}
        />
        <DataRow
          label={t("metadata.exposures")}
          value={
            plane
              ? t("metadata.exposuresValue", {
                  used: formatInteger(plane.n_used),
                  total: formatInteger(plane.n_exposures),
                })
              : NO_VALUE
          }
        />
        <DataRow label={t("metadata.source")} value={source ?? NO_VALUE} />
        <DataRow
          label={t("metadata.status")}
          value={statusKey ? t(`metadata.statusValue.${statusKey}`) : NO_VALUE}
        />
      </DataGroup>
    </GlassPanel>
  );
}
