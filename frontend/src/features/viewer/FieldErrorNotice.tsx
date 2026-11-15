import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, GlassPanel } from "@/components";
import type { FieldError } from "@/data/fieldState";
import { formatInteger } from "@/lib/format";
import { useFieldStore } from "@/state/fieldStore";
import styles from "./FieldErrorNotice.module.css";

/** Segundos de espera que le quedan a un error al mostrarlo; 0 si no pide esperar. */
function initialWait(error: FieldError): number {
  if (error.retryAt === null) return 0;
  const untilRetry = (error.retryAt - Date.now()) / 1000;
  // Nunca mas que lo que pidio el backend, aunque los relojes no coincidan.
  return Math.max(0, Math.min(untilRetry, error.retryAfterS ?? untilRetry));
}

/**
 * Cuenta regresiva, de a un segundo, de la espera que pidio el backend
 * (`Retry-After`). Devuelve los segundos que faltan, redondeados hacia arriba.
 */
function useWait(error: FieldError): number {
  const [total] = useState(() => initialWait(error));
  const [left, setLeft] = useState(total);

  useEffect(() => {
    if (!(total > 0)) return;
    const start = Date.now();
    const timer = window.setInterval(() => {
      const remaining = total - (Date.now() - start) / 1000;
      setLeft(Math.max(0, remaining));
      if (remaining <= 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [total]);

  return Math.ceil(left);
}

interface ErrorPanelProps {
  readonly error: FieldError;
}

function ErrorPanel({ error }: ErrorPanelProps) {
  const { t } = useTranslation("viewer");
  const { t: tErrors } = useTranslation("errors");
  const retry = useFieldStore((state) => state.retry);
  const waitS = useWait(error);

  return (
    <div role="alert" className={styles.alert}>
      <GlassPanel as="div" title={t("error.title")} icon="alert" className={styles.panel}>
        <p className={styles.message}>{tErrors(`code.${error.code}`)}</p>
        {error.retryable && waitS > 0 ? (
          <p className={styles.wait}>{tErrors("retryIn", { seconds: formatInteger(waitS) })}</p>
        ) : null}
        {error.retryable ? (
          <Button
            variant="primary"
            className={styles.retry}
            disabled={waitS > 0}
            disabledReason={t("disabled.retryWait")}
            onClick={() => void retry()}
          >
            {tErrors("retry")}
          </Button>
        ) : null}
      </GlassPanel>
    </div>
  );
}

/**
 * Error del campo: fallo el pedido, el flujo de eventos o el trabajo del
 * backend. La frase sale del namespace `errors` a partir del codigo. Si tiene
 * sentido reintentar hay un boton; con la cola llena (`queue_full`) el boton
 * espera lo que pidio el backend en `Retry-After`.
 */
export function FieldErrorNotice() {
  const error = useFieldStore((state) => state.error);
  if (error === null) return null;
  // Cada error es un objeto nuevo en el store: otro error arranca su propia cuenta.
  return <ErrorPanel key={`${error.code}:${error.retryAt ?? ""}`} error={error} />;
}
