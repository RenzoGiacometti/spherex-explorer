import {
  type CSSProperties,
  type ReactNode,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { classNames, ImageTag } from "@/components";
import { useLanguage } from "@/i18n/useLanguage";
import { formatPercent } from "@/lib/format";
import { DEFAULT_CONTRAST, DEFAULT_STRETCH, type StretchKind } from "@/viewer/stretch";
import styles from "./Curtain.module.css";
import {
  CURTAIN_STEPS,
  clampCurtain,
  curtainFromValue,
  curtainKeyStep,
  curtainToValue,
} from "./curtainMath";
import { FrameCanvas, type FrameLayout } from "./FrameCanvas";
import type { FrameImage } from "./journey";
import type { PlateCredit } from "./optical";

// Los textos estan en src/i18n/locales/<idioma>/curtain.json (namespace `curtain`).

// Punto medio (U+00B7): separa el nombre de la mision de su dato.
const SEPARATOR = String.fromCodePoint(0x00b7);

/** Un lado de la cortina: la imagen y como se la rotula. */
export interface CurtainSide {
  /** null mientras la imagen no llego: ese lado queda vacio. */
  readonly image: FrameImage | null;
  /** Nombre de la mision o del relevamiento: "DSS", "WISE". No se traduce. */
  readonly name: string;
  /** El dato, ya formateado: banda, longitud de onda y fecha. */
  readonly detail: string;
}

export interface CurtainProps {
  /** Lo que se ve a la izquierda del divisor: la imagen en luz visible. */
  readonly left: CurtainSide;
  /** Lo que se ve a la derecha: la imagen infrarroja. */
  readonly right: CurtainSide;
  /** Forma de la grilla `[ny, nx]`, la misma de las dos imagenes. */
  readonly shape: readonly [number, number];
  /** Donde esta el divisor, de 0 (borde izquierdo) a 1 (borde derecho). */
  readonly position: number;
  readonly onPositionChange: (position: number) => void;
  readonly contrast?: number;
  readonly stretch?: StretchKind;
  /** Capas que se dibujan encima de las dos imagenes (la mira, las fuentes de Gaia). */
  readonly children?: ((layout: FrameLayout) => ReactNode) | undefined;
  readonly className?: string | undefined;
}

/**
 * Cortina visible/infrarrojo: dos imagenes del mismo campo en la misma grilla,
 * una encima de la otra, y un divisor vertical que se arrastra. A la izquierda
 * del divisor se ve la imagen en luz visible y a la derecha, la infrarroja.
 *
 * El divisor se mueve con un control de rango nativo que cubre toda la imagen
 * y no se ve: arrastrar o tocar en cualquier lugar lleva el divisor ahi, y con
 * el teclado funcionan las flechas, Inicio, Fin y Av/Re Pag sin escribir nada.
 * Lo que se ve (la linea y la perilla) es solo el dibujo de ese control.
 *
 * Cada lado lleva su rotulo de imagen, del lado que le corresponde, para que
 * siempre se sepa que se esta mirando. El divisor va en blanco sobre un trazo
 * negro, como las demas anotaciones: el acento no es para esto.
 */
export function Curtain({
  left,
  right,
  shape,
  position,
  onPositionChange,
  contrast = DEFAULT_CONTRAST,
  stretch = DEFAULT_STRETCH,
  children,
  className,
}: CurtainProps) {
  const { t } = useTranslation("curtain");
  const language = useLanguage();
  const inputId = useId();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const where = clampCurtain(position);
  const [ny, nx] = shape;

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) return;
    const measure = (): void => {
      const { clientWidth, clientHeight } = box;
      setSize(
        clientWidth > 0 && clientHeight > 0 ? { width: clientWidth, height: clientHeight } : null,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  // Misma cuenta que FrameCanvas: de pixel de la grilla a pixel de pantalla, con el norte arriba.
  const layout = useMemo<FrameLayout | null>(() => {
    if (size === null) return null;
    const scaleX = size.width / nx;
    const scaleY = size.height / ny;
    return {
      width: size.width,
      height: size.height,
      scale: Math.min(scaleX, scaleY),
      toScreen: (x, y) => ({ x: (x + 0.5) * scaleX, y: (ny - 0.5 - y) * scaleY }),
    };
  }, [size, nx, ny]);

  const style = {
    "--curtain-position": `${(where * 100).toFixed(2)}%`,
    aspectRatio: `${nx} / ${ny}`,
  } as CSSProperties;

  return (
    <div
      ref={boxRef}
      className={classNames(styles.curtain, className)}
      style={style}
      data-curtain-position={where}
    >
      {/* Abajo, entera, la imagen de la derecha; arriba, recortada al divisor, la de la izquierda. */}
      <FrameCanvas
        className={styles.layer}
        image={right.image}
        shape={shape}
        contrast={contrast}
        stretch={stretch}
        ariaLabel={t("image", { name: right.name, detail: right.detail })}
      />
      <div className={styles.clip}>
        <FrameCanvas
          className={styles.layer}
          image={left.image}
          shape={shape}
          contrast={contrast}
          stretch={stretch}
          ariaLabel={t("image", { name: left.name, detail: left.detail })}
        />
      </div>

      {layout === null || children === undefined ? null : (
        <div className={styles.annotations}>{children(layout)}</div>
      )}

      <ImageTag
        className={styles.leftTag}
        label={t("visible")}
        value={`${left.name} ${SEPARATOR} ${left.detail}`}
      />
      <ImageTag
        className={styles.rightTag}
        label={t("infrared")}
        value={`${right.name} ${SEPARATOR} ${right.detail}`}
      />

      <label className={styles.visuallyHidden} htmlFor={inputId}>
        {t("label", { left: left.name, right: right.name })}
      </label>
      <input
        id={inputId}
        className={styles.input}
        type="range"
        min={0}
        max={CURTAIN_STEPS}
        step={1}
        value={curtainToValue(where)}
        aria-valuetext={t("value", {
          percent: formatPercent(where, language),
          left: left.name,
          right: right.name,
        })}
        onChange={(event) => onPositionChange(curtainFromValue(event.currentTarget.valueAsNumber))}
        onKeyDown={(event) => {
          // El control nativo avanza de a una milesima por flecha: bien para el puntero, lento
          // para el teclado. Las flechas se atienden aca; Inicio, Fin y Av/Re Pag quedan nativos.
          const next = curtainKeyStep(where, event.key, event.shiftKey);
          if (next === null) return;
          event.preventDefault();
          onPositionChange(next);
        }}
      />
      <span className={styles.divider} aria-hidden="true">
        <span className={styles.handle} />
      </span>
    </div>
  );
}

export interface OpticalCreditProps {
  /** Placa, relevamiento y titular, tal como los da la capa (`plateCredit`). */
  readonly credit: PlateCredit;
  readonly className?: string | undefined;
}

/**
 * Credito de una placa del Digitized Sky Survey. Va junto a la imagen cada vez
 * que se la muestra: las placas tienen titular y STScI pide citar el
 * relevamiento.
 */
export function OpticalCredit({ credit, className }: OpticalCreditProps) {
  const { t } = useTranslation("curtain");
  return (
    <p className={classNames(styles.credit, className)}>
      {t("credit", { plate: credit.plate, survey: credit.survey, owner: credit.owner })}
    </p>
  );
}
