import { type MouseEvent, useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components";
import { BASE_FREQUENCY_HZ, OCTAVES, SOUND_DURATION_S } from "@/features/spectrum/sonify";
import { formatInteger } from "@/lib/format";
import styles from "./AboutDialog.module.css";

/** Fuentes de datos, en el orden en que se acreditan. Sus textos: `about:data.<id>`. */
const DATA_CREDITS = [
  "spherex",
  "surveys",
  "gaia",
  "dss",
  "sky",
  "constellations",
  "names",
  "code",
] as const;

export interface AboutDialogProps {
  /** Se llama cuando el dialogo se cerro: con su boton, con Escape o tocando afuera. */
  readonly onClose: () => void;
}

/**
 * "Acerca de": que es la aplicacion, la declaracion de uso de IA, los creditos
 * de los datos con sus licencias y la aclaracion sobre el sonido del espectro.
 * Todo en texto: no lleva logos de NASA ni de la mision.
 *
 * Es un `<dialog>` modal nativo: el navegador atrapa el foco adentro, Escape
 * lo cierra y, al cerrar, el foco vuelve al control que lo abrio. Se monta
 * solo mientras esta abierto.
 */
export function AboutDialog({ onClose }: AboutDialogProps) {
  const { t } = useTranslation("about");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null || dialog.open) return;
    // Donde `showModal` no existe queda abierto sin ser modal: se lee y se cierra igual.
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);

  function close(): void {
    const dialog = dialogRef.current;
    // `close()` dispara el evento `close`, que es el que avisa (y devuelve el foco).
    if (dialog?.open && typeof dialog.close === "function") dialog.close();
    else onClose();
  }

  /** Un clic en el fondo oscuro cae sobre el propio `<dialog>`, no sobre su contenido. */
  function handleBackdrop(event: MouseEvent<HTMLDialogElement>): void {
    if (event.target === event.currentTarget) close();
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: el teclado ya cierra con Escape, que el dialogo modal maneja solo.
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={handleBackdrop}
    >
      <div className={styles.content}>
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {t("title")}
          </h2>
          <IconButton icon="close" size="sm" label={t("close")} onClick={close} />
        </header>

        <section className={styles.section}>
          <h3 className={styles.heading}>{t("what.title")}</h3>
          <p>{t("what.body")}</p>
          <p>{t("what.origin")}</p>
        </section>

        {/* La declaracion de uso de IA va destacada: borde fuerte y texto en blanco pleno. */}
        <section className={styles.disclosure}>
          <h3 className={styles.heading}>{t("ai.title")}</h3>
          <p>{t("ai.body")}</p>
        </section>

        <section className={styles.section}>
          <h3 className={styles.heading}>{t("data.title")}</h3>
          <dl className={styles.credits}>
            {DATA_CREDITS.map((id) => (
              <div key={id} className={styles.credit}>
                <dt className={styles.creditName}>{t(`data.${id}.name`)}</dt>
                <dd className={styles.creditBody}>{t(`data.${id}.body`)}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className={styles.section}>
          <h3 className={styles.heading}>{t("sound.title")}</h3>
          <p>
            {t("sound.body", {
              seconds: formatInteger(SOUND_DURATION_S),
              octaves: formatInteger(OCTAVES),
              hz: formatInteger(BASE_FREQUENCY_HZ),
            })}
          </p>
        </section>
      </div>
    </dialog>
  );
}
