import { useTranslation } from "react-i18next";
import { QualityNotice } from "@/components";
import {
  Curtain,
  type CurtainSide,
  frameBandText,
  frameDateText,
  type JourneyFrame,
  OpticalCredit,
  type OpticalLayer,
  plateCredit,
  type TargetOffset,
} from "@/features/context";
import { useLanguage } from "@/i18n/useLanguage";
import { formatArcminutes } from "@/lib/format";
import styles from "./CurtainStage.module.css";
import type { ViewerController } from "./useViewerController";

// Punto medio (U+00B7): separa la banda de la fecha, como en el rotulo de imagen.
const SEPARATOR = String.fromCodePoint(0x00b7);

export interface CurtainStageProps {
  readonly controller: ViewerController;
}

/**
 * Modo `curtain`: la cortina visible/infrarrojo en la zona libre del visor. A
 * la izquierda del divisor, la placa optica del DSS; a la derecha, la imagen
 * de SPHEREx de la banda y la epoca que se ven (se eligen con los controles de
 * siempre). Debajo de la imagen va siempre el credito de la placa.
 *
 * El contraste y el estirado son los del panel Imagen. La cortina ocupa el
 * cuadrado mas grande que entra en la zona libre dejando lugar al credito.
 */
export function CurtainStage({ controller }: CurtainStageProps) {
  const { t } = useTranslation("curtain");
  const language = useLanguage();
  const { curtain, contrast, stretch } = controller;
  const { plate, visible, infrared, shape } = curtain;
  if (plate === null || shape === null) return null;

  const side = (frame: JourneyFrame | null, dated: boolean): CurtainSide => ({
    image: frame?.image ?? null,
    name: frame?.mission ?? "",
    detail:
      frame === null
        ? ""
        : `${frameBandText(frame, language)} ${SEPARATOR} ${
            dated ? frameDateText(frame) : t("unreliableDate")
          }`,
  });

  return (
    <div className={styles.box} data-curtain={plate.key}>
      <Curtain
        className={styles.curtain}
        left={side(visible, plate.date_reliable)}
        right={side(infrared, true)}
        shape={shape}
        position={curtain.position}
        onPositionChange={curtain.setPosition}
        contrast={contrast}
        stretch={stretch}
      />
      <OpticalCredit className={styles.credit} credit={plateCredit(plate)} />
    </div>
  );
}

export interface PlateCaptionProps {
  /** Placa del DSS que se esta viendo en el viaje; null en una capa de 2MASS o de WISE. */
  readonly plate: OpticalLayer | null;
  /** Donde estaba el objeto si en esa fecha caia fuera del campo; null si estaba adentro. */
  readonly outside: TargetOffset | null;
  /** Nombre del objeto del campo, si se conoce. */
  readonly name: string | null;
  /**
   * La capa se guardo sin la posicion de un objeto que se mueve (UGPS J0722):
   * se dice, para que no se busque al objeto donde no se sabe si esta.
   */
  readonly noPosition?: boolean;
}

/**
 * Pie de una placa del DSS en el viaje entre misiones. Va debajo de la imagen
 * mientras se la ve: el credito de la placa, siempre, y, si en esa fecha el
 * objeto del campo todavia no habia entrado en el campo (Barnard, en 1950 y en
 * 1991), el aviso que lo dice, para que el cuadro no quede sin su objeto y sin
 * explicacion.
 */
export function PlateCaption({ plate, outside, name, noPosition = false }: PlateCaptionProps) {
  const { t } = useTranslation("context");
  const language = useLanguage();
  return (
    <div className={styles.caption} data-plate={plate?.key}>
      {noPosition ? (
        <div className={styles.outside} role="status" data-journey-no-position="">
          <QualityNotice>
            {t("journey.noPosition", { name: name ?? t("journey.outsideObject") })}
          </QualityNotice>
        </div>
      ) : null}
      {outside === null || plate === null ? null : (
        <div className={styles.outside} role="status" data-journey-outside="">
          <QualityNotice>
            {t("journey.outside", {
              year: plate.date.slice(0, 4),
              name: name ?? t("journey.outsideObject"),
              distance: formatArcminutes(outside.arcmin / 60, language),
              direction: outside.direction === null ? "" : t(`direction.${outside.direction}`),
            })}
          </QualityNotice>
        </div>
      )}
      {plate === null ? null : (
        <OpticalCredit className={styles.credit} credit={plateCredit(plate)} />
      )}
    </div>
  );
}
