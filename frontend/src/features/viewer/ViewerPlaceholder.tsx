import { useTranslation } from "react-i18next";
import { useLanguage } from "@/i18n/useLanguage";
import { formatArcminutes, formatBand, formatDec, formatRa } from "@/lib/format";
import { useUrlState } from "@/state/urlState";
import styles from "./ViewerPlaceholder.module.css";

/**
 * Marcador de posicion del visor: muestra el estado leido de la URL. El visor
 * WebGL y los paneles llegan con las tareas F3 a F6.
 */
export function ViewerPlaceholder() {
  const { t } = useTranslation("viewer");
  const language = useLanguage();
  const ra = useUrlState((state) => state.ra);
  const dec = useUrlState((state) => state.dec);
  const fov = useUrlState((state) => state.fov);
  const band = useUrlState((state) => state.band);
  const mode = useUrlState((state) => state.mode);

  if (ra === null || dec === null) return null;

  return (
    <main className={styles.root}>
      <h1 className="type-label-cap">{t("placeholder.heading")}</h1>
      <p className={styles.body}>{t("placeholder.body")}</p>
      <dl className={styles.rows}>
        <div className={styles.row}>
          <dt>{t("field.ra")}</dt>
          <dd className="type-data">{formatRa(ra, { language })}</dd>
        </div>
        <div className={styles.row}>
          <dt>{t("field.dec")}</dt>
          <dd className="type-data">{formatDec(dec, { language })}</dd>
        </div>
        <div className={styles.row}>
          <dt>{t("field.fov")}</dt>
          <dd className="type-data">{formatArcminutes(fov, language)}</dd>
        </div>
        <div className={styles.row}>
          <dt>{t("field.band")}</dt>
          <dd className="type-data">{formatBand(band)}</dd>
        </div>
        <div className={styles.row}>
          <dt>{t("field.mode")}</dt>
          <dd>{t(`mode.${mode}`)}</dd>
        </div>
      </dl>
    </main>
  );
}
