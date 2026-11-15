// Busqueda de la entrada: da el estado de URL que abre en el visor el campo de
// lo que escribio la persona. Es la unica logica de busqueda: la usa la esfera
// (src/features/sphere), que acerca la camara al lugar antes de abrirlo.
//
// Tres caminos, en este orden:
//
// 1. El texto es el nombre o un alias de un campo guardado (featured.ts): se
//    abre ese campo sin pasar por la red.
// 2. Cualquier otro texto, nombre o coordenadas, se resuelve con
//    GET /api/resolve (docs/contrato-cubo.md, seccion 4.8).
// 3. Si el punto resuelto cae dentro de la huella de un campo guardado, se abre
//    ese campo y no uno casi igual a su lado, que habria que armar de cero.

import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiErrorCode, isAbortError } from "@/api/errors";
import type { ResolveResponse } from "@/api/types";
import { errorCodeOf, type NameResolver, resolveQuery } from "@/data/nameResolver";
import { MINUS } from "@/lib/format";
import { DEFAULT_VIEW_FOV } from "@/lib/fov";
import { DEFAULT_BAND, DEFAULT_MODE } from "@/state/urlState";
import { featuredUrlPatch, savedFieldAt, savedFieldByName, type ViewerUrlPatch } from "./featured";

export type SearchStatus =
  | { readonly kind: "idle" }
  /** Se envio el buscador sin texto: se pide un nombre o unas coordenadas. */
  | { readonly kind: "empty" }
  /** Hay un pedido a /api/resolve en camino para `query`. */
  | { readonly kind: "resolving"; readonly query: string }
  /** El pedido fallo; `code` se traduce con el namespace `errors`. */
  | { readonly kind: "error"; readonly query: string; readonly code: ApiErrorCode };

/** Lugar encontrado: como nombrarlo y el estado de URL que abre su campo. */
export interface FoundPlace {
  /**
   * Nombre para mostrar mientras se abre: lo que escribio la persona, o el
   * nombre del campo guardado si lo buscado fue un alias o unas coordenadas
   * dentro de su huella.
   */
  readonly label: string;
  readonly patch: ViewerUrlPatch;
}

/**
 * Como termino una busqueda: `found`, con el lugar para abrir; `failed`, el
 * motivo quedo en `status` (tambien cuando no habia texto); `cancelled`, se la
 * reemplazo o cancelo antes de tener respuesta.
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
const EMPTY: SearchStatus = { kind: "empty" };
const FAILED: SearchResult = { outcome: "failed" };
const CANCELLED: SearchResult = { outcome: "cancelled" };

/**
 * Texto tal como se manda a resolver: sin espacios de mas y con el signo menos
 * del teclado. La interfaz muestra las declinaciones con el signo menos
 * tipografico (src/lib/format.ts) y el backend no lo lee como coordenada: sin
 * este cambio, unas coordenadas copiadas del visor salian como nombre no
 * encontrado.
 *
 * Es lo unico que se toca. Las comas, los puntos, el signo mas y las letras de
 * unas coordenadas ("269,4463 +4,7683", "08h55m10.831s -07d14m42.53s") llegan
 * al backend como se escribieron: leerlas es trabajo suyo.
 */
function cleanQuery(text: string): string {
  return text.trim().replace(/\s+/g, " ").replaceAll(MINUS, "-");
}

/**
 * Estado de URL que abre lo que resolvio el backend para `query`.
 *
 * Si el punto cae dentro de la huella de un campo guardado se abre ese campo:
 * su centro y su banda. Con unas coordenadas va tambien su nombre, que trae la
 * mira y el contexto del objeto; con el nombre de otro objeto que cae ahi (una
 * galaxia vecina, otro nombre de catalogo), el nombre buscado.
 *
 * En cualquier otro lugar: `field_center` (la posicion propagada a 2026,0, no
 * la de catalogo), la banda por defecto y el nombre buscado, que es el que el
 * visor vuelve a resolver para la mira y el rastro. Unas coordenadas no llevan
 * nombre.
 */
function foundPlace(query: string, resolved: ResolveResponse): FoundPlace {
  const byName = resolved.source === "sesame";
  const saved = savedFieldAt(resolved.field_center);
  if (saved !== null) {
    return {
      label: byName ? query : saved.label,
      patch: { ...featuredUrlPatch(saved), name: byName ? query : saved.name },
    };
  }
  return {
    label: query,
    patch: {
      ra: resolved.field_center.ra,
      dec: resolved.field_center.dec,
      fov: DEFAULT_VIEW_FOV,
      band: DEFAULT_BAND,
      mode: DEFAULT_MODE,
      // Es otro campo: la epoca fijada del anterior no vale.
      epoch: null,
      name: byName ? query : null,
    },
  };
}

/**
 * Estado de la busqueda de la entrada. Todo lugar encontrado abre en la vista
 * de 10 minutos, en parpadeo y sin epoca fijada; el centro, la banda y el
 * nombre salen de `foundPlace` o del campo guardado.
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
      cancel();
      if (query === "") {
        setStatus(EMPTY);
        return FAILED;
      }

      // El nombre o un alias de un campo guardado: se abre sin pedir nada.
      const saved = savedFieldByName(query);
      if (saved !== null) {
        setStatus(IDLE);
        return { outcome: "found", place: { label: saved.label, patch: featuredUrlPatch(saved) } };
      }

      const controller = new AbortController();
      controllerRef.current = controller;
      setStatus({ kind: "resolving", query });

      try {
        const { resolved } = await resolveQuery(query, {
          signal: controller.signal,
          ...(resolver ? { resolver } : {}),
        });
        if (controller.signal.aborted) return CANCELLED;
        controllerRef.current = null;
        setStatus(IDLE);
        return { outcome: "found", place: foundPlace(query, resolved) };
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
