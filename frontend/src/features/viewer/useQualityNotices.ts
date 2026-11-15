import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { PlaneRef, WarningOf } from "@/api/types";
import type { NoticeItem } from "@/components";
import { selectWarningGroups, type WarningGroup } from "@/data/selectors";
import { useLanguage } from "@/i18n/useLanguage";
import { formatDec, formatInteger, formatIsoDateTime, formatPercent, formatRa } from "@/lib/format";
import { useFieldStore } from "@/state/fieldStore";
import {
  FEW_EXPOSURES_LIMIT,
  formatBandList,
  groupPlanes,
  LOW_COVERAGE_LIMIT,
} from "./qualityNotices";

/** Clave del aviso de una comparacion con una epoca provisoria: no es un aviso del contrato. */
export const PROVISIONAL_NOTICE = "comparison_provisional";

/** Separa los grupos de epocas dentro de una frase: "epocas 1, 2 (B1, B4); epoca 3 (B2)". */
const GROUP_SEPARATOR = "; ";

function warningsOf<Code extends WarningGroup["code"]>(
  group: WarningGroup,
): readonly WarningOf<Code>[] {
  return group.warnings as readonly WarningOf<Code>[];
}

/**
 * Los avisos de calidad del campo, una frase por aviso y en el idioma activo
 * (contrato, seccion 5): los del backend juntos por codigo, en el orden de
 * `WARNING_ORDER` (la fuente saturada va primero), y adelante de todos el de
 * una comparacion en la que alguna de las epocas es provisoria (seccion 8).
 *
 * `comparesProvisional` es `ViewModel.provisional`.
 */
export function useQualityNotices(comparesProvisional: boolean): readonly NoticeItem[] {
  const { t } = useTranslation("viewer");
  const language = useLanguage();
  const groups = useFieldStore(selectWarningGroups);

  return useMemo(() => {
    /** "epocas 1, 2, 3 (B1 a B6); epoca 4 (B2, B3)". */
    const describePlanes = (planes: readonly PlaneRef[]): string =>
      groupPlanes(planes)
        .map((group) =>
          t(group.epochs.length === 1 ? "quality.planes.one" : "quality.planes.other", {
            epochs: group.epochs.map(formatInteger).join(", "),
            bands: formatBandList(group.detectors),
          }),
        )
        .join(GROUP_SEPARATOR);

    const sentence = (group: WarningGroup): string => {
      switch (group.code) {
        case "saturated_source": {
          const sources = warningsOf<"saturated_source">(group);
          const only = sources[0];
          if (sources.length === 1 && only) {
            return t("quality.saturated_source.one", {
              ra: formatRa(only.ra, { language }),
              dec: formatDec(only.dec, { language }),
            });
          }
          return t("quality.saturated_source.other", { n: formatInteger(sources.length) });
        }
        case "plane_empty":
          return t("quality.plane_empty", {
            planes: describePlanes(warningsOf<"plane_empty">(group)),
          });
        case "few_exposures":
          return t("quality.few_exposures", {
            limit: formatInteger(FEW_EXPOSURES_LIMIT),
            planes: describePlanes(warningsOf<"few_exposures">(group)),
          });
        case "low_coverage":
          return t("quality.low_coverage", {
            limit: formatPercent(LOW_COVERAGE_LIMIT, language),
            planes: describePlanes(warningsOf<"low_coverage">(group)),
          });
        case "cutouts_failed": {
          const failures = warningsOf<"cutouts_failed">(group);
          const missing = failures.reduce((sum, warning) => sum + warning.n, 0);
          return t(missing === 1 ? "quality.cutouts_failed.one" : "quality.cutouts_failed.other", {
            n: formatInteger(missing),
            planes: describePlanes(failures.flatMap((warning) => warning.planes)),
          });
        }
        case "stale_exposure_list": {
          const listedAt = warningsOf<"stale_exposure_list">(group)[0]?.listed_at ?? "";
          return t("quality.stale_exposure_list", {
            date: formatIsoDateTime(new Date(listedAt)),
          });
        }
        default:
          return t("quality.full_download");
      }
    };

    const notices: NoticeItem[] = [];
    if (comparesProvisional) {
      notices.push({ key: PROVISIONAL_NOTICE, text: t("comparison.provisional") });
    }
    for (const group of groups) notices.push({ key: group.code, text: sentence(group) });
    return notices;
  }, [groups, comparesProvisional, language, t]);
}
