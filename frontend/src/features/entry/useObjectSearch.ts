// Busqueda de la entrada: resuelve lo que escribio la persona con
// GET /api/resolve (docs/contrato-cubo.md, seccion 4.8) y abre su campo en el
// visor. Un texto que son coordenadas pasa por el mismo camino.

import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiErrorCode, isAbortError } from "@/api/errors";
import { errorCodeOf, type NameResolver, resolveQuery } from "@/data/nameResolver";
import { MINUS } from "@/lib/format";
import { DEFAULT_VIEW_FOV } from "@/lib/fov";
import { DEFAULT_BAND, DEFAULT_MODE, useUrlState } from "@/state/urlState";
import { resolvableName } from "./featured";

export type SearchStatus =
  | { readonly kind: "idle" }
  /** Hay un pedido a /api/resolve en camino para `query`. */
  | { readonly kind: "resolving"; readonly query: string }
  /** El pedido fallo; `code` se traduce con el namespace `errors`. */
  | { readonly kind: "error"; readonly query: string; readonly code: ApiErrorCode };

/**
 * Como termino una busqueda: `opened`, la URL ya apunta al campo; `failed`, el
 * motivo quedo en `status`; `cancelled`, no habia texto o se la reemplazo o
 * cancelo antes de tener respuesta.
 */
export type SearchOutcome = "opened" | "failed" | "cancelled";

export interface ObjectSearch {
  readonly status: SearchStatus;
  /**
   * Resuelve el texto y, si sale bien, lleva la URL al campo del objeto. La
   * promesa nunca se rechaza: dice como termino, y un fallo queda en `status`.
   */
  submit(text: string): Promise<SearchOutcome>;
  /** Cancela el pedido en camino y borra el error. */
  reset(): void;
}

const IDLE: SearchStatus = { kind: "idle" };

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
 * Con la respuesta se navega al visor con `ra` y `dec` de `field_center` (la
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
    async (text: string): Promise<SearchOutcome> => {
      const query = cleanQuery(text);
      if (query === "") return "cancelled";

      cancel();
      const controller = new AbortController();
      controllerRef.current = controller;
      setStatus({ kind: "resolving", query });

      const name = resolvableName(query);
      try {
        const { resolved, url } = await resolveQuery(name, {
          signal: controller.signal,
          ...(resolver ? { resolver } : {}),
        });
        if (controller.signal.aborted) return "cancelled";
        controllerRef.current = null;
        useUrlState.getState().update(
          {
            ...url,
            fov: DEFAULT_VIEW_FOV,
            band: DEFAULT_BAND,
            mode: DEFAULT_MODE,
            name: resolved.source === "sesame" ? name : null,
          },
          { history: "push" },
        );
        setStatus(IDLE);
        return "opened";
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return "cancelled";
        controllerRef.current = null;
        setStatus({ kind: "error", query, code: errorCodeOf(error) });
        return "failed";
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
