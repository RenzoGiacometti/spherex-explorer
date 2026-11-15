// Pedido del espectro al backend: GET /api/spectrum (backend/app/spectrum/router.py).
//
// Mismo trato que el cliente de src/api: el JSON se valida antes de entregarlo
// y todo fallo sale como ApiError con `code`. Una cancelacion con
// AbortController pasa sin envolver.

import { ApiError, errorFromResponse, networkError } from "@/api/errors";
import { parseSpectrum, type SpectrumDocument } from "./types";

export interface SpectrumQuery {
  /** Punto a medir, grados ICRS. */
  readonly ra: number;
  readonly dec: number;
  /** Id del campo que se esta mirando: limita la busqueda a sus recortes. */
  readonly field?: string | undefined;
  /** Movimiento propio en mas/anio (`motion` de /api/resolve); `pmRa` incluye cos(dec). */
  readonly pmRa?: number | undefined;
  readonly pmDec?: number | undefined;
  /** Anio juliano de `ra` y `dec`. Por defecto, el del centro del campo (2026,0). */
  readonly epoch?: number | undefined;
}

export interface SpectrumRequestOptions {
  readonly signal?: AbortSignal | undefined;
  /** Prefijo de la API. Por defecto "/api". */
  readonly baseUrl?: string | undefined;
  /** Reemplazo de fetch, para los tests. */
  readonly fetch?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;
}

/** Ruta del pedido, con sus parametros. */
export function spectrumUrl(query: SpectrumQuery, baseUrl = "/api"): string {
  const params = new URLSearchParams({ ra: String(query.ra), dec: String(query.dec) });
  if (query.field !== undefined) params.set("field", query.field);
  if (query.pmRa !== undefined && query.pmDec !== undefined) {
    params.set("pm_ra", String(query.pmRa));
    params.set("pm_dec", String(query.pmDec));
  }
  if (query.epoch !== undefined) params.set("epoch", String(query.epoch));
  return `${baseUrl}/spectrum?${params.toString()}`;
}

/** Pide el espectro de un punto. Una fuente saturada no es un error: llega con `status: "saturated"`. */
export async function fetchSpectrum(
  query: SpectrumQuery,
  options: SpectrumRequestOptions = {},
): Promise<SpectrumDocument> {
  const url = spectrumUrl(query, options.baseUrl);
  const doFetch = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let response: Response;
  try {
    response = await doFetch(url, {
      headers: { Accept: "application/json" },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    throw networkError(cause, url);
  }
  if (!response.ok) throw await errorFromResponse(response);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw networkError(cause, url);
  }
  try {
    return parseSpectrum(payload);
  } catch (cause) {
    throw new ApiError({
      code: "invalid_response",
      status: response.status,
      retryable: false,
      message: `${url}: el espectro no cumple el formato`,
      cause,
    });
  }
}
