// Que hace un clic sobre la imagen del visor: un unico punto de decision.
//
// Regla:
//
//   - Por defecto (ninguna herramienta anotada), el clic abre el panel de la
//     fuente: espectro y curva de luz de ese punto (useSpectrum.ts,
//     SpectrumDock.tsx). Es el modo `DEFAULT_IMAGE_CLICK_MODE` ("source").
//   - Una herramienta que necesita el clic (el medidor de movimiento propio,
//     que marca la posicion del objeto en cada epoca; el recorrido guiado, que
//     pide hacer clic sobre el objeto) lo toma mientras esta activa. Mientras
//     haya una anotada, el clic va a su manejador y NO abre el espectro.
//   - Si se anotan dos, manda la ultima; al soltarla, vuelve la anterior.
//
// Como lo usa una herramienta, desde un componente:
//
//   useImageClickTool("proper-motion", active ? handleClick : null);
//
// o fuera de React (devuelve la funcion que la quita):
//
//   const release = claimImageClick("tour", handleClick);
//   ...
//   release();
//
// El manejador recibe el `ImageClick` del visor (src/viewer/ImageViewer.tsx):
// `x`, `y` en pixeles de imagen, que son los de la grilla del campo, y la
// transformacion de ese momento. Para pasarlos al cielo: `pixelToSky` (lib/wcs.ts)
// con `meta.grid` del store del campo.
//
// ViewerPage es el unico que llama a `routeImageClick`, y solo entrega clics
// cuando hay algo que elegir: fuera de `embed`, sobre una imagen de SPHEREx y
// sin el boton de "mantener apretado" en uso. Publica quien tiene el clic en
// `data-click` del <main>: "source" o el `id` de la herramienta.

import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { ImageClick } from "@/viewer/ImageViewer";

export type ImageClickHandler = (click: ImageClick) => void;

/** Una herramienta que tomo el clic. */
export interface ImageClickClaim {
  /** Nombre corto de la herramienta: "proper-motion", "tour". Sale en `data-click`. */
  readonly id: string;
  readonly handler: ImageClickHandler;
}

/** Modo del clic cuando ninguna herramienta lo tomo: espectro y curva de luz. */
export const DEFAULT_IMAGE_CLICK_MODE = "source";

interface ImageClickState {
  /** Herramientas anotadas, en el orden en que tomaron el clic. Manda la ultima. */
  readonly claims: readonly ImageClickClaim[];
}

const useImageClickStore = create<ImageClickState>(() => ({ claims: [] }));

function activeClaim(state: ImageClickState): ImageClickClaim | null {
  return state.claims[state.claims.length - 1] ?? null;
}

/**
 * Anota una herramienta para que reciba los clics sobre la imagen. Devuelve la
 * funcion que la quita; llamarla dos veces no hace nada.
 */
export function claimImageClick(id: string, handler: ImageClickHandler): () => void {
  const claim: ImageClickClaim = { id, handler };
  useImageClickStore.setState((state) => ({ claims: [...state.claims, claim] }));
  return () => {
    useImageClickStore.setState((state) => ({
      claims: state.claims.filter((item) => item !== claim),
    }));
  };
}

/** `id` de la herramienta que tiene el clic, o null si vale la regla por defecto. */
export function activeImageClickTool(): string | null {
  return activeClaim(useImageClickStore.getState())?.id ?? null;
}

/** Quien tiene el clic: `DEFAULT_IMAGE_CLICK_MODE` o el `id` de la herramienta. Se actualiza solo. */
export function useImageClickMode(): string {
  return useImageClickStore((state) => activeClaim(state)?.id ?? DEFAULT_IMAGE_CLICK_MODE);
}

/**
 * Toma el clic para una herramienta mientras `handler` no sea null, y lo
 * suelta al pasar null o al desmontar el componente. El manejador puede
 * cambiar entre dibujos sin volver a anotarse.
 */
export function useImageClickTool(id: string, handler: ImageClickHandler | null): void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  const active = handler !== null;
  useEffect(() => {
    if (!active) return;
    return claimImageClick(id, (click) => handlerRef.current?.(click));
  }, [id, active]);
}

/**
 * Entrega un clic sobre la imagen: a la herramienta que lo tomo o, si no hay
 * ninguna, a `openSource` (el panel de espectro y curva de luz).
 */
export function routeImageClick(click: ImageClick, openSource: ImageClickHandler): void {
  const claim = activeClaim(useImageClickStore.getState());
  (claim?.handler ?? openSource)(click);
}
