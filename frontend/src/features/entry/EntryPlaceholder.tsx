import { useTranslation } from "react-i18next";
import { serializeUrlState } from "@/state/urlState";
import styles from "./EntryPlaceholder.module.css";

// Ejemplo de SPEC.md, seccion 3.3: WISE 0855 en su posicion de 2026.
const EXAMPLE_HREF = `/${serializeUrlState({
  ra: 133.7598,
  dec: -7.2422,
  fov: 0.1667,
  band: 6,
  mode: "blink",
  epoch: null,
  name: null,
  embed: false,
  lang: null,
})}`;

/**
 * Marcador de posicion de la entrada. El buscador y los destacados llegan con
 * la tarea F7; la esfera, con la Etapa 4.
 */
export function EntryPlaceholder() {
  const { t } = useTranslation("entry");
  const { t: tCommon } = useTranslation("common");

  return (
    <main className={styles.root}>
      <h1 className="type-title">{tCommon("app.name")}</h1>
      <p className={styles.body}>{t("placeholder.body")}</p>
      <p className={styles.example}>
        <span className="type-label-cap">{t("placeholder.example")}</span>
        <a className="type-data" href={EXAMPLE_HREF}>
          {EXAMPLE_HREF}
        </a>
      </p>
    </main>
  );
}
