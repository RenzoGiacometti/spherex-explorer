import { classNames } from "./classNames";
import { useDisabledReason } from "./DisabledReason";
import styles from "./Toggle.module.css";

export interface ToggleProps {
  /** Rotulo visible; tambien es el nombre accesible. */
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled?: boolean;
  /** Por que esta deshabilitado, ya traducido (DisabledReason.tsx). */
  readonly disabledReason?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * Conmutador: prende y apaga una opcion (una capa, el rastro). Es una casilla
 * nativa con rol `switch`, asi que la barra espaciadora y el clic en el rotulo
 * funcionan sin codigo propio. Prendido se invierte a blanco solido, como toda
 * seleccion; no usa el acento.
 */
export function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
  disabledReason,
  className,
}: ToggleProps) {
  const reason = useDisabledReason(disabled, disabledReason);
  return (
    <label className={classNames(styles.toggle, disabled && styles.disabled, className)}>
      <span className={styles.label}>{label}</span>
      <input
        type="checkbox"
        role="switch"
        className={styles.input}
        checked={checked}
        aria-checked={checked}
        disabled={reason.active ? undefined : disabled}
        onChange={(event) => {
          // Deshabilitado no avisa cambios, tampoco ante un evento sintetico.
          if (!disabled) onChange(event.currentTarget.checked);
        }}
        {...reason.props}
      />
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      {reason.bubble}
    </label>
  );
}
