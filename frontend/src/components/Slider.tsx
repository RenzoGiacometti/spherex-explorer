import { useId } from "react";
import { ControlHeader } from "./ControlHeader";
import { classNames } from "./classNames";
import styles from "./Slider.module.css";

export interface SliderProps {
  /** Rotulo visible, a la izquierda. */
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /**
   * Valor ya formateado con `lib/format.ts` ("65 %"). Se muestra a la derecha
   * en monoespaciada y es lo que anuncia el lector de pantalla.
   */
  readonly valueText?: string | undefined;
  readonly disabled?: boolean;
  readonly className?: string | undefined;
}

/**
 * Deslizador (DESIGN.md, "Selectores"): control nativo de rango en blanco.
 * Al ser nativo, el teclado viene dado: flechas, Inicio, Fin y Av/Re Pag.
 */
export function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  valueText,
  disabled = false,
  className,
}: SliderProps) {
  const id = useId();
  return (
    <div className={classNames(styles.slider, className)}>
      <ControlHeader label={label} value={valueText} htmlFor={id} />
      <input
        id={id}
        type="range"
        className={styles.input}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={valueText}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
    </div>
  );
}
