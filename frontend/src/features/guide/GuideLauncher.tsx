import { useTranslation } from "react-i18next";
import { Button, classNames } from "@/components";
import { useUrlState } from "@/state/urlState";
import styles from "./guide.module.css";
import { startTour } from "./guideStore";
import { TOUR_START } from "./tour";

export interface GuideLauncherProps {
  readonly className?: string | undefined;
}

/**
 * Boton de la entrada que inicia el recorrido guiado: abre el campo de
 * WISE 0855 en el visor y muestra el primer paso. Es una accion secundaria
 * (`button-ghost`): el boton relleno de la entrada es Buscar.
 *
 * Con `embed=1` no se ofrece: esa vista no tiene los controles del recorrido.
 */
export function GuideLauncher({ className }: GuideLauncherProps) {
  const { t } = useTranslation("guide");
  const embed = useUrlState((state) => state.embed);
  if (embed || TOUR_START === null) return null;
  return (
    <Button icon="target" className={classNames(styles.launcher, className)} onClick={startTour}>
      {t("launcher.start")}
    </Button>
  );
}
