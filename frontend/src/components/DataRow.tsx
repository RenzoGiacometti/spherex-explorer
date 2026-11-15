import type { ReactNode } from "react";
import { classNames } from "./classNames";
import styles from "./DataRow.module.css";

export interface DataGroupProps {
  readonly className?: string | undefined;
  /** Filas `DataRow`. */
  readonly children?: ReactNode;
}

/**
 * Grupo de datos: una lista de descripcion con una fila por dato. El nombre
 * accesible lo da el panel que la contiene.
 */
export function DataGroup({ className, children }: DataGroupProps) {
  return <dl className={classNames(styles.group, className)}>{children}</dl>;
}

export interface DataRowProps {
  /** Rotulo de la fila, en `body-sm` y `text-mute`. */
  readonly label: string;
  /**
   * Valor, ya formateado con `lib/format.ts`. Va en monoespaciada con cifras
   * tabulares; la unidad acompana al valor en la misma familia.
   */
  readonly value: ReactNode;
  /**
   * Corta el valor con puntos suspensivos si no entra. Solo para nombres
   * largos (DESIGN.md, "Dos idiomas"); el texto completo queda en `title`.
   */
  readonly truncate?: boolean;
}

/** Fila de dato (`data-row` de DESIGN.md): rotulo a la izquierda y valor a la derecha. */
export function DataRow({ label, value, truncate = false }: DataRowProps) {
  return (
    <div className={styles.row}>
      <dt className={styles.label}>{label}</dt>
      <dd
        className={classNames(styles.value, truncate && styles.truncate)}
        title={truncate && typeof value === "string" ? value : undefined}
      >
        {value}
      </dd>
    </div>
  );
}
