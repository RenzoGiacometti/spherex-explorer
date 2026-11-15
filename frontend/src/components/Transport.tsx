import { useTranslation } from "react-i18next";
import { classNames } from "./classNames";
import { IconButton, type IconButtonSize } from "./IconButton";
import styles from "./Transport.module.css";

export interface TransportProps {
  /** Si esta reproduciendo: el boton central muestra pausa. */
  readonly playing: boolean;
  /** Recibe el estado nuevo: `true` para reproducir, `false` para pausar. */
  readonly onPlayingChange: (playing: boolean) => void;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
  /**
   * Lado del boton de reproduccion: 44 px (`md`), 56 (`lg`) o 64 (`xl`), igual
   * en todas las pantallas. Sin este valor mide 44 px y, en celular, 56.
   */
  readonly playSize?: Extract<IconButtonSize, "md" | "lg" | "xl"> | undefined;
  readonly disabled?: boolean;
  /** Nombre accesible del grupo. Por defecto sale de i18n. */
  readonly label?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * Transporte (DESIGN.md, "Tiempo y carga"): epoca anterior, reproducir o
 * pausar en blanco solido, y epoca siguiente.
 */
export function Transport({
  playing,
  onPlayingChange,
  onPrevious,
  onNext,
  playSize,
  disabled = false,
  label,
  className,
}: TransportProps) {
  const { t } = useTranslation("components");
  return (
    // biome-ignore lint/a11y/useSemanticElements: un fieldset traeria su borde y su leyenda; aca solo hace falta agrupar tres botones con nombre.
    <div
      role="group"
      className={classNames(styles.transport, className)}
      aria-label={label ?? t("transport.label")}
    >
      <IconButton
        icon="prev"
        label={t("transport.previous")}
        disabled={disabled}
        onClick={onPrevious}
      />
      <IconButton
        icon={playing ? "pause" : "play"}
        label={playing ? t("transport.pause") : t("transport.play")}
        variant="solid"
        size={playSize ?? "md"}
        // Sin tamano pedido, la hoja de estilos lo agranda en celular.
        className={playSize === undefined ? styles.playAuto : undefined}
        disabled={disabled}
        onClick={() => onPlayingChange(!playing)}
      />
      <IconButton icon="next" label={t("transport.next")} disabled={disabled} onClick={onNext} />
    </div>
  );
}
