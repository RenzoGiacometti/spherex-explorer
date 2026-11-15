import { classNames } from "./classNames";
import styles from "./Toggle.module.css";

export interface ToggleProps {
  /** Rotulo visible; tambien es el nombre accesible. */
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  readonly className?: string | undefined;
}

/**
 * Conmutador: prende y apaga una opcion (una capa, el rastro). Es una casilla
 * nativa con rol `switch`, asi que la barra espaciadora y el clic en el rotulo
 * funcionan sin codigo propio. Prendido se invierte a blanco solido, como toda
 * seleccion; no usa el acento.
 */
export function Toggle({ label, checked, onChange, disabled = false, className }: ToggleProps) {
  return (
    <label className={classNames(styles.toggle, disabled && styles.disabled, className)}>
      <span className={styles.label}>{label}</span>
      <input
        type="checkbox"
        role="switch"
        className={styles.input}
        checked={checked}
        aria-checked={checked}
        disabled={disabled}
        onChange={(event) => {
          // Deshabilitado no avisa cambios, tampoco ante un evento sintetico.
          if (!disabled) onChange(event.currentTarget.checked);
        }}
      />
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
    </label>
  );
}
