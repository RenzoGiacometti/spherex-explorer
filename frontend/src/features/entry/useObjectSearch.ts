// Busqueda de la entrada: resuelve lo que escribio la persona con
// GET /api/resolve (docs/contrato-cubo.md, seccion 4.8) y da el estado de URL
// que abre su campo en el visor. Un texto que son coordenadas pasa por el mismo
// camino. Es la unica logica de busqueda: la usa la esfera (src/features/sphere),
// que acerca la camara al lugar antes de abrirlo.

import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiErrorCode, isAbortError } from "@/api/errors";
import { errorCodeOf, type NameResolver, resolveQuery } from "@/data/nameResolver";
import { MINUS } from "@/lib/format";
import { DEFAULT_VIEW_FOV } from "@/lib/fov";
import { DEFAULT_BAND, DEFAULT_MODE } from "@/state/urlState";
import { openingBand, resolvableName, type ViewerUrlPatch } from "./featured";

export type SearchStatus =
  | { readonly kind: "idle" }
  /** Hay un pedido a /api/resolve en camino para `query`. */
  | { readonly kind: "resolving"; readonly query: string }
  /** El pedido fallo; `code` se traduce con el namespace `errors`. */
  | { readonly kind: "error"; readonly query: string; readonly code: ApiErrorCode };

/** Lugar encontrado: como nombrarlo y el estado de URL que abre su campo. */
export interface FoundPlace {
  /** Nombre para mostrar mientras se abre: lo que escribio la persona. */
  readonly label: string;
  readonly patch: ViewerUrlPatch;
}

/**
 * Como termino una busqueda: `found`, con el lugar para abrir; `failed`, el
 * motivo quedo en `status`; `cancelled`, no habia texto o se la reemplazo o
 * cancelo antes de tener respuesta.
 */
export type SearchResult =
  | { readonly outcome: "found"; readonly place: FoundPlace }
  | { readonly outcome: "failed" }
  | { readonly outcome: "cancelled" };

export interface ObjectSearch {
  readonly status: SearchStatus;
  /**
   * Resuelve el texto. La promesa nunca se rechaza: dice como termino, y un
   * fallo queda en `status`. Abrir el lugar encontrado es de quien llama.
   */
  submit(text: string): Promise<SearchResult>;
  /** Cancela el pedido en camino y borra el error. */
  reset(): void;
}

const IDLE: SearchStatus = { kind: "idle" };
const FAILED: SearchResult = { outcome: "failed" };
const CANCELLED: SearchResult = { outcome: "cancelled" };

/**
 * Texto tal como se manda a resolver: sin espacios de mas y con el signo menos
 * del teclado. La interfaz muestra las declinaciones con el signo menos
 * tipografico (src/lib/format.ts) y el backend no lo lee como coordenada: sin
 * este cambio, unas coordenadas copiadas del visor salian como nombre no
 * encontrado.
 */
function cleanQuery(text: string): string {
  return text.trim().replace(/\s+/g, " ").replaceAll(MINUS, "-");
}

/**
 * Estado de la busqueda de la entrada.
 *
 * El lugar encontrado abre el visor con `ra` y `dec` de `field_center` (la
 * posicion propagada a 2026,0, no la de catalogo), la vista de 10 minutos, la
 * banda por defecto y `name` con el nombre buscado, que es el que el visor
 * vuelve a resolver para la mira y el rastro. Si el texto eran coordenadas no
 * hay nombre.
 */
export function useObjectSearch(resolver?: NameResolver): ObjectSearch {
  const [status, setStatus] = useState<SearchStatus>(IDLE);
  const controllerRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  // Al salir de la entrada no queda ningun pedido en camino.
  useEffect(() => cancel, [cancel]);

  const submit = useCallback(
    async (text: string): Promise<SearchResult> => {
      const query = cleanQuery(text);
      if (query === "") return CANCELLED;

      cancel();
      const controller = new AbortController();
      controllerRef.current = controller;
      setStatus({ kind: "resolving", query });

      const name = resolvableName(query);
      try {
        const { resolved } = await resolveQuery(name, {
          signal: controller.signal,
          ...(resolver ? { resolver } : {}),
        });
        if (controller.signal.aborted) return CANCELLED;
        controllerRef.current = null;
        setStatus(IDLE);
        return {
          outcome: "found",
          place: {
            label: query,
            patch: {
              ra: resolved.field_center.ra,
              dec: resolved.field_center.dec,
              fov: DEFAULT_VIEW_FOV,
              band: openingBand(query, resolved.field_center) ?? DEFAULT_BAND,
              mode: DEFAULT_MODE,
              // Es otro campo: la epoca fijada del anterior no vale.
              epoch: null,
              name: resolved.source === "sesame" ? name : null,
            },
          },
        };
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return CANCELLED;
        controllerRef.current = null;
        setStatus({ kind: "error", query, code: errorCodeOf(error) });
        return FAILED;
      }
    },
    [cancel, resolver],
  );

  const reset = useCallback(() => {
    cancel();
    setStatus(IDLE);
  }, [cancel]);

  return { status, submit, reset };
}
