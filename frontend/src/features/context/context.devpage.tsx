// Pagina de prueba del contexto de otras misiones: /?dev=context con `pnpm dev`.
//
// Muestra, para cada uno de los cinco objetos de prueba, el viaje entre
// misiones (2MASS, WISE y las epocas de SPHEREx, en orden de fecha) y la capa
// de Gaia DR3 con sus flechas de movimiento propio.
//
// Los datos llegan por las rutas reales, a traves del proxy de /api:
//
//   /api/context, /api/context/gaia, /api/survey   contexto precalculado
//   /api/field y /api/field/{id}/plane/{e}/{d}     epocas de SPHEREx, si el
//                                                  servidor tiene el campo armado
//
// Hace falta un backend que tenga las rutas de contexto. Hasta que esten
// montadas en la aplicacion principal, desde backend/:
//
//   uv run uvicorn app.context.devapp:app --port 8000
//
// El estado inicial se puede fijar en la URL, para sacar capturas:
//
//   object    barnard | epsindb | wise0855 | rwaur | rdra
//   frame     identificador del cuadro: twomass_ks, wise_w2, spherex-1, ...
//   band      1 a 6: detector de SPHEREx
//   gaia      0 apaga la capa de Gaia
//   arrow     0 a 8: paso del largo de las flechas (1, 3, 10, ... 10000 anios)
//   mag       magnitud G limite
//   contrast  0 a 1
//   target    0 oculta la posicion esperada del objeto
//   ui        0 oculta los paneles
//   lang      es | en
//
// Para comprobar desde afuera, el estado queda en el DOM:
//
//   main[data-dev-page="context"]  data-status (loading | ready | error),
//                                  data-object, data-frames, data-frame,
//                                  data-year, data-spherex (yes | no),
//                                  data-gaia-total

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import { isApiError } from "@/api/errors";
import { isListed, type ListedFieldMeta } from "@/api/types";
import { classNames, GlassPanel, ImageTag, SegmentedControl, Slider, Toggle } from "@/components";
import type { DevPage } from "@/dev/devPages";
import { useLanguage } from "@/i18n/useLanguage";
import { formatBand, formatPercent, formatWaveRange } from "@/lib/format";
import { DEFAULT_CONTRAST, MAX_CONTRAST, MIN_CONTRAST } from "@/viewer/stretch";
import { contextApi, type FieldGeometry } from "./contextApi";
import contextDevEn from "./contextDev.en.json";
import contextDevEs from "./contextDev.es.json";
import styles from "./contextDevPage.module.css";
import { FrameCanvas, type FrameLayout } from "./FrameCanvas";
import { DEFAULT_GAIA_LIMIT, GaiaControls, GaiaLayer } from "./GaiaLayer";
import { ARROW_YEAR_STEPS, arrowYearsForStep, DEFAULT_ARROW_STEP, gaiaMarkers } from "./gaia";
import {
  type FramePoint,
  type JourneyFrame,
  orderFrames,
  spherexFrame,
  surveyFrame,
} from "./journey";
import { frameBandText, frameDateText, MissionJourney } from "./MissionJourney";
import type { ContextDocument, GaiaCatalog } from "./schema";
import { registerTexts, useContextTexts, useTexts } from "./texts";

// Los textos de la pagina van al lado y se registran al cargar este modulo.
const DEV_NAMESPACE = "contextDev";
registerTexts(DEV_NAMESPACE, { es: contextDevEs, en: contextDevEn });

function useDevTexts() {
  return useTexts<typeof contextDevEs>(DEV_NAMESPACE);
}

// ---- Objetos de prueba -------------------------------------------------------

const OBJECTS = ["barnard", "epsindb", "wise0855", "rwaur", "rdra"] as const;
type ObjectAlias = (typeof OBJECTS)[number];

/** Detector de SPHEREx con el que arranca cada objeto: WISE 0855 solo se ve en B5 y B6. */
const DEFAULT_DETECTOR: Record<ObjectAlias, number> = {
  barnard: 3,
  epsindb: 3,
  wise0855: 6,
  rwaur: 3,
  rdra: 3,
};

const DETECTORS = [1, 2, 3, 4, 5, 6] as const;

// ---- Datos -------------------------------------------------------------------

interface LoadedContext {
  readonly alias: ObjectAlias;
  readonly geometry: FieldGeometry;
  readonly document: ContextDocument;
  readonly layers: ReadonlyMap<string, Float32Array>;
  readonly gaia: GaiaCatalog | null;
  /** Campo de SPHEREx ya armado, o null si el servidor no lo tiene. */
  readonly field: ListedFieldMeta | null;
}

async function loadContext(alias: ObjectAlias, signal: AbortSignal): Promise<LoadedContext> {
  const index = await contextApi.getIndex({ signal });
  const entry = index.fields.find((field) => field.alias === alias);
  if (entry === undefined) throw new Error(`no hay contexto guardado para ${alias}`);
  const geometry: FieldGeometry = { ra: entry.ra, dec: entry.dec, fov: entry.fov };
  const document = await contextApi.getContext(geometry, { signal });
  const shape = document.grid.shape;

  const [layers, gaia, field] = await Promise.all([
    Promise.all(
      document.surveys.map(
        async (layer) =>
          [layer.key, await contextApi.getLayer(geometry, layer.key, shape, { signal })] as const,
      ),
    ),
    document.gaia === null ? null : contextApi.getGaia(geometry, { signal }),
    api
      .requestField(
        { ra: entry.ra, dec: entry.dec, fov: entry.fov, band: DEFAULT_DETECTOR[alias] },
        { signal },
      )
      .then((response) => (isListed(response.meta) ? response.meta : null))
      .catch((error: unknown) => {
        // Sin el campo armado el viaje sigue con 2MASS y WISE; cualquier otro fallo si es un error.
        if (isApiError(error) && error.code === "not_found") return null;
        throw error;
      }),
  ]);
  return { alias, geometry, document, layers: new Map(layers), gaia, field };
}

/** Posicion esperada del objeto en `year`, extrapolando en linea recta entre dos capas del contexto. */
function extrapolateTarget(document: ContextDocument, year: number): FramePoint | null {
  const known = document.surveys.filter((layer) => layer.target !== null);
  const first = known[0];
  const last = known[known.length - 1];
  if (first?.target == null || last?.target == null || last.year === first.year) return null;
  const fraction = (year - first.year) / (last.year - first.year);
  return {
    x: first.target.x + (last.target.x - first.target.x) * fraction,
    y: first.target.y + (last.target.y - first.target.y) * fraction,
  };
}

// ---- Estado inicial desde la URL ---------------------------------------------

function pick<T extends string>(value: string | null, options: readonly T[], fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

function readNumber(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value === null || value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

interface InitialState {
  readonly alias: ObjectAlias;
  readonly frame: string | null;
  readonly detector: number | null;
  readonly gaia: boolean;
  readonly arrowStep: number;
  readonly maxGMag: number | null;
  readonly contrast: number;
  readonly target: boolean;
  readonly ui: boolean;
}

function readInitialState(search: string): InitialState {
  const params = new URLSearchParams(search);
  const band = params.get("band");
  const mag = params.get("mag");
  return {
    alias: pick(params.get("object"), OBJECTS, "barnard"),
    frame: params.get("frame"),
    detector: band === null ? null : Math.round(readNumber(band, 3, 1, 6)),
    gaia: params.get("gaia") !== "0",
    arrowStep: Math.round(
      readNumber(params.get("arrow"), DEFAULT_ARROW_STEP, 0, ARROW_YEAR_STEPS.length - 1),
    ),
    maxGMag: mag === null ? null : readNumber(mag, 17, 0, 25),
    contrast: readNumber(params.get("contrast"), DEFAULT_CONTRAST, MIN_CONTRAST, MAX_CONTRAST),
    target: params.get("target") !== "0",
    ui: params.get("ui") !== "0",
  };
}

/** Magnitud limite de partida: 17, o la mas debil del campo si es mas brillante. */
function defaultMagnitude(document: ContextDocument): number {
  const faintest = document.gaia?.g_mag_max ?? 17;
  return Math.min(17, Math.ceil(faintest));
}

// ---- Mira ----------------------------------------------------------------------

interface TargetMarkProps {
  readonly layout: FrameLayout;
  readonly point: FramePoint;
  readonly label: string;
}

/** Mira chica sobre la posicion esperada del objeto: circulo con cuatro marcas, en ambar. */
function TargetMark({ layout, point, label }: TargetMarkProps) {
  const center = layout.toScreen(point.x, point.y);
  const radius = 14;
  const tick = 6;
  const ticks = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ] as const;
  return (
    <svg
      className={styles.target}
      width={layout.width}
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label={label}
    >
      {(["targetUnder", "targetOver"] as const).map((kind) => (
        <g key={kind} className={styles[kind]}>
          <circle cx={center.x} cy={center.y} r={radius} />
          {ticks.map(([dx, dy]) => (
            <line
              key={`${dx}-${dy}`}
              x1={center.x + dx * (radius - tick / 2)}
              y1={center.y + dy * (radius - tick / 2)}
              x2={center.x + dx * (radius + tick / 2)}
              y2={center.y + dy * (radius + tick / 2)}
            />
          ))}
        </g>
      ))}
    </svg>
  );
}

// ---- Pagina --------------------------------------------------------------------

function ContextDevPage() {
  const t = useDevTexts();
  const tc = useContextTexts();
  const language = useLanguage();
  const [initial] = useState(() => readInitialState(window.location.search));

  const [alias, setAlias] = useState<ObjectAlias>(initial.alias);
  const [loaded, setLoaded] = useState<LoadedContext | null>(null);
  const [failed, setFailed] = useState(false);
  const [detector, setDetector] = useState<number>(
    initial.detector ?? DEFAULT_DETECTOR[initial.alias],
  );
  const [planes, setPlanes] = useState<ReadonlyMap<string, Float32Array>>(new Map());
  const [frameId, setFrameId] = useState<string | null>(initial.frame);
  const [playing, setPlaying] = useState(false);
  const [gaiaVisible, setGaiaVisible] = useState(initial.gaia);
  const [arrowStep, setArrowStep] = useState(initial.arrowStep);
  const [maxGMag, setMaxGMag] = useState<number | null>(initial.maxGMag);
  const [contrast, setContrast] = useState(initial.contrast);
  const [showTarget, setShowTarget] = useState(initial.target);

  // Contexto del objeto elegido.
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null);
    setFailed(false);
    setPlanes(new Map());
    loadContext(alias, controller.signal)
      .then((context) => {
        if (controller.signal.aborted) return;
        setLoaded(context);
        setMaxGMag((current) => current ?? defaultMagnitude(context.document));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error("contexto: no se pudo cargar", error);
        setFailed(true);
      });
    return () => controller.abort();
  }, [alias]);

  // Planos de SPHEREx del detector elegido: uno por epoca con datos.
  const field = loaded?.field ?? null;
  useEffect(() => {
    if (field === null) return;
    const controller = new AbortController();
    const wanted = field.planes.filter(
      (plane) =>
        plane.detector === detector && (plane.status === "ready" || plane.status === "partial"),
    );
    Promise.all(
      wanted.map(async (plane) => {
        const buffer = await api.getPlane(field.id, plane.epoch, plane.detector, field.grid.shape, {
          signal: controller.signal,
        });
        return [`${plane.epoch}-${plane.detector}`, new Float32Array(buffer)] as const;
      }),
    )
      .then((entries) => {
        if (!controller.signal.aborted) setPlanes((current) => new Map([...current, ...entries]));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          console.error("contexto: no se pudo cargar un plano", error);
      });
    return () => controller.abort();
  }, [field, detector]);

  const frames = useMemo<JourneyFrame[]>(() => {
    if (loaded === null) return [];
    const { document } = loaded;
    const shape = document.grid.shape;
    const list = document.surveys.map((layer) =>
      surveyFrame(layer, shape, loaded.layers.get(layer.key) ?? null),
    );
    if (loaded.field !== null) {
      const info = loaded.field.detectors.find((item) => item.detector === detector);
      for (const epoch of loaded.field.epochs) {
        const frame = spherexFrame({
          epoch,
          detector,
          waveRangeUm: [info?.wave_min_um ?? 0, info?.wave_max_um ?? 0],
          display: info?.display ?? null,
          shape: loaded.field.grid.shape,
          values: planes.get(`${epoch.epoch}-${detector}`) ?? null,
        });
        list.push({ ...frame, target: extrapolateTarget(document, frame.year) });
      }
    }
    return orderFrames(list);
  }, [loaded, planes, detector]);

  // Si el cuadro elegido no existe en este objeto, se arranca por el mas antiguo.
  const current = frames.find((frame) => frame.id === frameId) ?? frames[0] ?? null;
  const selectFrame = useCallback((id: string) => setFrameId(id), []);

  const selectObject = (next: ObjectAlias): void => {
    setAlias(next);
    setDetector(DEFAULT_DETECTOR[next]);
    setFrameId(null);
    setMaxGMag(null);
    setPlaying(false);
  };

  const document = loaded?.document ?? null;
  const gaia = loaded?.gaia ?? null;
  const magnitude = maxGMag ?? (document === null ? 17 : defaultMagnitude(document));
  const arrowYears = arrowYearsForStep(arrowStep);
  const year = current?.year ?? 2016;

  // La fuente de Gaia que corresponde al objeto: la mas cercana a su posicion esperada (a menos de 2 px).
  const highlightIndex = useMemo(() => {
    if (gaia === null || document === null || current?.target == null) return null;
    const target = current.target;
    let best: number | null = null;
    let bestDistance = 2;
    for (const marker of gaiaMarkers(gaia, document.grid, { year: current.year, arrowYears: 1 })) {
      const distance = Math.hypot(marker.x - target.x, marker.y - target.y);
      if (distance < bestDistance) {
        best = marker.index;
        bestDistance = distance;
      }
    }
    return best;
  }, [gaia, document, current]);

  const shown = useMemo(() => {
    if (gaia === null || document === null || !gaiaVisible) return 0;
    return gaiaMarkers(gaia, document.grid, {
      year,
      arrowYears,
      maxGMag: magnitude,
      limit: DEFAULT_GAIA_LIMIT,
    }).length;
  }, [gaia, document, gaiaVisible, year, arrowYears, magnitude]);

  const status = failed ? "error" : loaded === null ? "loading" : "ready";
  const frameLabel =
    current === null
      ? ""
      : tc("journey.frame", {
          mission: current.mission,
          band: current.band,
          date: frameDateText(current),
        });

  return (
    <main
      className={styles.page}
      data-dev-page="context"
      data-status={status}
      data-object={alias}
      data-frames={frames.length}
      data-frame={current?.id ?? ""}
      data-year={current?.year ?? ""}
      data-spherex={loaded?.field ? "yes" : "no"}
      data-gaia-total={gaia?.count ?? ""}
    >
      <div className={styles.stage}>
        {document === null ? (
          <p className={classNames(styles.status, "type-body")} role="status">
            {failed ? t("status.error") : t("status.loading")}
          </p>
        ) : (
          <div className={styles.image}>
            <FrameCanvas
              image={current?.image ?? null}
              shape={document.grid.shape}
              contrast={contrast}
              ariaLabel={frameLabel}
              placeholder={tc("journey.noImage")}
            >
              {(layout) => (
                <>
                  {gaia !== null && gaiaVisible ? (
                    <GaiaLayer
                      catalog={gaia}
                      grid={document.grid}
                      layout={layout}
                      year={year}
                      arrowYears={arrowYears}
                      maxGMag={magnitude}
                      highlightIndex={highlightIndex}
                    />
                  ) : null}
                  {showTarget && current?.target != null ? (
                    <TargetMark layout={layout} point={current.target} label={t("view.target")} />
                  ) : null}
                </>
              )}
            </FrameCanvas>
            {current === null ? null : (
              <ImageTag
                className={styles.tag}
                label={current.mission}
                value={`${frameBandText(current, language)} ${SEPARATOR} ${frameDateText(current)}`}
                note={current.mission === "SPHEREx" ? undefined : tc("journey.notSpherex")}
              />
            )}
          </div>
        )}
      </div>

      <div className={styles.panels} hidden={!initial.ui}>
        <GlassPanel title={t("title")} icon="globe">
          <SegmentedControl
            label={t("objects.label")}
            options={OBJECTS.map((value) => ({ value, label: t(`objects.${value}`) }))}
            value={alias}
            onChange={selectObject}
            columns={3}
          />
          {loaded !== null && loaded.field === null ? (
            <p className={styles.note}>{t("status.noSpherex")}</p>
          ) : null}
        </GlassPanel>

        <MissionJourney
          frames={frames}
          currentId={current?.id ?? null}
          onSelect={selectFrame}
          playing={playing}
          onPlayingChange={setPlaying}
        />

        {gaia === null || document === null ? null : (
          <GaiaControls
            visible={gaiaVisible}
            onVisibleChange={setGaiaVisible}
            arrowStep={arrowStep}
            onArrowStepChange={setArrowStep}
            maxGMag={magnitude}
            onMaxGMagChange={setMaxGMag}
            magRange={[document.gaia?.g_mag_min ?? 5, document.gaia?.g_mag_max ?? 21]}
            shown={shown}
            total={gaia.count}
            year={year}
          />
        )}

        <GlassPanel title={t("view.title")} icon="contrast">
          {loaded?.field == null ? null : (
            <SegmentedControl
              label={t("view.band")}
              showLabel
              options={DETECTORS.map((value) => {
                const info = loaded.field?.detectors.find((item) => item.detector === value);
                return {
                  value,
                  label: formatBand(value),
                  detail:
                    info === undefined
                      ? undefined
                      : formatWaveRange(info.wave_min_um, info.wave_max_um, language),
                };
              })}
              value={detector}
              onChange={setDetector}
              columns={3}
            />
          )}
          <Slider
            label={t("view.contrast")}
            min={MIN_CONTRAST}
            max={MAX_CONTRAST}
            step={0.01}
            value={contrast}
            valueText={formatPercent(contrast, language)}
            onChange={setContrast}
          />
          <Toggle label={t("view.target")} checked={showTarget} onChange={setShowTarget} />
        </GlassPanel>
      </div>
    </main>
  );
}

// Punto medio (U+00B7): separa los datos del rotulo de imagen.
const SEPARATOR = String.fromCodePoint(0x00b7);

export const devPage: DevPage = { Component: ContextDevPage };
