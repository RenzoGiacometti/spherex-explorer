// Contexto de otras misiones del campo abierto (docs/contexto.md): el documento
// de contexto, las capas de 2MASS y WISE y el catalogo de Gaia. Lo usan el modo
// "viaje entre misiones" y la capa de Gaia del panel Imagen.
//
// Solo hay contexto guardado para algunos campos precalculados. En los demas
// `GET /api/context` responde 404 y el estado queda en `unavailable`: el modo y
// la capa se muestran deshabilitados. Un fallo de red deja `error` y tampoco
// rompe nada: el visor sigue con las imagenes de SPHEREx.

import { useEffect, useState } from "react";
import { isApiError } from "@/api/errors";
import { type ContextDocument, contextApi, type GaiaCatalog } from "@/features/context";
import { useFieldStore } from "@/state/fieldStore";
import { type PlaneImage, toPlaneImage } from "@/viewer/planeImage";

/**
 * - `idle`: no hay campo abierto.
 * - `loading`: el documento de contexto esta en camino.
 * - `ready`: hay contexto; las capas y Gaia van llegando despues.
 * - `unavailable`: el campo no tiene contexto guardado.
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
  /** Capas bajadas, por `key` ("twomass_ks", "wise_w2"). */
  readonly layers: ReadonlyMap<string, SurveyImage>;
  /** Catalogo de Gaia, o null si todavia no llego o el campo no tiene. */
  readonly gaia: GaiaCatalog | null;
}

const NO_LAYERS: ReadonlyMap<string, SurveyImage> = new Map();

function emptyContext(status: FieldContextStatus): FieldContext {
  return { status, document: null, layers: NO_LAYERS, gaia: null };
}

const IDLE = emptyContext("idle");
const LOADING = emptyContext("loading");

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

    contextApi
      .getContext(geometry, { signal })
      .then((document) => {
        if (signal.aborted) return;
        setLoaded({ key, context: { ...emptyContext("ready"), document } });
        const shape = document.grid.shape;
        for (const layer of document.surveys) {
          // Una capa sin escala de contraste no tiene pixeles validos: no se pide.
          if (layer.display === null) continue;
          contextApi
            .getLayer(geometry, layer.key, shape, { signal })
            .then((values) => {
              const image = toPlaneImage(values, shape);
              patch((context) => ({
                ...context,
                layers: new Map(context.layers).set(layer.key, { values, image }),
              }));
            })
            // Sin la capa, su cuadro del viaje queda sin imagen; el resto sigue.
            .catch(() => undefined);
        }
        if (document.gaia !== null) {
          contextApi
            .getGaia(geometry, { signal })
            .then((gaia) => patch((context) => ({ ...context, gaia })))
            // Sin el catalogo la capa de Gaia queda deshabilitada.
            .catch(() => undefined);
        }
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        const missing = isApiError(error) && (error.code === "not_found" || error.status === 404);
        setLoaded({ key, context: emptyContext(missing ? "unavailable" : "error") });
      });
    return () => controller.abort();
  }, [key, ra, dec, fov]);

  if (key === null) return IDLE;
  return loaded?.key === key ? loaded.context : LOADING;
}
