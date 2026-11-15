// Pagina de prueba de la ficha del objeto: /?dev=ficha con `pnpm dev`.
//
// Muestra una imagen del campo con las fuentes de Gaia encima. Un clic elige
// la fuente mas cercana y la ficha dice, en lenguaje llano, que se sabe de
// ella; si no hay ninguna cerca, lo explica (es lo que pasa sobre WISE 0855).
//
// Los datos llegan por las rutas en vivo (`/api/live/*`), que sirven el
// contexto precalculado si existe y, si no, le piden a IRSA el recorte de WISE
// y las fuentes de Gaia con un plazo corto. Con `center` en la URL se prueba
// un campo cualquiera. Hace falta el backend de prueba, desde backend/:
//
//   uv run uvicorn app.context.devapp2:app --port 8000
//
// Estado inicial en la URL, para sacar capturas:
//
//   object   alias de un campo precalculado: barnard, wise0855, proxima-centauri...
//   center   centro de un campo cualquiera, "ra,dec" en grados (se arma en vivo).
//            No se llama `ra` y `dec`: esos son los parametros de la aplicacion,
//            que al verlos pide el campo de SPHEREx aunque se este en esta pagina.
//   layer    capa que se muestra: wise_w2 (por defecto) o twomass_ks
//   x, y     pixel de la grilla donde se simula el clic
//   target   1 simula el clic sobre la posicion esperada del objeto en esa capa
//   gaia     0 oculta las fuentes de Gaia
//   ui       0 oculta los paneles
//   lang     es | en
//
// El estado queda en el DOM:
//
//   main[data-dev-page="ficha"]  data-status (loading | ready | unavailable | error),
//                                data-field, data-layer, data-precomputed,
//                                data-gaia-total, data-card (none | source | empty)

import { type MouseEvent, useEffect, useMemo, useState } from "react";
import { isApiError } from "@/api/errors";
import { classNames, GlassPanel, ImageTag, SegmentedControl, Toggle } from "@/components";
import type { DevPage } from "@/dev/devPages";
import { useLanguage } from "@/i18n/useLanguage";
import { createContextApi, type FieldGeometry } from "./contextApi";
import { FrameCanvas } from "./FrameCanvas";
import fichaDevEn from "./fichaDev.en.json";
import fichaDevEs from "./fichaDev.es.json";
import styles from "./fichaDevPage.module.css";
import { GaiaLayer } from "./GaiaLayer";
import { type FramePoint, type JourneyFrame, surveyFrame } from "./journey";
import { frameBandText, frameDateText } from "./MissionJourney";
import { ObjectCard } from "./ObjectCard";
import { nearestSource } from "./objectFacts";
import type { ContextDocument, ContextIndex, GaiaCatalog } from "./schema";
import { registerTexts, useContextTexts, useTexts } from "./texts";

const DEV_NAMESPACE = "fichaDev";
registerTexts(DEV_NAMESPACE, { es: fichaDevEs, en: fichaDevEn });

/** Las mismas rutas del contexto, bajo el prefijo que tambien arma campos nuevos. */
const liveApi = createContextApi({ baseUrl: "/api/live" });
const savedApi = createContextApi();

const CUSTOM = "custom";
const DEFAULT_OBJECT = "wise0855";
const DEFAULT_LAYER = "wise_w2";
const SEPARATOR = String.fromCodePoint(0x00b7);

interface Loaded {
  readonly geometry: FieldGeometry;
  readonly document: ContextDocument;
  readonly layers: ReadonlyMap<string, Float32Array>;
  readonly gaia: GaiaCatalog | null;
}

type Status = "loading" | "ready" | "unavailable" | "error";

async function load(geometry: FieldGeometry, signal: AbortSignal): Promise<Loaded> {
  // Primero el documento: para un campo nuevo es el pedido que hace armar la capa y las fuentes.
  const document = await liveApi.getContext(geometry, { signal });
  const shape = document.grid.shape;
  const layers = new Map<string, Float32Array>();
  for (const layer of document.surveys) {
    layers.set(layer.key, await liveApi.getLayer(geometry, layer.key, shape, { signal }));
  }
  const gaia = document.gaia === null ? null : await liveApi.getGaia(geometry, { signal });
  return { geometry, document, layers, gaia };
}

function readNumber(value: string | null): number | null {
  const parsed = value === null || value.trim() === "" ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface InitialState {
  readonly object: string;
  readonly center: FieldGeometry | null;
  readonly layer: string;
  readonly point: FramePoint | null;
  readonly onTarget: boolean;
  readonly gaia: boolean;
  readonly ui: boolean;
}

function readInitialState(search: string): InitialState {
  const params = new URLSearchParams(search);
  const [raText = null, decText = null] = (params.get("center") ?? "").split(",");
  const ra = readNumber(raText);
  const dec = readNumber(decText);
  const x = readNumber(params.get("x"));
  const y = readNumber(params.get("y"));
  const center = ra === null || dec === null ? null : { ra, dec };
  return {
    object: center === null ? (params.get("object") ?? DEFAULT_OBJECT) : CUSTOM,
    center,
    layer: params.get("layer") ?? DEFAULT_LAYER,
    point: x === null || y === null ? null : { x, y },
    onTarget: params.get("target") === "1",
    gaia: params.get("gaia") !== "0",
    ui: params.get("ui") !== "0",
  };
}

function FichaDevPage() {
  const t = useTexts<typeof fichaDevEs>(DEV_NAMESPACE);
  const tc = useContextTexts();
  const language = useLanguage();
  const [initial] = useState(() => readInitialState(window.location.search));

  const [index, setIndex] = useState<ContextIndex | null>(null);
  const [object, setObject] = useState(initial.object);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [layerKey, setLayerKey] = useState(initial.layer);
  const [point, setPoint] = useState<FramePoint | null>(initial.point);
  const [showGaia, setShowGaia] = useState(initial.gaia);

  useEffect(() => {
    const controller = new AbortController();
    savedApi
      .getIndex({ signal: controller.signal })
      .then(setIndex)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.error("ficha: no se pudo leer el indice de contexto", error);
        setStatus("error");
      });
    return () => controller.abort();
  }, []);

  // Geometria del campo elegido: el centro de la URL o el de un campo precalculado.
  const geometry = useMemo<FieldGeometry | null>(() => {
    if (object === CUSTOM) return initial.center;
    const entry = index?.fields.find((field) => field.alias === object) ?? index?.fields[0];
    return entry === undefined ? null : { ra: entry.ra, dec: entry.dec, fov: entry.fov };
  }, [object, index, initial.center]);

  useEffect(() => {
    if (geometry === null) return;
    const controller = new AbortController();
    setLoaded(null);
    setStatus("loading");
    load(geometry, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setLoaded(result);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // IRSA lento no es un error de la pagina: el campo queda sin contexto por ahora.
        const unavailable = isApiError(error) && error.code === "upstream_unavailable";
        if (!unavailable) console.error("ficha: no se pudo cargar el contexto", error);
        setStatus(unavailable ? "unavailable" : "error");
      });
    return () => controller.abort();
  }, [geometry]);

  const document = loaded?.document ?? null;
  const gaia = loaded?.gaia ?? null;
  const layer =
    document?.surveys.find((item) => item.key === layerKey) ?? document?.surveys[0] ?? null;
  const frame = useMemo<JourneyFrame | null>(() => {
    if (document === null || layer === null || loaded === null) return null;
    return surveyFrame(layer, document.grid.shape, loaded.layers.get(layer.key) ?? null);
  }, [document, layer, loaded]);

  // `target=1`: el clic se simula sobre la posicion esperada del objeto en la capa que se mira.
  useEffect(() => {
    if (initial.onTarget && frame?.target != null) setPoint(frame.target);
  }, [initial.onTarget, frame]);

  const year = frame?.year ?? 2016;
  const found = useMemo(
    () =>
      gaia === null || document === null || point === null
        ? null
        : nearestSource(gaia, document.grid, point.x, point.y, year),
    [gaia, document, point, year],
  );

  const pick = (event: MouseEvent<HTMLButtonElement>): void => {
    if (document === null) return;
    const [ny, nx] = document.grid.shape;
    if (event.detail === 0) {
      // Activado con el teclado: no hay posicion de puntero. Se usa la del objeto, o el centro.
      setPoint(frame?.target ?? { x: (nx - 1) / 2, y: (ny - 1) / 2 });
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    setPoint({
      x: ((event.clientX - box.left) / box.width) * nx - 0.5,
      y: ny - 0.5 - ((event.clientY - box.top) / box.height) * ny,
    });
  };

  const selectObject = (next: string): void => {
    setObject(next);
    setPoint(null);
  };

  const fieldOptions = [
    ...(initial.center === null ? [] : [{ value: CUSTOM, label: t("field.custom") }]),
    ...(index?.fields ?? []).map((field) => ({
      value: field.alias ?? field.key,
      label: field.alias ?? field.key,
    })),
  ];
  const card = point === null || gaia === null ? "none" : found === null ? "empty" : "source";

  return (
    <main
      className={styles.page}
      data-dev-page="ficha"
      data-status={status}
      data-field={document?.key ?? ""}
      data-layer={layer?.key ?? ""}
      data-precomputed={document === null ? "" : String(document.object !== null)}
      data-gaia-total={gaia?.count ?? ""}
      data-card={card}
    >
      <div className={styles.stage}>
        {document === null || frame === null ? (
          <p className={classNames(styles.status, "type-body")} role="status">
            {t(status === "ready" ? "status.loading" : `status.${status}`)}
          </p>
        ) : (
          <div className={styles.image}>
            <button
              type="button"
              className={styles.picker}
              aria-label={t("image.label")}
              onClick={pick}
            >
              <FrameCanvas
                image={frame.image}
                shape={document.grid.shape}
                ariaLabel={tc("journey.frame", {
                  mission: frame.mission,
                  band: frame.band,
                  date: frameDateText(frame),
                })}
                placeholder={tc("journey.noImage")}
              >
                {(layout) => {
                  const mark = point === null ? null : layout.toScreen(point.x, point.y);
                  return (
                    <>
                      {gaia !== null && showGaia ? (
                        <GaiaLayer
                          catalog={gaia}
                          grid={document.grid}
                          layout={layout}
                          year={year}
                          arrowYears={100}
                          highlightIndex={found?.index ?? null}
                        />
                      ) : null}
                      {mark === null ? null : (
                        <svg
                          className={styles.mark}
                          width={layout.width}
                          height={layout.height}
                          role="img"
                          aria-label={t("image.click")}
                        >
                          <circle className={styles.markUnder} cx={mark.x} cy={mark.y} r={12} />
                          <circle className={styles.markOver} cx={mark.x} cy={mark.y} r={12} />
                        </svg>
                      )}
                    </>
                  );
                }}
              </FrameCanvas>
            </button>
            <ImageTag
              className={styles.tag}
              label={frame.mission}
              value={`${frameBandText(frame, language)} ${SEPARATOR} ${frameDateText(frame)}`}
              note={tc("journey.notSpherex")}
            />
          </div>
        )}
      </div>

      <div className={styles.panels} hidden={!initial.ui}>
        <GlassPanel title={t("title")} icon="globe">
          <SegmentedControl
            label={t("field.label")}
            options={fieldOptions}
            value={object}
            onChange={selectObject}
            columns={2}
          />
          {document !== null && document.surveys.length > 1 ? (
            <SegmentedControl
              label={t("field.layer")}
              showLabel
              options={document.surveys.map((item) => ({
                value: item.key,
                label: `${item.survey} ${item.band}`,
              }))}
              value={layer?.key ?? null}
              onChange={setLayerKey}
            />
          ) : null}
          <Toggle label={t("image.gaia")} checked={showGaia} onChange={setShowGaia} />
          {document !== null && document.object === null ? (
            <p className={styles.note}>{t("field.live")}</p>
          ) : null}
        </GlassPanel>

        {document === null ? null : (
          <ObjectCard
            catalog={gaia}
            grid={document.grid}
            point={point}
            year={year}
            onPick={setPoint}
          />
        )}
      </div>
    </main>
  );
}

export const devPage: DevPage = { Component: FichaDevPage };
