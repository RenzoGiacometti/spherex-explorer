// Juego de iconos de DESIGN.md ("Iconos"): linea de 1,5 px sobre una grilla de
// 24, extremos y uniones redondeados, sin relleno, en el color del texto
// (currentColor). Los trazos son los de la lamina "Sistema de diseno" de la
// maqueta. No hay emojis ni caracteres dingbat: todo icono sale de aca.

import type { ReactElement } from "react";
import { classNames } from "./classNames";
import styles from "./Icon.module.css";

const ICON_SHAPES = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  shuffle: (
    <>
      <path d="M3 7h3.5c2 0 3.2 1 4.3 2.6l2.4 4.8c1.1 1.6 2.3 2.6 4.3 2.6H21" />
      <path d="M3 17h3.5c1.4 0 2.4-.5 3.2-1.4" />
      <path d="M14.3 8.4c.8-.9 1.8-1.4 3.2-1.4H21" />
      <path d="M18.5 4.5L21 7l-2.5 2.5" />
      <path d="M18.5 14.5L21 17l-2.5 2.5" />
    </>
  ),
  layers: (
    <>
      <path d="M12 4l8.5 4.5L12 13 3.5 8.5 12 4z" />
      <path d="M3.5 12.5L12 17l8.5-4.5" />
      <path d="M3.5 16.5L12 21l8.5-4.5" />
    </>
  ),
  play: <path d="M8 5.5v13l10.5-6.5L8 5.5z" />,
  pause: (
    <>
      <path d="M8.5 5.5v13" />
      <path d="M15.5 5.5v13" />
    </>
  ),
  prev: (
    <>
      <path d="M17 6l-8 6 8 6V6z" />
      <path d="M6.5 6v12" />
    </>
  ),
  next: (
    <>
      <path d="M7 6l8 6-8 6V6z" />
      <path d="M17.5 6v12" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="6" />
      <path d="M12 2.5v5" />
      <path d="M12 16.5v5" />
      <path d="M2.5 12h5" />
      <path d="M16.5 12h5" />
    </>
  ),
  share: (
    <>
      <path d="M12 15V4" />
      <path d="M8 7.5l4-4 4 4" />
      <path d="M5 12.5V19h14v-6.5" />
    </>
  ),
  flag: (
    <>
      <path d="M5.5 21V4" />
      <path d="M5.5 4.5h11l-2 4 2 4h-11" />
    </>
  ),
  sound: (
    <>
      <path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4H4z" />
      <path d="M15.5 9a4.5 4.5 0 010 6" />
      <path d="M18 6.5a8 8 0 010 11" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <path d="M12 7.7v.1" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4l9 15.5H3L12 4z" />
      <path d="M12 10v4.5" />
      <path d="M12 17v.1" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </>
  ),
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  contrast: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17" />
      <path d="M12 8h7.5" />
      <path d="M12 12h8.5" />
      <path d="M12 16h7.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.8 2.3 4 5.2 4 8.5s-1.2 6.2-4 8.5c-2.8-2.3-4-5.2-4-8.5s1.2-6.2 4-8.5z" />
    </>
  ),
  back: <path d="M14.5 5.5L8 12l6.5 6.5" />,
  bands: (
    <>
      <path d="M4 18V6" />
      <path d="M8 18v-8" />
      <path d="M12 18V4" />
      <path d="M16 18v-6" />
      <path d="M20 18V8" />
    </>
  ),
  blink: (
    <>
      <rect x="3.5" y="5.5" width="11" height="11" rx="1" />
      <rect x="9.5" y="7.5" width="11" height="11" rx="1" />
    </>
  ),
  fov: (
    <>
      <path d="M4 9V4h5" />
      <path d="M20 9V4h-5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15 9l-1.8 4.2L9 15l1.8-4.2L15 9z" />
    </>
  ),
  spectrum: (
    <>
      <path d="M3 17c3 0 3-9 6-9s3 6 5 6 2.5-8 4-8 2 5 3 5" />
      <path d="M3 20.5h18" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
} as const satisfies Record<string, ReactElement>;

/** Nombre de un icono del juego de DESIGN.md. */
export type IconName = keyof typeof ICON_SHAPES;

/** Todos los iconos, en el orden en que los lista DESIGN.md. */
export const ICON_NAMES = Object.keys(ICON_SHAPES) as IconName[];

export interface IconProps {
  readonly name: IconName;
  /** Lado en px. DESIGN.md: 18 en encabezados de panel, 20 a 24 en botones. */
  readonly size?: number;
  /**
   * Nombre accesible. Sin el, el icono es decorativo y queda oculto para los
   * lectores de pantalla: es el caso normal, porque va al lado de un texto o
   * dentro de un boton que ya tiene nombre.
   */
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}

/** Icono de linea, en SVG y con el color del texto que lo rodea. */
export function Icon({ name, size = 20, label, className }: IconProps) {
  const classes = classNames(styles.icon, className);
  const shape = ICON_SHAPES[name];

  if (label === undefined) {
    return (
      <svg
        className={classes}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        data-icon={name}
      >
        {shape}
      </svg>
    );
  }

  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={label}
      focusable="false"
      data-icon={name}
    >
      <title>{label}</title>
      {shape}
    </svg>
  );
}
