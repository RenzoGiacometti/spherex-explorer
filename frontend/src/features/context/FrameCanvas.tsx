import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { classNames } from "@/components";
import { NO_DATA_COLOR_VARIABLE, readCssColor, toRgb } from "@/viewer/colors";
import {
  contrastCuts,
  DEFAULT_CONTRAST,
  DEFAULT_STRETCH,
  type StretchKind,
} from "@/viewer/stretch";
import styles from "./FrameCanvas.module.css";
import { FALLBACK_NO_DATA, frameToRgba } from "./frameImage";
import type { FrameImage } from "./journey";

/** Lo que necesita una capa dibujada encima de la imagen para ubicarse. */
export interface FrameLayout {
  /** Lado de la imagen en pantalla, en pixeles CSS. */
  readonly width: number;
  readonly height: number;
  /** Pixeles de pantalla por pixel de la grilla. */
  readonly scale: number;
  /** De pixel de la grilla (x al oeste, y al norte, desde 0) a pixel de pantalla. */
  readonly toScreen: (x: number, y: number) => { x: number; y: number };
}

export interface FrameCanvasProps {
  /** El cuadro que se muestra. Con null queda el lienzo vacio y se muestra `placeholder`. */
  readonly image: FrameImage | null;
  /** Forma de la grilla `[ny, nx]`: fija el tamano aunque todavia no haya imagen. */
  readonly shape: readonly [number, number];
  /** Posicion del control de contraste, de 0 a 1, como en el visor. */
  readonly contrast?: number;
  readonly stretch?: StretchKind;
  /** Nombre accesible de la imagen: mision, banda y fecha. */
  readonly ariaLabel: string;
  /** Texto que se muestra en lugar de la imagen mientras no hay ninguna. */
  readonly placeholder?: string | undefined;
  /** Capas que se dibujan encima, en pixeles de pantalla. */
  readonly children?: ((layout: FrameLayout) => ReactNode) | undefined;
  readonly className?: string | undefined;
}

/**
 * Imagen de un cuadro del viaje: un plano de la grilla del campo, con el norte
 * arriba y el este a la izquierda, sin esquinas redondeadas ni marco
 * (DESIGN.md, "Shapes"). Cada pixel de la grilla se dibuja como un cuadrado
 * nitido, igual que en el visor.
 *
 * Encima de la imagen se dibujan las capas que lleguen en `children` (la de
 * Gaia, la mira): reciben el tamano en pantalla y una funcion que pasa de
 * pixel de la grilla a pixel de pantalla.
 */
export function FrameCanvas({
  image,
  shape,
  contrast = DEFAULT_CONTRAST,
  stretch = DEFAULT_STRETCH,
  ariaLabel,
  placeholder,
  children,
  className,
}: FrameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [side, setSide] = useState<{ width: number; height: number } | null>(null);
  const [ny, nx] = shape;

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    const measure = (): void => {
      const { clientWidth, clientHeight } = box;
      setSide(
        clientWidth > 0 && clientHeight > 0 ? { width: clientWidth, height: clientHeight } : null,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d") ?? null;
    if (canvas === null || context === null) return;
    if (image === null) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const noData = readCssColor(NO_DATA_COLOR_VARIABLE);
    const pixels = frameToRgba(
      image,
      contrastCuts(image.display, contrast),
      stretch,
      noData === null ? FALLBACK_NO_DATA : toRgb(noData),
    );
    context.putImageData(new ImageData(pixels, image.shape[1], image.shape[0]), 0, 0);
  }, [image, contrast, stretch]);

  const layout = useMemo<FrameLayout | null>(() => {
    if (side === null) return null;
    const scaleX = side.width / nx;
    const scaleY = side.height / ny;
    return {
      width: side.width,
      height: side.height,
      scale: Math.min(scaleX, scaleY),
      // El centro del pixel (x, y) cae medio pixel adentro; `y` crece al norte y la pantalla hacia abajo.
      toScreen: (x, y) => ({ x: (x + 0.5) * scaleX, y: (ny - 0.5 - y) * scaleY }),
    };
  }, [side, nx, ny]);

  return (
    <div
      ref={boxRef}
      className={classNames(styles.frame, className)}
      style={{ aspectRatio: `${nx} / ${ny}` }}
    >
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        width={nx}
        height={ny}
        role="img"
        aria-label={ariaLabel}
      />
      {image === null && placeholder !== undefined ? (
        <p className={classNames(styles.placeholder, "type-body-sm")} role="status">
          {placeholder}
        </p>
      ) : null}
      {layout !== null && children !== undefined ? (
        <div className={styles.overlay}>{children(layout)}</div>
      ) : null}
    </div>
  );
}
