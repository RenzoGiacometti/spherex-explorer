import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatInteger } from "@/lib/format";
import a11y from "./a11y.module.css";
import { classNames } from "./classNames";
import { Icon } from "./Icon";
import styles from "./QualityNotice.module.css";

// Signo de multiplicar (U+00D7), para "x3" con el signo tipografico.
const TIMES = String.fromCodePoint(0x00d7);

export interface QualityNoticeProps {
  /** Cuantas veces se repite. Con 2 o mas se muestra la cantidad en monoespaciada. */
  readonly count?: number;
  /** Elemento que se dibuja: `li` dentro de una lista, `p` suelto. */
  readonly as?: "li" | "p" | "div";
  readonly className?: string | undefined;
  /** La frase del aviso, ya traducida. */
  readonly children: ReactNode;
}

/**
 * Aviso de calidad (DESIGN.md, "Paneles y datos"): icono `alert` en blanco y
 * una frase en `body-sm`. No hay colores semanticos: el aviso se comunica con
 * el icono y el texto.
 */
export function QualityNotice({ count = 1, as = "p", className, children }: QualityNoticeProps) {
  const { t } = useTranslation("components");
  const Element = as;
  const repeated = count > 1;
  const amount = formatInteger(count);

  return (
    <Element className={classNames(styles.notice, className)}>
      <Icon name="alert" size={18} className={styles.icon} />
      <span className={styles.text}>{children}</span>
      {repeated ? (
        <>
          {/* El espacio no se dibuja (el aviso es flex), pero separa la frase de la cantidad al leerlas. */}{" "}
          <span className={styles.count}>
            <span aria-hidden="true">{`${TIMES}${amount}`}</span>
            <span className={a11y.visuallyHidden}>{t("notices.repeated", { n: amount })}</span>
          </span>
        </>
      ) : null}
    </Element>
  );
}

export interface NoticeItem {
  /** La frase del aviso, ya traducida. */
  readonly text: string;
  /**
   * Clave de agrupamiento. Los avisos con la misma clave se muestran una sola
   * vez, con la frase del primero y la cantidad. Sin clave se agrupa por frase.
   */
  readonly key?: string | undefined;
}

export interface NoticeGroup {
  readonly key: string;
  readonly text: string;
  readonly count: number;
}

/**
 * Agrupa los avisos repetidos conservando el orden de aparicion. Sirve tambien
 * para la cantidad del encabezado del panel: `groupNotices(items).length`.
 */
export function groupNotices(notices: ReadonlyArray<NoticeItem>): NoticeGroup[] {
  const groups = new Map<string, NoticeGroup>();
  for (const notice of notices) {
    const key = notice.key ?? notice.text;
    const existing = groups.get(key);
    groups.set(
      key,
      existing === undefined
        ? { key, text: notice.text, count: 1 }
        : { ...existing, count: existing.count + 1 },
    );
  }
  return [...groups.values()];
}

export interface QualityNoticeListProps {
  readonly notices: ReadonlyArray<NoticeItem>;
  /** Lo que se muestra cuando no hay avisos. Sin este texto, la lista vacia no dibuja nada. */
  readonly emptyText?: string | undefined;
  readonly className?: string | undefined;
}

/** Lista de avisos de calidad. Los repetidos se agrupan en un renglon con su cantidad. */
export function QualityNoticeList({ notices, emptyText, className }: QualityNoticeListProps) {
  const groups = groupNotices(notices);

  if (groups.length === 0) {
    return emptyText === undefined ? null : (
      <p className={classNames(styles.empty, className)}>{emptyText}</p>
    );
  }

  return (
    <ul className={classNames(styles.list, className)}>
      {groups.map((group) => (
        <QualityNotice key={group.key} as="li" count={group.count}>
          {group.text}
        </QualityNotice>
      ))}
    </ul>
  );
}
