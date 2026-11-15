import styles from "./SkyWindowOverlay.module.css";

/** Diametro de la mira en la ventana al cielo, en px (DESIGN.md, `reticle`). */
export const WINDOW_RETICLE_SIZE = 128;

export interface SkyWindowOverlayProps {
  /** Nombre del objeto destacado que esta dentro de la mira, o null. */
  readonly lockedName: string | null;
  /** Sin objeto en la mira: el destacado mas cercano ("Mas cercano: R Draconis"). */
  readonly nearestText: string | null;
  /** A cuanto esta el mas cercano, ya formateado ("34" con el signo de grado). */
  readonly nearestDistance: string | null;
}

/**
 * Lo que la ventana al cielo dibuja sobre la esfera (DESIGN.md, "Ventana al
 * cielo"): la mira central en el acento y, debajo, el nombre del objeto que
 * hay ahi. El boton para abrirlo va aparte, en la zona del pulgar.
 */
export function SkyWindowOverlay({
  lockedName,
  nearestText,
  nearestDistance,
}: SkyWindowOverlayProps) {
  return (
    <div className={styles.overlay}>
      {/* Mismas proporciones que el icono `target`: circulo y cuatro marcas que lo cruzan. */}
      <svg
        className={styles.reticle}
        width={WINDOW_RETICLE_SIZE}
        height={WINDOW_RETICLE_SIZE}
        viewBox="0 0 128 128"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="64" cy="64" r="32" />
        <path d="M64 13v27" />
        <path d="M64 88v27" />
        <path d="M13 64h27" />
        <path d="M88 64h27" />
      </svg>
      <div className={styles.caption} aria-live="polite">
        {lockedName !== null ? (
          <p className={styles.name}>{lockedName}</p>
        ) : nearestText !== null ? (
          <p className={styles.nearest}>
            {nearestText} <span className={styles.distance}>{nearestDistance}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
