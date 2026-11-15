import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Icon,
  LanguageSelector,
  QuickLink,
  QuickLinkList,
  SearchField,
} from "@/components";
import type { NameResolver } from "@/data/nameResolver";
import { useLanguage } from "@/i18n/useLanguage";
import { formatDec, formatRa } from "@/lib/format";
import { DEFAULT_URL_STATE, useUrlState } from "@/state/urlState";
import { DEFAULT_FOV, type SkyView } from "./SkyScene";
import { type SkyMarker, SkySphere, type SkySphereHandle, type SkySphereStatus } from "./SkySphere";
import styles from "./SpherePage.module.css";
import { clamp } from "./skyMath";
import {
  type FieldUrlPatch,
  pickRandomField,
  SEARCH_EXAMPLE,
  SKY_TARGETS,
  type SkyTarget,
  targetUrlPatch,
  viewerHref,
} from "./targets";
import { useSphereTexts } from "./texts";
import { type FoundPlace, useSphereSearch } from "./useSphereSearch";

/**
 * Vista al entrar: el centro galactico abajo, la Via Lactea cruzando la
 * pantalla y Barnard's Star cerca del centro.
 */
const INITIAL_VIEW: SkyView = { ra: 272, dec: -6, fov: DEFAULT_FOV };

/** Deriva del cielo hasta la primera interaccion, en grados por segundo. */
const DRIFT_RATE = 0.5;

/** Campo de vision al que llega el acercamiento antes de abrir el visor, en grados. */
const ZOOM_FOV = 14;

/** Si despues de abrir un campo la pantalla sigue montada, vuelve a su estado normal. */
const RESTORE_DELAY_MS = 1500;

/** Opacidad del fundido a negro segun el avance del vuelo: ocupa el ultimo tramo. */
function fadeAt(progress: number): number {
  return clamp((progress - 0.55) / 0.45, 0, 1) ** 2;
}

export interface SpherePageProps {
  /** Resolucion de nombres; por defecto la compartida (src/data/nameResolver.ts). */
  readonly resolver?: NameResolver | undefined;
  /**
   * Abre un campo en el visor. Por defecto escribe el campo en la URL, y
   * App.tsx muestra el visor. La pagina de prueba pasa la suya.
   */
  readonly onOpenField?: ((patch: FieldUrlPatch) => void) | undefined;
  readonly initialView?: SkyView | undefined;
  /** Grados por segundo de la deriva inicial; 0 la apaga. */
  readonly driftRate?: number | undefined;
  /** Marcas adicionales sobre el cielo (pagina de prueba). */
  readonly extraMarkers?: readonly SkyMarker[] | undefined;
  /** Fuente de azar de "Lugar al azar"; por defecto Math.random. */
  readonly random?: (() => number) | undefined;
}

/**
 * Pantalla de entrada con la esfera celeste (SPEC.md, Etapa 4): el cielo a
 * pantalla completa, los cinco objetos de prueba marcados, el buscador y el
 * boton "Lugar al azar". Elegir un lugar acerca la camara al punto y abre su
 * campo en el visor.
 */
export function SpherePage({
  resolver,
  onOpenField,
  initialView,
  driftRate,
  extraMarkers,
  random,
}: SpherePageProps) {
  const t = useSphereTexts();
  const { t: tCommon } = useTranslation("common");
  const { t: tErrors } = useTranslation("errors");
  const language = useLanguage();

  const urlLanguage = useUrlState((state) => state.lang);
  const embed = useUrlState((state) => state.embed);
  const updateUrl = useUrlState((state) => state.update);

  const sphereRef = useRef<SkySphereHandle>(null);
  const fadeRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const openingRef = useRef(false);
  const restoreTimerRef = useRef<number | null>(null);
  const lastRandomRef = useRef<string | null>(null);

  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [sphereStatus, setSphereStatus] = useState<SkySphereStatus>("loading");
  const search = useSphereSearch(resolver);
  const { status } = search;

  useEffect(
    () => () => {
      if (restoreTimerRef.current !== null) window.clearTimeout(restoreTimerRef.current);
    },
    [],
  );

  const setFade = useCallback((opacity: number) => {
    if (fadeRef.current !== null) fadeRef.current.style.opacity = String(opacity);
  }, []);

  /** Acerca la camara al lugar y abre su campo. Un arrastre a mitad de camino lo cancela. */
  const openPlace = useCallback(
    async (place: FoundPlace): Promise<void> => {
      if (openingRef.current) return;
      openingRef.current = true;
      setOpening(place.label);

      const sphere = sphereRef.current;
      const hasScene = sphere !== null && sphere.getView() !== null;
      const arrived = hasScene
        ? await sphere.flyTo(
            { ra: place.patch.ra, dec: place.patch.dec },
            { fov: ZOOM_FOV, onProgress: (progress) => setFade(fadeAt(progress)) },
          )
        : true;

      if (!arrived) {
        setFade(0);
        openingRef.current = false;
        setOpening(null);
        return;
      }

      if (onOpenField) onOpenField(place.patch);
      else updateUrl(place.patch, { history: "push" });

      // Lo normal es que el visor reemplace a esta pantalla. Si sigue montada
      // (o el navegador la restaura al volver atras), se deja como estaba.
      restoreTimerRef.current = window.setTimeout(() => {
        restoreTimerRef.current = null;
        setFade(0);
        openingRef.current = false;
        setOpening(null);
        void sphereRef.current?.flyTo(
          { ra: place.patch.ra, dec: place.patch.dec },
          { fov: DEFAULT_FOV, duration: 700 },
        );
      }, RESTORE_DELAY_MS);
    },
    [onOpenField, setFade, updateUrl],
  );

  function openTarget(target: SkyTarget): void {
    search.reset();
    void openPlace({ label: target.label, patch: targetUrlPatch(target) });
  }

  /** Con una tecla modificadora, o con otro boton, el navegador abre el link por su cuenta. */
  function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
    return (
      !event.defaultPrevented &&
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    );
  }

  function handleTargetClick(id: string, event: MouseEvent<HTMLAnchorElement>): void {
    const target = SKY_TARGETS.find((candidate) => candidate.id === id);
    if (target === undefined || !isPlainClick(event)) return;
    event.preventDefault();
    openTarget(target);
  }

  function handleRandom(): void {
    const field = pickRandomField(lastRandomRef.current, random);
    lastRandomRef.current = field.id;
    openTarget(field);
  }

  async function handleSubmit(text: string): Promise<void> {
    const place = await search.submit(text);
    if (place === null) {
      // Despues de un fallo el foco vuelve al campo, para corregir o reintentar.
      inputRef.current?.focus();
      return;
    }
    await openPlace(place);
  }

  function handleQueryChange(value: string): void {
    setQuery(value);
    // Al editar se suelta la busqueda anterior: su error o su pedido en camino.
    if (status.kind !== "idle") search.reset();
  }

  function handleViewChange(view: SkyView): void {
    const element = readoutRef.current;
    if (element === null) return;
    const text = `${formatRa(view.ra, { language })} ${formatDec(view.dec, { language })}`;
    if (element.textContent !== text) element.textContent = text;
  }

  const targetHref = useCallback(
    (target: SkyTarget): string =>
      viewerHref({ ...DEFAULT_URL_STATE, embed, lang: urlLanguage, ...targetUrlPatch(target) }),
    [embed, urlLanguage],
  );

  const markers = useMemo<SkyMarker[]>(
    () => [
      ...SKY_TARGETS.map((target) => ({
        id: target.id,
        label: target.label,
        ra: target.ra,
        dec: target.dec,
        href: targetHref(target),
        openLabel: t("markers.open", { name: target.label }),
      })),
      ...(extraMarkers ?? []),
    ],
    [extraMarkers, t, targetHref],
  );

  const example = t("search.example", {
    name: SEARCH_EXAMPLE.label,
    coordinates: `${formatRa(SEARCH_EXAMPLE.ra, { language })} ${formatDec(SEARCH_EXAMPLE.dec, { language })}`,
  });

  // Un solo renglon debajo del campo: lo que esta pasando o, en reposo, como se usa la esfera.
  let hintText = sphereStatus === "no-webgl" ? undefined : t("hint");
  let liveText = "";
  if (opening !== null) {
    hintText = t("opening", { name: opening });
    liveText = hintText;
  } else if (status.kind === "resolving") {
    hintText = t("search.resolving", { query: status.query });
    liveText = hintText;
  }

  let errorText: string | undefined;
  if (status.kind === "error" && opening === null) {
    const message = tErrors(`code.${status.code}`);
    // Los dos fallos que tienen una salida a mano la dicen al lado del motivo.
    const advice =
      status.code === "not_resolved" || status.code === "upstream_unavailable"
        ? t(`search.advice.${status.code}`)
        : null;
    errorText = advice === null ? message : `${message} ${advice}`;
    hintText = undefined;
  }

  const busy = opening !== null || status.kind === "resolving";
  const noticeText =
    sphereStatus === "no-webgl"
      ? t("status.noWebgl")
      : sphereStatus === "texture-error"
        ? t("status.textureError")
        : null;

  return (
    <div className={styles.page}>
      <SkySphere
        ref={sphereRef}
        label={t("stage.label")}
        markersLabel={t("markers.nav")}
        markers={markers}
        onMarkerClick={(marker, event) => handleTargetClick(marker.id, event)}
        initialView={initialView ?? INITIAL_VIEW}
        driftRate={driftRate ?? DRIFT_RATE}
        onViewChange={handleViewChange}
        onStatusChange={setSphereStatus}
      />
      {/* Fundido a negro del final del acercamiento: el visor abre sobre el mismo negro. */}
      <div ref={fadeRef} className={styles.fade} aria-hidden="true" />

      <header className={styles.topbar}>
        <p className={styles.brand}>{tCommon("app.name")}</p>
        {/* El idioma va en la URL (`lang`); App lo aplica a i18next. */}
        <LanguageSelector value={language} onChange={(lang) => updateUrl({ lang })} />
      </header>

      <p className={styles.readout} data-hidden={sphereStatus === "no-webgl"}>
        <span className={styles.readoutLabel}>{t("center")}</span>{" "}
        <span ref={readoutRef} className={styles.readoutValue} />
      </p>

      <div className={styles.bottom}>
        <main className={styles.dock}>
          {noticeText === null ? null : (
            <p className={styles.notice} role="status">
              <Icon name="alert" size={18} className={styles.noticeIcon} />
              <span>{noticeText}</span>
            </p>
          )}
          {sphereStatus !== "no-webgl" ? null : (
            <QuickLinkList label={t("markers.nav")}>
              {SKY_TARGETS.map((target) => (
                <QuickLink
                  key={target.id}
                  href={targetHref(target)}
                  onClick={(event) => handleTargetClick(target.id, event)}
                >
                  {target.label}
                </QuickLink>
              ))}
            </QuickLinkList>
          )}
          <div className={styles.searchRow}>
            <SearchField
              className={styles.search}
              label={t("search.label")}
              value={query}
              onChange={handleQueryChange}
              onSubmit={(text) => void handleSubmit(text)}
              submitLabel={t("search.submit")}
              placeholder={example}
              hint={hintText}
              error={errorText}
              busy={busy}
              inputRef={inputRef}
            />
            <Button
              className={styles.random}
              variant="ghost"
              icon="shuffle"
              disabled={busy}
              onClick={handleRandom}
            >
              {t("random")}
            </Button>
          </div>
          {/* Siempre montado, para que el lector de pantalla anuncie el cambio de texto. */}
          <p className={styles.visuallyHidden} role="status">
            {liveText}
          </p>
        </main>
        <p className={styles.credit}>{t("credit")}</p>
      </div>
    </div>
  );
}
