// Suscripcion a GET /api/field/{id}/events (docs/contrato-cubo.md, seccion 4.2).
//
// Lee el flujo con fetch en vez de EventSource para poder leer el cuerpo de
// error del contrato cuando el backend responde 404 o 429, cosa que
// EventSource no deja ver.
//
// Lo que garantiza:
// - Cada evento se valida con su esquema y se entrega como union discriminada
//   por `type`. Un evento que no valida se descarta y se avisa por
//   `onInvalidEvent`; nunca llega a `onEvent`.
// - Reconexion: si el flujo se corta sin `done` ni `error`, vuelve a conectar
//   con espera creciente. El backend no repite eventos perdidos: al reconectar
//   manda un `state` nuevo, que quien consume debe tomar como reemplazo de
//   todo el estado anterior.
// - Cierre: despues de entregar `done` o `error` corta la conexion y no vuelve
//   a conectar.
// - Si pasan `idleTimeoutMs` sin recibir nada (el backend manda ": ping" cada
//   15 s), da la conexion por muerta y reconecta.

import type { FetchLike } from "./client";
import { ApiError, errorFromResponse } from "./errors";
import { fieldEventSchemas } from "./schema";
import { createSseParser, type SseMessage } from "./sseParser";
import type { FieldEvent, FieldEventType } from "./types";

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface InvalidEvent {
  /** Nombre del evento tal como llego. */
  event: string;
  /** `data` sin interpretar. */
  data: string;
  /**
   * - unknown_event: el contrato no define ese nombre de evento.
   * - invalid_json: `data` no es JSON.
   * - invalid_data: el JSON no cumple el esquema del evento.
   */
  reason: "unknown_event" | "invalid_json" | "invalid_data";
  error?: unknown;
}

export interface FieldEventsOptions {
  /** Recibe cada evento valido, en orden. */
  onEvent: (event: FieldEvent) => void;
  /** Cambios de la conexion, para mostrar que se esta reconectando. */
  onStatus?: (status: StreamStatus) => void;
  /**
   * La suscripcion termino sin `done` ni `error` del servidor: una respuesta
   * de error no reintentable (por ejemplo 404 not_found) o reintentos agotados.
   */
  onFailure?: (error: ApiError) => void;
  /** Evento descartado por no cumplir el contrato. Por defecto se anota en la consola. */
  onInvalidEvent?: (event: InvalidEvent) => void;
  /** Reemplazo de fetch, para los tests. */
  fetch?: FetchLike;
  /** Reintentos seguidos sin recibir ningun evento valido antes de rendirse. Por defecto 8. */
  maxRetries?: number;
  /** Espera en ms antes del reintento numero `attempt` (desde 1). Por defecto 1, 2, 4, 8 y 15 s. */
  retryDelayMs?: (attempt: number) => number;
  /** Tiempo en ms sin recibir nada antes de reconectar. Por defecto 45 s. */
  idleTimeoutMs?: number;
}

export interface FieldEventsSubscription {
  /** Corta la conexion y cancela los reintentos. No llama a `onFailure`. */
  close(): void;
}

const EVENT_STREAM = "text/event-stream";
const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 45_000;
/** Tope para la espera que pide Retry-After. */
const MAX_RETRY_AFTER_MS = 60_000;

function defaultRetryDelayMs(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** (attempt - 1));
}

function defaultOnInvalidEvent(event: InvalidEvent): void {
  console.warn(
    `SSE: evento "${event.event}" descartado (${event.reason})`,
    event.error ?? event.data,
  );
}

function isFieldEventType(name: string): name is FieldEventType {
  return Object.hasOwn(fieldEventSchemas, name);
}

function parseEventId(id: string): number | null {
  return /^\d+$/.test(id) ? Number(id) : null;
}

function streamError(message: string, cause?: unknown): ApiError {
  return new ApiError({ code: "network", status: 0, retryable: true, message, cause });
}

export function subscribeFieldEvents(
  url: string,
  options: FieldEventsOptions,
): FieldEventsSubscription {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const onInvalidEvent = options.onInvalidEvent ?? defaultOnInvalidEvent;

  let closed = false;
  let status: StreamStatus | null = null;
  // Reintentos seguidos sin recibir un evento valido.
  let attempt = 0;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function setStatus(next: StreamStatus): void {
    if (next === status) return;
    status = next;
    options.onStatus?.(next);
  }

  function clearTimers(): void {
    clearTimeout(retryTimer);
    clearTimeout(idleTimer);
    retryTimer = undefined;
    idleTimer = undefined;
  }

  function finish(): void {
    if (closed) return;
    closed = true;
    clearTimers();
    controller?.abort();
    controller = null;
    setStatus("closed");
  }

  function fail(error: ApiError): void {
    if (closed) return;
    finish();
    options.onFailure?.(error);
  }

  function scheduleReconnect(error: ApiError): void {
    if (closed) return;
    clearTimeout(idleTimer);
    attempt += 1;
    if (attempt > maxRetries) {
      fail(error);
      return;
    }
    setStatus("reconnecting");
    const delay =
      error.retryAfterS !== null
        ? Math.min(error.retryAfterS * 1000, MAX_RETRY_AFTER_MS)
        : retryDelayMs(attempt);
    retryTimer = setTimeout(() => void connect(), delay);
  }

  function armIdleTimer(current: AbortController): void {
    clearTimeout(idleTimer);
    if (idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => current.abort(), idleTimeoutMs);
    }
  }

  function handleMessage(message: SseMessage): void {
    if (closed) return;

    const type = message.event;
    if (!isFieldEventType(type)) {
      onInvalidEvent({ event: type, data: message.data, reason: "unknown_event" });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(message.data);
    } catch (error) {
      onInvalidEvent({ event: type, data: message.data, reason: "invalid_json", error });
      return;
    }

    const parsed = fieldEventSchemas[type].safeParse(payload);
    if (!parsed.success) {
      onInvalidEvent({
        event: type,
        data: message.data,
        reason: "invalid_data",
        error: parsed.error,
      });
      return;
    }

    // Llego un evento valido: la conexion sirve y los reintentos vuelven a cero.
    attempt = 0;

    // FieldEvent se deriva de fieldEventSchemas (types.ts), asi que el `data`
    // que valida el esquema de `type` es por construccion el de ese evento.
    const event = { type, id: parseEventId(message.id), data: parsed.data } as FieldEvent;
    try {
      options.onEvent(event);
    } catch (error) {
      // Un error de quien consume no es un corte de red: se anota y el flujo
      // sigue, igual que con un listener de EventSource.
      console.error(`SSE: fallo el manejador del evento "${type}"`, error);
    }

    if (type === "done" || type === "error") finish();
  }

  async function connect(): Promise<void> {
    if (closed) return;
    retryTimer = undefined;
    if (status === null) setStatus("connecting");

    const current = new AbortController();
    controller = current;
    // El mismo limite vale para la espera de la respuesta: un backend que
    // acepta la conexion y no contesta tambien cuenta como conexion muerta.
    armIdleTimer(current);

    let response: Response;
    try {
      response = await doFetch(url, {
        headers: { Accept: EVENT_STREAM },
        cache: "no-store",
        signal: current.signal,
      });
    } catch (cause) {
      if (closed) return;
      scheduleReconnect(streamError(`${url}: sin respuesta del backend`, cause));
      return;
    }
    if (closed) return;

    if (!response.ok) {
      const error = await errorFromResponse(response);
      if (closed) return;
      if (error.retryable) scheduleReconnect(error);
      else fail(error);
      return;
    }

    const contentType = response.headers.get("Content-Type") ?? "";
    if (!response.body || !contentType.includes(EVENT_STREAM)) {
      fail(
        new ApiError({
          code: "invalid_response",
          status: response.status,
          message: `${url}: la respuesta no es un flujo ${EVENT_STREAM} (Content-Type: "${contentType}")`,
        }),
      );
      return;
    }

    setStatus("open");

    const parser = createSseParser({ onMessage: handleMessage });
    const decoder = new TextDecoder();
    const reader = response.body.getReader();

    for (;;) {
      armIdleTimer(current);

      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (cause) {
        if (closed) return;
        scheduleReconnect(streamError(`${url}: se corto el flujo de eventos`, cause));
        return;
      }
      if (closed) return;
      if (chunk.done) break;

      parser.feed(decoder.decode(chunk.value, { stream: true }));
      if (closed) return;
    }

    // El servidor cerro el flujo sin `done` ni `error`.
    scheduleReconnect(streamError(`${url}: el flujo de eventos termino sin done ni error`));
  }

  void connect();

  return {
    close: finish,
  };
}
