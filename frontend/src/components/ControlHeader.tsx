import styles from "./ControlHeader.module.css";

export interface ControlHeaderProps {
  /** Rotulo del control, en `body-sm` y `text-mute`. */
  readonly label: string;
  /** Valor actual, ya formateado; va a la derecha en monoespaciada. */
  readonly value?: string | undefined;
  /** `id` del control nativo que rotula: el rotulo pasa a ser un `<label>`. */
  readonly htmlFor?: string | undefined;
  /** `id` del rotulo, para `aria-labelledby`. */
  readonly id?: string | undefined;
}

/**
 * Renglon que encabeza un control dentro de un panel: rotulo a la izquierda y
 * valor a la derecha ("Contraste" y "65 %", "Campo de vision" y "10 min").
 */
export function ControlHeader({ label, value, htmlFor, id }: ControlHeaderProps) {
  return (
    <div className={styles.header}>
      {htmlFor === undefined ? (
        <span id={id} className={styles.label}>
          {label}
        </span>
      ) : (
        <label id={id} htmlFor={htmlFor} className={styles.label}>
          {label}
        </label>
      )}
      {value === undefined ? null : <span className={styles.value}>{value}</span>}
    </div>
  );
}
