import { type FormEvent, type Ref, useId } from "react";
import { Button } from "./Button";
import { classNames } from "./classNames";
import { Icon } from "./Icon";
import styles from "./SearchField.module.css";

export interface SearchFieldProps {
  /** Etiqueta visible, encima del campo. */
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Recibe el texto sin espacios en las puntas. No se llama con el campo vacio ni mientras `busy`. */
  readonly onSubmit: (value: string) => void;
  /** Texto del boton: "Buscar". */
  readonly submitLabel: string;
  /**
   * Ejemplo: un nombre y unas coordenadas. Va dentro del campo; en celular,
   * donde no entra, se muestra entero en un renglon debajo del campo.
   */
  readonly placeholder?: string | undefined;
  /** Texto de ayuda debajo del campo. */
  readonly hint?: string | undefined;
  /** Mensaje de error debajo del campo: icono `alert` y texto, sin color semantico. */
  readonly error?: string | undefined;
  /** Hay una busqueda en curso: el boton queda deshabilitado. */
  readonly busy?: boolean;
  /** Referencia al campo de texto, por ejemplo para darle el foco. */
  readonly inputRef?: Ref<HTMLInputElement> | undefined;
  readonly className?: string | undefined;
}

/**
 * Campo de busqueda (`search-field` de DESIGN.md): campo de vidrio de 56 px
 * con icono, etiqueta visible encima, ejemplo como texto de ayuda y el boton
 * principal adentro. Es un formulario con rol `search`: Enter envia.
 */
export function SearchField({
  label,
  value,
  onChange,
  onSubmit,
  submitLabel,
  placeholder,
  hint,
  error,
  busy = false,
  inputRef,
  className,
}: SearchFieldProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = classNames(hint !== undefined && hintId, error !== undefined && errorId);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const text = value.trim();
    if (text !== "" && !busy) onSubmit(text);
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: el elemento <search> es de 2023; con role="search" el formulario es una region de busqueda tambien en navegadores anteriores.
    <form
      role="search"
      className={classNames(styles.search, className)}
      onSubmit={handleSubmit}
      aria-labelledby={labelId}
      aria-busy={busy}
    >
      <label id={labelId} htmlFor={id} className={styles.label}>
        {label}
      </label>
      <div className={styles.field}>
        <Icon name="search" size={20} className={styles.icon} />
        <input
          ref={inputRef}
          id={id}
          type="search"
          className={styles.input}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
          aria-describedby={describedBy === "" ? undefined : describedBy}
          aria-invalid={error === undefined ? undefined : true}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <Button type="submit" variant="primary" disabled={busy}>
          {submitLabel}
        </Button>
      </div>
      {placeholder === undefined ? null : (
        // Solo se ve en celular (SearchField.module.css). El lector de pantalla
        // ya recibe el ejemplo como `placeholder` del campo: aca no se repite.
        <p className={styles.example} aria-hidden="true">
          {placeholder}
        </p>
      )}
      {hint === undefined ? null : (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p id={errorId} className={styles.error} role="alert">
          <Icon name="alert" size={18} className={styles.errorIcon} />
          <span>{error}</span>
        </p>
      )}
    </form>
  );
}
