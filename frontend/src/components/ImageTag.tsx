import { classNames } from "./classNames";
import styles from "./ImageTag.module.css";

// Punto medio (U+00B7): el separador entre la palabra y el dato en DESIGN.md.
const SEPARATOR = String.fromCodePoint(0x00b7);

export interface ImageTagProps {
  /** La palabra, en `label-cap`: "Provisorio", "Vista provisoria". */
  readonly label: string;
  /** El dato, en monoespaciada y ya formateado: "9 / 18 exposiciones", "WISE 3,4 um". */
  readonly value?: string | undefined;
  /**
   * Segunda linea en `body-sm`. Para la vista de otro relevamiento aclara que
   * no es una imagen de SPHEREx.
   */
  readonly note?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * Rotulo de imagen (`image-tag` de DESIGN.md): pildora de vidrio de 28 px que
 * va centrada sobre el borde superior de la imagen. Dos usos: plano
 * provisorio y vista provisoria de otro relevamiento. La ubicacion sobre la
 * imagen la decide quien lo usa.
 */
export function ImageTag({ label, value, note, className }: ImageTagProps) {
  return (
    <div className={classNames(styles.tag, className)}>
      <p className={styles.pill}>
        <span className={styles.label}>{label}</span>
        {value === undefined ? null : (
          <>
            {/* El espacio no se dibuja (la pildora es flex), pero separa la palabra del dato al leerlos. */}{" "}
            <span className={styles.separator} aria-hidden="true">
              {SEPARATOR}
            </span>
            <span className={styles.value}>{value}</span>
          </>
        )}
      </p>
      {note === undefined ? null : <p className={styles.note}>{note}</p>}
    </div>
  );
}
