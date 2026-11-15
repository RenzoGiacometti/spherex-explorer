import { useTranslation } from "react-i18next";
import { formatBand } from "@/lib/format";
import { useFieldStore } from "@/state/fieldStore";
import { useUrlState } from "@/state/urlState";
import { FieldErrorNotice } from "./FieldErrorNotice";
import styles from "./StageStatus.module.css";
import type { ViewerController } from "./useViewerController";

export interface StageStatusProps {
  readonly controller: ViewerController;
}

/**
 * Lo que se lee en la zona libre del visor cuando falta la imagen o algo fallo:
 * - en el centro, por que no hay imagen (todavia no llego, la epoca no tiene
 *   datos en la banda);
 * - el error del campo: en el centro si no hay imagen, abajo si la hay, para no
 *   tapar el centro.
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
  const { view, source, mode } = controller;

  let message: string | null = null;
  if (source === "none" && !hasError && view.missing !== null) {
    const bandName = formatBand(band);
    if (view.missing === "waiting") message = t("stage.waiting");
    else if (view.missing === "pending") message = t("stage.pending");
    else message = t(mode === "sum" ? "stage.emptyBand" : "stage.empty", { band: bandName });
  }

  const centered = source === "none";

  return (
    <>
      <div className={styles.center}>
        {message === null ? null : (
          <p className={styles.message} role="status" data-missing={view.missing}>
            {message}
          </p>
        )}
        {hasError && centered ? <FieldErrorNotice /> : null}
      </div>
      <div className={styles.bottom}>{hasError && !centered ? <FieldErrorNotice /> : null}</div>
    </>
  );
}
