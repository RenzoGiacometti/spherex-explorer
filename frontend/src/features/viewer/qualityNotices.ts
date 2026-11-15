// Avisos de calidad (DESIGN.md, "Aviso de calidad"; contrato, seccion 5,
// "Avisos"): una frase por aviso, armada en el idioma activo a partir del
// codigo y sus parametros. Los avisos del contrato llegan uno por plano (una
// muestra trae 22 `low_coverage`): aca se juntan por codigo, y los planos se
// resumen por epoca y por banda.
//
// Este archivo tiene la parte pura; la frase la arma useQualityNotices.ts.

import type { PlaneRef } from "@/api/types";
import { EN_DASH, formatBand } from "@/lib/format";

/**
 * Por debajo de cuantas exposiciones un plano lleva `few_exposures`, y por
 * debajo de que fraccion con datos lleva `low_coverage` (contrato, seccion 5,
 * tabla de avisos). Van en la frase, formateados.
 */
export const FEW_EXPOSURES_LIMIT = 5;
export const LOW_COVERAGE_LIMIT = 0.9;

/** Bandas seguidas que hacen falta para escribirlas como rango ("B1 a B6" con raya). */
const MIN_RUN = 3;

/**
 * Lista de bandas en pocas letras: las seguidas, de a tres o mas, van como
 * rango con raya corta ("B1-B6"); las demas, separadas por coma ("B1, B4").
 */
export function formatBandList(detectors: readonly number[]): string {
  const sorted = [...new Set(detectors)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let start = 0; start < sorted.length; ) {
    let end = start;
    while (end + 1 < sorted.length && sorted[end + 1] === (sorted[end] as number) + 1) end += 1;
    if (end - start + 1 >= MIN_RUN) {
      parts.push(
        `${formatBand(sorted[start] as number)}${EN_DASH}${formatBand(sorted[end] as number)}`,
      );
    } else {
      for (let index = start; index <= end; index += 1) {
        parts.push(formatBand(sorted[index] as number));
      }
    }
    start = end + 1;
  }
  return parts.join(", ");
}

/** Epocas que comparten las mismas bandas afectadas. */
export interface PlaneGroup {
  readonly epochs: readonly number[];
  readonly detectors: readonly number[];
}

/**
 * Junta los planos de un aviso por epoca y despues las epocas que tienen las
 * mismas bandas: 18 planos de 3 epochs por 6 bandas quedan en un solo grupo.
 * Las epocas van en orden y cada grupo, donde aparece su primera epoca.
 */
export function groupPlanes(planes: readonly PlaneRef[]): PlaneGroup[] {
  const byEpoch = new Map<number, Set<number>>();
  for (const plane of planes) {
    const detectors = byEpoch.get(plane.epoch) ?? new Set<number>();
    detectors.add(plane.detector);
    byEpoch.set(plane.epoch, detectors);
  }
  const groups = new Map<string, { epochs: number[]; detectors: number[] }>();
  for (const epoch of [...byEpoch.keys()].sort((a, b) => a - b)) {
    const detectors = [...(byEpoch.get(epoch) ?? [])].sort((a, b) => a - b);
    const key = detectors.join(",");
    const group = groups.get(key);
    if (group) group.epochs.push(epoch);
    else groups.set(key, { epochs: [epoch], detectors });
  }
  return [...groups.values()];
}
