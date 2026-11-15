// Pagina de desarrollo del visor: /?dev=viewer con `pnpm dev`.
//
// Carga los planos de muestra de src/test/fixtures (generados por el backend
// con datos reales de IRSA) y deja probar los modos, el estirado, el contraste
// y el acercamiento:
//
//   barnard   epoca 1, detector 3: con NaN (solo el 35 % tiene datos) y un
//             nucleo saturado de 152 pixeles en +Infinity
//   wise0855  epoca 2, detector 6: todo el plano con datos
//
// De cada campo hay un solo plano. Para los modos de comparacion, las epocas
// B, C y D son el mismo plano corrido unos pixeles: no son datos reales.
//
// Ademas compara, para cada modo y estirado, lo que dibuja cada camino
// (WebGL2 y canvas 2D, leido con readPixels) con la composicion de referencia
// en CPU, y deja el resultado en el DOM con atributos data-*:
//
//   main[data-dev-page]   data-status, data-renderer, data-webgl-version (el visor
//                         de la pagina), data-zoom, data-center-x, data-center-y
//                         y data-scale (la vista vigente)
//   [data-viewer-checks]  data-status, data-webgl-available, data-webgl-version,
//                         data-webgl-glsl, data-webgl-gpu, data-max-diff-webgl2,
//                         data-max-diff-canvas2d
//   [data-check]          data-renderer, data-sample, data-mode, data-stretch,
//                         data-highlight, data-scale, data-max-diff,
//                         data-different, data-pixels
//
// El estado inicial se puede fijar en la URL, para sacar capturas:
//
//   sample     barnard | wise0855
//   compose    single | difference | sum | redcyan
//   plane      0 a 3 (A a D), para el modo de un plano
//   stretch    linear | log | asinh
//   contrast   0 a 1
//   home       1 (cubo entero) | 2 (vista de 5 minutos)
//   renderer   webgl2 | canvas2d
//   highlight  none | noData | saturated
//   marks      0 oculta el contorno de saturacion y la posicion del objeto
//   ui         0 oculta los paneles
//   lang       es | en

import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type GridShape, planeByteLength, planeView } from "@/api/binary";
import { fieldMetaSchema, trackResponseSchema } from "@/api/schema";
import { type Display, isListed, type SaturatedRegion } from "@/api/types";
import type { DevPage } from "@/dev/devPages";
import { registerDevTexts } from "@/dev/devTexts";
import { useLanguage } from "@/i18n/useLanguage";
import { formatDecimal, formatInteger } from "@/lib/format";
import barnardMeta from "@/test/fixtures/barnard/meta.json";
import barnardTrack from "@/test/fixtures/barnard/track_name-barnard-s-star.json";
import wiseMeta from "@/test/fixtures/wise0855/meta.json";
import wiseTrack from "@/test/fixtures/wise0855/track_wisea-j085510-74-071442-5.json";
import { createCanvas2dRenderer } from "./canvas2dRenderer";
import {
  NO_COLOR,
  NO_DATA_COLOR_VARIABLE,
  type Rgb,
  type Rgba,
  readCssColor,
  toRgb,
} from "./colors";
import { composeScene, type ImageSize, SCENE_MODES, type Scene, type SceneMode } from "./compose";
import { ImageViewer, type ImageViewerHandle, type ViewerOverlay } from "./ImageViewer";
import { MASK_NO_DATA, MASK_SATURATED, type PlaneImage, toPlaneImage } from "./planeImage";
import type { RendererInfo, RendererKind, SceneRenderer } from "./renderer";
import {
  contrastCuts,
  DEFAULT_CONTRAST,
  DEFAULT_STRETCH,
  MAX_CONTRAST,
  MIN_CONTRAST,
  STRETCH_KINDS,
  type StretchKind,
} from "./stretch";
import { homeView, imageToScreen, KEY_ZOOM_STEP, type Point, viewTransform } from "./view";
import viewerDevEn from "./viewerDev.en.json";
import viewerDevEs from "./viewerDev.es.json";
import styles from "./viewerDevPage.module.css";
import { createWebglRenderer } from "./webglRenderer";

// Los textos de la pagina estan al lado y se registran al cargar este modulo:
// no van en src/i18n/resources.ts, que viaja en el sitio compilado.
registerDevTexts("viewerDev", { es: viewerDevEs, en: viewerDevEn });

// ---- Datos de muestra ------------------------------------------------------

const SAMPLE_IDS = ["barnard", "wise0855"] as const;
type SampleId = (typeof SAMPLE_IDS)[number];

/**
 * Carpeta de los datos de muestra, como la sirve `pnpm dev`. Los planos se
 * piden por su ruta dentro del proyecto y no se importan con `?url`: Vite
 * copiaria los archivos a dist/ al compilar, aunque esta pagina no exista en
 * el sitio compilado.
 */
const FIXTURES_URL = `${import.meta.env.BASE_URL}src/test/fixtures`;

interface SampleSource {
  readonly id: SampleId;
  readonly planeUrl: string;
  readonly meta: unknown;
  readonly track: unknown;
  readonly epoch: number;
  readonly detector: number;
}

const SOURCES: readonly SampleSource[] = [
  {
    id: "barnard",
    planeUrl: `${FIXTURES_URL}/barnard/plane_e1_d3.f32`,
    meta: barnardMeta,
    track: barnardTrack,
    epoch: 1,
    detector: 3,
  },
  {
    id: "wise0855",
    planeUrl: `${FIXTURES_URL}/wise0855/plane_e2_d6.f32`,
    meta: wiseMeta,
    track: wiseTrack,
    epoch: 2,
    detector: 6,
  },
];

/** Nombre de cada plano de la escena y cuanto esta corrido, en pixeles (oeste, norte). */
const PLANES = [
  { letter: "A", dx: 0, dy: 0 },
  { letter: "B", dx: 3, dy: 2 },
  { letter: "C", dx: -2, dy: 4 },
  { letter: "D", dx: 5, dy: -3 },
] as const;

interface LoadedSample {
  readonly id: SampleId;
  readonly image: ImageSize;
  /** A es el plano real; B, C y D, el mismo plano corrido. */
  readonly planes: readonly PlaneImage[];
  /** Escala del detector (`detectors[].display`). */
  readonly display: Display;
  /** Regiones saturadas del plano real (`planes[].saturated`). */
  readonly saturated: readonly SaturatedRegion[];
  /** Posicion esperada del objeto en la epoca del plano (`/track`). */
  readonly position: Point | null;
}

/** Copia de un plano corrida `dx` columnas y `dy` filas; lo que entra por el borde queda sin datos. */
function shiftPlane(source: Float32Array, shape: GridShape, dx: number, dy: number): Float32Array {
  const [height, width] = shape;
  const shifted = new Float32Array(source.length).fill(Number.NaN);
  for (let y = 0; y < height; y += 1) {
    const fromY = y - dy;
    if (fromY < 0 || fromY >= height) continue;
    for (let x = 0; x < width; x += 1) {
      const fromX = x - dx;
      if (fromX < 0 || fromX >= width) continue;
      shifted[y * width + x] = source[fromY * width + fromX] as number;
    }
  }
  return shifted;
}

async function loadSample(source: SampleSource): Promise<LoadedSample> {
  const meta = fieldMetaSchema.parse(source.meta);
  if (!isListed(meta)) throw new Error(`${source.id}: los metadatos no traen la grilla`);
  const shape = meta.grid.shape;
  const display = meta.detectors.find((item) => item.detector === source.detector)?.display;
  if (!display) throw new Error(`${source.id}: el detector ${source.detector} no tiene escala`);

  const response = await fetch(source.planeUrl);
  if (!response.ok) throw new Error(`${source.id}: el plano respondio ${response.status}`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== planeByteLength(shape)) {
    throw new RangeError(`${source.id}: el plano tiene ${buffer.byteLength} bytes`);
  }
  const values = planeView(buffer, shape);

  const plane = meta.planes.find(
    (item) => item.epoch === source.epoch && item.detector === source.detector,
  );
  const track = trackResponseSchema.parse(source.track);
  const position = track.positions.find((item) => item.epoch === source.epoch);

  return {
    id: source.id,
    image: { width: shape[1], height: shape[0] },
    planes: PLANES.map(({ dx, dy }) =>
      toPlaneImage(dx === 0 && dy === 0 ? values : shiftPlane(values, shape, dx, dy), shape),
    ),
    display,
    saturated: plane?.saturated ?? [],
    position: position ? { x: position.x, y: position.y } : null,
  };
}

// ---- Escena ----------------------------------------------------------------

const HIGHLIGHTS = ["none", "noData", "saturated"] as const;
type HighlightKind = (typeof HIGHLIGHTS)[number];

const RENDERERS = ["webgl2", "canvas2d"] as const satisfies readonly RendererKind[];

const HOME_ZOOMS = [1, 2] as const;
type HomeZoom = (typeof HOME_ZOOMS)[number];

interface Settings {
  readonly sample: SampleId;
  readonly mode: SceneMode;
  /** Plano que se muestra en el modo de un plano: indice dentro de `PLANES`. */
  readonly plane: number;
  readonly stretch: StretchKind;
  readonly contrast: number;
  readonly highlight: HighlightKind;
}

interface Colors {
  readonly noData: Rgb;
  readonly highlight: Rgba;
}

/** Colores de tokens.css: el vacio y, para el resaltado, el blanco al 32 % de hairline-strong. */
function readColors(): Colors {
  return {
    noData: toRgb(readCssColor(NO_DATA_COLOR_VARIABLE) ?? NO_COLOR),
    highlight: readCssColor("--color-hairline-strong") ?? NO_COLOR,
  };
}

const highlightMasks = new WeakMap<PlaneImage, Map<number, Uint8Array>>();

/** Mascara de resaltado con los pixeles de un plano que tienen ese valor de mascara. */
function highlightMask(plane: PlaneImage, value: number): Uint8Array {
  let byValue = highlightMasks.get(plane);
  if (byValue === undefined) {
    byValue = new Map();
    highlightMasks.set(plane, byValue);
  }
  let mask = byValue.get(value);
  if (mask === undefined) {
    mask = plane.mask.map((flag) => (flag === value ? 1 : 0));
    byValue.set(value, mask);
  }
  return mask;
}

function buildScene(sample: LoadedSample, settings: Settings, colors: Colors): Scene {
  const first = sample.planes[0] as PlaneImage;
  const second = sample.planes[1] as PlaneImage;
  const planes =
    settings.mode === "single"
      ? [sample.planes[settings.plane] ?? first]
      : settings.mode === "sum"
        ? sample.planes
        : [first, second];
  const shown = planes[0] as PlaneImage;
  return {
    mode: settings.mode,
    planes,
    stretch: settings.stretch,
    cuts: contrastCuts(sample.display, settings.contrast),
    noDataColor: colors.noData,
    highlight:
      settings.highlight === "none"
        ? null
        : {
            mask: highlightMask(
              shown,
              settings.highlight === "noData" ? MASK_NO_DATA : MASK_SATURATED,
            ),
            color: colors.highlight,
          },
  };
}

// ---- Comparacion con la referencia -----------------------------------------

interface CheckResult {
  readonly renderer: RendererKind;
  readonly sample: SampleId;
  readonly mode: SceneMode;
  readonly stretch: StretchKind;
  readonly highlight: boolean;
  /** Pixeles de pantalla por pixel de imagen al dibujar. */
  readonly scale: number;
  /** Mayor diferencia en un canal, de 0 a 255. -1 si no se pudo leer. */
  readonly maxDiff: number;
  /** Pixeles con alguna diferencia. */
  readonly different: number;
  readonly pixels: number;
}

interface Checks {
  readonly results: readonly CheckResult[];
  /** Con que dibujo WebGL2, o null si el navegador no lo da. */
  readonly webgl: RendererInfo | null;
}

/** Contraste con el que se hacen las comparaciones. */
const CHECK_CONTRAST = DEFAULT_CONTRAST;

/** Dibuja una escena y la compara con la referencia, pixel por pixel. */
function compare(renderer: SceneRenderer, scene: Scene, image: ImageSize, scale: number) {
  const viewport = { width: image.width * scale, height: image.height * scale };
  renderer.draw({
    scene,
    transform: viewTransform(homeView(image), image, viewport),
    viewport,
    pixelRatio: 1,
  });
  const snapshot = renderer.readPixels();
  const reference = composeScene(scene);
  if (snapshot === null || snapshot.width !== viewport.width) {
    return { maxDiff: -1, different: 0, pixels: 0 };
  }
  let maxDiff = 0;
  let different = 0;
  for (let y = 0; y < snapshot.height; y += 1) {
    const row = Math.floor(y / scale);
    for (let x = 0; x < snapshot.width; x += 1) {
      const drawn = (y * snapshot.width + x) * 4;
      const expected = (row * image.width + Math.floor(x / scale)) * 4;
      let worst = 0;
      for (let channel = 0; channel < 4; channel += 1) {
        const diff = Math.abs(
          (snapshot.data[drawn + channel] as number) - (reference[expected + channel] as number),
        );
        if (diff > worst) worst = diff;
      }
      if (worst > 0) different += 1;
      if (worst > maxDiff) maxDiff = worst;
    }
  }
  return { maxDiff, different, pixels: snapshot.width * snapshot.height };
}

/**
 * Compara los dos caminos de dibujo con la referencia, sobre un canvas aparte
 * del tamano de la imagen: cada modo con cada estirado, cada modo con
 * resaltado, y un plano ampliado 3 veces para comprobar el encuadre.
 */
function runChecks(samples: readonly LoadedSample[], colors: Colors): Checks {
  const results: CheckResult[] = [];
  let webgl: RendererInfo | null = null;

  for (const kind of RENDERERS) {
    const canvas = document.createElement("canvas");
    // Cada comprobacion lee los pixeles del canvas: el de canvas 2D se pide
    // preparado para eso, o el navegador deja un aviso en la consola.
    const renderer =
      kind === "webgl2"
        ? createWebglRenderer(canvas)
        : createCanvas2dRenderer(canvas, { willReadFrequently: true });
    if (renderer === null) continue;
    if (kind === "webgl2") webgl = renderer.info;

    const check = (
      sample: LoadedSample,
      mode: SceneMode,
      stretch: StretchKind,
      highlight: boolean,
      scale: number,
    ): void => {
      const scene = buildScene(
        sample,
        {
          sample: sample.id,
          mode,
          plane: 0,
          stretch,
          contrast: CHECK_CONTRAST,
          highlight: highlight ? "noData" : "none",
        },
        colors,
      );
      results.push({
        renderer: kind,
        sample: sample.id,
        mode,
        stretch,
        highlight,
        scale,
        ...compare(renderer, scene, sample.image, scale),
      });
    };

    for (const sample of samples) {
      for (const mode of SCENE_MODES) {
        for (const stretch of STRETCH_KINDS) check(sample, mode, stretch, false, 1);
        check(sample, mode, "asinh", true, 1);
      }
      check(sample, "single", "asinh", false, 3);
    }

    renderer.dispose();
    // Los navegadores admiten pocos contextos de WebGL a la vez: este no hace falta mas.
    if (kind === "webgl2") {
      canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    }
  }
  return { results, webgl };
}

function worstDiff(results: readonly CheckResult[], renderer: RendererKind): number | null {
  const own = results.filter((result) => result.renderer === renderer);
  if (own.length === 0) return null;
  // Una lectura fallida (-1) cuenta como la peor.
  return own.some((result) => result.maxDiff < 0)
    ? -1
    : Math.max(...own.map((result) => result.maxDiff));
}

// ---- Estado inicial desde la URL -------------------------------------------

function pick<T extends string>(value: string | null, options: readonly T[], fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

function readNumber(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value === null || value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

interface InitialState {
  readonly settings: Settings;
  readonly homeZoom: HomeZoom;
  readonly renderer: RendererKind;
  readonly marks: boolean;
  readonly ui: boolean;
}

function readInitialState(search: string): InitialState {
  const params = new URLSearchParams(search);
  return {
    settings: {
      sample: pick(params.get("sample"), SAMPLE_IDS, "barnard"),
      mode: pick(params.get("compose"), SCENE_MODES, "single"),
      plane: Math.round(readNumber(params.get("plane"), 0, 0, PLANES.length - 1)),
      stretch: pick(params.get("stretch"), STRETCH_KINDS, DEFAULT_STRETCH),
      contrast: readNumber(params.get("contrast"), DEFAULT_CONTRAST, MIN_CONTRAST, MAX_CONTRAST),
      highlight: pick(params.get("highlight"), HIGHLIGHTS, "none"),
    },
    homeZoom: params.get("home") === "2" ? 2 : 1,
    renderer: pick(params.get("renderer"), RENDERERS, "webgl2"),
    marks: params.get("marks") !== "0",
    ui: params.get("ui") !== "0",
  };
}

// ---- Controles -------------------------------------------------------------

interface SelectFieldProps<T extends string | number> {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (value: T) => void;
}

function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: SelectFieldProps<T>) {
  const id = useId();
  return (
    <>
      <label className={`${styles.label} type-body-sm`} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={`${styles.control} type-body-sm`}
        value={String(value)}
        onChange={(event) => {
          const chosen = options.find((option) => String(option.value) === event.target.value);
          if (chosen) onChange(chosen.value);
        }}
      >
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    </>
  );
}

// ---- Pagina ----------------------------------------------------------------

function ViewerDevPage() {
  const { t } = useTranslation("viewerDev");
  const language = useLanguage();
  const [initial] = useState(() => readInitialState(window.location.search));
  const [colors] = useState(readColors);

  const [samples, setSamples] = useState<readonly LoadedSample[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [settings, setSettings] = useState<Settings>(initial.settings);
  const [homeZoom, setHomeZoom] = useState<HomeZoom>(initial.homeZoom);
  const [renderer, setRenderer] = useState<RendererKind>(initial.renderer);
  const [marks, setMarks] = useState(initial.marks);
  const [blink, setBlink] = useState(false);
  const [info, setInfo] = useState<RendererInfo | null>(null);
  const [overlay, setOverlay] = useState<ViewerOverlay | null>(null);
  const [checks, setChecks] = useState<Checks | null>(null);

  const viewerRef = useRef<ImageViewerHandle>(null);
  const helpId = useId();
  const contrastId = useId();
  const marksId = useId();
  const blinkId = useId();

  useEffect(() => {
    let cancelled = false;
    Promise.all(SOURCES.map(loadSample))
      .then((loaded) => {
        if (!cancelled) setSamples(loaded);
      })
      .catch((error: unknown) => {
        console.error("visor: no se pudieron cargar los planos de muestra", error);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (samples !== null) setChecks(runChecks(samples, colors));
  }, [samples, colors]);

  // Parpadeo entre A y B: cambia de plano sin tocar nada mas.
  const blinking = blink && settings.mode === "single";
  useEffect(() => {
    if (!blinking) return;
    const timer = window.setInterval(() => {
      setSettings((current) => ({ ...current, plane: current.plane === 0 ? 1 : 0 }));
    }, 400);
    return () => window.clearInterval(timer);
  }, [blinking]);

  const sample = samples?.find((item) => item.id === settings.sample) ?? null;
  const scene = useMemo(
    () => (sample === null ? null : buildScene(sample, settings, colors)),
    [sample, settings, colors],
  );

  const update = (change: Partial<Settings>): void => {
    setSettings((current) => ({ ...current, ...change }));
  };

  const status = failed ? "error" : samples === null ? "loading" : "ready";
  const webglDiff = checks === null ? null : worstDiff(checks.results, "webgl2");
  const canvasDiff = checks === null ? null : worstDiff(checks.results, "canvas2d");
  const sampleLabel = t(`samples.${settings.sample}`);

  const renderMarks = (current: ViewerOverlay): ReactNode => {
    if (!marks || sample === null) return null;
    const position =
      sample.position === null
        ? null
        : imageToScreen(current.transform, sample.position.x, sample.position.y);
    return (
      <svg className={styles.marks} aria-hidden="true">
        {sample.saturated.map((region) => {
          const center = imageToScreen(current.transform, region.x, region.y);
          return (
            <circle
              key={`${region.x}-${region.y}`}
              className={styles.saturated}
              cx={center.x}
              cy={center.y}
              r={region.radius_px * current.transform.scale}
            />
          );
        })}
        {position === null ? null : (
          <circle className={styles.position} cx={position.x} cy={position.y} r={4} />
        )}
      </svg>
    );
  };

  return (
    <main
      className={styles.page}
      data-dev-page="viewer"
      data-status={status}
      data-renderer={info?.kind ?? ""}
      data-webgl-version={info?.version ?? ""}
      data-zoom={overlay?.view.zoom ?? ""}
      data-center-x={overlay?.view.centerX ?? ""}
      data-center-y={overlay?.view.centerY ?? ""}
      data-scale={overlay?.transform.scale ?? ""}
    >
      <div className={styles.viewer}>
        {scene === null ? (
          <p className={`${styles.status} type-body`} role="status">
            {failed ? t("status.error") : t("status.loading")}
          </p>
        ) : (
          <ImageViewer
            ref={viewerRef}
            scene={scene}
            homeZoom={homeZoom}
            renderer={renderer}
            ariaLabel={t("viewer.label", { sample: sampleLabel })}
            ariaDescribedBy={helpId}
            onRendererChange={setInfo}
            onOverlayChange={setOverlay}
          >
            {renderMarks}
          </ImageViewer>
        )}
      </div>

      <div className={styles.panels} hidden={!initial.ui}>
        <section className={styles.panel}>
          <h1 className={`${styles.heading} type-label-cap`}>{t("title")}</h1>
          <div className={styles.fields}>
            <SelectField
              label={t("controls.sample")}
              value={settings.sample}
              options={SAMPLE_IDS.map((value) => ({ value, label: t(`samples.${value}`) }))}
              onChange={(value) => update({ sample: value })}
            />
            <SelectField
              label={t("controls.mode")}
              value={settings.mode}
              options={SCENE_MODES.map((value) => ({ value, label: t(`modes.${value}`) }))}
              onChange={(value) => update({ mode: value })}
            />
            {settings.mode === "single" ? (
              <SelectField
                label={t("controls.plane")}
                value={settings.plane}
                options={PLANES.map((plane, index) => ({ value: index, label: plane.letter }))}
                onChange={(value) => update({ plane: value })}
              />
            ) : null}
            <SelectField
              label={t("controls.stretch")}
              value={settings.stretch}
              options={STRETCH_KINDS.map((value) => ({ value, label: t(`stretches.${value}`) }))}
              onChange={(value) => update({ stretch: value })}
            />
            <label className={`${styles.label} type-body-sm`} htmlFor={contrastId}>
              {t("controls.contrast")}
            </label>
            <div className={styles.rangeRow}>
              <input
                id={contrastId}
                className={styles.range}
                type="range"
                min={MIN_CONTRAST}
                max={MAX_CONTRAST}
                step={0.01}
                value={settings.contrast}
                aria-valuetext={formatDecimal(settings.contrast, language, 2)}
                onChange={(event) => update({ contrast: Number(event.target.value) })}
              />
              <output className="type-data" htmlFor={contrastId}>
                {formatDecimal(settings.contrast, language, 2)}
              </output>
            </div>
            <SelectField
              label={t("controls.view")}
              value={homeZoom}
              options={[
                { value: 1 as HomeZoom, label: t("views.ten") },
                { value: 2 as HomeZoom, label: t("views.five") },
              ]}
              onChange={setHomeZoom}
            />
            <SelectField
              label={t("controls.renderer")}
              value={renderer}
              options={RENDERERS.map((value) => ({ value, label: t(`renderers.${value}`) }))}
              onChange={setRenderer}
            />
            <SelectField
              label={t("controls.highlight")}
              value={settings.highlight}
              options={HIGHLIGHTS.map((value) => ({ value, label: t(`highlights.${value}`) }))}
              onChange={(value) => update({ highlight: value })}
            />
          </div>

          <div className={styles.buttons}>
            <button
              type="button"
              className={`${styles.button} type-label-cap`}
              onClick={() => viewerRef.current?.zoomBy(KEY_ZOOM_STEP)}
            >
              {t("controls.zoomIn")}
            </button>
            <button
              type="button"
              className={`${styles.button} type-label-cap`}
              onClick={() => viewerRef.current?.zoomBy(1 / KEY_ZOOM_STEP)}
            >
              {t("controls.zoomOut")}
            </button>
            <button
              type="button"
              className={`${styles.button} type-label-cap`}
              onClick={() => viewerRef.current?.resetView()}
            >
              {t("controls.reset")}
            </button>
          </div>

          <div className={`${styles.check} type-body-sm`}>
            <input
              id={marksId}
              type="checkbox"
              checked={marks}
              onChange={(event) => setMarks(event.target.checked)}
            />
            <label htmlFor={marksId}>{t("controls.annotations")}</label>
          </div>
          <div className={`${styles.check} type-body-sm`}>
            <input
              id={blinkId}
              type="checkbox"
              checked={blink}
              disabled={settings.mode !== "single"}
              onChange={(event) => setBlink(event.target.checked)}
            />
            <label htmlFor={blinkId}>{t("controls.blink")}</label>
          </div>

          <p className={`${styles.note} type-body-sm`}>{t("note.synthetic")}</p>
          <p id={helpId} className={`${styles.note} type-body-sm`}>
            {t("viewer.help")}
          </p>

          <dl className={`${styles.readout} type-body-sm`}>
            <dt>{t("readout.renderer")}</dt>
            <dd>{info === null ? t("readout.none") : t(`renderers.${info.kind}`)}</dd>
            <dt>{t("readout.version")}</dt>
            <dd className="type-data-sm">{info?.version ?? t("readout.none")}</dd>
            <dt>{t("readout.cuts")}</dt>
            <dd className="type-data">
              {scene === null
                ? t("readout.none")
                : `${formatDecimal(scene.cuts.low, language, 3)} / ${formatDecimal(scene.cuts.high, language, 3)}`}
            </dd>
            <dt>{t("readout.zoom")}</dt>
            <dd className="type-data">
              {overlay === null ? t("readout.none") : formatDecimal(overlay.view.zoom, language, 2)}
            </dd>
          </dl>
        </section>

        <section
          className={styles.panel}
          data-viewer-checks=""
          data-status={checks === null ? "pending" : "done"}
          data-webgl-available={checks === null ? "" : String(checks.webgl !== null)}
          data-webgl-version={checks?.webgl?.version ?? ""}
          data-webgl-glsl={checks?.webgl?.shadingLanguageVersion ?? ""}
          data-webgl-gpu={checks?.webgl?.gpu ?? ""}
          data-max-diff-webgl2={webglDiff ?? ""}
          data-max-diff-canvas2d={canvasDiff ?? ""}
        >
          <h2 className={`${styles.heading} type-label-cap`}>{t("checks.title")}</h2>
          <p className={`${styles.label} type-body-sm`}>{t("checks.description")}</p>
          {checks === null ? (
            <p className={`${styles.summary} type-body-sm`} role="status">
              {t("checks.pending")}
            </p>
          ) : (
            <>
              {checks.webgl === null ? (
                <p className={`${styles.summary} type-body-sm`}>{t("checks.unavailable")}</p>
              ) : null}
              {RENDERERS.map((kind) => {
                const worst = worstDiff(checks.results, kind);
                if (worst === null) return null;
                return (
                  <p key={kind} className={`${styles.summary} type-body-sm`}>
                    {t("checks.summary", {
                      renderer: t(`renderers.${kind}`),
                      maxDiff: formatInteger(worst),
                      count: formatInteger(
                        checks.results.filter((result) => result.renderer === kind).length,
                      ),
                    })}
                  </p>
                );
              })}
              <details className={styles.details}>
                <summary className="type-body-sm">{t("checks.details")}</summary>
                <div className={styles.tableScroll}>
                  <table className={`${styles.table} type-data-sm`}>
                    <thead>
                      <tr>
                        <th scope="col">{t("checks.column.renderer")}</th>
                        <th scope="col">{t("checks.column.sample")}</th>
                        <th scope="col">{t("checks.column.mode")}</th>
                        <th scope="col">{t("checks.column.stretch")}</th>
                        <th scope="col">{t("checks.column.highlight")}</th>
                        <th scope="col">{t("checks.column.scale")}</th>
                        <th scope="col">{t("checks.column.maxDiff")}</th>
                        <th scope="col">{t("checks.column.different")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {checks.results.map((result) => (
                        <tr
                          key={`${result.renderer}-${result.sample}-${result.mode}-${result.stretch}-${result.highlight}-${result.scale}`}
                          data-check=""
                          data-renderer={result.renderer}
                          data-sample={result.sample}
                          data-mode={result.mode}
                          data-stretch={result.stretch}
                          data-highlight={String(result.highlight)}
                          data-scale={result.scale}
                          data-max-diff={result.maxDiff}
                          data-different={result.different}
                          data-pixels={result.pixels}
                        >
                          <td>{t(`renderers.${result.renderer}`)}</td>
                          <td>{result.sample}</td>
                          <td>{result.mode}</td>
                          <td>{result.stretch}</td>
                          <td>{result.highlight ? t("checks.yes") : t("checks.no")}</td>
                          <td>{formatInteger(result.scale)}</td>
                          <td>{formatInteger(result.maxDiff)}</td>
                          <td>{formatInteger(result.different)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

export const devPage: DevPage = { Component: ViewerDevPage };
