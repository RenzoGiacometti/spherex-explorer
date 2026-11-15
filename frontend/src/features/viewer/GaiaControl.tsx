import { useMemo } from "react";
import {
  arrowYearsForStep,
  DEFAULT_GAIA_LIMIT,
  GaiaControls,
  gaiaMarkers,
} from "@/features/context";
import type { GaiaControl as GaiaLayerState } from "./useViewerController";

export interface GaiaControlProps {
  readonly gaia: GaiaLayerState;
}

/**
 * Capa de Gaia dentro del panel Imagen, junto a la de flags: el conmutador y,
 * prendida, el largo de las flechas y la magnitud limite (`GaiaControls`).
 *
 * En un campo sin contexto, o si el catalogo no se pudo cargar, el conmutador
 * queda deshabilitado, sin parrafos que lo expliquen.
 */
export function GaiaControl({ gaia }: GaiaControlProps) {
  const { catalog, grid, on, year, arrowStep, maxGMag } = gaia;

  // Cuantas fuentes se dibujan con estos controles: la misma cuenta que hace la capa.
  const shown = useMemo(() => {
    if (!on || catalog === null || grid === null) return 0;
    return gaiaMarkers(catalog, grid, {
      year,
      arrowYears: arrowYearsForStep(arrowStep),
      maxGMag,
      limit: DEFAULT_GAIA_LIMIT,
    }).length;
  }, [on, catalog, grid, year, arrowStep, maxGMag]);

  return (
    <GaiaControls
      variant="inline"
      visible={on}
      onVisibleChange={gaia.setOn}
      arrowStep={arrowStep}
      onArrowStepChange={gaia.setArrowStep}
      maxGMag={maxGMag}
      onMaxGMagChange={gaia.setMaxGMag}
      magRange={gaia.magRange}
      shown={shown}
      total={catalog?.count ?? 0}
      year={year}
      disabled={catalog === null || grid === null}
    />
  );
}
