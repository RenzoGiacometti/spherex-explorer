import { useMemo } from "react";
import { arrowYearsForStep, type FrameLayout, GaiaLayer } from "@/features/context";
import type { ViewerOverlay } from "@/viewer/ImageViewer";
import { imageScreenRect, imageToScreen } from "@/viewer/view";
import type { GaiaControl } from "./useViewerController";

export interface GaiaOverlayProps {
  /** Transformacion vigente del visor: llega de `children` de ImageViewer. */
  readonly overlay: ViewerOverlay;
  readonly gaia: GaiaControl;
  /** Hay una imagen en pantalla sobre la que dibujar. */
  readonly shown: boolean;
}

/**
 * Capa de Gaia sobre la imagen del visor: las fuentes del catalogo del campo,
 * en la posicion que tenian en la fecha de lo que se ve, con su flecha de
 * movimiento propio. Sigue el acercamiento y el desplazamiento, como las demas
 * anotaciones, y no recibe el puntero.
 */
export function GaiaOverlay({ overlay, gaia, shown }: GaiaOverlayProps) {
  const { transform, viewport, image } = overlay;
  // `GaiaLayer` se ubica con lo mismo que le da `FrameCanvas`: aca, la transformacion del visor.
  const layout = useMemo<FrameLayout>(
    () => ({
      width: viewport.width,
      height: viewport.height,
      scale: transform.scale,
      toScreen: (x, y) => imageToScreen(transform, x, y),
    }),
    [transform, viewport.width, viewport.height],
  );
  // La capa ocupa el visor entero: el dibujo se recorta al rectangulo de la imagen, para que una
  // flecha larga no siga por encima de los paneles ni del fondo.
  const clip = useMemo(() => imageScreenRect(transform, image), [transform, image]);

  if (!shown || !gaia.on || gaia.catalog === null || gaia.grid === null) return null;
  return (
    <GaiaLayer
      catalog={gaia.catalog}
      grid={gaia.grid}
      layout={layout}
      year={gaia.year}
      arrowYears={arrowYearsForStep(gaia.arrowStep)}
      maxGMag={gaia.maxGMag}
      clip={clip}
    />
  );
}
