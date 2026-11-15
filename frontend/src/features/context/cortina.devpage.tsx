// Pagina de prueba de la capa optica: /?dev=cortina con `pnpm dev`.
//
// Dos vistas del mismo campo:
//
//   cortina  la placa del Digitized Sky Survey (luz visible) y una imagen
//            infrarroja (WISE, 2MASS o SPHEREx), separadas por un divisor que
//            se arrastra
//   viaje    el viaje entre misiones con las placas del DSS como primeras
//            paradas: DSS, 2MASS, WISE y las epocas de SPHEREx, en orden de fecha
//
// Los datos llegan por /api: el contexto precalculado (`/api/context`,
// `/api/survey`), la capa optica (`/api/context/optical`,
// `/api/survey/optical`) y, si el servidor tiene el campo armado, las epocas
// de SPHEREx. Hace falta el backend de prueba, desde backend/:
//
//   uv run uvicorn app.context.devapp2:app --port 8000
//
// Estado inicial en la URL, para sacar capturas:
//
//   object    alias de un campo precalculado: barnard, wolf-359, proxima-centauri...
//   view      curtain | journey
//   optical   capa del lado visible: dss2_red | dss1
//   infrared  capa del lado infrarrojo: wise_w2 | twomass_ks | spherex
//   position  0 a 1: donde esta el divisor
//   frame     cuadro del viaje: dss1, dss2_red, twomass_ks, wise_w2, spherex-1...
//   band      1 a 6: detector de SPHEREx
//   contrast  0 a 1
//   ui        0 oculta los paneles
//   lang      es | en
//
// El estado queda en el DOM:
//
//   main[data-dev-page="cortina"]  data-status (loading | ready | error), data-field,
//                                  data-view, data-optical, data-infrared,
//                                  data-frames, data-frame, data-spherex (yes | no)

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import { isApiError } from "@/api/errors";
import { isListed, type ListedFieldMeta } from "@/api/types";
import { classNames, GlassPanel, ImageTag, SegmentedControl, Slider, Toggle } from "@/components";
import type { DevPage } from "@/dev/devPages";
import type { Language } from "@/i18n/languages";
import { useLanguage } from "@/i18n/useLanguage";
import { formatBand, formatPercent, formatWaveRange } from "@/lib/format";
import { DEFAULT_CONTRAST, MAX_CONTRAST, MIN_CONTRAST } from "@/viewer/stretch";
import { Curtain, type CurtainSide, OpticalCredit } from "./Curtain";
import { contextApi, type FieldGeometry } from "./contextApi";
import cortinaDevEn from "./cortinaDev.en.json";
import cortinaDevEs from "./cortinaDev.es.json";
import styles from "./cortinaDevPage.module.css";
import { clampCurtain, DEFAULT_CURTAIN } from "./curtainMath";
import { FrameCanvas } from "./FrameCanvas";
import { type JourneyFrame, orderFrames, spherexFrame, surveyFrame } from "./journey";
import { frameBandText, frameDateText, MissionJourney } from "./MissionJourney";
import {
  curtainLayer,
  journeyLayers,
  type OpticalDocument,
  type OpticalLayer,
  opticalApi,
  opticalFrame,
  plateCredit,
  targetOutsideField,
} from "./optical";
import type { ContextDocument, ContextIndex } from "./schema";
import { TargetMark } from "./TargetMark";
import { registerTexts, useTexts } from "./texts";

const DEV_NAMESPACE = "cortinaDev";
registerTexts(DEV_NAMESPACE, { es: cortinaDevEs, en: cortinaDevEn });

const VIEWS = ["curtain", "journey"] as const;
type View = (typeof VIEWS)[number];

const SPHEREX = "spherex";
const DETECTORS = [1, 2, 3, 4, 5, 6] as const;
const SEPARATOR = String.fromCodePoint(0x00b7);

interface Loaded {
  readonly geometry: FieldGeometry;
  readonly context: ContextDocument;
  readonly layers: ReadonlyMap<string, Float32Array>;
  readonly optical: OpticalDocument | null;
  readonly plates: ReadonlyMap<string, Float32Array>;
  readonly field: ListedFieldMeta | null;
}

/** Devuelve null si la API dice que eso no existe; cualquier otro fallo sigue siendo un error. */
async function orNull<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (isApiError(error) && error.code === "not_found") return null;
    throw error;
  }
}

async function load(geometry: FieldGeometry, signal: AbortSignal): Promise<Loaded> {
  const context = await contextApi.getContext(geometry, { signal });
  const shape = context.grid.shape;
  const layers = new Map<string, Float32Array>();
  for (const layer of context.surveys) {
    layers.set(layer.key, await contextApi.getLayer(geometry, layer.key, shape, { signal }));
  }
  const optical = await orNull(opticalApi.getOptical(geometry, { signal }));
  const plates = new Map<string, Float32Array>();
  for (const layer of optical?.layers ?? []) {
    plates.set(layer.key, await opticalApi.getLayer(geometry, layer.key, shape, { signal }));
  }
  const response = await orNull(
    api.requestField(
      { ra: geometry.ra, dec: geometry.dec, fov: geometry.fov ?? 0.1667 },
      { signal },
    ),
  );
  const field = response !== null && isListed(response.meta) ? response.meta : null;
  return { geometry, context, layers, optical, plates, field };
}

function pick<T extends string>(value: string | null, options: readonly T[], fallback: T): T {
  return options.find((option) => option === value) ?? fallback;
}

function readNumber(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = value === null || value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

/** Dato de un lado de la cortina: banda, longitud de onda y fecha. */
function sideDetail(frame: JourneyFrame, language: Language, dateText: string): string {
  return `${frameBandText(frame, language)} ${SEPARATOR} ${dateText}`;
}

function CortinaDevPage() {
  const t = useTexts<typeof cortinaDevEs>(DEV_NAMESPACE);
  const { t: tc } = useTranslation("context");
  const { t: tk } = useTranslation("curtain");
  const language = useLanguage();
  const [params] = useState(() => new URLSearchParams(window.location.search));

  const [index, setIndex] = useState<ContextIndex | null>(null);
  const [object, setObject] = useState(params.get("object") ?? "wolf-359");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View>(pick(params.get("view"), VIEWS, "curtain"));
  const [opticalKey, setOpticalKey] = useState<string | null>(params.get("optical"));
  const [infraredKey, setInfraredKey] = useState(params.get("infrared") ?? "wise_w2");
  const [position, setPosition] = useState(
    clampCurtain(readNumber(params.get("position"), DEFAULT_CURTAIN, 0, 1)),
  );
  const [detector, setDetector] = useState(Math.round(readNumber(params.get("band"), 3, 1, 6)));
  const [planes, setPlanes] = useState<ReadonlyMap<string, Float32Array>>(new Map());
  const [frameId, setFrameId] = useState<string | null>(params.get("frame"));
  const [playing, setPlaying] = useState(false);
  const [contrast, setContrast] = useState(
    readNumber(params.get("contrast"), DEFAULT_CONTRAST, MIN_CONTRAST, MAX_CONTRAST),
  );
  const [showTarget, setShowTarget] = useState(params.get("target") !== "0");
  const ui = params.get("ui") !== "0";

  useEffect(() => {
    const controller = new AbortController();
    contextApi
      .getIndex({ signal: controller.signal })
      .then(setIndex)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error("cortina: no se pudo leer el indice de contexto", error);
        setFailed(true);
      });
    return () => controller.abort();
  }, []);

  const geometry = useMemo<FieldGeometry | null>(() => {
    const entry = index?.fields.find((field) => field.alias === object) ?? index?.fields[0];
    return entry === undefined ? null : { ra: entry.ra, dec: entry.dec, fov: entry.fov };
  }, [index, object]);

  useEffect(() => {
    if (geometry === null) return;
    const controller = new AbortController();
    setLoaded(null);
    setFailed(false);
    setPlanes(new Map());
    load(geometry, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setLoaded(result);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error("cortina: no se pudo cargar el contexto", error);
        setFailed(true);
      });
    return () => controller.abort();
  }, [geometry]);

  // Planos de SPHEREx del detector elegido, uno por epoca con datos.
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
        if (!controller.signal.aborted) console.error("cortina: no se pudo cargar un plano", error);
      });
    return () => controller.abort();
  }, [field, detector]);

  const context = loaded?.context ?? null;
  const optical = loaded?.optical ?? null;
  const shape = context?.grid.shape ?? null;

  // Cuadros de cada origen, ya con su imagen si llego.
  const opticalFrames = useMemo(() => {
    const frames = new Map<string, JourneyFrame>();
    if (loaded === null || optical === null || shape === null) return frames;
    for (const layer of optical.layers) {
      frames.set(layer.key, opticalFrame(layer, shape, loaded.plates.get(layer.key) ?? null));
    }
    return frames;
  }, [loaded, optical, shape]);

  const surveyFrames = useMemo(() => {
    const frames = new Map<string, JourneyFrame>();
    if (loaded === null || context === null || shape === null) return frames;
    for (const layer of context.surveys) {
      frames.set(layer.key, surveyFrame(layer, shape, loaded.layers.get(layer.key) ?? null));
    }
    return frames;
  }, [loaded, context, shape]);

  const spherexFrames = useMemo(() => {
    if (field === null) return [];
    const info = field.detectors.find((item) => item.detector === detector);
    return field.epochs.map((epoch) =>
      spherexFrame({
        epoch,
        detector,
        waveRangeUm: [info?.wave_min_um ?? 0, info?.wave_max_um ?? 0],
        display: info?.display ?? null,
        shape: field.grid.shape,
        values: planes.get(`${epoch.epoch}-${detector}`) ?? null,
      }),
    );
  }, [field, planes, detector]);

  // ---- Cortina ----
  const opticalLayerInUse: OpticalLayer | null =
    optical === null
      ? null
      : (optical.layers.find((layer) => layer.key === opticalKey) ?? curtainLayer(optical));
  const leftFrame =
    opticalLayerInUse === null ? null : (opticalFrames.get(opticalLayerInUse.key) ?? null);
  const lastSpherex = [...spherexFrames].reverse().find((frame) => frame.image !== null) ?? null;
  const rightFrame =
    infraredKey === SPHEREX
      ? lastSpherex
      : (surveyFrames.get(infraredKey) ?? [...surveyFrames.values()][0] ?? null);

  const side = (frame: JourneyFrame | null, reliable: boolean): CurtainSide => ({
    image: frame?.image ?? null,
    name: frame?.mission ?? "",
    detail:
      frame === null
        ? ""
        : sideDetail(frame, language, reliable ? frameDateText(frame) : tk("unreliableDate")),
  });

  // ---- Viaje ----
  const journeyFrames = useMemo(() => {
    const plates =
      optical === null
        ? []
        : journeyLayers(optical).flatMap((layer) => opticalFrames.get(layer.key) ?? []);
    return orderFrames([...plates, ...surveyFrames.values(), ...spherexFrames]);
  }, [optical, opticalFrames, surveyFrames, spherexFrames]);
  const current = journeyFrames.find((frame) => frame.id === frameId) ?? journeyFrames[0] ?? null;
  const currentPlate = optical?.layers.find((layer) => layer.key === current?.id) ?? null;
  const skipped = optical?.layers.filter((layer) => !layer.date_reliable) ?? [];
  const selectFrame = useCallback((id: string) => setFrameId(id), []);

  const selectObject = (next: string): void => {
    setObject(next);
    setFrameId(null);
    setOpticalKey(null);
    setPlaying(false);
  };

  const status = failed ? "error" : loaded === null ? "loading" : "ready";
  const infraredOptions = [
    ...(context?.surveys ?? []).map((layer) => ({
      value: layer.key,
      label: `${layer.survey} ${layer.band}`,
    })),
    ...(lastSpherex === null ? [] : [{ value: SPHEREX, label: t("sides.spherex") }]),
  ];
  const creditLayer = view === "curtain" ? opticalLayerInUse : currentPlate;

  return (
    <main
      className={styles.page}
      data-dev-page="cortina"
      data-status={status}
      data-field={context?.key ?? ""}
      data-view={view}
      data-optical={opticalLayerInUse?.key ?? ""}
      data-infrared={infraredKey}
      data-frames={journeyFrames.length}
      data-frame={current?.id ?? ""}
      data-spherex={field === null ? "no" : "yes"}
    >
      <div className={styles.stage}>
        {context === null || shape === null ? (
          <p className={classNames(styles.status, "type-body")} role="status">
            {failed ? t("status.error") : t("status.loading")}
          </p>
        ) : (
          <div className={styles.image}>
            {view === "curtain" ? (
              <Curtain
                left={side(leftFrame, opticalLayerInUse?.date_reliable ?? true)}
                right={side(rightFrame, true)}
                shape={shape}
                position={position}
                onPositionChange={setPosition}
                contrast={contrast}
              />
            ) : (
              <div className={styles.frame}>
                <FrameCanvas
                  image={current?.image ?? null}
                  shape={shape}
                  contrast={contrast}
                  ariaLabel={
                    current === null
                      ? ""
                      : tc("journey.frame", {
                          mission: current.mission,
                          band: current.band,
                          date: frameDateText(current),
                        })
                  }
                  placeholder={tc("journey.noImage")}
                >
                  {(layout) =>
                    showTarget && current?.target != null ? (
                      <TargetMark
                        layout={layout}
                        point={current.target}
                        label={t("image.target")}
                      />
                    ) : null
                  }
                </FrameCanvas>
                {current === null ? null : (
                  <ImageTag
                    className={styles.tag}
                    label={current.mission}
                    value={sideDetail(current, language, frameDateText(current))}
                    note={current.mission === "SPHEREx" ? undefined : tc("journey.notSpherex")}
                  />
                )}
              </div>
            )}
            {creditLayer === null ? null : <OpticalCredit credit={plateCredit(creditLayer)} />}
          </div>
        )}
      </div>

      <div className={styles.panels} hidden={!ui}>
        <GlassPanel title={t("title")} icon="layers">
          <SegmentedControl
            label={t("field")}
            options={(index?.fields ?? []).map((item) => ({
              value: item.alias ?? item.key,
              label: item.alias ?? item.key,
            }))}
            value={object}
            onChange={selectObject}
            columns={2}
          />
          <SegmentedControl
            label={t("view.label")}
            showLabel
            options={VIEWS.map((value) => ({ value, label: t(`view.${value}`) }))}
            value={view}
            onChange={setView}
          />
          {loaded !== null && optical === null ? (
            <p className={styles.note}>{t("notes.noOptical")}</p>
          ) : null}
          {loaded !== null && field === null ? (
            <p className={styles.note}>{t("notes.noSpherex")}</p>
          ) : null}
        </GlassPanel>

        {view === "curtain" ? (
          <GlassPanel title={t("view.curtain")} icon="contrast">
            {optical === null || optical.layers.length < 2 ? null : (
              <SegmentedControl
                label={t("sides.optical")}
                showLabel
                options={optical.layers.map((layer) => ({
                  value: layer.key,
                  label: `${layer.generation} ${layer.band}`,
                }))}
                value={opticalLayerInUse?.key ?? null}
                onChange={setOpticalKey}
              />
            )}
            <SegmentedControl
              label={t("sides.infrared")}
              showLabel
              options={infraredOptions}
              value={infraredKey}
              onChange={setInfraredKey}
            />
          </GlassPanel>
        ) : (
          <>
            <MissionJourney
              frames={journeyFrames}
              currentId={current?.id ?? null}
              onSelect={selectFrame}
              playing={playing}
              onPlayingChange={setPlaying}
            />
            {currentPlate !== null && targetOutsideField(currentPlate) ? (
              <p className={styles.note} data-note="outside">
                {t("notes.outside")}
              </p>
            ) : null}
            {skipped.map((layer) => (
              <p key={layer.key} className={styles.note} data-note="skipped">
                {t("notes.skipped", { plate: layer.plate })}
              </p>
            ))}
          </>
        )}

        <GlassPanel title={t("image.title")} icon="bands">
          {field === null ? null : (
            <SegmentedControl
              label={t("image.band")}
              showLabel
              options={DETECTORS.map((value) => {
                const info = field.detectors.find((item) => item.detector === value);
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
            label={t("image.contrast")}
            min={MIN_CONTRAST}
            max={MAX_CONTRAST}
            step={0.01}
            value={contrast}
            valueText={formatPercent(contrast, language)}
            onChange={setContrast}
          />
          {view === "journey" ? (
            <Toggle label={t("image.target")} checked={showTarget} onChange={setShowTarget} />
          ) : null}
        </GlassPanel>
      </div>
    </main>
  );
}

export const devPage: DevPage = { Component: CortinaDevPage };
