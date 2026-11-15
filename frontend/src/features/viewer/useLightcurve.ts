// Curva de luz de la fuente que muestra el panel del espectro: se pide recien
// cuando se abre la pestana "Curva de luz" de SpectrumDock, con la misma
// consulta que el espectro (punto del clic o el objeto buscado con su
// movimiento propio, y el mismo campo), para que las dos pestanas hablen de la
// misma fuente. El backend ajusta el punto a la fuente guardada mas cercana con
// el mismo radio que el espectro (backend/app/lightcurve/saved.py).
//
// Que no haya curva no es un error: un 404 `not_found` (no hay curva guardada
// para ese punto) queda como `none`, y SpectrumDock lo cuenta como "sin curva".
// La respuesta de un punto se conserva al ir y volver entre pestanas.

import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiErrorCode, isAbortError, isApiError } from "@/api/errors";
import { errorCodeOf } from "@/data/nameResolver";
import {
  fetchLightcurve,
  type LightcurveDocument,
  type LightcurveQuery,
  lightcurveUrl,
} from "@/features/lightcurve";

export type LightcurveRequestState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly lightcurve: LightcurveDocument }
  /** No hay curva guardada para ese punto (404 `not_found`). */
  | { readonly status: "none" }
  | {
      readonly status: "error";
      /** Codigo para traducir con el namespace `errors`. */
      readonly code: ApiErrorCode;
      readonly retryable: boolean;
    };

export interface LightcurveController {
  readonly state: LightcurveRequestState;
  /** Vuelve a pedir el mismo punto, despues de un error. */
  retry(): void;
}

const IDLE: LightcurveRequestState = { status: "idle" };

/**
 * @param query Consulta del punto elegido; null si no hay ninguno.
 * @param wanted Si la pestana de la curva esta a la vista: sin eso no se pide nada.
 */
export function useLightcurve(
  query: LightcurveQuery | null,
  wanted: boolean,
): LightcurveController {
  const key = query === null ? null : lightcurveUrl(query);
  const [entry, setEntry] = useState<{
    readonly key: string | null;
    readonly state: LightcurveRequestState;
  }>({ key: null, state: IDLE });
  const [attempt, setAttempt] = useState(0);
  /** Consulta cuya respuesta ya llego: no se vuelve a pedir al volver a la pestana. */
  const answeredRef = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: la consulta se identifica por `key`; `attempt` avisa de un reintento
  useEffect(() => {
    if (!wanted || query === null || key === null) return;
    if (answeredRef.current === key) return;
    const request = new AbortController();
    setEntry({ key, state: { status: "loading" } });
    fetchLightcurve(query, { signal: request.signal }).then(
      (lightcurve) => {
        if (request.signal.aborted) return;
        answeredRef.current = key;
        setEntry({ key, state: { status: "ready", lightcurve } });
      },
      (error: unknown) => {
        if (request.signal.aborted || isAbortError(error)) return;
        if (isApiError(error) && (error.code === "not_found" || error.status === 404)) {
          answeredRef.current = key;
          setEntry({ key, state: { status: "none" } });
          return;
        }
        setEntry({
          key,
          state: {
            status: "error",
            code: errorCodeOf(error),
            retryable: isApiError(error) && error.retryable,
          },
        });
      },
    );
    return () => request.abort();
  }, [wanted, key, attempt]);

  const retry = useCallback((): void => setAttempt((count) => count + 1), []);

  // Lo guardado es de otro punto hasta que el pedido nuevo arranca.
  const state =
    entry.key === key ? entry.state : key === null ? IDLE : { status: "loading" as const };
  return { state, retry };
}
