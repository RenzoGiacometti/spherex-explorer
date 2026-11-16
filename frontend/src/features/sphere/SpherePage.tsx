import {
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { AboutDialog } from "@/features/about";
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
import { DEFAULT_URL_STATE, useUrlState } from "@/state/urlState";
import {
  type BrightStar,
  CONSTELLATION_NAMES,
  type ConstellationFigure,
  constellationAt,
  constellationLabel,
  figureFrame,
  loadBrightStars,
  loadConstellationFigures,
} from "./constellations";
import { findPatch } from "./patches";
import { SkyDebug } from "./SkyDebug";
import { DEFAULT_FOV, type SkyView } from "./SkyScene";
import {
  type SkyBox,
  type SkyLabel,
  type SkyMarker,
  SkySphere,
  type SkySphereHandle,
  type SkySphereStatus,
} from "./SkySphere";
import { SkyWindowOverlay, WINDOW_RETICLE_SIZE } from "./SkyWindowOverlay";
import styles from "./SpherePage.module.css";
import { ENTRY_SHORTCUTS, type EntryShortcut } from "./shortcuts";
import { angularSeparation, clamp, type SkyPosition, wrapDegrees } from "./skyMath";
import {
  lastRandomFieldId,
  PRECOMPUTED_FIELDS,
  pickRandomField,
  rememberRandomField,
  SKY_TARGETS,
  skyPointField,
} from "./targets";
import { useSphereTexts } from "./texts";
import { type SkyWindowReading, useSkyWindow } from "./useSkyWindow";

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

/** Al encuadrar una constelacion, cuanto mas que su tamano abarca la vista. */
const FRAME_MARGIN = 1.35;
/** Limites del campo de vision al encuadrar una constelacion, en grados. */
const FRAME_MIN_FOV = 12;
const FRAME_MAX_FOV = 110;

/** Si despues de abrir un campo la pantalla sigue montada, vuelve a su estado normal. */
const RESTORE_DELAY_MS = 1500;

/** Ancho de celular de DESIGN.md ("Responsive Behavior"). */
const PHONE_QUERY = "(max-width: 599px)";

/**
 * Lo que la interfaz tapa del cielo lleva este atributo: la esfera no dibuja
 * debajo marcadores ni nombres (`occluders`, SkySphere.tsx). `chrome` es lo que
 * se retira al acercarse a un campo (buscador, tarjeta, credito y lectura del
 * centro); `bar`, lo de la barra superior, que queda.
 */
const COVER_ATTRIBUTE = "data-sky-cover";

const NO_COVER: readonly SkyBox[] = [];

/** Cartel del punto elegido: distancia, en pixeles, entre el centro de la mira y el cartel. */
const CALLOUT_GAP = 48;
/** Donde empieza la linea que une la mira con el cartel: medio lado de la mira (20 px) y 2 px mas. */
const CALLOUT_RETICLE = 22;
/** Aire entre el cartel y el resto de la interfaz (barra, riel, franja de abajo). */
const CALLOUT_MARGIN = 8;
/** Aire entre el cartel y el borde de la ventana, y entre la linea y las esquinas del cartel. */
const CALLOUT_EDGE = 12;

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

/** Si la ventana tiene ancho de celular: ahi la barra superior no tiene lugar para un boton con texto. */
function usePhoneWidth(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(PHONE_QUERY).matches === true,
  );
  useEffect(() => {
    if (typeof window === "undefined" || window.matchMedia === undefined) return;
    const query = window.matchMedia(PHONE_QUERY);
    const update = (): void => setPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

/**
 * Campo guardado mas cercano al centro de la ventana al cielo: cualquiera de
 * los catorce, no solo los cinco destacados. Todos tienen marcador y abren al
 * instante.
 */
interface Nearest {
  readonly id: string;
  /** Distancia al centro en grados enteros: no hace falta redibujar por menos. */
  readonly distance: number;
  /** Esta dentro de la mira. */
  readonly locked: boolean;
}

function nearestTarget(view: SkyView): Nearest | null {
  let best: { target: FeaturedObject; distance: number } | null = null;
  for (const target of PRECOMPUTED_FIELDS) {
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
 * objetos de prueba marcados y tambien listados como accesos sobre el
 * buscador, el buscador y, en un riel vertical sobre el borde derecho, el
 * recorrido guiado (src/features/guide), dos accesos directos (shortcuts.ts:
 * el viaje en el tiempo y la cortina) y "Lugar al azar". Elegir un lugar acerca
 * la camara al punto y abre su campo en el visor. En un telefono suma la
 * "ventana al cielo": la esfera sigue la direccion a la que apunta el aparato.
 *
 * Un clic sobre el cielo elige un punto: queda la mira y, a su lado, un
 * cartel con sus coordenadas, su constelacion y el boton que lo abre. Si
 * el punto cae dentro de la huella de un campo guardado abre ese campo
 * (targets.ts, `skyPointField`). Nada de esto se pisa: la esfera no dibuja
 * marcadores ni nombres de constelaciones debajo de la interfaz (los elementos
 * con `data-sky-cover`), y el cartel se ubica donde no tapa la mira, la
 * barra, el riel ni el buscador.
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
  const { t: tAbout } = useTranslation("about");
  const language = useLanguage();

  const urlLanguage = useUrlState((state) => state.lang);
  const embed = useUrlState((state) => state.embed);
  const updateUrl = useUrlState((state) => state.update);

  const sphereRef = useRef<SkySphereHandle>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** Cuanto se ve la interfaz de abajo, de 0 a 1 (`setChrome`). */
  const chromeRef = useRef(1);
  const topbarRef = useRef<HTMLElement>(null);
  const fadeRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const openingRef = useRef(false);
  const railRef = useRef<HTMLElement>(null);
  const calloutRef = useRef<HTMLElement>(null);
  const leaderRef = useRef<SVGLineElement>(null);
  const pickRef = useRef<SkyPosition | null>(null);
  const restoreTimerRef = useRef<number | null>(null);

  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const [sphereStatus, setSphereStatus] = useState<SkySphereStatus>("loading");
  const [nearest, setNearest] = useState<Nearest | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  // Capa de constelaciones: el interruptor va en la URL (`const=1`, state/urlState.ts)
  // y las figuras se piden al prenderla.
  const constellationsOn = useUrlState((state) => state.constellations);
  const [figures, setFigures] = useState<readonly ConstellationFigure[] | null>(null);
  const [stars, setStars] = useState<readonly BrightStar[] | null>(null);
  useEffect(() => {
    if (!constellationsOn || figures !== null) return;
    let alive = true;
    // Los nombres de las estrellas brillantes van con la misma capa.
    loadBrightStars()
      .then((loaded) => {
        if (alive) setStars(loaded);
      })
      .catch((error: unknown) => {
        console.warn("esfera: no se pudieron cargar las estrellas", error);
      });
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
  const shownStars = constellationsOn ? stars : null;
  // Primero las constelaciones y despues las estrellas, de la mas brillante a la mas debil:
  // en ese orden la esfera decide cual se escribe cuando dos se tocarian.
  const skyLabels = useMemo<SkyLabel[]>(
    () => [
      ...constellationLabels,
      ...(shownStars ?? []).map(([name, ra, dec], rank) => ({
        id: `star-${rank}`,
        ra,
        dec,
        text: name,
        kind: "star" as const,
        rank,
      })),
    ],
    [constellationLabels, shownStars],
  );

  /** Punto del cielo elegido con un clic o un toque: lleva la mira y la tarjeta. */
  const [pick, setPick] = useState<SkyPosition | null>(null);
  /**
   * Estrella brillante elegida al tocar su nombre. Vale mientras el punto
   * elegido siga siendo el suyo: otro toque sobre el cielo la deja de lado.
   */
  const [pickStar, setPickStar] = useState<(SkyPosition & { name: string }) | null>(null);
  const [coarsePointer] = useState(
    () =>
      typeof window !== "undefined" && (window.matchMedia?.("(pointer: coarse)").matches ?? false),
  );
  const phone = usePhoneWidth();
  const phoneRef = useRef(phone);
  phoneRef.current = phone;
  pickRef.current = pick;

  /**
   * Ubica el cartel del punto elegido al lado de la mira y tiende la linea que
   * los une. Corre en cada cuadro en que cambia la vista, sin pasar por el
   * estado: escribe la posicion directo en los elementos.
   *
   * El cartel no tapa la mira, la barra, el riel ni la franja de abajo. En
   * escritorio sale a la derecha de la mira y, si no entra, a la izquierda; en
   * el celular, debajo de la mira si el punto esta en la mitad de arriba y
   * encima si esta en la de abajo. Si el punto sale de la vista, o la interfaz
   * se retiro al acercarse a un campo, se oculta.
   */
  const placeCallout = useCallback((): void => {
    const card = calloutRef.current;
    const line = leaderRef.current;
    const page = pageRef.current;
    if (card === null || line === null || page === null) return;
    const target = pickRef.current;
    // Con la interfaz retirada del todo (`setChrome`) el cartel tampoco se muestra:
    // con opacidad 0 seguiria recibiendo el puntero y el foco.
    const retired = page.dataset.chrome === "hidden";
    const point = target === null || retired ? null : (sphereRef.current?.project(target) ?? null);
    if (point === null) {
      card.style.visibility = "hidden";
      line.style.visibility = "hidden";
      return;
    }
    const width = page.clientWidth;
    const height = page.clientHeight;
    const cardWidth = card.offsetWidth;
    const cardHeight = card.offsetHeight;
    const origin = page.getBoundingClientRect();
    const rail = railRef.current?.getBoundingClientRect();
    const ceiling = (topbarRef.current?.offsetHeight ?? 0) + CALLOUT_MARGIN;
    const floor = height - (bottomRef.current?.offsetHeight ?? 0) - CALLOUT_MARGIN;
    const rightLimit =
      rail === undefined ? width - CALLOUT_EDGE : rail.left - origin.left - CALLOUT_MARGIN;
    let left: number;
    let top: number;
    let fromX = point.x;
    let fromY = point.y;
    let toX: number;
    let toY: number;
    if (phoneRef.current) {
      // Celular: debajo de la mira si el punto esta arriba y entra; si no, encima.
      const below = point.y < (ceiling + floor) / 2 && point.y + CALLOUT_GAP + cardHeight <= floor;
      left = clamp(
        point.x - cardWidth / 2,
        CALLOUT_EDGE,
        Math.max(CALLOUT_EDGE, rightLimit - cardWidth),
      );
      top = below ? point.y + CALLOUT_GAP : point.y - CALLOUT_GAP - cardHeight;
      top = clamp(top, ceiling, Math.max(ceiling, floor - cardHeight));
      fromY = point.y + (below ? CALLOUT_RETICLE : -CALLOUT_RETICLE);
      toX = clamp(point.x, left + CALLOUT_EDGE, left + cardWidth - CALLOUT_EDGE);
      toY = below ? top : top + cardHeight;
    } else {
      // Escritorio: a la derecha de la mira; si no entra, a la izquierda.
      const onRight = point.x + CALLOUT_GAP + cardWidth <= rightLimit;
      left = onRight ? point.x + CALLOUT_GAP : point.x - CALLOUT_GAP - cardWidth;
      left = Math.max(left, CALLOUT_EDGE);
      top = clamp(point.y - cardHeight / 2, ceiling, Math.max(ceiling, floor - cardHeight));
      fromX = point.x + (onRight ? CALLOUT_RETICLE : -CALLOUT_RETICLE);
      toX = onRight ? left : left + cardWidth;
      toY = clamp(point.y, top + CALLOUT_EDGE, top + cardHeight - CALLOUT_EDGE);
    }
    card.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px)`;
    card.style.visibility = "visible";
    line.setAttribute("x1", fromX.toFixed(1));
    line.setAttribute("y1", fromY.toFixed(1));
    line.setAttribute("x2", toX.toFixed(1));
    line.setAttribute("y2", toY.toFixed(1));
    line.style.visibility = "visible";
  }, []);

  // Al elegir un punto se ubica antes de pintar: el cartel no pasa por la esquina.
  // biome-ignore lint/correctness/useExhaustiveDependencies: se reubica con cada punto nuevo.
  useLayoutEffect(() => {
    placeCallout();
  }, [pick, placeCallout]);

  useEffect(() => {
    window.addEventListener("resize", placeCallout);
    return () => window.removeEventListener("resize", placeCallout);
  }, [placeCallout]);

  // Escape quita la mira y su cartel, salvo que haya un dialogo abierto encima.
  useEffect(() => {
    if (pick === null || aboutOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setPick(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pick, aboutOpen]);
  const search = useObjectSearch(resolver);
  const { status } = search;

  // Diagnostico de la orientacion: `?debug=1` (SkyDebug.tsx). Se lee una vez, al montar.
  const [debug] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("debug") === "1",
  );
  const debugReadingRef = useRef<SkyWindowReading | null>(null);

  const skyWindow = useSkyWindow({
    onOrientation: (orientation) => sphereRef.current?.setFreeOrientation(orientation),
    onReading: (reading) => {
      debugReadingRef.current = reading;
    },
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
      // Cambio lo que la interfaz tapa: la esfera vuelve a ubicar marcadores y nombres.
      sphereRef.current?.refresh();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bottom);
    return () => observer.disconnect();
  }, []);

  // Despues de cada cambio de esta pantalla (otro idioma, la tarjeta, un aviso)
  // la interfaz puede tapar otra parte del cielo aunque la vista no se mueva.
  useEffect(() => {
    sphereRef.current?.refresh();
    placeCallout();
  });

  /**
   * Lo que la interfaz tapa del cielo, en pixeles de la pantalla: cada elemento
   * marcado con `data-sky-cover`. La esfera lo pide en cada cuadro que dibuja,
   * y debajo no pone marcadores ni nombres de constelaciones.
   *
   * En la ventana al cielo no se tapa nada: arriba queda la salida y abajo un
   * solo boton. Tampoco cuenta lo de abajo cuando ya se retiro para dejar ver
   * la imagen del campo al que se llega.
   */
  const coveredBoxes = useCallback((): readonly SkyBox[] => {
    const page = pageRef.current;
    if (page === null || windowOnRef.current) return NO_COVER;
    const origin = page.getBoundingClientRect();
    const chromeShown = chromeRef.current > 0.5;
    const boxes: SkyBox[] = [];
    for (const element of page.querySelectorAll<HTMLElement>(`[${COVER_ATTRIBUTE}]`)) {
      if (!chromeShown && element.getAttribute(COVER_ATTRIBUTE) === "chrome") continue;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      boxes.push({
        left: box.left - origin.left,
        top: box.top - origin.top,
        right: box.right - origin.left,
        bottom: box.bottom - origin.top,
      });
    }
    return boxes;
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
  const setChrome = useCallback(
    (opacity: number) => {
      const page = pageRef.current;
      chromeRef.current = opacity;
      if (page === null) return;
      page.style.setProperty("--sphere-chrome", String(opacity));
      // Invisible del todo, tampoco recibe el puntero ni el foco.
      const chrome = opacity <= 0.01 ? "hidden" : "shown";
      if (page.dataset.chrome === chrome) return;
      page.dataset.chrome = chrome;
      // El cartel del punto elegido lleva su visibilidad en linea: se retira y vuelve con el resto.
      placeCallout();
    },
    [placeCallout],
  );

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
    const target = PRECOMPUTED_FIELDS.find((candidate) => candidate.id === id);
    if (target === undefined || !isPlainClick(event)) return;
    event.preventDefault();
    // El vuelo necesita la vista con el norte arriba: el sensor deja de mandar.
    skyWindow.stop();
    openTarget(target);
  }

  /** Acceso directo: abre su campo en el modo que lo muestra mejor. */
  function handleShortcut(shortcut: EntryShortcut): void {
    skyWindow.stop();
    search.reset();
    void openPlace({ label: shortcut.label, patch: shortcut.patch });
  }

  /** Clic o toque corto sobre el cielo: deja la mira ahi y abre la tarjeta del punto. */
  /**
   * Toque sobre un nombre del cielo. El de una constelacion vuela hasta
   * encuadrarla. El de una estrella (o la estrella misma) la elige como punto,
   * y la tarjeta avisa que una estrella asi de brillante satura en SPHEREx.
   */
  function handleLabelTap(label: SkyLabel): void {
    if (openingRef.current) return;
    if (label.kind === "star") {
      const position = { ra: wrapDegrees(label.ra), dec: label.dec };
      setPick(position);
      setPickStar({ ...position, name: label.text });
      return;
    }
    const figure = figures?.find((candidate) => candidate.id === label.id);
    const sphere = sphereRef.current;
    if (figure === undefined || sphere === null) return;
    const { center, radius } = figureFrame(figure);
    // El campo de vision se mide sobre el lado largo de la ventana y la figura
    // tiene que entrar en el corto, con aire alrededor.
    const long = Math.max(window.innerWidth, window.innerHeight);
    const short = Math.max(1, Math.min(window.innerWidth, window.innerHeight));
    const fov = clamp(2 * radius * FRAME_MARGIN * (long / short), FRAME_MIN_FOV, FRAME_MAX_FOV);
    void sphere.flyTo(center, { fov });
  }

  function handleSkyTap(position: SkyPosition): void {
    if (openingRef.current) return;
    // Con los cuatro decimales de un centro de campo (docs/contrato-cubo.md, seccion 4.8).
    setPick({
      ra: wrapDegrees(Math.round(position.ra * 1e4) / 1e4),
      dec: Math.round(position.dec * 1e4) / 1e4,
    });
  }

  /**
   * Abre un punto del cielo: el campo guardado entero si cae dentro de la huella
   * de uno, o un campo nuevo centrado ahi. La regla es la del buscador y la de
   * la URL (`skyPointField`, targets.ts).
   */
  function openPosition(position: SkyPosition): void {
    const { saved, patch } = skyPointField(position);
    search.reset();
    void openPlace({
      label: saved === null ? formatPosition(position.ra, position.dec) : saved.label,
      patch,
    });
  }

  /** Campo guardado cuya huella contiene al punto elegido, o null: lo que dice la tarjeta. */
  const pickSaved = pick === null ? null : skyPointField(pick).saved;
  /** Nombre de la estrella brillante elegida, si el punto elegido es una. */
  const pickedStar =
    pick !== null && pickStar !== null && pickStar.ra === pick.ra && pickStar.dec === pick.dec
      ? pickStar.name
      : null;

  /** Abre el punto elegido en el visor. */
  function handlePickOpen(): void {
    if (pick === null) return;
    setPick(null);
    openPosition(pick);
  }

  function handleRandom(): void {
    setPick(null);
    // El anterior se recuerda fuera de esta pantalla (targets.ts): al volver del
    // visor el boton lleva a otro campo, no al mismo del que se viene.
    const field = pickRandomField(lastRandomFieldId(), random);
    rememberRandomField(field.id);
    openTarget(field);
  }

  async function handleSubmit(text: string): Promise<void> {
    const result = await search.submit(text);
    // Despues de un fallo el foco vuelve al campo, para corregir o reintentar.
    if (result.outcome === "failed") inputRef.current?.focus();
    if (result.outcome === "found") await openPlace(result.place);
  }

  /**
   * El campo de busqueda no avisa cuando se lo envia vacio (SearchField). El
   * envio del formulario sube hasta el renglon que lo contiene, y ahi se pide
   * un nombre o unas coordenadas en vez de no hacer nada.
   */
  function handleEmptySubmit(): void {
    if (query.trim() === "" && !busy) void handleSubmit("");
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
    placeCallout();
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
    nearest === null ? undefined : PRECOMPUTED_FIELDS.find((target) => target.id === nearest.id);
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
    // Dentro de la huella de un campo guardado se abre ese campo, con su banda y su nombre.
    openPosition(view);
  }

  const targetHref = useCallback(
    (target: FeaturedObject): string =>
      viewerHref({ ...DEFAULT_URL_STATE, embed, lang: urlLanguage, ...featuredUrlPatch(target) }),
    [embed, urlLanguage],
  );

  // Un marcador en ambar por cada campo guardado, no solo los cinco destacados:
  // asi se distingue de lejos donde hay un campo que abre al instante.
  const markers = useMemo<SkyMarker[]>(
    () => [
      ...PRECOMPUTED_FIELDS.map((target) => ({
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
  // En el celular el renglon queda para lo que esta pasando: en reposo no se muestra.
  let hintText = sphereStatus === "no-webgl" || phone ? undefined : t("hint");
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
  if (status.kind === "empty" && opening === null) {
    errorText = tEntry("search.empty");
    hintText = undefined;
  } else if (status.kind === "error" && opening === null) {
    if (status.code === "upstream_unavailable") {
      // /api/resolve solo sale a la red por un nombre: lo caido es el servicio
      // de nombres, no el archivo de datos del texto generico. Las coordenadas
      // no pasan por el, asi que se invita a probar con ellas.
      errorText = tEntry("search.nameServiceDown", { coordinates: exampleCoordinates });
    } else if (status.code === "invalid_request") {
      // El backend rechaza asi unas coordenadas fuera de rango. El texto generico
      // habla del campo de vision, que en el buscador no se elige: va uno propio.
      errorText = tEntry("search.invalidCoordinates");
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
  // Por que los botones no responden mientras tanto: se dice al pasar el cursor, al tocar y al lector.
  const busyReason = opening !== null ? t("busy.opening") : t("busy.searching");

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
        // La lista de accesos de abajo ya se llama "Objetos destacados": esta lleva otro nombre.
        markersLabel={t("markers.sky")}
        markers={markers}
        onMarkerClick={(marker, event) => handleTargetClick(marker.id, event)}
        initialView={initialView ?? INITIAL_VIEW}
        driftRate={driftRate ?? DRIFT_RATE}
        unlabelledMarkerId={lockedTarget?.id ?? null}
        interactive={!windowOn}
        lines={constellationLines}
        labels={skyLabels}
        pick={windowOn ? null : pick}
        occluders={coveredBoxes}
        onSkyTap={handleSkyTap}
        onLabelTap={handleLabelTap}
        onViewChange={handleViewChange}
        onStatusChange={setSphereStatus}
      />
      {/*
        Fundido a negro del final del acercamiento a un lugar sin imagen propia: el
        visor abre sobre el mismo negro. Hacia un campo precalculado no se usa: la
        escena oscurece el cielo y deja la imagen del campo.
      */}
      <div ref={fadeRef} className={styles.fade} aria-hidden="true" />

      {debug ? <SkyDebug sphereRef={sphereRef} readingRef={debugReadingRef} /> : null}

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
        <p className={styles.brand} data-sky-cover="bar">
          {tCommon("app.name")}
        </p>
        {windowOn ? (
          // En la ventana al cielo, arriba solo queda la salida.
          <IconButton icon="close" label={t("window.exit")} onClick={skyWindow.stop} />
        ) : (
          <div className={styles.topActions} data-sky-cover="bar">
            {sphereStatus === "no-webgl" ? null : (
              // Capa de constelaciones: prendida, el boton va relleno en blanco.
              <IconButton
                icon="layers"
                label={t(constellationsOn ? "constellations.hide" : "constellations.show")}
                pressed={constellationsOn}
                onClick={() => updateUrl({ constellations: !constellationsOn })}
              />
            )}
            {/*
              "Acerca de": que es, uso de IA y creditos de los datos. Se ve con y sin
              esfera. En el celular va solo el icono: con el texto, la capa de
              constelaciones y el idioma no entran en la barra.
            */}
            {phone ? (
              <IconButton
                icon="info"
                label={tAbout("open")}
                aria-haspopup="dialog"
                onClick={() => setAboutOpen(true)}
              />
            ) : (
              <Button
                className={styles.action}
                variant="ghost"
                icon="info"
                aria-haspopup="dialog"
                onClick={() => setAboutOpen(true)}
              >
                {tAbout("open")}
              </Button>
            )}
            {/* El idioma va en la URL (`lang`); App lo aplica a i18next. */}
            <LanguageSelector value={language} onChange={(lang) => updateUrl({ lang })} />
          </div>
        )}
      </header>
      {aboutOpen ? <AboutDialog onClose={() => setAboutOpen(false)} /> : null}

      <p
        className={styles.readout}
        data-hidden={sphereStatus === "no-webgl"}
        data-sky-cover="chrome"
      >
        <span className={styles.readoutLabel}>{t("center")}</span>{" "}
        <span ref={readoutRef} className={styles.readoutValue} />
      </p>

      {/*
        Riel de accesos, vertical sobre el borde derecho: el recorrido guiado, los
        dos accesos directos, "Lugar al azar" y, en un telefono, la ventana al
        cielo. A la vista va un rotulo de una palabra; el nombre completo es el
        nombre accesible y la ayuda al pasar el cursor.
      */}
      {windowOn ? null : (
        <section
          ref={railRef}
          className={styles.rail}
          aria-label={t("rail.label")}
          data-sky-cover="chrome"
        >
          <GuideLauncher className={styles.cell} compact />
          {ENTRY_SHORTCUTS.map((shortcut) => (
            <Button
              key={shortcut.id}
              className={styles.cell}
              variant="ghost"
              icon={shortcut.icon}
              disabled={busy}
              disabledReason={busyReason}
              aria-label={t(`shortcuts.${shortcut.id}`)}
              title={
                busy ? undefined : t(`shortcutDetail.${shortcut.id}`, { name: shortcut.label })
              }
              data-shortcut={shortcut.id}
              onClick={() => handleShortcut(shortcut)}
            >
              {t(`rail.${shortcut.id}`)}
            </Button>
          ))}
          <Button
            className={styles.cell}
            variant="ghost"
            icon="shuffle"
            disabled={busy}
            disabledReason={busyReason}
            aria-label={t("random")}
            title={busy ? undefined : t("random")}
            onClick={handleRandom}
          >
            {t("rail.random")}
          </Button>
          {showWindowButton ? (
            <Button
              className={styles.cell}
              variant="ghost"
              icon="compass"
              disabled={busy || windowState.kind === "starting"}
              disabledReason={busy ? busyReason : t("busy.sensors")}
              aria-label={t("window.enter")}
              title={busy ? undefined : t("window.enter")}
              onClick={() => void skyWindow.start()}
            >
              {t("rail.window")}
            </Button>
          ) : null}
        </section>
      )}

      {/*
        Cartel del punto elegido: sale de la mira, unido a ella por una linea, y
        la sigue cuando el cielo gira (`placeCallout`). Se lee de corrido: punto,
        constelacion, si el campo esta guardado, abrir, cerrar.
      */}
      <svg className={styles.leader} aria-hidden="true">
        <line ref={leaderRef} />
      </svg>
      {pick === null || windowOn ? null : (
        <section
          ref={calloutRef}
          className={styles.pick}
          aria-label={t("pick.title")}
          data-sky-cover="chrome"
        >
          <div className={styles.pickPoint}>
            <h2 className={styles.pickTitle}>{t("pick.title")}</h2>
            <p className={styles.pickCoordinates}>{formatPosition(pick.ra, pick.dec)}</p>
          </div>
          <div className={styles.pickInfo}>
            <p>
              {t("pick.constellation", {
                name: constellationLabel(constellationAt(pick), language),
              })}
            </p>
            {pickedStar === null ? null : (
              <p role="status">{t("pick.star", { name: pickedStar })}</p>
            )}
            <p className={styles.pickNote} role="status">
              {pickSaved === null ? t("pick.new") : t("pick.saved", { name: pickSaved.label })}
            </p>
          </div>
          <Button
            className={classNames(styles.action, styles.pickOpen)}
            variant="ghost"
            icon="target"
            disabled={busy}
            onClick={handlePickOpen}
          >
            {t("pick.open")}
          </Button>
          <IconButton
            className={styles.pickClose}
            icon="close"
            label={t("pick.close")}
            onClick={() => setPick(null)}
          />
        </section>
      )}

      <div ref={bottomRef} className={styles.bottom}>
        {windowOn ? (
          <main className={styles.windowDock}>
            {/* El unico boton relleno de la vista: abre lo que esta en la mira. */}
            <Button
              variant="primary"
              icon="target"
              disabled={busy}
              disabledReason={busyReason}
              onClick={handleWindowOpen}
            >
              {lockedTarget === undefined
                ? t("window.openHere")
                : t("window.open", { name: lockedTarget.label })}
            </Button>
          </main>
        ) : (
          <main className={styles.dock} data-sky-cover="chrome">
            {notices.map((notice) => (
              <p key={notice} className={styles.notice} role="status">
                <Icon name="alert" size={18} className={styles.noticeIcon} />
                <span>{notice}</span>
              </p>
            ))}
            {/*
              Los cinco objetos del desafio, siempre a la vista: al entrar la esfera
              muestra uno o dos marcadores y el resto queda fuera de la pantalla.
            */}
            <QuickLinkList label={t("markers.nav")} className={styles.featured}>
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
            <div className={styles.searchRow} onSubmit={handleEmptySubmit}>
              <SearchField
                className={styles.search}
                label={tEntry("search.label")}
                value={query}
                onChange={handleQueryChange}
                onSubmit={(text) => void handleSubmit(text)}
                submitLabel={tEntry("search.submit")}
                placeholder={phone ? tEntry("search.short") : example}
                hint={hintText}
                error={errorText}
                busy={busy}
                busyReason={busyReason}
                inputRef={inputRef}
                compact={phone}
              />
            </div>
          </main>
        )}
        {/* Siempre montado, para que el lector de pantalla anuncie el cambio de texto. */}
        <p className={styles.visuallyHidden} role="status">
          {liveText}
        </p>
        <p className={styles.credit} data-sky-cover="chrome">
          {t(phone ? "creditShort" : "credit")}
        </p>
      </div>
    </div>
  );
}
