import { useTranslation } from "react-i18next";
import { Button, classNames } from "@/components";
import a11y from "@/components/a11y.module.css";
import { useUrlState } from "@/state/urlState";
import styles from "./guide.module.css";
import { startTour } from "./guideStore";
import { TOUR_START } from "./tour";

export interface GuideLauncherProps {
  readonly className?: string | undefined;
  /** Rotulo de una palabra, para el riel de accesos de la entrada. */
  readonly compact?: boolean | undefined;
}

/**
 * Boton de la entrada que inicia el recorrido guiado: abre el campo de
 * WISE 0855 en el visor y muestra el primer paso. Es una accion secundaria
 * (`button-ghost`): el boton relleno de la entrada es Buscar.
 *
 * Con `embed=1` no se ofrece: esa vista no tiene los controles del recorrido.
 */
export function GuideLauncher({ className, compact = false }: GuideLauncherProps) {
  const { t } = useTranslation("guide");
  const embed = useUrlState((state) => state.embed);
  if (embed || TOUR_START === null) return null;
  return (
    // A la vista va el rotulo corto, para que los accesos de la entrada entren
    // en una linea; el nombre completo sigue siendo el nombre accesible, la
    // ayuda al pasar el cursor y el texto del boton en el documento.
    <Button
      icon="target"
      className={classNames(styles.launcher, className)}
      aria-label={t("launcher.start")}
      title={t("launcher.start")}
      onClick={startTour}
    >
      {t(compact ? "launcher.rail" : "launcher.short")}
      <span className={a11y.visuallyHidden}>{t("launcher.detail")}</span>
    </Button>
  );
}
