// Espectro del punto elegido en el visor: lo pide con un clic sobre la imagen y
// guarda en que anda el pedido (cargando, listo o con error) para SpectrumDock.
//
// No va en el store del campo: es de la pantalla del visor y se descarta al
// cambiar de campo. Un pedido nuevo cancela el anterior.
//
// Si el backend ajusto el clic a una fuente guardada del campo, el punto que
// queda marcado sobre la imagen es el de la fuente (spectrumClick.ts).

import { useCallback, useEffect, useRef, useState } from "react";
import { type ApiErrorCode, isAbortError, isApiError } from "@/api/errors";
import { errorCodeOf } from "@/data/nameResolver";
import { selectTargetPosition } from "@/data/selectors";
import { fetchSpectrum, type SpectrumDocument } from "@/features/spectrum";
import { useFieldStore } from "@/state/fieldStore";
import type { ImageClick } from "@/viewer/ImageViewer";
import {
  type SpectrumPoint,
  snapPointToSource,
  spectrumPointForClick,
  spectrumPointForSky,
} from "./spectrumClick";

export type SpectrumRequestState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly point: SpectrumPoint }
  | {
      readonly status: "ready";
      readonly point: SpectrumPoint;
      readonly spectrum: SpectrumDocument;
    }
  | {
      readonly status: "error";
      readonly point: SpectrumPoint;
      /** Codigo para traducir con el namespace `errors`. */
      readonly code: ApiErrorCode;
      readonly retryable: boolean;
    };

export interface SpectrumController {
  readonly state: SpectrumRequestState;
  /** Pide el espectro del punto de la imagen donde cayo un clic. */
  requestAt(click: ImageClick): void;
  /** Pide el espectro de una posicion del cielo (grados ICRS) del campo abierto. */
  requestPosition(position: { readonly ra: number; readonly dec: number }): void;
  /** Vuelve a pedir el mismo punto, despues de un error. */
  retry(): void;
  /** Cierra el panel y cancela el pedido en camino. */
  close(): void;
}

const IDLE: SpectrumRequestState = { status: "idle" };

/**
 * @param shownEpoch Epoca que se esta viendo: decide donde esta la mira del
 *   objeto buscado, para saber si un clic cayo sobre el.
 */
export function useSpectrum(shownEpoch: number | null): SpectrumController {
  const [state, setState] = useState<SpectrumRequestState>(IDLE);
  const requestRef = useRef<AbortController | null>(null);
  const fieldId = useFieldStore((store) => store.fieldId);

  // Otro campo: el espectro era de un punto del anterior.
  const [seenField, setSeenField] = useState(fieldId);
  if (seenField !== fieldId) {
    setSeenField(fieldId);
    if (state.status !== "idle") setState(IDLE);
  }
  // Al cambiar de campo y al salir del visor, el pedido en camino se cancela.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `fieldId` no se lee: avisa que cambio el campo
  useEffect(
    () => () => {
      requestRef.current?.abort();
      requestRef.current = null;
    },
    [fieldId],
  );

  const run = useCallback((point: SpectrumPoint): void => {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    setState({ status: "loading", point });
    fetchSpectrum(point.query, { signal: request.signal }).then(
      (spectrum) => {
        if (request.signal.aborted) return;
        const grid = useFieldStore.getState().meta?.grid ?? null;
        setState({ status: "ready", point: snapPointToSource(point, spectrum, grid), spectrum });
      },
      (error: unknown) => {
        if (request.signal.aborted || isAbortError(error)) return;
        setState({
          status: "error",
          point,
          code: errorCodeOf(error),
          retryable: isApiError(error) && error.retryable,
        });
      },
    );
  }, []);

  const requestAt = useCallback(
    (click: ImageClick): void => {
      const store = useFieldStore.getState();
      const grid = store.meta?.grid;
      if (store.fieldId === null || grid === undefined) return;
      run(
        spectrumPointForClick({
          x: click.x,
          y: click.y,
          scale: click.transform.scale,
          grid,
          fieldId: store.fieldId,
          name: store.target.name,
          target: selectTargetPosition(store, shownEpoch),
          resolved: store.target.resolved,
        }),
      );
    },
    [run, shownEpoch],
  );

  const requestPosition = useCallback(
    (position: { readonly ra: number; readonly dec: number }): void => {
      const store = useFieldStore.getState();
      const grid = store.meta?.grid;
      if (store.fieldId === null || grid === undefined) return;
      run(spectrumPointForSky({ ...position, grid, fieldId: store.fieldId }));
    },
    [run],
  );

  const retry = useCallback((): void => {
    if (state.status === "error") run(state.point);
  }, [run, state]);

  const close = useCallback((): void => {
    requestRef.current?.abort();
    requestRef.current = null;
    setState(IDLE);
  }, []);

  return { state, requestAt, requestPosition, retry, close };
}
