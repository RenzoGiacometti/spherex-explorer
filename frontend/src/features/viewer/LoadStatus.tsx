import { useTranslation } from "react-i18next";
import { Button, ProgressBar, QualityNotice } from "@/components";
import { selectLoadProgress, selectQueuePosition } from "@/data/selectors";
import { useLanguage } from "@/i18n/useLanguage";
import { formatInteger, formatPercent } from "@/lib/format";
import { useFieldStore } from "@/state/fieldStore";
import styles from "./LoadStatus.module.css";

// Punto medio (U+00B7): separa la palabra del dato, como en el rotulo de imagen.
const SEPARATOR = String.fromCodePoint(0x00b7);

/**
 * Estado de la carga del campo (DESIGN.md, `progress-bar`): pidiendo, en cola
 * con su posicion, buscando exposiciones, bajando con recortes y porcentaje,
 * y al final campo completo o incompleto. Ocupa siempre su renglon, para que
 * la imagen no cambie de tamano al terminar la carga.
 *
 * Debajo avisa si alguna imagen no se pudo bajar del backend, con un boton
 * para reintentar esas descargas.
 */
export function LoadStatus() {
  const { t } = useTranslation("viewer");
  const language = useLanguage();
  const phase = useFieldStore((state) => state.phase);
  const status = useFieldStore((state) => state.meta?.status);
  const progress = useFieldStore(selectLoadProgress);
  const queuePosition = useFieldStore(selectQueuePosition);
  const failedDownloads = useFieldStore(
    (state) => Object.keys(state.planeErrors).length + (state.cube.status === "error" ? 1 : 0),
  );
  const retryDownloads = useFieldStore((state) => state.retryDownloads);

  if (phase === "idle") return null;

  const cutouts =
    progress !== null && progress.total > 0
      ? t("load.cutouts", {
          done: formatInteger(progress.done),
          total: formatInteger(progress.total),
          percent: formatPercent(progress.fraction, language),
        })
      : undefined;

  let content = null;
  if (phase === "error") {
    // El detalle del error y el boton de reintentar estan sobre la imagen. Si el
    // trabajo habia empezado, lo que llego sigue a la vista.
    content = (
      <p className={styles.summary}>
        <span className={styles.label}>
          {progress === null ? t("load.notLoaded") : t("load.interrupted")}
        </span>
      </p>
    );
  } else if (phase === "requesting" || progress === null) {
    content = <ProgressBar label={t("load.requesting")} value={null} />;
  } else if (phase === "loading") {
    switch (progress.phase) {
      case "queued":
        content = (
          <ProgressBar
            label={t("load.queued")}
            value={null}
            valueText={
              queuePosition === null
                ? undefined
                : t("load.queuePosition", { n: formatInteger(queuePosition) })
            }
          />
        );
        break;
      case "listing":
        content = <ProgressBar label={t("load.listing")} value={null} />;
        break;
      case "finishing":
        content = (
          <ProgressBar label={t("load.finishing")} value={progress.fraction} valueText={cutouts} />
        );
        break;
      default:
        content = (
          <ProgressBar
            label={t("load.downloading")}
            value={progress.fraction}
            valueText={cutouts}
          />
        );
    }
  } else {
    const partial = status === "partial";
    const detail = partial
      ? t("load.partialDetail", {
          failed: formatInteger(progress.cutoutsFailed),
          total: formatInteger(progress.total),
        })
      : t("load.readyDetail", { total: formatInteger(progress.total) });
    content = (
      <p className={styles.summary} role="status">
        <span className={styles.label}>{partial ? t("load.partial") : t("load.ready")}</span>{" "}
        <span className={styles.separator} aria-hidden="true">
          {SEPARATOR}
        </span>
        <span className={styles.detail}>{detail}</span>
      </p>
    );
  }

  return (
    <div className={styles.status}>
      {content}
      {failedDownloads > 0 ? (
        <div className={styles.downloads}>
          <QualityNotice>
            {t("load.downloadFailed", { n: formatInteger(failedDownloads) })}
          </QualityNotice>
          <Button onClick={retryDownloads}>{t("load.retryDownloads")}</Button>
        </div>
      ) : null}
    </div>
  );
}
