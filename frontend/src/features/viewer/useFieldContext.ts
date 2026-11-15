// Contexto de otras misiones del campo abierto (docs/contexto.md y
// docs/contexto-2.md): el documento de contexto, las capas de 2MASS y WISE, las
// placas opticas del Digitized Sky Survey y el catalogo de Gaia. Lo usan el
// modo "viaje entre misiones", la cortina visible/infrarrojo, la capa de Gaia
// del panel Imagen y la ficha del objeto.
//
// Los campos precalculados tienen su contexto guardado (`GET /api/context`).
// Para un campo nuevo esa ruta responde 404 y se prueba con las rutas en vivo
// (`/api/live`), que arman WISE W2 y Gaia en el momento; ahi no hay placas
// opticas. Si tampoco hay, el estado queda en `unavailable`; un fallo de red
// deja `error`. En los dos casos el modo y la capa quedan deshabilitados y el
// visor sigue con las imagenes de SPHEREx.

import { useEffect, useState } from "react";
import { isApiError } from "@/api/errors";
import {
  type ContextApi,
  type ContextDocument,
  contextApi,
  createContextApi,
  type FieldGeometry,
  type GaiaCatalog,
  type OpticalDocument,
  opticalApi,
} from "@/features/context";
import { useFieldStore } from "@/state/fieldStore";
import { type PlaneImage, toPlaneImage } from "@/viewer/planeImage";

/**
 * - `idle`: no hay campo abierto.
 * - `loading`: el documento de contexto esta en camino.
 * - `ready`: hay contexto; las capas y Gaia van llegando despues.
 * - `unavailable`: el campo no tiene contexto guardado ni se pudo armar en vivo.
 * - `error`: el pedido fallo (red, servidor, respuesta invalida).
 */
export type FieldContextStatus = "idle" | "loading" | "ready" | "unavailable" | "error";

/** Una capa de otra mision ya bajada: sus valores y el plano listo para el visor. */
export interface SurveyImage {
  readonly values: Float32Array;
  readonly image: PlaneImage;
}

export interface FieldContext {
  readonly status: FieldContextStatus;
  readonly document: ContextDocument | null;
  /** Placas opticas del campo (DSS), o null si no tiene o todavia no llegaron. */
  readonly optical: OpticalDocument | null;
  /** El pedido de las placas opticas sigue en camino: todavia no se sabe si el campo tiene. */
  readonly opticalPending: boolean;
  /** Capas bajadas, por `key` ("twomass_ks", "wise_w2", "dss1", "dss2_red"). */
  readonly layers: ReadonlyMap<string, SurveyImage>;
  /** Catalogo de Gaia, o null si todavia no llego o el campo no tiene. */
  readonly gaia: GaiaCatalog | null;
}

const NO_LAYERS: ReadonlyMap<string, SurveyImage> = new Map();

function emptyContext(status: FieldContextStatus): FieldContext {
  return {
    status,
    document: null,
    optical: null,
    opticalPending: false,
    layers: NO_LAYERS,
    gaia: null,
  };
}

const IDLE = emptyContext("idle");
const LOADING = emptyContext("loading");

/** Contexto armado en el momento para un campo que no esta precalculado (docs/contexto-2.md, seccion 2). */
const liveContextApi: ContextApi = createContextApi({ baseUrl: "/api/live" });

function isMissing(error: unknown): boolean {
  return isApiError(error) && (error.code === "not_found" || error.status === 404);
}

/** El documento de contexto y el cliente que lo dio: el guardado o, si no hay, el armado en vivo. */
async function loadDocument(
  geometry: FieldGeometry,
  signal: AbortSignal,
): Promise<{ api: ContextApi; document: ContextDocument }> {
  try {
    return { api: contextApi, document: await contextApi.getContext(geometry, { signal }) };
  } catch (error) {
    if (!isMissing(error)) throw error;
    return { api: liveContextApi, document: await liveContextApi.getContext(geometry, { signal }) };
  }
}

interface Loaded {
  /** Campo al que pertenece lo cargado: otro campo no lo hereda ni por un dibujo. */
  readonly key: string;
  readonly context: FieldContext;
}

/** Contexto de otras misiones del campo abierto. Se vuelve a pedir al cambiar de campo. */
export function useFieldContext(): FieldContext {
  const ra = useFieldStore((state) => state.request?.ra ?? null);
  const dec = useFieldStore((state) => state.request?.dec ?? null);
  const fov = useFieldStore((state) => state.request?.fov ?? null);
  const key = ra === null || dec === null || fov === null ? null : `${ra}_${dec}_${fov}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    if (key === null || ra === null || dec === null || fov === null) return;
    const controller = new AbortController();
    const { signal } = controller;
    const geometry = { ra, dec, fov };
    /** Aplica un cambio solo si este campo sigue abierto. */
    const patch = (change: (context: FieldContext) => FieldContext): void => {
      if (signal.aborted) return;
      setLoaded((previous) =>
        previous?.key === key ? { key, context: change(previous.context) } : previous,
      );
    };
    const addLayer = (layerKey: string, values: Float32Array, shape: [number, number]): void => {
      const image = toPlaneImage(values, shape);
      patch((context) => ({
        ...context,
        layers: new Map(context.layers).set(layerKey, { values, image }),
      }));
    };

    loadDocument(geometry, signal)
      .then(({ api, document }) => {
        if (signal.aborted) return;
        const precomputed = api === contextApi;
        setLoaded({
          key,
          context: { ...emptyContext("ready"), document, opticalPending: precomputed },
        });
        const shape = document.grid.shape;
        for (const layer of document.surveys) {
          // Una capa sin escala de contraste no tiene pixeles validos: no se pide.
          if (layer.display === null) continue;
          api
            .getLayer(geometry, layer.key, shape, { signal })
            .then((values) => addLayer(layer.key, values, shape))
            // Sin la capa, su cuadro del viaje queda sin imagen; el resto sigue.
            .catch(() => undefined);
        }
        if (document.gaia !== null) {
          api
            .getGaia(geometry, { signal })
            .then((gaia) => patch((context) => ({ ...context, gaia })))
            // Sin el catalogo la capa de Gaia queda deshabilitada.
            .catch(() => undefined);
        }
        // Placas opticas: solo los campos precalculados las tienen guardadas.
        if (!precomputed) return;
        opticalApi
          .getOptical(geometry, { signal })
          .then((optical) => {
            const [ny, nx] = optical.grid.shape;
            // Las placas solo sirven si estan en la grilla del contexto.
            if (ny !== shape[0] || nx !== shape[1]) {
              patch((context) => ({ ...context, opticalPending: false }));
              return;
            }
            patch((context) => ({ ...context, optical, opticalPending: false }));
            for (const layer of optical.layers) {
              if (layer.display === null) continue;
              opticalApi
                .getLayer(geometry, layer.key, shape, { signal })
                .then((values) => addLayer(layer.key, values, shape))
                .catch(() => undefined);
            }
          })
          // Sin placas el viaje arranca en 2MASS y la cortina queda deshabilitada.
          .catch(() => patch((context) => ({ ...context, opticalPending: false })));
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        setLoaded({ key, context: emptyContext(isMissing(error) ? "unavailable" : "error") });
      });
    return () => controller.abort();
  }, [key, ra, dec, fov]);

  if (key === null) return IDLE;
  return loaded?.key === key ? loaded.context : LOADING;
}
