// Resolucion de un texto (nombre o coordenadas) con GET /api/resolve
// (docs/contrato-cubo.md, seccion 4.8), con memoria de lo ya resuelto.
//
// La entrada resuelve el texto que escribio la persona y abre el campo; el
// visor vuelve a necesitar el mismo objeto para la mira. Lo resuelto se guarda
// por el texto buscado y por el nombre principal, asi el segundo pedido no sale.

import { type ApiClient, api, type RequestOptions } from "@/api/client";
import { ApiError, type ApiErrorCode, isApiError } from "@/api/errors";
import type { ResolveResponse } from "@/api/types";
import type { UrlState } from "@/state/urlState";

export interface NameResolver {
  /** Resuelve un texto. Falla con ApiError (`not_resolved`, `upstream_unavailable`, `network`). */
  resolve(text: string, options?: RequestOptions): Promise<ResolveResponse>;
}

function cacheKey(text: string): string {
  return text.trim().toLowerCase();
}

export function createNameResolver(client: ApiClient = api): NameResolver {
  // Solo respuestas que llegaron bien; un fallo no se recuerda y se puede reintentar.
  const resolved = new Map<string, ResolveResponse>();

  return {
    async resolve(text, options) {
      const key = cacheKey(text);
      if (key === "") {
        // El mismo codigo que daria el backend, sin gastar un pedido.
        throw new ApiError({
          code: "invalid_request",
          status: 0,
          retryable: false,
          message: "resolve: el texto buscado esta vacio",
        });
      }
      const known = resolved.get(key);
      if (known) return known;

      const response = await client.resolve(text.trim(), options);
      resolved.set(key, response);
      if (response.name !== null) resolved.set(cacheKey(response.name), response);
      return response;
    },
  };
}

/** Resolucion por defecto, sobre el cliente por defecto. La comparten la entrada y el visor. */
export const nameResolver: NameResolver = createNameResolver();

/** Parte del estado de la URL que abre el campo de un objeto resuelto. */
export type FieldUrlPatch = Pick<UrlState, "ra" | "dec" | "name" | "epoch">;

export interface ResolvedQuery {
  /** Respuesta de /api/resolve, para mostrar que se encontro. */
  resolved: ResolveResponse;
  /**
   * Cambio de estado de URL que abre su campo: el centro es `field_center` (la
   * posicion propagada, no la de catalogo) y `name` es el nombre principal, o
   * null si el texto eran coordenadas. La epoca se suelta porque es otro campo.
   */
  url: FieldUrlPatch;
}

export interface ResolveQueryOptions extends RequestOptions {
  /** Resolucion a usar; por defecto la compartida. */
  resolver?: NameResolver;
}

/**
 * Accion de la entrada: resuelve lo que escribio la persona y devuelve el
 * estado de URL que abre su campo.
 *
 *   const { url } = await resolveQuery("Barnard's Star");
 *   useUrlState.getState().update(url, { history: "push" });
 *
 * Falla con ApiError; `errorCodeOf(error)` da el codigo para traducir.
 */
export async function resolveQuery(
  text: string,
  options: ResolveQueryOptions = {},
): Promise<ResolvedQuery> {
  const { resolver = nameResolver, signal } = options;
  const resolved = await resolver.resolve(text, signal ? { signal } : undefined);
  return {
    resolved,
    url: {
      ra: resolved.field_center.ra,
      dec: resolved.field_center.dec,
      name: resolved.name,
      epoch: null,
    },
  };
}

/** Codigo de un error cualquiera, para traducirlo: el de ApiError, o `unknown`. */
export function errorCodeOf(error: unknown): ApiErrorCode {
  return isApiError(error) ? error.code : "unknown";
}
