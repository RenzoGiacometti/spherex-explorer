import { type MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  classNames,
  Icon,
  IconButton,
  LanguageSelector,
  QuickLink,
  QuickLinkList,
  SearchField,
} from "@/components";
import type { NameResolver } from "@/data/nameResolver";
import {
  type FeaturedObject,
  type FoundPlace,
  featuredUrlPatch,
  SEARCH_EXAMPLE,
  typedCoordinates,
  useObjectSearch,
  type ViewerUrlPatch,
  viewerHref,
} from "@/features/entry";
import { GuideLauncher } from "@/features/guide";
import { useLanguage } from "@/i18n/useLanguage";
import { formatDec, formatDegrees, formatRa } from "@/lib/format";
import { DEFAULT_VIEW_FOV } from "@/lib/fov";
import { DEFAULT_BAND, DEFAULT_MODE, DEFAULT_URL_STATE, useUrlState } from "@/state/urlState";
import {
  CONSTELLATION_NAMES,
  type ConstellationFigure,
  constellationAt,
  constellationLabel,
  loadConstellationFigures,
} from "./constellations";
import { findPatch } from "./patches";
import { DEFAULT_FOV, type SkyView } from "./SkyScene";
import {
  type SkyLabel,
  type SkyMarker,
  SkySphere,
  type SkySphereHandle,
  type SkySphereStatus,
} from "./SkySphere";
import { SkyWindowOverlay, WINDOW_RETICLE_SIZE } from "./SkyWindowOverlay";
import styles from "./SpherePage.module.css";
import { angularSeparation, clamp, type SkyPosition, wrapDegrees } from "./skyMath";
import { pickRandomField, SKY_TARGETS, savedFieldNear } from "./targets";
import { useSphereTexts } from "./texts";
import { useUrlFlag } from "./urlFlag";
import { useSkyWindow } from "./useSkyWindow";

/**
 * Vista al entrar: el centro galactico abajo, la Via Lactea cruzando la
 * pantalla y Barnard's Star cerca del centro.
 */
const INITIAL_VIEW: SkyView = { ra: 272, dec: -6, fov: DEFAULT_FOV };

/** Deriva del cielo hasta la primera interaccion, en grados por segundo. */
const DRIFT_RATE = 0.5;

/** Campo de vision al que llega el acercamiento antes de abrir el visor, en grados. */
const ZOOM_FOV = 14;

/** Campo de vision de la ventana al cielo, sobre el lado largo de la pantalla. */
const WINDOW_FOV = 75;

/**
 * Un destacado cuenta como "en la mira" si esta dentro del circulo, y nunca a
 * menos de este radio en grados: la brujula del telefono no es mas precisa.
 */
const MIN_LOCK_RADIUS = 5;

/** Parametro de la URL que prende la capa de constelaciones: `?const=1`. */
const CONSTELLATIONS_PARAM = "const";

/** Si despues de abrir un campo la pantalla sigue montada, vuelve a su estado normal. */
const RESTORE_DELAY_MS = 1500;

/**
 * Tiempo que el acercamiento se queda sobre la imagen del campo antes de abrir
 * el visor, en milisegundos: se llega a ver adonde se llego.
 */
const PATCH_DWELL_MS = 350;

/**
 * Opacidad del fundido a negro segun el avance del vuelo: ocupa el ultimo
 * tramo. Hacia un campo con parche lo que se va a negro es solo el cielo, y
 * queda la imagen del campo.
 */
function fadeAt(progress: number): number {
  return clamp((progress - 0.55) / 0.45, 0, 1) ** 2;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Destacado mas cercano al centro de la ventana al cielo. */
interface Nearest {
  readonly id: string;
  /** Distancia al centro en grados enteros: no hace falta redibujar por menos. */
  readonly distance: number;
  /** Esta dentro de la mira. */
  readonly locked: boolean;
}

function nearestTarget(view: SkyView): Nearest | null {
  let best: { target: FeaturedObject; distance: number } | null = null;
  for (const target of SKY_TARGETS) {
    const distance = angularSeparation(view, target);
    if (best === null || distance < best.distance) best = { target, distance };
  }
  if (best === null) return null;
  const longSide = Math.max(window.innerWidth, window.innerHeight, 1);
  const reticleRadius = ((WINDOW_RETICLE_SIZE / 2) * view.fov) / longSide;
  return {
    id: best.target.id,
    distance: Math.round(best.distance),
    locked: best.distance <= Math.max(reticleRadius, MIN_LOCK_RADIUS),
  };
}

export interface SpherePageProps {
  /** Resolucion de nombres; por defecto la compartida (src/data/nameResolver.ts). */
  readonly resolver?: NameResolver | undefined;
  /**
   * Abre un campo en el visor. Por defecto escribe el campo en la URL, y
   * App.tsx muestra el visor. La pagina de prueba pasa la suya.
   */
  readonly onOpenField?: ((patch: ViewerUrlPatch) => void) | undefined;
  readonly initialView?: SkyView | undefined;
  /** Grados por segundo de la deriva inicial; 0 la apaga. */
  readonly driftRate?: number | undefined;
  /** Marcas adicionales sobre el cielo (pagina de prueba). */
  readonly extraMarkers?: readonly SkyMarker[] | undefined;
  /** Fuente de azar de "Lugar al azar"; por defecto Math.random. */
  readonly random?: (() => number) | undefined;
  /**
   * Muestra el boton "Ventana al cielo". Por defecto, solo donde el puntero
   * principal es un dedo (telefonos y tabletas).
   */
  readonly offerSkyWindow?: boolean | undefined;
  /** Solo para la pagina de prueba: acepta sensores simulados sin brujula. */
  readonly allowRelativeOrientation?: boolean | undefined;
}

/**
 * Pantalla de entrada de la aplicacion: lo que se ve cuando la URL no trae
 * coordenadas (SPEC.md, Etapa 4). El cielo a pantalla completa, los cinco
 * objetos de prueba marcados, el buscador, el boton "Lugar al azar" y el que
 * inicia el recorrido guiado (src/features/guide). Elegir un
 * lugar acerca la camara al punto y abre su campo en el visor. En un telefono
 * suma la "ventana al cielo": la esfera sigue la direccion a la que apunta el
 * aparato.
 *
 * El buscador es uno solo: se ve como lo dibuja esta pantalla y busca con la
 * logica de src/features/entry (useObjectSearch). Si el navegador no puede
 * dibujar la esfera, quedan el buscador, "Lugar al azar" y los objetos
 * destacados como links.
 */
export function SpherePage({
  resolver,
  onOpenField,
  initialView,
  driftRate,
  extraMarkers,
  random,
  offerSkyWindow,
  allowRelativeOrientation,
}: SpherePageProps) {
  const t = useSphereTexts();
  const { t: tEntry } = useTranslation("entry");
  const { t: tCommon } = useTranslation("common");
  const { t: tErrors } = useTranslation("errors");
  const language = useLanguage();

  const urlLanguage = useUrlState((state) => state.lang);
  const embed = useUrlState((state) => state.embed);
  const updateUrl = useUrlState((state) => state.update);

  const sphereRef = useRef<SkySphereHandle>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const fadeRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const openingRef = useRef(false);
  const restoreTimerRef = useRef<number | null>(null);
  const lastRandomRef = useRef<string | null>(null);

  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [sphereStatus, setSphereStatus] = useState<SkySphereStatus>("loading");
  const [nearest, setNearest] = useState<Nearest | null>(null);
  // Capa de constelaciones: el interruptor va en la URL y las figuras se piden al prenderla.
  const [constellationsOn, setConstellationsOn] = useUrlFlag(CONSTELLATIONS_PARAM);
  const [figures, setFigures] = useState<readonly ConstellationFigure[] | null>(null);
  useEffect(() => {
    if (!constellationsOn || figures !== null) return;
    let alive = true;
    loadConstellationFigures()
      .then((loaded) => {
        if (alive) setFigures(loaded);
      })
      .catch((error: unknown) => {
        console.warn("esfera: no se pudieron cargar las constelaciones", error);
      });
    return () => {
      alive = false;
    };
  }, [constellationsOn, figures]);
  const shownFigures = constellationsOn ? figures : null;
  const constellationLines = useMemo(
    () => (shownFigures === null ? null : shownFigures.flatMap((figure) => figure.lines)),
    [shownFigures],
  );
  const constellationLabels = useMemo<SkyLabel[]>(
    () =>
      (shownFigures ?? []).map((figure) => ({
        id: figure.id,
        ra: figure.label[0],
        dec: figure.label[1],
        text: CONSTELLATION_NAMES[figure.abbr]?.[language] ?? figure.abbr,
      })),
    [shownFigures, language],
  );

  /** Punto del cielo elegido con un clic o un toque: lleva la mira y la tarjeta. */
  const [pick, setPick] = useState<SkyPosition | null>(null);
  const [coarsePointer] = useState(
    () =>
      typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false),
  );
  const search = useObjectSearch(resolver);
  const { status } = search;

  const skyWindow = useSkyWindow({
    onOrientation: (orientation) => sphereRef.current?.setFreeOrientation(orientation),
    allowRelative: allowRelativeOrientation,
  });
  const windowState = skyWindow.state;
  const windowOn = windowState.kind === "on";
  const windowOnRef = useRef(windowOn);
  windowOnRef.current = windowOn;

  // La ventana al cielo usa un campo de vision propio; al salir vuelve el de la entrada.
  useEffect(() => {
    if (!windowOn) return;
    sphereRef.current?.setView({ fov: WINDOW_FOV });
    return () => {
      sphereRef.current?.setView({ fov: DEFAULT_FOV });
      setNearest(null);
    };
  }, [windowOn]);

  useEffect(
    () => () => {
      if (restoreTimerRef.current !== null) window.clearTimeout(restoreTimerRef.current);
    },
    [],
  );

  // Alto de la franja de abajo (buscador, botones y credito), que cambia con la
  // ventana y con lo que se muestra. La esfera lo usa para no escribir nombres
  // del cielo debajo de esos textos.
  useEffect(() => {
    const page = pageRef.current;
    const bottom = bottomRef.current;
    if (page === null || bottom === null || typeof ResizeObserver === "undefined") return;
    const measure = (): void => {
      page.style.setProperty("--sky-labels-inset", `${bottom.offsetHeight}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bottom);
    return () => observer.disconnect();
  }, []);

  const setFade = useCallback((opacity: number) => {
    if (fadeRef.current !== null) fadeRef.current.style.opacity = String(opacity);
  }, []);

  /**
   * Cuanto se ve la interfaz de abajo (buscador, botones, credito y lectura del
   * centro), de 0 a 1. Al acercarse a un campo con imagen se retira junto con
   * el cielo, para que nada tape la imagen: en un celular el buscador ocupa
   * casi media pantalla.
   */
  const setChrome = useCallback((opacity: number) => {
    const page = pageRef.current;
    if (page === null) return;
    page.style.setProperty("--sphere-chrome", String(opacity));
    // Invisible del todo, tampoco recibe el puntero ni el foco.
    page.dataset.chrome = opacity <= 0.01 ? "hidden" : "shown";
  }, []);

  /** Acerca la camara al lugar y abre su campo. Un arrastre a mitad de camino lo cancela. */
  const openPlace = useCallback(
    async (place: FoundPlace): Promise<void> => {
      if (openingRef.current) return;
      openingRef.current = true;
      setOpening(place.label);

      const sphere = sphereRef.current;
      const hasScene = sphere !== null && sphere.getView() !== null;
      const position = { ra: place.patch.ra, dec: place.patch.dec };
      // Un campo precalculado tiene su imagen sobre la esfera: el acercamiento
      // termina sobre ella. Para cualquier otro lugar termina en negro.
      const patch = hasScene ? findPatch(position) : undefined;
      let arrived = true;
      if (hasScene && patch !== undefined) {
        arrived = await sphere.flyToPatch(patch.id, {
          // La imagen no llega hasta la barra superior.
          inset: topbarRef.current?.offsetHeight ?? 0,
          onProgress: (progress) => {
            const fade = fadeAt(progress);
            sphere.setSkyDim(fade);
            setChrome(1 - fade);
          },
        });
        if (arrived) await wait(PATCH_DWELL_MS);
      } else if (hasScene) {
        arrived = await sphere.flyTo(position, {
          fov: ZOOM_FOV,
          onProgress: (progress) => setFade(fadeAt(progress)),
        });
      }

      if (!arrived) {
        setFade(0);
        setChrome(1);
        sphere?.setSkyDim(0);
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
        setChrome(1);
        sphereRef.current?.setSkyDim(0);
        openingRef.current = false;
        setOpening(null);
        void sphereRef.current?.flyTo(
          { ra: place.patch.ra, dec: place.patch.dec },
          { fov: DEFAULT_FOV, duration: 700 },
        );
      }, RESTORE_DELAY_MS);
    },
    [onOpenField, setChrome, setFade, updateUrl],
  );

  function openTarget(target: FeaturedObject): void {
    search.reset();
    void openPlace({ label: target.label, patch: featuredUrlPatch(target) });
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
    // El vuelo necesita la vista con el norte arriba: el sensor deja de mandar.
    skyWindow.stop();
    openTarget(target);
  }

  /** Clic o toque corto sobre el cielo: deja la mira ahi y abre la tarjeta del punto. */
  function handleSkyTap(position: SkyPosition): void {
    if (openingRef.current) return;
    // Con los cuatro decimales de un centro de campo (docs/contrato-cubo.md, seccion 4.8).
    setPick({
      ra: wrapDegrees(Math.round(position.ra * 1e4) / 1e4),
      dec: Math.round(position.dec * 1e4) / 1e4,
    });
  }

  /** Campo guardado a menos de un minuto de arco del punto elegido, si lo hay. */
  const pickSaved = pick === null ? undefined : savedFieldNear(pick);

  /** Abre el punto elegido: el campo guardado si cae sobre uno, o un campo nuevo centrado ahi. */
  function handlePickOpen(): void {
    if (pick === null) return;
    setPick(null);
    if (pickSaved !== undefined) {
      openTarget(pickSaved);
      return;
    }
    search.reset();
    void openPlace({
      label: formatPosition(pick.ra, pick.dec),
      patch: {
        ra: pick.ra,
        dec: pick.dec,
        fov: DEFAULT_VIEW_FOV,
        band: DEFAULT_BAND,
        mode: DEFAULT_MODE,
        epoch: null,
        name: null,
      },
    });
  }

  function handleRandom(): void {
    setPick(null);
    const field = pickRandomField(lastRandomRef.current, random);
    lastRandomRef.current = field.id;
    openTarget(field);
  }

  async function handleSubmit(text: string): Promise<void> {
    const result = await search.submit(text);
    // Despues de un fallo el foco vuelve al campo, para corregir o reintentar.
    if (result.outcome === "failed") inputRef.current?.focus();
    if (result.outcome === "found") await openPlace(result.place);
  }

  function handleQueryChange(value: string): void {
    setQuery(value);
    // Al editar se suelta la busqueda anterior: su error o su pedido en camino.
    if (status.kind !== "idle") search.reset();
  }

  function formatPosition(ra: number, dec: number): string {
    return `${formatRa(ra, { language })} ${formatDec(dec, { language })}`;
  }

  function handleViewChange(view: SkyView): void {
    const element = readoutRef.current;
    if (element !== null) {
      const text = formatPosition(view.ra, view.dec);
      if (element.textContent !== text) element.textContent = text;
    }
    if (!windowOnRef.current) return;
    const next = nearestTarget(view);
    // Corre en cada cuadro: solo cambia el estado cuando cambia lo que se muestra.
    setNearest((previous) =>
      previous !== null &&
      next !== null &&
      previous.id === next.id &&
      previous.distance === next.distance &&
      previous.locked === next.locked
        ? previous
        : next,
    );
  }

  const nearestObject =
    nearest === null ? undefined : SKY_TARGETS.find((target) => target.id === nearest.id);
  const lockedTarget = nearest?.locked ? nearestObject : undefined;

  /** Abre lo que esta en la mira: el destacado, o el punto del cielo al que apunta el telefono. */
  function handleWindowOpen(): void {
    const view = sphereRef.current?.getView() ?? null;
    skyWindow.stop();
    if (lockedTarget !== undefined) {
      openTarget(lockedTarget);
      return;
    }
    if (view === null) return;
    search.reset();
    void openPlace({
      label: formatPosition(view.ra, view.dec),
      patch: {
        ra: view.ra,
        dec: view.dec,
        fov: DEFAULT_VIEW_FOV,
        band: DEFAULT_BAND,
        mode: DEFAULT_MODE,
        epoch: null,
        name: null,
      },
    });
  }

  const targetHref = useCallback(
    (target: FeaturedObject): string =>
      viewerHref({ ...DEFAULT_URL_STATE, embed, lang: urlLanguage, ...featuredUrlPatch(target) }),
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

  // En grados y con los 4 decimales del centro del campo: quien lo tipea abre
  // el campo precalculado y no uno casi igual.
  const exampleCoordinates = typedCoordinates(SEARCH_EXAMPLE);
  const example = tEntry("search.example", {
    name: SEARCH_EXAMPLE.label,
    coordinates: exampleCoordinates,
  });

  // Un solo renglon debajo del campo: lo que esta pasando o, en reposo, como se usa la esfera.
  let hintText = sphereStatus === "no-webgl" ? undefined : t("hint");
  let liveText = "";
  if (opening !== null) {
    hintText = t("opening", { name: opening });
    liveText = hintText;
  } else if (status.kind === "resolving") {
    hintText = tEntry("search.resolving", { query: status.query });
    liveText = hintText;
  } else if (windowState.kind === "starting") {
    hintText = t("window.starting");
    liveText = hintText;
  }

  let errorText: string | undefined;
  if (status.kind === "error" && opening === null) {
    if (status.code === "upstream_unavailable") {
      // /api/resolve solo sale a la red por un nombre: lo caido es el servicio
      // de nombres, no el archivo de datos del texto generico. Las coordenadas
      // no pasan por el, asi que se invita a probar con ellas.
      errorText = tEntry("search.nameServiceDown", { coordinates: exampleCoordinates });
    } else {
      const message = tErrors(`code.${status.code}`);
      // Un nombre que no existe tiene una salida a mano: se dice al lado del motivo.
      errorText =
        status.code === "not_resolved"
          ? `${message} ${tEntry("search.advice.not_resolved")}`
          : message;
    }
    hintText = undefined;
  }

  const busy = opening !== null || status.kind === "resolving";

  // Avisos sobre el buscador: la esfera no se pudo dibujar, o la ventana al cielo no esta disponible.
  const notices: string[] = [];
  if (sphereStatus === "no-webgl") notices.push(t("status.noWebgl"));
  else if (sphereStatus === "texture-error") notices.push(t("status.textureError"));
  if (windowState.kind === "unavailable") {
    notices.push(`${t(`window.unavailable.${windowState.issue}`)} ${t("window.dragMode")}`);
  }

  const showWindowButton = (offerSkyWindow ?? coarsePointer) && sphereStatus !== "no-webgl";

  return (
    <div ref={pageRef} className={styles.page} data-window={windowOn}>
      <SkySphere
        ref={sphereRef}
        label={t("stage.label")}
        markersLabel={t("markers.nav")}
        markers={markers}
        onMarkerClick={(marker, event) => handleTargetClick(marker.id, event)}
        initialView={initialView ?? INITIAL_VIEW}
        driftRate={driftRate ?? DRIFT_RATE}
        unlabelledMarkerId={lockedTarget?.id ?? null}
        interactive={!windowOn}
        lines={constellationLines}
        labels={constellationLabels}
        pick={windowOn ? null : pick}
        onSkyTap={handleSkyTap}
        onViewChange={handleViewChange}
        onStatusChange={setSphereStatus}
      />
      {/*
        Fundido a negro del final del acercamiento a un lugar sin imagen propia: el
        visor abre sobre el mismo negro. Hacia un campo precalculado no se usa: la
        escena oscurece el cielo y deja la imagen del campo.
      */}
      <div ref={fadeRef} className={styles.fade} aria-hidden="true" />

      {windowOn ? (
        <SkyWindowOverlay
          lockedName={lockedTarget?.label ?? null}
          nearestText={
            nearestObject === undefined ? null : t("window.nearest", { name: nearestObject.label })
          }
          nearestDistance={nearest === null ? null : formatDegrees(nearest.distance, language, 0)}
        />
      ) : null}

      <header ref={topbarRef} className={styles.topbar}>
        <p className={styles.brand}>{tCommon("app.name")}</p>
        {windowOn ? (
          // En la ventana al cielo, arriba solo queda la salida.
          <IconButton icon="close" label={t("window.exit")} onClick={skyWindow.stop} />
        ) : (
          <div className={styles.topActions}>
            {sphereStatus === "no-webgl" ? null : (
              // Capa de constelaciones: prendida, el boton va relleno en blanco.
              <IconButton
                icon="layers"
                label={t(constellationsOn ? "constellations.hide" : "constellations.show")}
                pressed={constellationsOn}
                onClick={() => setConstellationsOn(!constellationsOn)}
              />
            )}
            {/* El idioma va en la URL (`lang`); App lo aplica a i18next. */}
            <LanguageSelector value={language} onChange={(lang) => updateUrl({ lang })} />
          </div>
        )}
      </header>

      <p className={styles.readout} data-hidden={sphereStatus === "no-webgl"}>
        <span className={styles.readoutLabel}>{t("center")}</span>{" "}
        <span ref={readoutRef} className={styles.readoutValue} />
      </p>

      <div ref={bottomRef} className={styles.bottom}>
        {windowOn ? (
          <main className={styles.windowDock}>
            {/* El unico boton relleno de la vista: abre lo que esta en la mira. */}
            <Button variant="primary" icon="target" disabled={busy} onClick={handleWindowOpen}>
              {lockedTarget === undefined
                ? t("window.openHere")
                : t("window.open", { name: lockedTarget.label })}
            </Button>
          </main>
        ) : (
          <main className={styles.dock}>
            {notices.map((notice) => (
              <p key={notice} className={styles.notice} role="status">
                <Icon name="alert" size={18} className={styles.noticeIcon} />
                <span>{notice}</span>
              </p>
            ))}
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
            {pick === null ? null : (
              <section className={styles.pick} aria-label={t("pick.title")}>
                <div className={styles.pickHead}>
                  <h2 className={styles.pickTitle}>{t("pick.title")}</h2>
                  <IconButton icon="close" label={t("pick.close")} onClick={() => setPick(null)} />
                </div>
                <p className={styles.pickCoordinates}>{formatPosition(pick.ra, pick.dec)}</p>
                <p className={styles.pickLine}>
                  {t("pick.constellation", {
                    name: constellationLabel(constellationAt(pick), language),
                  })}
                </p>
                <p className={styles.pickNote} role="status">
                  {pickSaved === undefined
                    ? t("pick.new")
                    : t("pick.saved", { name: pickSaved.label })}
                </p>
                <Button
                  className={classNames(styles.action, styles.pickOpen)}
                  variant="ghost"
                  icon="target"
                  disabled={busy}
                  onClick={handlePickOpen}
                >
                  {t("pick.open")}
                </Button>
              </section>
            )}
            {/* Renglon propio sobre el buscador: se ve con y sin esfera, y en el celular. */}
            <GuideLauncher className={classNames(styles.action, styles.guide)} />
            <div className={styles.searchRow}>
              <SearchField
                className={styles.search}
                label={tEntry("search.label")}
                value={query}
                onChange={handleQueryChange}
                onSubmit={(text) => void handleSubmit(text)}
                submitLabel={tEntry("search.submit")}
                placeholder={example}
                hint={hintText}
                error={errorText}
                busy={busy}
                inputRef={inputRef}
              />
              <div className={styles.actions}>
                <Button
                  className={styles.action}
                  variant="ghost"
                  icon="shuffle"
                  disabled={busy}
                  onClick={handleRandom}
                >
                  {t("random")}
                </Button>
                {showWindowButton ? (
                  <Button
                    className={styles.action}
                    variant="ghost"
                    icon="compass"
                    disabled={busy || windowState.kind === "starting"}
                    onClick={() => void skyWindow.start()}
                  >
                    {t("window.enter")}
                  </Button>
                ) : null}
              </div>
            </div>
          </main>
        )}
        {/* Siempre montado, para que el lector de pantalla anuncie el cambio de texto. */}
        <p className={styles.visuallyHidden} role="status">
          {liveText}
        </p>
        <p className={styles.credit}>{t("credit")}</p>
      </div>
    </div>
  );
}
