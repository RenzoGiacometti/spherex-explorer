import { type CSSProperties, useId } from "react";
import { classNames } from "./classNames";
import styles from "./ProgressBar.module.css";

export interface ProgressBarProps {
  /** Etiqueta en mayusculas, a la izquierda: "Cargando datos". */
  readonly label: string;
  /**
   * Avance entre 0 y 1. `null` es avance desconocido (en cola, listando): la
   * barra no informa un valor.
   */
  readonly value: number | null;
  /**
   * Conteo ya formateado, a la derecha en monoespaciada: "14 / 22 recortes,
   * 64 %". Tambien es lo que anuncia el lector de pantalla.
   */
  readonly valueText?: string | undefined;
  readonly className?: string | undefined;
}

/** Lleva un avance a un porcentaje entero entre 0 y 100. */
function toPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

/**
 * Barra de progreso (`progress-bar` de DESIGN.md): linea de 2 px con el avance
 * en ambar, que es uno de los cuatro usos del acento.
 */
export function ProgressBar({ label, value, valueText, className }: ProgressBarProps) {
  const labelId = useId();
  const percent = value === null ? null : toPercent(value);
  const fillStyle = { "--progress-value": `${percent ?? 0}%` } as CSSProperties;

  return (
    <div className={classNames(styles.progress, className)}>
      <span id={labelId} className={styles.label}>
        {label}
      </span>
      <div
        role="progressbar"
        className={styles.rail}
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={valueText}
      >
        <div
          className={classNames(styles.fill, percent === null && styles.indeterminate)}
          style={fillStyle}
        />
      </div>
      {valueText === undefined ? null : <span className={styles.count}>{valueText}</span>}
    </div>
  );
}
