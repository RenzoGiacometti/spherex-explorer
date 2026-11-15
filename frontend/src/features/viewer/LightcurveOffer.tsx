import { useTranslation } from "react-i18next";
import { Button, GlassPanel } from "@/components";
import type { ChallengeVariable } from "./challengeVariables";
import styles from "./LightcurveOffer.module.css";

export interface LightcurveOfferProps {
  /** La variable del desafio de este campo (challengeVariables.ts). */
  readonly variable: ChallengeVariable;
  /** Abre el panel del objeto en la pestana de la curva de luz. */
  readonly onOpen: () => void;
  /**
   * `panel`: un panel de la columna derecha, con una frase. `compact`: solo el
   * boton, a lo ancho, para ponerlo con los controles del celular.
   */
  readonly variant?: "panel" | "compact";
}

/**
 * Oferta de la curva de luz en el campo de una estrella variable del desafio:
 * se ve apenas se abre el campo y lleva directo a la pestana "Curva de luz" del
 * objeto, sin tener que hacer clic sobre el.
 */
export function LightcurveOffer({ variable, onOpen, variant = "panel" }: LightcurveOfferProps) {
  const { t } = useTranslation("viewer");

  if (variant === "compact") {
    return (
      <div className={styles.compact} data-lightcurve-offer={variable.name}>
        <Button
          icon="blink"
          onClick={(event) => {
            // El boton queda tapado por la hoja que abre: suelta el foco, y el panel lo toma.
            event.currentTarget.blur();
            onOpen();
          }}
        >
          {t("offer.actionNamed", { name: variable.name })}
        </Button>
      </div>
    );
  }
  return (
    <div data-lightcurve-offer={variable.name}>
      <GlassPanel title={t("offer.title")} icon="blink">
        <p className={styles.body}>{t("offer.body", { name: variable.name })}</p>
        <Button className={styles.action} icon="blink" onClick={onOpen}>
          {t("offer.action")}
        </Button>
      </GlassPanel>
    </div>
  );
}
