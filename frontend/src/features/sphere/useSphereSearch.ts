// Busqueda de la esfera: lleva lo que escribio la persona a un punto del cielo.
//
// Un nombre o unas coordenadas se resuelven con GET /api/resolve
// (docs/contrato-cubo.md, seccion 4.8) a traves de src/data/nameResolver.ts.
// Los cinco objetos marcados no pasan por el servicio: su campo ya esta en
// targets.ts, asi abren aunque el servicio de nombres no responda.

import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiErrorCode, isAbortError } from "@/api/errors";
import { errorCodeOf, type NameResolver, resolveQuery } from "@/data/nameResolver";
import { MINUS } from "@/lib/format";
import { DEFAULT_VIEW_FOV } from "@/lib/fov";
import { DEFAULT_BAND, DEFAULT_MODE } from "@/state/urlState";
import { type FieldUrlPatch, findTargetByName, targetUrlPatch } from "./targets";

export type SearchStatus =
  | { readonly kind: "idle" }
  /** Hay un pedido a /api/resolve en camino para `query`. */
  | { readonly kind: "resolving"; readonly query: string }
  /** El pedido fallo; `code` se traduce con el namespace `errors`. */
  | { readonly kind: "error"; readonly query: string; readonly code: ApiErrorCode };

/** Lugar encontrado: como mostrarlo y el estado de URL que abre su campo. */
export interface FoundPlace {
  readonly label: string;
  readonly patch: FieldUrlPatch;
}

export interface SphereSearch {
  readonly status: SearchStatus;
  /**
   * Resuelve el texto. Da el lugar, o null si fallo (el motivo queda en
   * `status`) o si se cancelo. La promesa nunca se rechaza.
   */
  submit(text: string): Promise<FoundPlace | null>;
  /** Cancela el pedido en camino y borra el error. */
  reset(): void;
}

const IDLE: SearchStatus = { kind: "idle" };

/**
 * Texto tal como se manda a resolver: sin espacios de mas y con el signo menos
 * del teclado. La interfaz muestra las declinaciones con el signo menos
 * tipografico (src/lib/format.ts) y el backend no lo lee como coordenada.
 */
function cleanQuery(text: string): string {
  return text.trim().replace(/\s+/g, " ").replaceAll(MINUS, "-");
}

export function useSphereSearch(resolver?: NameResolver): SphereSearch {
  const [status, setStatus] = useState<SearchStatus>(IDLE);
  const controllerRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  // Al salir de la pantalla no queda ningun pedido en camino.
  useEffect(() => cancel, [cancel]);

  const submit = useCallback(
    async (text: string): Promise<FoundPlace | null> => {
      const query = cleanQuery(text);
      if (query === "") return null;
      cancel();

      const target = findTargetByName(query);
      if (target !== null) {
        setStatus(IDLE);
        return { label: target.label, patch: targetUrlPatch(target) };
      }

      const controller = new AbortController();
      controllerRef.current = controller;
      setStatus({ kind: "resolving", query });
      try {
        const { resolved } = await resolveQuery(query, {
          signal: controller.signal,
          ...(resolver ? { resolver } : {}),
        });
        if (controller.signal.aborted) return null;
        controllerRef.current = null;
        setStatus(IDLE);
        return {
          label: resolved.name ?? query,
          patch: {
            // El centro del campo es la posicion propagada a 2026,0, no la de catalogo.
            ra: resolved.field_center.ra,
            dec: resolved.field_center.dec,
            fov: DEFAULT_VIEW_FOV,
            band: DEFAULT_BAND,
            mode: DEFAULT_MODE,
            epoch: null,
            // El visor vuelve a resolver este nombre para la mira; con coordenadas no hay nombre.
            name: resolved.source === "sesame" ? query : null,
          },
        };
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) return null;
        controllerRef.current = null;
        setStatus({ kind: "error", query, code: errorCodeOf(error) });
        return null;
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
