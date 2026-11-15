import type { FrameLayout } from "./FrameCanvas";
import type { FramePoint } from "./journey";
import styles from "./TargetMark.module.css";

export interface TargetMarkProps {
  /** Tamano de la imagen en pantalla, como lo entregan `FrameCanvas` y `Curtain`. */
  readonly layout: FrameLayout;
  /** Posicion del objeto, en pixeles de la grilla. */
  readonly point: FramePoint;
  /** Nombre accesible: que marca la mira. */
  readonly label: string;
  /** Radio del circulo en pixeles de pantalla. */
  readonly radius?: number;
}

const TICKS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

/**
 * Mira sobre una posicion de la imagen: circulo con cuatro marcas, en ambar
 * (uso 1 del acento en DESIGN.md) montado sobre un trazo negro para que se lea
 * sobre una estrella brillante. Es la version chica de `reticle`, para las
 * capas que se dibujan encima de una imagen del contexto.
 */
export function TargetMark({ layout, point, label, radius = 14 }: TargetMarkProps) {
  const center = layout.toScreen(point.x, point.y);
  const tick = 6;
  return (
    <svg
      className={styles.mark}
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={label}
    >
      {(["under", "over"] as const).map((kind) => (
        <g key={kind} className={styles[kind]}>
          <circle cx={center.x} cy={center.y} r={radius} />
          {TICKS.map(([dx, dy]) => (
            <line
              key={`${dx}-${dy}`}
              x1={center.x + dx * (radius - tick / 2)}
              y1={center.y + dy * (radius - tick / 2)}
              x2={center.x + dx * (radius + tick / 2)}
              y2={center.y + dy * (radius + tick / 2)}
            />
          ))}
        </g>
      ))}
    </svg>
  );
}
