import type { ComponentPropsWithoutRef, ReactNode } from "react";
import styles from "./Button.module.css";
import { classNames } from "./classNames";
import { describedBy, useDisabledReason, withoutHandlers } from "./DisabledReason";
import { Icon, type IconName } from "./Icon";

/**
 * `primary` es el boton relleno de acento: la accion principal de la vista,
 * uno por pantalla como maximo. `ghost` es el de borde blanco, para las
 * acciones secundarias.
 */
export type ButtonVariant = "primary" | "ghost";

interface ButtonOwnProps {
  readonly variant?: ButtonVariant;
  /** Icono de 18 px a la izquierda del texto. */
  readonly icon?: IconName | undefined;
  readonly className?: string | undefined;
  /** Texto del boton; llega traducido. */
  readonly children: ReactNode;
}

function buttonClass(variant: ButtonVariant, className: string | undefined): string {
  return classNames(
    styles.button,
    variant === "primary" ? styles.primary : styles.ghost,
    className,
  );
}

function ButtonContent({ icon, children }: Pick<ButtonOwnProps, "icon" | "children">) {
  return (
    <>
      {icon === undefined ? null : <Icon name={icon} size={18} />}
      <span className={styles.text}>{children}</span>
    </>
  );
}

export type ButtonProps = ButtonOwnProps &
  Omit<ComponentPropsWithoutRef<"button">, keyof ButtonOwnProps> & {
    /**
     * Por que esta deshabilitado, ya traducido. Con esto el boton deshabilitado
     * muestra el motivo al pasarle el cursor, tocarlo o enfocarlo, y lo da como
     * descripcion accesible (DisabledReason.tsx).
     */
    readonly disabledReason?: string | undefined;
  };

/** Boton con texto (`button-primary` y `button-ghost` de DESIGN.md): pildora de 44 px. */
export function Button({
  variant = "ghost",
  icon,
  className,
  children,
  type = "button",
  disabled = false,
  disabledReason,
  ...rest
}: ButtonProps) {
  const reason = useDisabledReason(disabled, disabledReason);
  return (
    <>
      <button
        type={type}
        className={buttonClass(variant, className)}
        data-variant={variant}
        {...(reason.active ? withoutHandlers(rest) : rest)}
        disabled={reason.active ? undefined : disabled}
        {...reason.props}
        aria-describedby={describedBy(rest["aria-describedby"], reason)}
      >
        <ButtonContent icon={icon}>{children}</ButtonContent>
      </button>
      {reason.bubble}
    </>
  );
}

export type ButtonLinkProps = ButtonOwnProps &
  Omit<ComponentPropsWithoutRef<"a">, keyof ButtonOwnProps | "href"> & {
    readonly href: string;
  };

/** Enlace con el aspecto de un boton, para las acciones que llevan a otra vista. */
export function ButtonLink({
  variant = "ghost",
  icon,
  className,
  children,
  href,
  ...rest
}: ButtonLinkProps) {
  return (
    <a href={href} className={buttonClass(variant, className)} data-variant={variant} {...rest}>
      <ButtonContent icon={icon}>{children}</ButtonContent>
    </a>
  );
}
