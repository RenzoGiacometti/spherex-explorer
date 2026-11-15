import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useLanguage } from "@/i18n/useLanguage";
import { formatPercent, formatWavelength } from "@/lib/format";
import styles from "./ChemicalFingerprint.module.css";
import { chemicalFingerprint, type MoleculeEstimate } from "./fingerprint";
import { bandCenter, MOLECULE_FORMULA } from "./molecules";
import type { SpectrumBin } from "./types";

export interface ChemicalFingerprintProps {
  /** Promedios por canal del espectro (`binned`). */
  readonly bins: readonly SpectrumBin[];
  /** Detectores que no se evaluan porque ahi la luz es de otra fuente (aviso `offset_source`). */
  readonly excludedDetectors?: readonly number[] | undefined;
  /** Los mismos detectores ya escritos como bandas ("B1" a "B4"), para la aclaracion. */
  readonly excludedLabel?: string | undefined;
}

/**
 * Huella quimica (DESIGN.md, "Espectro"): una fila por molecula con nombre,
 * formula en monoespaciada, barra blanca de 6 px y una palabra. La palabra es
 * obligatoria: la barra sola no alcanza. Todo el bloque va rotulado como
 * indicio.
 */
export function ChemicalFingerprint({
  bins,
  excludedDetectors,
  excludedLabel,
}: ChemicalFingerprintProps) {
  const { t } = useTranslation("spectrum");
  const language = useLanguage();
  const rows = useMemo(
    () => chemicalFingerprint(bins, excludedDetectors ?? []),
    [bins, excludedDetectors],
  );

  const detail = (row: MoleculeEstimate): string | null => {
    if (row.best === null || row.best.depth === null) return null;
    const where = t("fingerprint.at", {
      wavelength: formatWavelength(bandCenter(row.best.band), language),
    });
    if (row.level === "none") return where;
    return `${where} · ${t("fingerprint.depth", { depth: formatPercent(row.best.depth, language) })}`;
  };

  return (
    <section className={styles.fingerprint}>
      <div className={styles.header}>
        <h3 className={styles.title}>{t("fingerprint.title")}</h3>
        <span className={styles.tag}>{t("fingerprint.hintTag")}</span>
      </div>
      <p className={styles.intro}>{t("fingerprint.intro")}</p>
      {excludedLabel === undefined || excludedLabel === "" ? null : (
        <p className={styles.intro}>{t("fingerprint.excluded", { bands: excludedLabel })}</p>
      )}
      <ul className={styles.rows}>
        {rows.map((row) => {
          const extra = detail(row);
          return (
            <li key={row.molecule} className={styles.row}>
              <span className={styles.name}>
                {t(`molecule.${row.molecule}`)}
                <span className={styles.formula}>{MOLECULE_FORMULA[row.molecule]}</span>
              </span>
              <span className={styles.track} aria-hidden="true">
                <span
                  className={styles.bar}
                  style={{ width: `${Math.round(row.strength * 100)}%` }}
                />
              </span>
              <span className={row.level === "unknown" ? styles.levelMuted : styles.level}>
                {t(`fingerprint.level.${row.level}`)}
              </span>
              {extra === null ? null : <span className={styles.detail}>{extra}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
