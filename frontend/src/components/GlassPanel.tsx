import { type ReactNode, useId } from "react";
import { classNames } from "./classNames";
import styles from "./GlassPanel.module.css";
import { Icon, type IconName } from "./Icon";

export interface GlassPanelProps {
  /** Encabezado del panel, en `label-cap`. Tambien le da nombre accesible. */
  readonly title?: string | undefined;
  /** Icono de 18 px que acompana al titulo. */
  readonly icon?: IconName | undefined;
  /** Lo que va a la derecha del encabezado: una cantidad o una unidad, en monoespaciada. */
  readonly aside?: ReactNode;
  /** Nombre accesible cuando el panel no tiene titulo visible. */
  readonly label?: string | undefined;
  /** Relleno interno: 14 px (compacto, por defecto) o 24 px (panel de espectro). */
  readonly padding?: "compact" | "roomy";
  /** Elemento que se dibuja. Con titulo o `label`, por defecto es una seccion con nombre. */
  readonly as?: "section" | "div" | "aside" | "nav" | "header" | "footer";
  readonly className?: string | undefined;
  readonly children?: ReactNode;
}

/**
 * Panel de vidrio (`glass-panel` de DESIGN.md): contenedor de todo control que
 * flota sobre la imagen. Cada panel agrupa una sola tarea.
 */
export function GlassPanel({
  title,
  icon,
  aside,
  label,
  padding = "compact",
  as,
  className,
  children,
}: GlassPanelProps) {
  const titleId = useId();
  const named = title !== undefined || label !== undefined;
  const Element = as ?? (named ? "section" : "div");

  return (
    <Element
      className={classNames(styles.panel, padding === "roomy" && styles.roomy, className)}
      aria-labelledby={title === undefined ? undefined : titleId}
      aria-label={title === undefined ? label : undefined}
    >
      {title === undefined ? null : (
        <div className={styles.header}>
          <div className={styles.heading}>
            {icon === undefined ? null : <Icon name={icon} size={18} />}
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
          </div>
          {aside === undefined || aside === null ? null : (
            <span className={styles.aside}>{aside}</span>
          )}
        </div>
      )}
      {children}
    </Element>
  );
}
