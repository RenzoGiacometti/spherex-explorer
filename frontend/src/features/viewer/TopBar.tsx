import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Icon, IconLink, LanguageSelector } from "@/components";
import a11y from "@/components/a11y.module.css";
import type { Language } from "@/i18n/languages";
import { useLanguage } from "@/i18n/useLanguage";
import { formatDec, formatInteger, formatRa } from "@/lib/format";
import { DEFAULT_URL_STATE, serializeUrlState, useUrlState } from "@/state/urlState";
import styles from "./TopBar.module.css";

export interface TopBarProps {
  /**
   * `desktop` (por defecto): la salida, la marca y el objeto a la izquierda y
   * el idioma a la derecha. `phone`: una sola franja con la salida, el objeto y
   * el acceso a los avisos de calidad; el idioma pasa al cajon de herramientas,
   * porque arriba solo van informacion y la salida (DESIGN.md, "Zona del pulgar").
   */
  readonly layout?: "desktop" | "phone";
  /** Celular: cantidad de avisos de calidad. Con 0 no se muestra el acceso. */
  readonly noticeCount?: number;
  /** Celular: abre el cajon de herramientas en los avisos. */
  readonly onOpenNotices?: (() => void) | undefined;
  /** Celular: si el cajon esta abierto, para `aria-expanded`. */
  readonly toolsOpen?: boolean;
}

/**
 * Barra superior del visor (DESIGN.md, "Estructura"): transparente, con la
 * salida y la marca a la izquierda, el objeto con sus coordenadas, y el idioma
 * a la derecha. Cada extremo va sobre su propio vidrio, para que se lea cuando
 * la imagen acercada pasa por debajo.
 */
export function TopBar({
  layout = "desktop",
  noticeCount = 0,
  onOpenNotices,
  toolsOpen = false,
}: TopBarProps) {
  const { t } = useTranslation("viewer");
  const { t: tCommon } = useTranslation("common");
  const language = useLanguage();
  const ra = useUrlState((state) => state.ra);
  const dec = useUrlState((state) => state.dec);
  const name = useUrlState((state) => state.name);
  const embed = useUrlState((state) => state.embed);
  const lang = useUrlState((state) => state.lang);
  const update = useUrlState((state) => state.update);
  const phone = layout === "phone";

  // La entrada es la misma direccion sin el campo; el idioma elegido se conserva.
  const backHref = `${window.location.pathname}${serializeUrlState({ ...DEFAULT_URL_STATE, embed, lang })}`;

  function goBack(event: MouseEvent<HTMLAnchorElement>): void {
    // Con Control, Mayusculas o el boton del medio el navegador abre el enlace aparte.
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    update({ ra: null, dec: null, epoch: null, name: null }, { history: "push" });
  }

  const identity = (
    <div className={styles.identity}>
      {/* El nombre del objeto va como en el catalogo, sin mayusculas forzadas. */}
      <h1 className={styles.object}>{name ?? t("page.field")}</h1>
      {ra === null || dec === null ? null : (
        <p className={styles.coordinates}>
          {/* Quien escucha la pantalla oye que es cada numero; a la vista alcanza con el formato. */}
          <span>
            <span className={a11y.visuallyHidden}>{t("field.ra")} </span>
            {formatRa(ra, { language })}
          </span>
          <span>
            <span className={a11y.visuallyHidden}>{t("field.dec")} </span>
            {formatDec(dec, { language })}
          </span>
        </p>
      )}
    </div>
  );

  if (phone) {
    const count = formatInteger(noticeCount);
    return (
      <header className={styles.phone}>
        <IconLink
          icon="back"
          variant="bare"
          label={t("page.back")}
          href={backHref}
          onClick={goBack}
        />
        {identity}
        {noticeCount > 0 ? (
          <button
            type="button"
            className={styles.notices}
            aria-label={t("quality.open", { n: count })}
            aria-expanded={toolsOpen}
            onClick={onOpenNotices}
          >
            <Icon name="alert" size={20} />
            <span className={styles.noticesCount} aria-hidden="true">
              {count}
            </span>
          </button>
        ) : (
          // Sin avisos el objeto queda igual de centrado.
          <span className={styles.spacer} aria-hidden="true" />
        )}
      </header>
    );
  }

  return (
    <header className={styles.bar}>
      <div className={styles.start}>
        <IconLink icon="back" label={t("page.back")} href={backHref} onClick={goBack} />
        <p className={styles.brand}>{tCommon("app.name")}</p>
        {identity}
      </div>
      <div className={styles.language}>
        <LanguageSelector value={language} onChange={(next: Language) => update({ lang: next })} />
      </div>
    </header>
  );
}
