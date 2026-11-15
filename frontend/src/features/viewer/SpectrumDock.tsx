import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button, GlassPanel, Icon, IconButton, ProgressBar, QualityNotice } from "@/components";
import { bandHasCurve, LightcurvePanel } from "@/features/lightcurve";
import { SpectrumPanel } from "@/features/spectrum";
import { useLanguage } from "@/i18n/useLanguage";
import { formatDec, formatRa } from "@/lib/format";
import styles from "./SpectrumDock.module.css";
import { useLightcurve } from "./useLightcurve";
import type { SpectrumController } from "./useSpectrum";

/** Pestanas del panel de la fuente elegida. */
export type SourceTab = "spectrum" | "lightcurve";

const TABS: readonly SourceTab[] = ["spectrum", "lightcurve"];

export interface SpectrumDockProps {
  readonly spectrum: SpectrumController;
  /** Pestana que se ve. */
  readonly tab: SourceTab;
  readonly onTabChange: (tab: SourceTab) => void;
  /** Banda que se ve en el visor: con ella abre la curva de luz, si ahi hay curva. */
  readonly band?: number | undefined;
  /** Lo que va arriba de las pestanas: la ficha del objeto (features/context, `ObjectCard`). */
  readonly header?: ReactNode;
}

/**
 * Panel de la fuente elegida en el visor. Se abre con un clic sobre la imagen
 * (useSpectrum.ts). Arriba va la ficha del objeto (`header`), si el campo tiene
 * contexto, y debajo dos pestanas, que hablan de la misma fuente:
 *
 * Espectro, que pasa por tres estados:
 *
 * - cargando: medir cientos de recortes lleva segundos, y se dice;
 * - error: la frase sale del namespace `errors` a partir del codigo, con un
 *   boton para reintentar si tiene sentido;
 * - listo: el panel de espectro (features/spectrum), con sus avisos arriba. Si
 *   el campo solo tiene espectros guardados y el punto no esta cerca de
 *   ninguno, el panel lo explica y ofrece pedir la fuente mas cercana.
 *
 * Curva de luz (features/lightcurve), que se pide recien al abrir la pestana
 * (useLightcurve.ts) con la misma consulta que el espectro. Que no haya curva
 * no es un error: se dice "sin curva" con su motivo, en el mismo recuadro que
 * los avisos destacados. Si la curva viene de las alas de una fuente saturada,
 * el panel avisa arriba que es variacion relativa.
 *
 * Las pestanas se recorren con las flechas, Inicio y Fin. En todos los estados
 * hay un boton para cerrar el panel, y Escape tambien lo cierra. Cerrado no
 * dibuja nada.
 */
export function SpectrumDock({ spectrum, tab, onTabChange, band, header }: SpectrumDockProps) {
  const { t } = useTranslation("spectrum");
  const { t: tCurve } = useTranslation("lightcurve");
  const { t: tViewer } = useTranslation("viewer");
  const { t: tErrors } = useTranslation("errors");
  const language = useLanguage();
  const { state, close, retry, requestPosition } = spectrum;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Partial<Record<SourceTab, HTMLButtonElement | null>>>({});
  const baseId = useId();

  // Cada pedido lo trae a la vista: en una ventana angosta queda debajo de la imagen.
  const point = state.status === "idle" ? null : state.point;
  useEffect(() => {
    if (point === null) return;
    const root = rootRef.current;
    if (root !== null && typeof root.scrollIntoView === "function") {
      root.scrollIntoView({ block: "nearest" });
    }
    // Si lo que abrio el panel ya no esta (el boton de la oferta de la curva de
    // luz se va al abrirlo), el foco no queda perdido: pasa a la pestana elegida.
    if (document.activeElement === null || document.activeElement === document.body) {
      root
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus({ preventScroll: true });
    }
  }, [point]);

  // La misma consulta que el espectro: las dos pestanas hablan de la misma fuente.
  const lightcurve = useLightcurve(point?.query ?? null, tab === "lightcurve");

  if (state.status === "idle") return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    const index = TABS.indexOf(tab);
    const last = TABS.length - 1;
    let next: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else return;
    event.preventDefault();
    const target = TABS[next] ?? tab;
    onTabChange(target);
    tabRefs.current[target]?.focus();
  }

  const { query, name } = state.point;

  /** Panel de un estado sin documento: el nombre, la posicion pedida y el boton de cerrar. */
  function pending(kind: SourceTab, children: ReactNode): ReactNode {
    const texts =
      kind === "spectrum"
        ? { title: t("panel.title"), unnamed: t("panel.unnamed"), close: t("panel.close") }
        : {
            title: tCurve("panel.title"),
            unnamed: tCurve("panel.unnamed"),
            close: tCurve("panel.close"),
          };
    return (
      <GlassPanel
        title={texts.title}
        icon={kind === "spectrum" ? "spectrum" : "blink"}
        padding="roomy"
      >
        <div className={styles.top}>
          <div className={styles.heading}>
            <p className={styles.name}>{name ?? texts.unnamed}</p>
            <p className={styles.position}>
              {`${formatRa(query.ra, { language })} ${formatDec(query.dec, { language })}`}
            </p>
          </div>
          <IconButton icon="close" size="sm" label={texts.close} onClick={close} />
        </div>
        {children}
      </GlassPanel>
    );
  }

  let content: ReactNode;
  let lightcurveStatus: string | undefined;
  if (tab === "lightcurve") {
    const request = lightcurve.state;
    lightcurveStatus = request.status;
    if (request.status === "ready") {
      const document = request.lightcurve;
      content = (
        <LightcurvePanel
          lightcurve={document}
          name={name ?? undefined}
          // La banda del visor, si ahi hay curva; si no, la primera que la tenga.
          initialBand={band !== undefined && bandHasCurve(document, band) ? band : undefined}
          onClose={close}
        />
      );
    } else if (request.status === "none") {
      content = pending(
        "lightcurve",
        // Sin curva guardada para este punto: se dice con su motivo, no como un error.
        <div className={styles.prominent} data-lightcurve-notices="prominent">
          <QualityNotice as="div">
            <span className={styles.tag}>{tCurve("noCurve.all")}</span> {tCurve("noCurve.notSaved")}
          </QualityNotice>
        </div>,
      );
    } else if (request.status === "error") {
      content = pending(
        "lightcurve",
        <div role="alert" className={styles.error}>
          <QualityNotice as="div">{tCurve("request.errorTitle")}</QualityNotice>
          <p className={styles.note}>{tErrors(`code.${request.code}`)}</p>
          {request.retryable ? (
            <Button className={styles.retry} onClick={lightcurve.retry}>
              {tErrors("retry")}
            </Button>
          ) : null}
        </div>,
      );
    } else {
      content = pending(
        "lightcurve",
        <ProgressBar label={tCurve("request.loading")} value={null} />,
      );
    }
  } else if (state.status === "ready") {
    content = (
      <SpectrumPanel
        spectrum={state.spectrum}
        name={name ?? undefined}
        onClose={close}
        onRequestPosition={requestPosition}
      />
    );
  } else if (state.status === "loading") {
    content = pending(
      "spectrum",
      <>
        <ProgressBar label={t("request.loading")} value={null} />
        <p className={styles.note}>{t("request.loadingNote")}</p>
      </>,
    );
  } else {
    content = pending(
      "spectrum",
      <div role="alert" className={styles.error}>
        <QualityNotice as="div">{t("request.errorTitle")}</QualityNotice>
        <p className={styles.note}>{tErrors(`code.${state.code}`)}</p>
        {state.retryable ? (
          <Button className={styles.retry} onClick={retry}>
            {tErrors("retry")}
          </Button>
        ) : null}
      </div>,
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: solo escucha Escape de los controles de adentro
    <div
      ref={rootRef}
      className={styles.dock}
      data-spectrum={state.status}
      data-source-tab={tab}
      data-lightcurve={lightcurveStatus}
      onKeyDown={handleKeyDown}
    >
      {header === undefined || header === null ? null : (
        <div className={styles.header} data-source-card="">
          {header}
        </div>
      )}
      <div className={styles.tabs} role="tablist" aria-label={tViewer("source.tabs")}>
        {TABS.map((id) => (
          <button
            key={id}
            ref={(element) => {
              tabRefs.current[id] = element;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${id}`}
            className={styles.tab}
            aria-selected={tab === id}
            aria-controls={`${baseId}-panel`}
            tabIndex={tab === id ? 0 : -1}
            data-source-tab={id}
            onClick={() => onTabChange(id)}
            onKeyDown={handleTabKeyDown}
          >
            <Icon name={id === "spectrum" ? "spectrum" : "blink"} size={18} />
            <span>{tViewer(`source.${id}`)}</span>
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${tab}`}
        className={styles.panel}
      >
        {content}
      </div>
    </div>
  );
}
