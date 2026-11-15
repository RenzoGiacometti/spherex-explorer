// Mide cuanto del visor queda tapado por la interfaz. En escritorio el visor
// ocupa toda la pantalla y los paneles flotan encima; la zona libre es la
// celda `stage` de la grilla de ViewerPage. ImageViewer encuadra la imagen ahi
// (`insets`). En una ventana angosta el visor y la celda coinciden y los
// margenes quedan en cero.

import { type RefObject, useLayoutEffect, useState } from "react";
import type { ViewerInsets } from "@/viewer/ImageViewer";

/** Diferencia, en pixeles CSS, por debajo de la cual dos medidas son la misma. */
const TOLERANCE = 0.5;

function sameInsets(a: ViewerInsets | undefined, b: ViewerInsets): boolean {
  return (
    a !== undefined &&
    Math.abs(a.top - b.top) < TOLERANCE &&
    Math.abs(a.right - b.right) < TOLERANCE &&
    Math.abs(a.bottom - b.bottom) < TOLERANCE &&
    Math.abs(a.left - b.left) < TOLERANCE
  );
}

/**
 * Margenes entre el borde del visor y la celda `stage`, al dia con los cambios
 * de tamano de cualquiera de los dos. `undefined` mientras no se pueden medir
 * (antes del primer dibujo, o donde no hay layout).
 */
export function useStageInsets(
  viewerRef: RefObject<HTMLElement | null>,
  stageRef: RefObject<HTMLElement | null>,
): ViewerInsets | undefined {
  const [insets, setInsets] = useState<ViewerInsets | undefined>(undefined);

  useLayoutEffect(() => {
    const viewer = viewerRef.current;
    const stage = stageRef.current;
    if (viewer === null || stage === null) return;

    const measure = (): void => {
      const outer = viewer.getBoundingClientRect();
      const inner = stage.getBoundingClientRect();
      if (!(inner.width > 0) || !(inner.height > 0)) {
        setInsets(undefined);
        return;
      }
      const next: ViewerInsets = {
        top: Math.max(0, inner.top - outer.top),
        right: Math.max(0, outer.right - inner.right),
        bottom: Math.max(0, outer.bottom - inner.bottom),
        left: Math.max(0, inner.left - outer.left),
      };
      setInsets((previous) => (sameInsets(previous, next) ? previous : next));
    };

    // Antes de pintar: la imagen no se ve saltar de lugar.
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    // La celda cambia de tamano cuando cambia la ventana o el alto de la linea de tiempo.
    const observer = new ResizeObserver(measure);
    observer.observe(viewer);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [viewerRef, stageRef]);

  return insets;
}
