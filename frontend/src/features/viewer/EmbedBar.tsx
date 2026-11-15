import { useTranslation } from "react-i18next";
import { ButtonLink, GlassPanel, Transport } from "@/components";
import { selectTimeline } from "@/data/selectors";
import { formatInteger } from "@/lib/format";
import { useFieldStore } from "@/state/fieldStore";
import { serializeUrlState, useUrlState } from "@/state/urlState";
import styles from "./EmbedBar.module.css";
import { HoldButton } from "./HoldButton";
import { LoadStatus } from "./LoadStatus";
import type { ViewerController } from "./useViewerController";

export interface EmbedBarProps {
  readonly controller: ViewerController;
}

/**
 * Lo unico que acompana a la imagen en el modo `embed` (SPEC.md, seccion 3.3):
 * el transporte para recorrer las epocas, cual se esta viendo, el avance si el
 * campo todavia carga, y un enlace que abre el visor completo con la misma
 * vista. Pensado para un `iframe`: el enlace abre otra pestana, para no
 * sacar de su lugar a la pagina que lo aloja.
 *
 * La banda, el modo y la epoca salen de la URL del `iframe`. En el modo
 * "mantener apretado" va tambien su boton, porque sin el no se puede comparar.
 */
export function EmbedBar({ controller }: EmbedBarProps) {
  const { t } = useTranslation("viewer");
  const url = useUrlState();
  const timeline = useFieldStore(selectTimeline);
  const phase = useFieldStore((state) => state.phase);
  const { view, playing, canPlay, mode } = controller;

  const shown = timeline.find((item) => item.epoch.epoch === view.displayed)?.epoch;
  // La misma vista, sin `embed`.
  const fullHref = `${window.location.pathname}${serializeUrlState({ ...url, embed: false })}`;
  const loading = phase === "requesting" || phase === "loading";

  return (
    <GlassPanel as="footer" label={t("panel.timeline")} className={styles.bar}>
      <div className={styles.row}>
        <Transport
          playing={playing}
          onPlayingChange={controller.setPlaying}
          onPrevious={() => controller.step(-1)}
          onNext={() => controller.step(1)}
          disabled={timeline.length === 0}
          playDisabled={!canPlay}
          disabledReason={t("disabled.transport")}
          playDisabledReason={t(mode === "blink" ? "disabled.play.epochs" : "disabled.play.mode")}
        />
        <p className={styles.position}>
          <span className={styles.positionLabel}>
            {shown
              ? t("timeline.position", {
                  n: formatInteger(shown.epoch),
                  total: formatInteger(timeline.length),
                })
              : t("timeline.none")}
          </span>
          {shown ? (
            <span className={styles.positionDate}>
              {t("timeline.dateRange", { start: shown.start, end: shown.end })}
            </span>
          ) : null}
        </p>
        {mode === "hold" ? <HoldButton controller={controller} className={styles.hold} /> : null}
        <ButtonLink
          className={styles.open}
          href={fullHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("embed.open")}
        </ButtonLink>
      </div>
      {loading ? <LoadStatus /> : null}
    </GlassPanel>
  );
}
