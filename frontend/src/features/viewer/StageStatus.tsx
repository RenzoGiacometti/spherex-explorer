import { useTranslation } from "react-i18next";
import { GlassPanel } from "@/components";
import { formatBand } from "@/lib/format";
import { useFieldStore } from "@/state/fieldStore";
import { useUrlState } from "@/state/urlState";
import { FieldErrorNotice } from "./FieldErrorNotice";
import styles from "./StageStatus.module.css";
import { useSlowListing } from "./useSlowListing";
import type { ViewerController } from "./useViewerController";

export interface StageStatusProps {
  readonly controller: ViewerController;
}

/**
 * Lo que se lee en la zona libre del visor cuando falta la imagen o algo fallo:
 * - en el centro, por que no hay imagen (todavia no llego, la epoca no tiene
 *   datos en la banda);
 * - el error del campo: en el centro si no hay imagen, abajo si la hay, para no
 *   tapar el centro;
 * - el aviso de que el archivo de datos responde lento y se sigue intentando
 *   (useSlowListing.ts), que no es un error: en el centro si no hay imagen, y
 *   abajo si ya se ve la vista provisoria, que sigue a la vista.
 *
 * El rotulo de la imagen (plano provisorio, vista de otro relevamiento) va con
 * las anotaciones, pegado al borde de la imagen (ImageAnnotations.tsx).
 *
 * Nada de esto recibe el puntero, salvo el panel de error: arrastrar encima
 * sigue desplazando la imagen.
 */
export function StageStatus({ controller }: StageStatusProps) {
  const { t } = useTranslation("viewer");
  const band = useUrlState((state) => state.band);
  const hasError = useFieldStore((state) => state.error !== null);
  // `loading`: el backend esta armando el campo (en cola, listando o bajando recortes).
  const building = useFieldStore((state) => state.phase === "loading");
  const { view, source, mode } = controller;
  const slow = useSlowListing().slow && !hasError;

  let message: string | null = null;
  if (slow) {
    message = source === "none" ? t("stage.slowArchive") : null;
  } else if (source === "none" && !hasError && view.missing !== null) {
    const bandName = formatBand(band);
    if (view.missing === "waiting") message = t(building ? "stage.building" : "stage.waiting");
    else if (view.missing === "pending") message = t("stage.pending");
    else message = t(mode === "sum" ? "stage.emptyBand" : "stage.empty", { band: bandName });
  }

  const centered = source === "none";

  return (
    <>
      <div className={styles.center}>
        {message === null ? null : (
          <p
            className={styles.message}
            role="status"
            data-missing={slow ? undefined : view.missing}
            data-slow-archive={slow ? "true" : undefined}
          >
            {message}
          </p>
        )}
        {hasError && centered ? <FieldErrorNotice /> : null}
      </div>
      <div className={styles.bottom}>
        {hasError && !centered ? <FieldErrorNotice /> : null}
        {slow && !centered ? (
          <GlassPanel as="div" className={styles.notice}>
            <p role="status" data-slow-archive="true">
              {t("stage.slowArchive")}
            </p>
          </GlassPanel>
        ) : null}
      </div>
    </>
  );
}
