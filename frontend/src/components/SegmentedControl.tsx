import { type CSSProperties, useId } from "react";
import { useTranslation } from "react-i18next";
import a11y from "./a11y.module.css";
import { ControlHeader } from "./ControlHeader";
import { classNames } from "./classNames";
import styles from "./SegmentedControl.module.css";

export interface SegmentedOption<T extends string | number> {
  readonly value: T;
  /** Texto de la celda, en `label-cap`: "B3", "Parpadeo", "10 min". */
  readonly label: string;
  /** Segunda linea en monoespaciada: el rango de la banda. */
  readonly detail?: string | undefined;
  /** Nombre accesible cuando el texto de la celda es una abreviatura. */
  readonly ariaLabel?: string | undefined;
  /** No se puede elegir. */
  readonly disabled?: boolean | undefined;
  /**
   * Sin datos: se muestra atenuada pero sigue siendo elegible (una banda sin
   * datos en la epoca actual).
   */
  readonly noData?: boolean | undefined;
}

export interface SegmentedControlProps<T extends string | number> {
  /** Nombre del grupo. Siempre es el nombre accesible; visible solo con `showLabel`. */
  readonly label: string;
  readonly options: ReadonlyArray<SegmentedOption<T>>;
  /** Opcion elegida, o `null` si no hay ninguna. */
  readonly value: T | null;
  readonly onChange: (value: T) => void;
  /** Columnas de la grilla. Por defecto, una por opcion. */
  readonly columns?: number | undefined;
  /** Muestra el rotulo arriba del control, con `valueText` a la derecha. */
  readonly showLabel?: boolean;
  /** Valor actual ya formateado, para el encabezado visible. */
  readonly valueText?: string | undefined;
  /**
   * `fill` (por defecto) reparte el ancho disponible; `content` ajusta cada
   * celda a su texto, para un selector corto fuera de un panel (idioma).
   */
  readonly fit?: "fill" | "content";
  readonly disabled?: boolean;
  /** Texto que se le agrega al nombre de una opcion sin datos. Por defecto sale de i18n. */
  readonly noDataLabel?: string | undefined;
  readonly className?: string | undefined;
}

function optionName<T extends string | number>(
  option: SegmentedOption<T>,
  noDataText: string,
): string {
  const base =
    option.ariaLabel ??
    (option.detail === undefined ? option.label : `${option.label} ${option.detail}`);
  return option.noData === true ? `${base}, ${noDataText}` : base;
}

/**
 * Control segmentado (`option` y `option-selected` de DESIGN.md): celdas de
 * 36 px (44 en celular) con 4 px de separacion, para banda, modo, campo de
 * vision, velocidad e idioma. La opcion elegida se invierte a blanco solido.
 *
 * Son botones de radio nativos dentro de un `fieldset`: se entra con Tab, las
 * flechas cambian de opcion salteando las deshabilitadas, y el grupo se
 * anuncia con su nombre.
 */
export function SegmentedControl<T extends string | number>({
  label,
  options,
  value,
  onChange,
  columns,
  showLabel = false,
  valueText,
  fit = "fill",
  disabled = false,
  noDataLabel,
  className,
}: SegmentedControlProps<T>) {
  const { t } = useTranslation("components");
  const groupName = useId();
  const noDataText = noDataLabel ?? t("segmented.noData");
  const gridStyle = { "--segmented-columns": String(columns ?? options.length) } as CSSProperties;

  return (
    <fieldset
      className={classNames(styles.group, fit === "content" && styles.fitContent, className)}
      disabled={disabled}
    >
      <legend className={a11y.visuallyHidden}>{label}</legend>
      {showLabel ? (
        // El nombre ya lo da la leyenda: el encabezado visible no se anuncia dos veces.
        <div aria-hidden="true">
          <ControlHeader label={label} value={valueText} />
        </div>
      ) : null}
      <div className={styles.grid} style={gridStyle}>
        {options.map((option) => (
          <label
            key={String(option.value)}
            className={classNames(styles.option, option.noData === true && styles.noData)}
            data-no-data={option.noData === true ? "true" : undefined}
          >
            <input
              type="radio"
              className={styles.input}
              name={groupName}
              value={String(option.value)}
              checked={option.value === value}
              disabled={option.disabled === true}
              aria-label={optionName(option, noDataText)}
              onChange={() => {
                // Un control deshabilitado no avisa cambios, tampoco ante un evento sintetico.
                if (!disabled && option.disabled !== true) onChange(option.value);
              }}
            />
            <span
              className={classNames(styles.cell, option.detail !== undefined && styles.twoLine)}
            >
              <span className={styles.name}>{option.label}</span>
              {option.detail === undefined ? null : (
                <span className={styles.detail}>{option.detail}</span>
              )}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
