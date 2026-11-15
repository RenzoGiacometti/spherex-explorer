import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button, ControlHeader, QualityNotice, Toggle } from "@/components";
import a11y from "@/components/a11y.module.css";
import { formatInteger } from "@/lib/format";
import styles from "./FlagsControl.module.css";
import type { FlagLayer } from "./useFlagLayer";

export interface FlagsControlProps {
  readonly layer: FlagLayer;
}

/** Muestra de como se ve un flag sobre la imagen: con la trama o sin ella. */
function Swatch({ hatched }: { readonly hatched: boolean }) {
  return (
    <svg
      className={styles.swatch}
      width={12}
      height={12}
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
      data-hatched={hatched ? "true" : "false"}
    >
      <rect className={styles.swatchFill} x="0" y="0" width="12" height="12" />
      {hatched ? (
        <path
          className={styles.swatchLines}
          d="M-1 3L3 -1M-1 7L7 -1M-1 11L11 -1M1 13L13 1M5 13L13 5M9 13L13 9"
        />
      ) : null}
      <rect className={styles.swatchBorder} x="0.5" y="0.5" width="11" height="11" />
    </svg>
  );
}

/**
 * Capa de flags (DESIGN.md, "Capa de flags"): el conmutador que la prende y,
 * prendida, la lista de flags presentes en la imagen que se ve, con su nombre,
 * su descripcion y la cantidad de pixeles. La trama cubre los que el
 * procesamiento descarta (`masked`); los demas se listan sin trama.
 *
 * El nombre de cada flag sale del encabezado de los archivos de SPHEREx: es un
 * dato y no se traduce. La descripcion del encabezado viene en ingles; como los
 * nombres son fijos, se muestra la de la tabla `flags.description` del idioma
 * (en ingles, la misma del encabezado) y, si el nombre no esta en la tabla, la
 * que trae el archivo.
 */
export function FlagsControl({ layer }: FlagsControlProps) {
  const { t } = useTranslation("viewer");
  const { status, present, epochs } = layer;
  const descriptions = t("flags.description", { returnObjects: true }) as Readonly<
    Record<string, string | undefined>
  >;

  // Lo que pasa con la capa, en una frase. Con la lista a la vista no hace falta.
  let message = null;
  if (status === "idle") {
    message = <p className={styles.note}>{t("flags.idle")}</p>;
  } else if (status === "loading") {
    message = <p className={styles.note}>{t("flags.loading")}</p>;
  } else if (status === "error") {
    message = (
      <div className={styles.failure}>
        <QualityNotice>{t("flags.error")}</QualityNotice>
        <Button onClick={layer.retry}>{t("flags.retry")}</Button>
      </div>
    );
  } else if (status === "ready" && present.length === 0) {
    message = <p className={styles.note}>{t("flags.none")}</p>;
  }

  const listed = status === "ready" && present.length > 0;

  // Al prender la capa la lista aparece debajo del conmutador y puede quedar
  // fuera de la columna, que se desplaza: se la trae a la vista esa vez. Mas
  // tarde, cuando cambia con cada epoca, no se toca el desplazamiento.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const revealRef = useRef(false);
  useEffect(() => {
    if (!listed || !revealRef.current) return;
    revealRef.current = false;
    rootRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [listed]);

  return (
    <div ref={rootRef} className={styles.flags} data-flags={status}>
      <Toggle
        label={t("flags.toggle")}
        checked={layer.on}
        onChange={(next) => {
          revealRef.current = next;
          layer.setOn(next);
        }}
      />
      {/*
       * Solo la frase es una region viva: la lista cambia con cada epoca del
       * reproductor y anunciarla entera cada vez no deja escuchar otra cosa.
       */}
      <div className={styles.body} role="status">
        {message}
      </div>
      {listed ? (
        <div className={styles.body}>
          <ControlHeader
            label={t("flags.list")}
            value={t(epochs.length === 1 ? "flags.epochs.one" : "flags.epochs.other", {
              epochs: epochs.map(formatInteger).join(", "),
            })}
          />
          <ul className={styles.list} aria-label={t("flags.list")}>
            {present.map(({ flag, pixels }) => (
              <li key={flag.bit} className={styles.item} data-flag={flag.name}>
                <Swatch hatched={flag.masked} />
                <span className={styles.name}>{flag.name}</span>
                <span className={styles.pixels}>
                  <span className={a11y.visuallyHidden}>
                    {flag.masked ? t("flags.hatched") : t("flags.plain")}{" "}
                  </span>
                  {t("flags.pixels", { n: formatInteger(pixels) })}
                </span>
                <span className={styles.description}>
                  {descriptions[flag.name] ?? flag.description}
                </span>
              </li>
            ))}
          </ul>
          <p className={styles.note}>{t("flags.hint")}</p>
        </div>
      ) : null}
    </div>
  );
}
