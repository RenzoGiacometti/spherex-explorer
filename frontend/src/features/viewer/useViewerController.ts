// Estado de la pantalla del visor que no esta en el store del campo: el
// reproductor, mantener apretado, el viaje entre misiones y la cortina
// visible/infrarrojo. Con eso, la URL (modo, epoca actual, epoca de referencia,
// estirado, contraste, capa de flags y capa de Gaia prendidas) y los planos
// bajados arma lo que se ve (viewModel.ts) y la escena que dibuja ImageViewer.
//
// Se usa una sola vez, en ViewerPage, que reparte el resultado a los paneles.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type BandPlane,
  selectBandInfo,
  selectBandPlanes,
  selectPreview,
  type VisiblePreview,
} from "@/data/selectors";
import {
  type ContextDocument,
  clampCurtain,
  curtainLayer,
  DEFAULT_ARROW_STEP,
  DEFAULT_CURTAIN,
  type GaiaCatalog,
  type JourneyFrame,
  journeyLayers,
  mjdToYear,
  type OpticalLayer,
  opticalFrame,
  orderFrames,
  spherexFrame,
  surveyFrame,
  type TargetOffset,
  targetOffset,
  targetOutsideField,
} from "@/features/context";
import { useFieldStore } from "@/state/fieldStore";
import { DEFAULT_MODE, useUrlState, type ViewMode } from "@/state/urlState";
import {
  NO_COLOR,
  NO_DATA_COLOR_VARIABLE,
  type Rgb,
  type Rgba,
  readCssColor,
  toRgb,
} from "@/viewer/colors";
import type { Scene } from "@/viewer/compose";
import { contrastCuts, type DisplayRange, type StretchKind } from "@/viewer/stretch";
import { type FieldContextStatus, useFieldContext } from "./useFieldContext";
import { type FlagLayer, useFlagLayer } from "./useFlagLayer";
import { useHoldKey } from "./useHoldKey";
import {
  contrastFromPercent,
  contrastToPercent,
  defaultStretchForMode,
  deriveView,
  stepEpoch,
  type ViewModel,
} from "./viewModel";

/** Velocidades del reproductor. */
export const PLAYBACK_SPEEDS = [0.5, 1, 2] as const;

export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export const DEFAULT_SPEED: PlaybackSpeed = 1;

/**
 * Tiempo que se ve cada epoca a velocidad 1x, en ms. Con 0,5x son 1,6 s y con
 * 2x, 0,4 s: mas rapido que eso el ojo deja de seguir una fuente que se mueve
 * un pixel.
 */
export const FRAME_MS = 800;

/**
 * Espera, en ms, entre el ultimo movimiento del control de contraste y su
 * escritura en la URL: arrastrarlo no reescribe el historial en cada paso (los
 * navegadores limitan cuantas veces se puede por segundo).
 */
export const CONTRAST_URL_DELAY_MS = 250;

/**
 * De donde sale lo que se dibuja: planos de SPHEREx, la vista provisoria de
 * otro relevamiento (contrato, seccion 4.10), una capa de otra mision del
 * viaje (2MASS o WISE, docs/contexto.md) o nada todavia.
 */
export type ImageSource = "spherex" | "preview" | "survey" | "none";

/**
 * Viaje entre misiones (modo `journey`): las placas del DSS, 2MASS, WISE y las
 * epocas de SPHEREx en orden de fecha. Al entrar arranca por la parada mas
 * antigua.
 */
export interface JourneyControl {
  /** Estado del contexto del campo: explica por que el modo no se puede elegir. */
  readonly status: FieldContextStatus;
  /** El campo tiene contexto guardado y la pantalla lo muestra: el modo se puede elegir. */
  readonly available: boolean;
  /** Cuadros del viaje; vacio fuera del modo. */
  readonly frames: readonly JourneyFrame[];
  /** Cuadro que se esta viendo, o null si la epoca actual no tiene cuadro. */
  readonly currentId: string | null;
  /** Cuadro de otra mision que se esta viendo; null si se ve una epoca de SPHEREx. */
  readonly survey: JourneyFrame | null;
  /** Placa del DSS que se esta viendo: su credito va siempre con la imagen. null si no es una placa. */
  readonly plate: OpticalLayer | null;
  /**
   * Si en la fecha de esa placa el objeto del campo estaba fuera del campo,
   * donde estaba respecto del centro; null si estaba adentro o no hay objeto.
   */
  readonly outside: TargetOffset | null;
  /** La capa de otra mision que se ve se guardo sin la posicion del objeto del campo. */
  readonly positionMissing: boolean;
  readonly playing: boolean;
  /** Elige un cuadro. Una epoca de SPHEREx pasa a ser la actual en la URL. */
  select(id: string): void;
  setPlaying(playing: boolean): void;
}

/**
 * Cortina visible/infrarrojo (modo `curtain`): de un lado la placa optica del
 * DSS y del otro la imagen de SPHEREx de la banda y la epoca que se ven.
 */
export interface CurtainControl {
  /** El campo tiene placa optica y la pantalla la muestra: el modo se puede elegir. */
  readonly available: boolean;
  /** El pedido de las placas opticas sigue en camino: todavia no se sabe si el campo tiene. */
  readonly pending: boolean;
  /** Placa del lado visible; null si el campo no tiene. Su credito va siempre con la imagen. */
  readonly plate: OpticalLayer | null;
  /** Lado visible: el cuadro de la placa (sin imagen mientras no llega). */
  readonly visible: JourneyFrame | null;
  /** Lado infrarrojo: la epoca de SPHEREx que se ve, en la banda elegida. */
  readonly infrared: JourneyFrame | null;
  /** Forma de la grilla `[ny, nx]` de las dos imagenes. */
  readonly shape: readonly [number, number] | null;
  /** Donde esta el divisor, de 0 (borde izquierdo) a 1. */
  readonly position: number;
  setPosition(position: number): void;
}

/** Capa de Gaia: fuentes del catalogo del campo con su movimiento propio. */
export interface GaiaControl {
  /** Estado del contexto del campo: explica por que la capa no se puede prender. */
  readonly status: FieldContextStatus;
  /** Catalogo del campo; null si no tiene o todavia no llego. */
  readonly catalog: GaiaCatalog | null;
  /** Grilla del campo segun el contexto, para ubicar las fuentes. */
  readonly grid: ContextDocument["grid"] | null;
  readonly on: boolean;
  setOn(on: boolean): void;
  /** Paso del largo de las flechas (`ARROW_YEAR_STEPS`). */
  readonly arrowStep: number;
  setArrowStep(step: number): void;
  /** Magnitud G limite y el recorrido que ofrece el catalogo. */
  readonly maxGMag: number;
  setMaxGMag(magnitude: number): void;
  readonly magRange: readonly [number, number];
  /** Anio juliano de la imagen que se ve: las fuentes se dibujan donde estaban. */
  readonly year: number;
}

export interface ViewerController {
  /**
   * Modo que se ve. Es el de la URL, salvo `journey` en un campo sin contexto
   * y `curtain` en un campo sin placa optica (o cualquiera de los dos en
   * `embed`), que caen a `blink`.
   */
  readonly mode: ViewMode;
  /** Planos de la banda actual, uno por epoca. */
  readonly entries: readonly BandPlane[];
  /** Epocas A y B, lo que se compone y lo que falta. */
  readonly view: ViewModel;
  /** Escena para ImageViewer; null si no hay nada que dibujar. */
  readonly scene: Scene | null;
  readonly source: ImageSource;
  /** Vista provisoria, si es lo que se esta viendo. */
  readonly preview: VisiblePreview | null;

  /** Cambia de modo en la URL. Fuera de `blink` el reproductor se detiene. */
  setMode(mode: ViewMode): void;

  // ---- Reproductor y epoca actual ----
  readonly playing: boolean;
  /** Solo se puede reproducir en `blink` y con mas de una epoca con imagen. */
  readonly canPlay: boolean;
  readonly speed: PlaybackSpeed;
  /** Al pausar, la epoca que se estaba viendo queda como actual en la URL. */
  setPlaying(playing: boolean): void;
  setSpeed(speed: PlaybackSpeed): void;
  /** Epoca anterior (-1) o siguiente (+1) entre las que tienen imagen. */
  step(direction: 1 | -1): void;
  /** Elige la epoca actual (A) y detiene el reproductor. */
  selectEpoch(epoch: number): void;

  // ---- Comparacion ----
  /** Elige la epoca de referencia (B): queda en la URL (`ref`). */
  setReference(epoch: number): void;
  /** Se esta viendo B en el modo `hold`. */
  readonly holding: boolean;
  setHolding(holding: boolean): void;

  // ---- Imagen ----
  /** Posicion del control de contraste, de 0 a 1 (`contrastCuts`). */
  readonly contrast: number;
  setContrast(contrast: number): void;
  /** Estirado: el elegido a mano (`stretch` en la URL) o, si no, el del modo. */
  readonly stretch: StretchKind;
  setStretch(stretch: StretchKind): void;
  /** Capa de flags: si esta prendida, que cubre y que flags hay en la imagen que se ve. */
  readonly flags: FlagLayer;

  // ---- Contexto de otras misiones ----
  readonly journey: JourneyControl;
  readonly curtain: CurtainControl;
  readonly gaia: GaiaControl;
}

/** Variable de tokens.css con el color claro de la trama de flags (`{colors.text}`). */
const HATCH_COLOR_VARIABLE = "--color-text";

/** Sin imagen de SPHEREx en pantalla no hay epocas de las que pedir flags. */
const NO_EPOCHS: readonly number[] = [];

const NO_FRAMES: readonly JourneyFrame[] = [];

/** Epoca de referencia de Gaia DR3 (features/context/gaia.ts): donde se dibuja si no hay fecha. */
const GAIA_REFERENCE_YEAR = 2016;

/** Magnitud G limite de partida de la capa de Gaia, y el recorrido si el contexto no lo trae. */
const DEFAULT_GAIA_MAGNITUDE = 17;
const FALLBACK_MAG_RANGE: readonly [number, number] = [5, 21];

/** Identificador del cuadro del viaje de una epoca de SPHEREx (`spherexFrame`). */
const SPHEREX_FRAME_ID = /^spherex-(\d+)$/;

/** Color de los pixeles sin datos, leido una vez de tokens.css. */
function readNoDataColor(): Rgb {
  return toRgb(readCssColor(NO_DATA_COLOR_VARIABLE) ?? NO_COLOR);
}

/**
 * Color claro de la trama de flags, leido una vez de tokens.css. La trama
 * alterna este color con el de vacio (DESIGN.md, "Capa de flags"). Si la
 * variable no se puede leer va el opuesto del vacio: los dos colores de la
 * trama tienen que distinguirse siempre.
 */
function readHatchColor(noData: Rgb): Rgba {
  const text = readCssColor(HATCH_COLOR_VARIABLE);
  if (text !== null && text[3] > 0) return [text[0], text[1], text[2], 1];
  return [1 - noData[0], 1 - noData[1], 1 - noData[2], 1];
}

/** El cuadro que sigue a `previous` entre las epocas con imagen, dando la vuelta. */
function nextFrame(frames: readonly number[], previous: number | null): number | null {
  const first = frames[0];
  if (first === undefined) return previous;
  if (previous === null) return first;
  const index = frames.indexOf(previous);
  if (index >= 0) return frames[(index + 1) % frames.length] ?? first;
  return frames.find((epoch) => epoch > previous) ?? first;
}

export function useViewerController(): ViewerController {
  const urlMode = useUrlState((state) => state.mode);
  const urlEpoch = useUrlState((state) => state.epoch);
  const urlReference = useUrlState((state) => state.ref);
  const urlStretch = useUrlState((state) => state.stretch);
  const urlContrast = useUrlState((state) => state.contrast);
  const flagsOn = useUrlState((state) => state.flags);
  const gaiaOn = useUrlState((state) => state.gaia);
  const embed = useUrlState((state) => state.embed);
  const update = useUrlState((state) => state.update);

  const request = useFieldStore((state) => state.request);
  const band = useFieldStore((state) => state.band);
  const gridShape = useFieldStore((state) => state.meta?.grid?.shape);
  const entries = useFieldStore(selectBandPlanes);
  const bandInfo = useFieldStore(selectBandInfo);
  const preview = useFieldStore(selectPreview);
  const context = useFieldContext();

  // El viaje entre misiones necesita el contexto del campo, y en `embed` no
  // hay donde poner su control. Mientras el contexto esta en camino el modo de
  // la URL se respeta; si resulta que no hay, cae a parpadeo.
  const journeyAvailable = context.status === "ready" && !embed;
  const journeyPending = !embed && (context.status === "loading" || context.status === "idle");

  const { document: contextDocument, layers: contextLayers, optical } = context;
  // Las capas del contexto solo sirven si estan en la grilla del campo abierto.
  const contextShape = contextDocument?.grid.shape;
  const sameGrid =
    contextShape !== undefined &&
    (gridShape === undefined ||
      (gridShape[0] === contextShape[0] && gridShape[1] === contextShape[1]));

  // La cortina necesita una placa optica con pixeles validos. Mientras el
  // pedido de las placas esta en camino el modo de la URL se respeta.
  const candidatePlate = optical === null || !sameGrid ? null : curtainLayer(optical);
  const curtainPlate =
    candidatePlate !== null && candidatePlate.display !== null ? candidatePlate : null;
  const curtainAvailable = journeyAvailable && curtainPlate !== null;
  const curtainPending = journeyPending || (journeyAvailable && context.opticalPending);
  const mode: ViewMode =
    (urlMode === "journey" && !journeyAvailable && !journeyPending) ||
    (urlMode === "curtain" && !curtainAvailable && !curtainPending)
      ? DEFAULT_MODE
      : urlMode;

  const [playing, setPlayingState] = useState(false);
  const [frame, setFrame] = useState<number | null>(null);
  const [speed, setSpeed] = useState<PlaybackSpeed>(DEFAULT_SPEED);
  const [holding, setHoldingState] = useState(false);
  // El contraste se mueve aca y llega a la URL con una demora corta.
  const [contrast, setContrastState] = useState(() => contrastFromPercent(urlContrast));
  const [seenUrlContrast, setSeenUrlContrast] = useState(urlContrast);
  const contrastTimer = useRef<number | null>(null);
  const [noDataColor] = useState(readNoDataColor);
  const [hatchColor] = useState(() => readHatchColor(noDataColor));
  /** Capa de otra mision elegida en el viaje; null si se ve una epoca de SPHEREx. */
  const [journeySurvey, setJourneySurvey] = useState<string | null>(null);
  const [journeyPlaying, setJourneyPlayingState] = useState(false);
  /** El viaje ya eligio su parada de arranque (la mas antigua) desde que se entro al modo. */
  const [journeyStarted, setJourneyStarted] = useState(false);
  const [curtainPosition, setCurtainPositionState] = useState(DEFAULT_CURTAIN);
  const [arrowStep, setArrowStep] = useState<number>(DEFAULT_ARROW_STEP);
  const [chosenMagnitude, setChosenMagnitude] = useState<number | null>(null);

  // La URL manda sobre el contraste cuando cambia desde afuera: un link, o
  // atras y adelante en el historial. Lo que escribe este control llega igual.
  if (seenUrlContrast !== urlContrast) {
    setSeenUrlContrast(urlContrast);
    setContrastState(contrastFromPercent(urlContrast));
  }

  // Otro campo: lo elegido para el anterior (cuadro, capa del viaje, magnitud
  // limite) ya no vale. El contraste, la velocidad y las capas prendidas son
  // gustos de la persona y quedan. La epoca de referencia la limpia la URL.
  const [seenRequest, setSeenRequest] = useState(request);
  if (seenRequest !== request) {
    setSeenRequest(request);
    setPlayingState(false);
    setFrame(null);
    setHoldingState(false);
    setJourneySurvey(null);
    setJourneyPlayingState(false);
    setJourneyStarted(false);
    setChosenMagnitude(null);
  }
  // El modo tambien cambia desde afuera (atras y adelante en el historial).
  if (playing && mode !== "blink") {
    setPlayingState(false);
    setFrame(null);
  }
  if (holding && mode !== "hold") setHoldingState(false);
  // Al salir del viaje se vuelve a SPHEREx: al entrar de nuevo arranca por la parada mas antigua.
  if (mode !== "journey" && (journeySurvey !== null || journeyPlaying || journeyStarted)) {
    setJourneySurvey(null);
    setJourneyPlayingState(false);
    setJourneyStarted(false);
  }

  const spherexView = useMemo(
    () =>
      deriveView({
        entries,
        mode,
        urlEpoch,
        frameEpoch: playing ? frame : null,
        chosenReference: urlReference,
        holding,
      }),
    [entries, mode, urlEpoch, playing, frame, urlReference, holding],
  );

  // ---- Viaje entre misiones -----------------------------------------------

  const journeyFrames = useMemo<readonly JourneyFrame[]>(() => {
    if (mode !== "journey") return NO_FRAMES;
    const list: JourneyFrame[] = [];
    if (contextDocument !== null && sameGrid) {
      // Las placas del DSS con fecha fiable: son las paradas mas antiguas.
      for (const layer of optical === null ? [] : journeyLayers(optical)) {
        if (layer.display === null) continue;
        const values = contextLayers.get(layer.key)?.values ?? null;
        list.push(opticalFrame(layer, contextDocument.grid.shape, values));
      }
      for (const layer of contextDocument.surveys) {
        // Sin escala de contraste la capa no tiene pixeles validos: no hay cuadro que mostrar.
        if (layer.display === null) continue;
        const values = contextLayers.get(layer.key)?.values ?? null;
        list.push(surveyFrame(layer, contextDocument.grid.shape, values));
      }
    }
    for (const entry of entries) {
      // Una epoca sin datos en la banda no es una parada del viaje.
      if (entry.plane?.status === "empty") continue;
      const image = entry.loaded?.image ?? null;
      list.push(
        spherexFrame({
          epoch: entry.epoch,
          detector: band,
          waveRangeUm: [bandInfo?.waveMinUm ?? 0, bandInfo?.waveMaxUm ?? 0],
          display: bandInfo?.display ?? null,
          shape: image === null ? [1, 1] : [image.height, image.width],
          values: image?.values ?? null,
        }),
      );
    }
    return orderFrames(list);
  }, [mode, contextDocument, optical, contextLayers, sameGrid, entries, band, bandInfo]);

  // Al entrar al viaje se arranca por la parada mas antigua (la placa de los
  // anios 50, si el campo la tiene): se espera a saber que paradas hay.
  if (mode === "journey" && !journeyStarted && journeyAvailable && !context.opticalPending) {
    setJourneyStarted(true);
    const first = journeyFrames[0];
    if (first !== undefined && first.mission !== "SPHEREx") setJourneySurvey(first.id);
  }

  const survey =
    journeySurvey === null
      ? null
      : (journeyFrames.find((item) => item.id === journeySurvey && item.mission !== "SPHEREx") ??
        null);
  const surveyImage = survey === null ? null : (contextLayers.get(survey.id)?.image ?? null);
  const surveyDisplay = survey?.image?.display ?? null;
  const surveyShown = survey !== null && surveyImage !== null && surveyDisplay !== null;

  // Con una capa de otra mision en pantalla no se compone ninguna epoca de
  // SPHEREx: no hay flags, mira ni espectro que mostrar sobre ella.
  const view = useMemo<ViewModel>(
    () =>
      survey === null
        ? spherexView
        : {
            ...spherexView,
            composition: null,
            issue: null,
            missing: surveyShown ? null : "pending",
            provisional: false,
          },
    [spherexView, survey, surveyShown],
  );

  const spherexFrameId = view.current === null ? null : `spherex-${view.current}`;
  const journeyCurrentId =
    survey?.id ??
    (journeyFrames.some((item) => item.id === spherexFrameId) ? spherexFrameId : null);

  const selectJourneyFrame = useCallback(
    (id: string) => {
      const match = SPHEREX_FRAME_ID.exec(id);
      if (match === null) {
        setJourneySurvey(id);
        return;
      }
      setJourneySurvey(null);
      update({ epoch: Number(match[1]) });
    },
    [update],
  );
  const setJourneyPlaying = useCallback((next: boolean) => setJourneyPlayingState(next), []);

  // Placa del DSS que se esta viendo en el viaje, y si el objeto del campo
  // estaba fuera del campo en esa fecha (Barnard, en 1950 y en 1991).
  const journeyPlate =
    survey === null || survey.mission !== "DSS"
      ? null
      : (optical?.layers.find((layer) => layer.key === survey.id) ?? null);
  const fieldCenter = contextDocument?.request ?? null;
  const journeyOutside = useMemo<TargetOffset | null>(
    () =>
      journeyPlate === null ||
      journeyPlate.target === null ||
      fieldCenter === null ||
      !targetOutsideField(journeyPlate)
        ? null
        : targetOffset(fieldCenter, journeyPlate.target),
    [journeyPlate, fieldCenter],
  );

  // ---- Cortina visible/infrarrojo -------------------------------------------

  const curtainOn = mode === "curtain";
  const curtainValues =
    curtainPlate === null ? null : (contextLayers.get(curtainPlate.key)?.values ?? null);
  const curtainVisible = useMemo<JourneyFrame | null>(
    () =>
      !curtainOn || curtainPlate === null || contextShape === undefined
        ? null
        : opticalFrame(curtainPlate, contextShape, curtainValues),
    [curtainOn, curtainPlate, contextShape, curtainValues],
  );
  const curtainEpoch = spherexView.displayed;
  const curtainInfrared = useMemo<JourneyFrame | null>(() => {
    if (!curtainOn) return null;
    const entry = entries.find((item) => item.epoch.epoch === curtainEpoch);
    if (entry === undefined) return null;
    const image = entry.loaded?.image ?? null;
    return spherexFrame({
      epoch: entry.epoch,
      detector: band,
      waveRangeUm: [bandInfo?.waveMinUm ?? 0, bandInfo?.waveMaxUm ?? 0],
      display: bandInfo?.display ?? null,
      shape: image === null ? [1, 1] : [image.height, image.width],
      values: image?.values ?? null,
    });
  }, [curtainOn, entries, curtainEpoch, band, bandInfo]);
  const setCurtainPosition = useCallback(
    (position: number) => setCurtainPositionState(clampCurtain(position)),
    [],
  );

  // ---- Reproductor --------------------------------------------------------

  const frames = view.imageEpochs;
  const framesRef = useRef(frames);
  useEffect(() => {
    framesRef.current = frames;
  }, [frames]);

  const active = playing && mode === "blink";
  useEffect(() => {
    if (!active) return;
    // Mientras reproduce solo cambia el cuadro: la URL no se reescribe en cada paso.
    const timer = window.setInterval(() => {
      setFrame((previous) => nextFrame(framesRef.current, previous));
    }, FRAME_MS / speed);
    return () => window.clearInterval(timer);
  }, [active, speed]);

  const canPlay = mode === "blink" && frames.length > 1;
  const { current, displayed } = view;

  const setPlaying = useCallback(
    (next: boolean) => {
      if (next) {
        if (!canPlay) return;
        setFrame(displayed);
        setPlayingState(true);
        return;
      }
      setPlayingState(false);
      setFrame(null);
      // Lo que se estaba viendo al pausar queda como epoca actual.
      if (displayed !== null) update({ epoch: displayed });
    },
    [canPlay, displayed, update],
  );

  const step = useCallback(
    (direction: 1 | -1) => {
      if (active) {
        setFrame(stepEpoch(entries, displayed, direction));
        return;
      }
      const next = stepEpoch(entries, current, direction);
      if (next !== null) update({ epoch: next });
    },
    [active, entries, displayed, current, update],
  );

  const selectEpoch = useCallback(
    (epoch: number) => {
      setPlayingState(false);
      setFrame(null);
      update({ epoch });
    },
    [update],
  );

  const setMode = useCallback(
    (next: ViewMode) => {
      // Sin contexto el viaje no se puede elegir, ni la cortina sin placa optica
      // (sus botones estan deshabilitados).
      if (next === "journey" && !journeyAvailable) return;
      if (next === "curtain" && !curtainAvailable) return;
      update({ mode: next });
    },
    [update, journeyAvailable, curtainAvailable],
  );

  // ---- Comparacion y estirado ---------------------------------------------

  const setReference = useCallback((epoch: number) => update({ ref: epoch }), [update]);
  // Diferencia y rojo/cian abren en lineal; lo elegido a mano manda en todos los modos.
  const stretch = urlStretch ?? defaultStretchForMode(mode);
  const setStretch = useCallback((next: StretchKind) => update({ stretch: next }), [update]);

  // ---- Contraste y capas, que van en la URL --------------------------------

  const setContrast = useCallback(
    (next: number) => {
      setContrastState(next);
      if (contrastTimer.current !== null) window.clearTimeout(contrastTimer.current);
      contrastTimer.current = window.setTimeout(() => {
        contrastTimer.current = null;
        update({ contrast: contrastToPercent(next) });
      }, CONTRAST_URL_DELAY_MS);
    },
    [update],
  );
  useEffect(
    () => () => {
      if (contrastTimer.current !== null) window.clearTimeout(contrastTimer.current);
    },
    [],
  );
  const setFlagsOn = useCallback((on: boolean) => update({ flags: on }), [update]);
  const setGaiaOn = useCallback((on: boolean) => update({ gaia: on }), [update]);

  // ---- Mantener apretado --------------------------------------------------

  const setHolding = useCallback((next: boolean) => setHoldingState(next), []);
  useHoldKey(mode === "hold", setHolding);

  // ---- Escena -------------------------------------------------------------

  const { composition } = view;
  const source: ImageSource =
    survey !== null
      ? surveyShown
        ? "survey"
        : "none"
      : composition
        ? "spherex"
        : preview !== null && preview.display !== null
          ? "preview"
          : "none";
  // La vista provisoria y las capas de otras misiones traen su propia escala:
  // sus valores no son los MJy/sr del detector.
  const display: DisplayRange | null =
    source === "survey"
      ? surveyDisplay
      : source === "preview"
        ? (preview?.display ?? null)
        : (bandInfo?.display ?? null);
  const previewImage = source === "preview" ? (preview?.image ?? null) : null;
  const shownSurveyImage = source === "survey" ? surveyImage : null;

  // ---- Capa de flags --------------------------------------------------------

  // Los flags son de los planos de SPHEREx que se ven: en una comparacion, de
  // todas las epocas que entran. La vista provisoria y las otras misiones no tienen.
  const flags = useFlagLayer(composition?.epochs ?? NO_EPOCHS, flagsOn, setFlagsOn);
  const flagMask = flags.mask;

  const scene = useMemo<Scene | null>(() => {
    if (display === null) return null;
    const cuts = contrastCuts(display, contrast);
    if (shownSurveyImage) {
      return { mode: "single", planes: [shownSurveyImage], stretch, cuts, noDataColor };
    }
    if (composition) {
      const first = composition.planes[0];
      // La trama solo va si la mascara es de esta grilla.
      const hatched =
        flagMask !== null && first !== undefined && flagMask.length === first.width * first.height;
      return {
        mode: composition.mode,
        planes: composition.planes,
        stretch,
        cuts,
        noDataColor,
        highlight: hatched ? { mask: flagMask, color: hatchColor, alternate: noDataColor } : null,
      };
    }
    if (previewImage) {
      return { mode: "single", planes: [previewImage], stretch, cuts, noDataColor };
    }
    return null;
  }, [
    composition,
    previewImage,
    shownSurveyImage,
    display,
    contrast,
    stretch,
    noDataColor,
    flagMask,
    hatchColor,
  ]);

  // ---- Capa de Gaia ---------------------------------------------------------

  // Las fuentes se dibujan donde estaban en la fecha de lo que se ve: la capa
  // de otra mision o la epoca de SPHEREx (en una comparacion, la actual).
  const shownEpoch =
    composition === null
      ? current
      : composition.mode === "single"
        ? (composition.epochs[0] ?? null)
        : current;
  const shownMjd = entries.find((entry) => entry.epoch.epoch === shownEpoch)?.epoch.mjd_mean;
  const gaiaYear =
    survey?.year ??
    (shownMjd === undefined
      ? (context.gaia?.ref_epoch ?? GAIA_REFERENCE_YEAR)
      : mjdToYear(shownMjd));
  const gaiaInfo = contextDocument?.gaia ?? null;
  const magMin = gaiaInfo?.g_mag_min ?? FALLBACK_MAG_RANGE[0];
  const magMax = gaiaInfo?.g_mag_max ?? FALLBACK_MAG_RANGE[1];
  const magRange = useMemo<readonly [number, number]>(() => [magMin, magMax], [magMin, magMax]);
  const maxGMag = chosenMagnitude ?? Math.min(DEFAULT_GAIA_MAGNITUDE, Math.ceil(magMax));

  const journey: JourneyControl = {
    status: context.status,
    available: journeyAvailable,
    frames: journeyFrames,
    currentId: journeyCurrentId,
    survey,
    plate: journeyPlate,
    outside: journeyOutside,
    positionMissing: survey?.positionMissing === true,
    playing: journeyPlaying && mode === "journey",
    select: selectJourneyFrame,
    setPlaying: setJourneyPlaying,
  };
  const curtain: CurtainControl = {
    available: curtainAvailable,
    pending: journeyAvailable && context.opticalPending,
    plate: curtainPlate,
    visible: curtainVisible,
    infrared: curtainInfrared,
    shape: contextShape ?? null,
    position: curtainPosition,
    setPosition: setCurtainPosition,
  };
  const gaia: GaiaControl = {
    status: context.status,
    catalog: sameGrid ? context.gaia : null,
    grid: sameGrid ? (contextDocument?.grid ?? null) : null,
    on: gaiaOn,
    setOn: setGaiaOn,
    arrowStep,
    setArrowStep,
    maxGMag,
    setMaxGMag: setChosenMagnitude,
    magRange,
    year: gaiaYear,
  };

  return {
    mode,
    entries,
    view,
    scene,
    source: scene === null ? "none" : source,
    preview: scene !== null && source === "preview" ? preview : null,
    setMode,
    playing: active,
    canPlay,
    speed,
    setPlaying,
    setSpeed,
    step,
    selectEpoch,
    setReference,
    holding,
    setHolding,
    contrast,
    setContrast,
    stretch,
    setStretch,
    flags,
    journey,
    curtain,
    gaia,
  };
}
