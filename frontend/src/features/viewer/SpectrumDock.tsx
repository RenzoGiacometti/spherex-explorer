import { type KeyboardEvent, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button, GlassPanel, IconButton, ProgressBar, QualityNotice } from "@/components";
import { SpectrumPanel } from "@/features/spectrum";
import { useLanguage } from "@/i18n/useLanguage";
import { formatDec, formatRa } from "@/lib/format";
import styles from "./SpectrumDock.module.css";
import type { SpectrumController } from "./useSpectrum";

export interface SpectrumDockProps {
  readonly spectrum: SpectrumController;
}

/**
 * Lugar del espectro en el visor. Se abre con un clic sobre la imagen
 * (useSpectrum.ts) y pasa por tres estados:
 *
 * - cargando: medir cientos de recortes lleva segundos, y se dice;
 * - error: la frase sale del namespace `errors` a partir del codigo, con un
 *   boton para reintentar si tiene sentido;
 * - listo: el panel de espectro (features/spectrum), con sus avisos arriba.
 *
 * En los tres hay un boton para cerrarlo, y Escape tambien lo cierra. Cerrado
 * no dibuja nada.
 */
export function SpectrumDock({ spectrum }: SpectrumDockProps) {
  const { t } = useTranslation("spectrum");
  const { t: tErrors } = useTranslation("errors");
  const language = useLanguage();
  const { state, close, retry } = spectrum;
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Cada pedido lo trae a la vista: en una ventana angosta queda debajo de la imagen.
  const point = state.status === "idle" ? null : state.point;
  useEffect(() => {
    if (point === null) return;
    const root = rootRef.current;
    if (root !== null && typeof root.scrollIntoView === "function") {
      root.scrollIntoView({ block: "nearest" });
    }
  }, [point]);

  if (state.status === "idle") return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  }

  let content = null;
  if (state.status === "ready") {
    content = (
      <SpectrumPanel
        spectrum={state.spectrum}
        name={state.point.name ?? undefined}
        onClose={close}
      />
    );
  } else {
    const { query, name } = state.point;
    content = (
      <GlassPanel title={t("panel.title")} icon="spectrum" padding="roomy">
        <div className={styles.top}>
          <div className={styles.heading}>
            <p className={styles.name}>{name ?? t("panel.unnamed")}</p>
            <p className={styles.position}>
              {`${formatRa(query.ra, { language })} ${formatDec(query.dec, { language })}`}
            </p>
          </div>
          <IconButton icon="close" size="sm" label={t("panel.close")} onClick={close} />
        </div>
        {state.status === "loading" ? (
          <>
            <ProgressBar label={t("request.loading")} value={null} />
            <p className={styles.note}>{t("request.loadingNote")}</p>
          </>
        ) : (
          <div role="alert" className={styles.error}>
            <QualityNotice as="div">{t("request.errorTitle")}</QualityNotice>
            <p className={styles.note}>{tErrors(`code.${state.code}`)}</p>
            {state.retryable ? (
              <Button className={styles.retry} onClick={retry}>
                {tErrors("retry")}
              </Button>
            ) : null}
          </div>
        )}
      </GlassPanel>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: solo escucha Escape de los controles de adentro
    <div
      ref={rootRef}
      className={styles.dock}
      data-spectrum={state.status}
      onKeyDown={handleKeyDown}
    >
      {content}
    </div>
  );
}
