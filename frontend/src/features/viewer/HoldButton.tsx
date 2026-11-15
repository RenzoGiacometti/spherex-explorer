import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, classNames } from "@/components";
import styles from "./panels.module.css";
import type { ViewerController } from "./useViewerController";

export interface HoldButtonProps {
  readonly controller: ViewerController;
  readonly className?: string | undefined;
}

function isHoldKey(event: KeyboardEvent): boolean {
  return event.key === " " || event.key === "Enter";
}

/**
 * Boton del modo "mantener apretado": mientras esta apretado, con el puntero,
 * el dedo o el teclado, se ve la epoca de referencia (B). Al soltarlo, o si el
 * puntero o el foco se van, vuelve la actual (A).
 */
export function HoldButton({ controller, className }: HoldButtonProps) {
  const { t } = useTranslation("viewer");
  const { holding, setHolding, view } = controller;
  return (
    <Button
      className={classNames(styles.holdButton, className)}
      aria-pressed={holding}
      disabled={view.issue !== null}
      disabledReason={view.issue === null ? undefined : t(`comparison.issue.${view.issue}`)}
      onPointerDown={() => setHolding(true)}
      onPointerUp={() => setHolding(false)}
      onPointerLeave={() => setHolding(false)}
      onPointerCancel={() => setHolding(false)}
      onBlur={() => setHolding(false)}
      onKeyDown={(event) => {
        if (isHoldKey(event) && !event.repeat) setHolding(true);
      }}
      onKeyUp={(event) => {
        if (isHoldKey(event)) setHolding(false);
      }}
      // Un toque largo no abre el menu del sistema ni selecciona el texto.
      onContextMenu={(event) => event.preventDefault()}
    >
      {t("comparison.holdButton")}
    </Button>
  );
}
