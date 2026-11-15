import type { ComponentPropsWithoutRef } from "react";
import { classNames } from "./classNames";
import { describedBy, useDisabledReason, withoutHandlers } from "./DisabledReason";
import { Icon, type IconName } from "./Icon";
import styles from "./IconButton.module.css";

/**
 * `outline`: borde fino, el estado normal. `solid`: relleno blanco con icono
 * negro, para el boton de reproduccion y para lo seleccionado. `bare`: sin
 * borde, para la salida en la barra de un celular.
 */
export type IconButtonVariant = "outline" | "solid" | "bare";

/** Lado del boton: 36 px (`sm`, sube a 44 en celular), 44 (`md`), 56 (`lg`) y 64 (`xl`). */
export type IconButtonSize = "sm" | "md" | "lg" | "xl";

/** `round` para transporte y acciones; `square` (radio de 4 px) para las herramientas en riel. */
export type IconButtonShape = "round" | "square";

const ICON_SIZE: Record<IconButtonSize, number> = { sm: 18, md: 20, lg: 24, xl: 28 };

interface IconButtonOwnProps {
  readonly icon: IconName;
  /** Nombre accesible. Es obligatorio: el boton no muestra texto. */
  readonly label: string;
  readonly variant?: IconButtonVariant;
  readonly size?: IconButtonSize;
  readonly shape?: IconButtonShape;
  readonly className?: string | undefined;
}

function iconButtonClass(
  variant: IconButtonVariant,
  size: IconButtonSize,
  shape: IconButtonShape,
  className: string | undefined,
): string {
  return classNames(
    styles.button,
    styles[variant],
    styles[size],
    shape === "square" && styles.square,
    className,
  );
}

export type IconButtonProps = IconButtonOwnProps &
  Omit<ComponentPropsWithoutRef<"button">, keyof IconButtonOwnProps | "children" | "aria-label"> & {
    /**
     * Para un boton que se prende y se apaga (una herramienta, una capa):
     * informa `aria-pressed` y, prendido, se dibuja relleno.
     */
    readonly pressed?: boolean | undefined;
    /** Por que esta deshabilitado, ya traducido (DisabledReason.tsx). */
    readonly disabledReason?: string | undefined;
  };

/** Boton de icono (`button-icon` de DESIGN.md): circulo de 44 px con borde fino. */
export function IconButton({
  icon,
  label,
  variant = "outline",
  size = "md",
  shape = "round",
  pressed,
  className,
  type = "button",
  disabled = false,
  disabledReason,
  ...rest
}: IconButtonProps) {
  const shown = pressed === true ? "solid" : variant;
  const reason = useDisabledReason(disabled, disabledReason);
  return (
    <>
      <button
        type={type}
        className={iconButtonClass(shown, size, shape, className)}
        data-variant={shown}
        data-size={size}
        data-shape={shape}
        aria-label={label}
        aria-pressed={pressed}
        {...(reason.active ? withoutHandlers(rest) : rest)}
        disabled={reason.active ? undefined : disabled}
        {...reason.props}
        aria-describedby={describedBy(rest["aria-describedby"], reason)}
      >
        <Icon name={icon} size={ICON_SIZE[size]} />
      </button>
      {reason.bubble}
    </>
  );
}

export type IconLinkProps = IconButtonOwnProps &
  Omit<
    ComponentPropsWithoutRef<"a">,
    keyof IconButtonOwnProps | "children" | "aria-label" | "href"
  > & {
    readonly href: string;
  };

/** Enlace con el aspecto de un boton de icono, por ejemplo para volver a la entrada. */
export function IconLink({
  icon,
  label,
  variant = "outline",
  size = "md",
  shape = "round",
  className,
  href,
  ...rest
}: IconLinkProps) {
  return (
    <a
      href={href}
      className={iconButtonClass(variant, size, shape, className)}
      data-variant={variant}
      data-size={size}
      data-shape={shape}
      aria-label={label}
      {...rest}
    >
      <Icon name={icon} size={ICON_SIZE[size]} />
    </a>
  );
}
