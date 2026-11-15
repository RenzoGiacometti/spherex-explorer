import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { classNames } from "./classNames";
import styles from "./QuickLink.module.css";

interface QuickLinkOwnProps {
  /** Adonde lleva: la URL del visor con el campo del objeto. */
  readonly href: string;
  /** Dato corto en monoespaciada al lado del nombre, por ejemplo el movimiento propio. */
  readonly detail?: string | undefined;
  readonly className?: string | undefined;
  /** Nombre del objeto, escrito como en el catalogo y sin mayusculas forzadas. */
  readonly children: ReactNode;
}

export type QuickLinkProps = QuickLinkOwnProps &
  Omit<ComponentPropsWithoutRef<"a">, keyof QuickLinkOwnProps>;

/**
 * Acceso rapido (`quick-link` de DESIGN.md): pildora de 36 px para los objetos
 * destacados de la entrada. Es un enlace de verdad: se puede abrir en otra
 * pestana y copiar. Quien lo usa puede sumar `onClick` para navegar sin recargar.
 */
export function QuickLink({ href, detail, className, children, ...rest }: QuickLinkProps) {
  return (
    <a href={href} className={classNames(styles.link, className)} {...rest}>
      <span className={styles.name}>{children}</span>
      {detail === undefined ? null : (
        <>
          {/* El espacio no se dibuja (el enlace es flex), pero separa las dos partes al leerlas. */}{" "}
          <span className={styles.detail}>{detail}</span>
        </>
      )}
    </a>
  );
}

export interface QuickLinkListProps {
  /** Nombre accesible de la navegacion: "Objetos destacados". */
  readonly label: string;
  readonly className?: string | undefined;
  /** Elementos `QuickLink`. */
  readonly children: ReactNode;
}

/** Navegacion con los accesos rapidos, centrados y en varias lineas si no entran. */
export function QuickLinkList({ label, className, children }: QuickLinkListProps) {
  return (
    <nav className={classNames(styles.list, className)} aria-label={label}>
      {children}
    </nav>
  );
}
