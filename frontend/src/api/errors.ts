// Errores de la API. El texto que ve la persona lo arma la interfaz a partir
// de `code` (con i18n); `message` es solo para el log.

import { errorBodySchema } from "./schema";
import type { ErrorCode } from "./types";

/**
 * Codigos que no vienen del backend:
 * - network: no hubo respuesta (sin conexion, backend caido, conexion cortada).
 * - invalid_response: la respuesta no cumple el contrato (JSON invalido,
 *   campos que no validan o un binario de otro tamano).
 * - unknown: respuesta de error sin el cuerpo {"error": ...} del contrato.
 */
export type ClientErrorCode = "network" | "invalid_response" | "unknown";

export type ApiErrorCode = ErrorCode | ClientErrorCode;

export interface ApiErrorInit {
  code: ApiErrorCode;
  /** Codigo HTTP, o 0 si no hubo respuesta. */
  status?: number;
  retryable?: boolean;
  message?: string;
  /** Segundos de la cabecera Retry-After, si vino. */
  retryAfterS?: number | null;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  /** Codigo HTTP, o 0 si no hubo respuesta. */
  readonly status: number;
  /** Si tiene sentido volver a intentar el mismo pedido. */
  readonly retryable: boolean;
  /** Segundos que pide esperar la cabecera Retry-After, o null. */
  readonly retryAfterS: number | null;

  constructor(init: ApiErrorInit) {
    super(init.message || init.code, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ApiError";
    this.code = init.code;
    this.status = init.status ?? 0;
    this.retryable = init.retryable ?? false;
    this.retryAfterS = init.retryAfterS ?? null;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Dice si un error es la cancelacion de un pedido con AbortController. */
export function isAbortError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    (value as { name: unknown }).name === "AbortError"
  );
}

/**
 * Cabecera Retry-After en segundos. Admite las dos formas de HTTP: una
 * cantidad de segundos o una fecha.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (header === null) return null;
  const text = header.trim();
  if (text === "") return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return null;
  return Math.max(0, (date - now) / 1000);
}

/** Arma el ApiError de una respuesta HTTP que no fue 2xx. */
export async function errorFromResponse(response: Response): Promise<ApiError> {
  const retryAfterS = parseRetryAfter(response.headers.get("Retry-After"));

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  const parsed = errorBodySchema.safeParse(payload);
  if (parsed.success) {
    const { code, message, retryable } = parsed.data.error;
    return new ApiError({ code, status: response.status, retryable, message, retryAfterS });
  }

  return new ApiError({
    code: "unknown",
    status: response.status,
    retryable: response.status === 429 || response.status >= 500,
    message: `HTTP ${response.status} sin cuerpo de error del contrato`,
    retryAfterS,
  });
}

/** Error de red a partir de lo que lanzo fetch. Una cancelacion se deja pasar tal cual. */
export function networkError(cause: unknown, what: string): unknown {
  if (isAbortError(cause)) return cause;
  return new ApiError({
    code: "network",
    status: 0,
    retryable: true,
    message: `${what}: sin respuesta del backend`,
    cause,
  });
}
