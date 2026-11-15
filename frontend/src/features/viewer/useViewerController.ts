// Estado de la pantalla del visor que no esta en la URL ni en el store del
// campo: el reproductor, la epoca de referencia, mantener apretado, el
// contraste, el estirado y la capa de flags. Con eso, la URL y los planos
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
import { useFieldStore } from "@/state/fieldStore";
import { useUrlState, type ViewMode } from "@/state/urlState";
import {
  NO_COLOR,
  NO_DATA_COLOR_VARIABLE,
  type Rgb,
  type Rgba,
  readCssColor,
  toRgb,
} from "@/viewer/colors";
import type { Scene } from "@/viewer/compose";
import {
  contrastCuts,
  DEFAULT_CONTRAST,
  DEFAULT_STRETCH,
  type DisplayRange,
  type StretchKind,
} from "@/viewer/stretch";
import { type FlagLayer, useFlagLayer } from "./useFlagLayer";
import { useHoldKey } from "./useHoldKey";
import { deriveView, stepEpoch, type ViewModel } from "./viewModel";

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
 * De donde sale lo que se dibuja: planos de SPHEREx, la vista provisoria de
 * otro relevamiento (contrato, seccion 4.10) o nada todavia.
 */
export type ImageSource = "spherex" | "preview" | "none";

export interface ViewerController {
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
  /** Elige la epoca de referencia (B). */
  setReference(epoch: number): void;
  /** Se esta viendo B en el modo `hold`. */
  readonly holding: boolean;
  setHolding(holding: boolean): void;

  // ---- Imagen ----
  /** Posicion del control de contraste, de 0 a 1 (`contrastCuts`). */
  readonly contrast: number;
  setContrast(contrast: number): void;
  readonly stretch: StretchKind;
  setStretch(stretch: StretchKind): void;
  /** Capa de flags: si esta prendida, que cubre y que flags hay en la imagen que se ve. */
  readonly flags: FlagLayer;
}

/** Variable de tokens.css con el color claro de la trama de flags (`{colors.text}`). */
const HATCH_COLOR_VARIABLE = "--color-text";

/** Sin imagen de SPHEREx en pantalla no hay epocas de las que pedir flags. */
const NO_EPOCHS: readonly number[] = [];

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
  const mode = useUrlState((state) => state.mode);
  const urlEpoch = useUrlState((state) => state.epoch);
  const update = useUrlState((state) => state.update);

  const request = useFieldStore((state) => state.request);
  const entries = useFieldStore(selectBandPlanes);
  const bandInfo = useFieldStore(selectBandInfo);
  const preview = useFieldStore(selectPreview);

  const [playing, setPlayingState] = useState(false);
  const [frame, setFrame] = useState<number | null>(null);
  const [speed, setSpeed] = useState<PlaybackSpeed>(DEFAULT_SPEED);
  const [chosenReference, setChosenReference] = useState<number | null>(null);
  const [holding, setHoldingState] = useState(false);
  const [contrast, setContrast] = useState(DEFAULT_CONTRAST);
  const [stretch, setStretch] = useState<StretchKind>(DEFAULT_STRETCH);
  const [noDataColor] = useState(readNoDataColor);
  const [hatchColor] = useState(() => readHatchColor(noDataColor));

  // Otro campo: lo elegido para el anterior (cuadro, referencia) ya no vale.
  // El contraste, el estirado y la velocidad son gustos de la persona y quedan.
  const [seenRequest, setSeenRequest] = useState(request);
  if (seenRequest !== request) {
    setSeenRequest(request);
    setPlayingState(false);
    setFrame(null);
    setChosenReference(null);
    setHoldingState(false);
  }
  // El modo tambien cambia desde afuera (atras y adelante en el historial).
  if (playing && mode !== "blink") {
    setPlayingState(false);
    setFrame(null);
  }
  if (holding && mode !== "hold") setHoldingState(false);

  const view = useMemo(
    () =>
      deriveView({
        entries,
        mode,
        urlEpoch,
        frameEpoch: playing ? frame : null,
        chosenReference,
        holding,
      }),
    [entries, mode, urlEpoch, playing, frame, chosenReference, holding],
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
      update({ mode: next });
    },
    [update],
  );

  // ---- Mantener apretado --------------------------------------------------

  const setHolding = useCallback((next: boolean) => setHoldingState(next), []);
  useHoldKey(mode === "hold", setHolding);

  // ---- Escena -------------------------------------------------------------

  const { composition } = view;
  const source: ImageSource = composition
    ? "spherex"
    : preview !== null && preview.display !== null
      ? "preview"
      : "none";
  // La vista provisoria trae su propia escala: sus valores no son MJy/sr.
  const display: DisplayRange | null =
    source === "preview" ? (preview?.display ?? null) : (bandInfo?.display ?? null);
  const previewImage = source === "preview" ? (preview?.image ?? null) : null;

  // ---- Capa de flags --------------------------------------------------------

  // Los flags son de los planos de SPHEREx que se ven: en una comparacion, de
  // todas las epocas que entran. La vista provisoria no tiene.
  const flags = useFlagLayer(composition?.epochs ?? NO_EPOCHS);
  const flagMask = flags.mask;

  const scene = useMemo<Scene | null>(() => {
    if (display === null) return null;
    const cuts = contrastCuts(display, contrast);
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
  }, [composition, previewImage, display, contrast, stretch, noDataColor, flagMask, hatchColor]);

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
    setReference: setChosenReference,
    holding,
    setHolding,
    contrast,
    setContrast,
    stretch,
    setStretch,
    flags,
  };
}
