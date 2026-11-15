// Huella quimica: un indicio de que moleculas absorben en el espectro.
//
// Para cada banda de molecules.ts compara el flujo medio dentro de la banda con
// el continuo que se espera ahi, interpolado entre las ventanas de sus
// costados:
//
//   profundidad = 1 - flujo_en_la_banda / continuo
//
// Todo sale de los promedios por canal (`binned`), ponderados por la inversa de
// la varianza. La palabra que se muestra depende de la profundidad y de que tan
// segura es (profundidad sobre su error):
//
//   fuerte        50 % o mas
//   moderada      25 % o mas
//   debil         10 % o mas
//   no detectada  menos, o menos de 3 sigma
//   sin datos     faltan puntos en la banda o en sus costados, o no hay
//                 continuo que absorber
//
// Es un indicio y no una deteccion: cada exposicion ve otra longitud de onda en
// otra fecha, asi que una fuente variable puede imitar una banda, y con esta
// resolucion varias moleculas se pisan. La interfaz lo rotula asi.

import {
  bandCenter,
  MOLECULE_BANDS,
  MOLECULE_IDS,
  type MoleculeBand,
  type MoleculeId,
  type WaveWindow,
} from "./molecules";
import type { SpectrumBin } from "./types";

export type FingerprintLevel = "strong" | "moderate" | "weak" | "none" | "unknown";

export interface BandEstimate {
  readonly band: MoleculeBand;
  readonly level: FingerprintLevel;
  /** Fraccion del continuo que falta en la banda (0 a 1); negativa si la banda sobresale. */
  readonly depth: number | null;
  /** Profundidad sobre su error. */
  readonly significance: number | null;
}

export interface MoleculeEstimate {
  readonly molecule: MoleculeId;
  readonly level: FingerprintLevel;
  /** La banda que decide la palabra: la mas profunda entre las que se pudieron medir. */
  readonly best: BandEstimate | null;
  /** Largo de la barra, de 0 a 1. */
  readonly strength: number;
}

const STRONG_DEPTH = 0.5;
const MODERATE_DEPTH = 0.25;
const WEAK_DEPTH = 0.1;
const MIN_SIGNIFICANCE = 3;
/** El continuo tiene que distinguirse del cero para hablar de absorcion. */
const MIN_CONTINUUM_SNR = 3;
const MIN_BAND_POINTS = 2;

interface Mean {
  readonly wavelength: number;
  readonly flux: number;
  readonly error: number;
  readonly n: number;
}

/** Media ponderada de los canales dentro de una ventana, o null si no hay ninguno. */
export function windowMean(bins: readonly SpectrumBin[], window: WaveWindow): Mean | null {
  let weightSum = 0;
  let fluxSum = 0;
  let waveSum = 0;
  let n = 0;
  for (const bin of bins) {
    if (bin.wavelength_um < window[0] || bin.wavelength_um > window[1]) continue;
    if (!(bin.error_mjy > 0) || !Number.isFinite(bin.flux_mjy)) continue;
    const weight = 1 / (bin.error_mjy * bin.error_mjy);
    weightSum += weight;
    fluxSum += weight * bin.flux_mjy;
    waveSum += weight * bin.wavelength_um;
    n += 1;
  }
  if (n === 0 || weightSum <= 0) return null;
  return {
    wavelength: waveSum / weightSum,
    flux: fluxSum / weightSum,
    error: Math.sqrt(1 / weightSum),
    n,
  };
}

/** Continuo en `wavelength`: recta entre los dos costados, o el nivel del unico que haya. */
function continuumAt(
  wavelength: number,
  left: Mean | null,
  right: Mean | null,
): { flux: number; error: number } | null {
  if (left !== null && right !== null && right.wavelength > left.wavelength) {
    const t = (wavelength - left.wavelength) / (right.wavelength - left.wavelength);
    return {
      flux: left.flux * (1 - t) + right.flux * t,
      error: Math.hypot(left.error * (1 - t), right.error * t),
    };
  }
  const only = left ?? right;
  return only === null ? null : { flux: only.flux, error: only.error };
}

function levelOf(depth: number, significance: number): FingerprintLevel {
  if (significance < MIN_SIGNIFICANCE || depth < WEAK_DEPTH) return "none";
  if (depth >= STRONG_DEPTH) return "strong";
  if (depth >= MODERATE_DEPTH) return "moderate";
  return "weak";
}

/** Profundidad de una banda. `unknown` si faltan datos para medirla. */
export function estimateBand(bins: readonly SpectrumBin[], band: MoleculeBand): BandEstimate {
  const unknown: BandEstimate = { band, level: "unknown", depth: null, significance: null };
  if (band.continuum === undefined) return unknown;

  const inside = windowMean(bins, [band.min, band.max]);
  if (inside === null || inside.n < MIN_BAND_POINTS) return unknown;
  const left = band.continuum.left === undefined ? null : windowMean(bins, band.continuum.left);
  const right = band.continuum.right === undefined ? null : windowMean(bins, band.continuum.right);
  // Si la banda declara dos costados, hacen falta los dos: con uno solo, una pendiente del espectro pasa por absorcion.
  if (band.continuum.left !== undefined && left === null) return unknown;
  if (band.continuum.right !== undefined && right === null) return unknown;
  const continuum = continuumAt(bandCenter(band), left, right);
  if (continuum === null || continuum.flux < MIN_CONTINUUM_SNR * continuum.error) return unknown;

  const ratio = inside.flux / continuum.flux;
  const depth = 1 - ratio;
  const ratioError = Math.hypot(
    inside.error / continuum.flux,
    (inside.flux * continuum.error) / (continuum.flux * continuum.flux),
  );
  const significance = ratioError > 0 ? depth / ratioError : 0;
  return { band, level: levelOf(depth, significance), depth, significance };
}

const LEVEL_RANK: Record<FingerprintLevel, number> = {
  unknown: 0,
  none: 1,
  weak: 2,
  moderate: 3,
  strong: 4,
};

/**
 * Una fila por molecula, en el orden de la interfaz: H2O, CH4, CO2, CO.
 *
 * `excludedDetectors` son los detectores cuyos canales no se usan: aquellos
 * donde la luz medida es sobre todo de otra fuente (aviso `offset_source`). Una
 * banda que caiga ahi queda "sin datos" en vez de describir a la vecina.
 */
export function chemicalFingerprint(
  bins: readonly SpectrumBin[],
  excludedDetectors: readonly number[] = [],
): MoleculeEstimate[] {
  const usable = bins.filter((bin) => !excludedDetectors.includes(bin.detector));
  return MOLECULE_IDS.map((molecule) => {
    const estimates = MOLECULE_BANDS.filter((band) => band.molecule === molecule).map((band) =>
      estimateBand(usable, band),
    );
    let best: BandEstimate | null = null;
    for (const estimate of estimates) {
      if (estimate.level === "unknown") continue;
      const better =
        best === null ||
        LEVEL_RANK[estimate.level] > LEVEL_RANK[best.level] ||
        (LEVEL_RANK[estimate.level] === LEVEL_RANK[best.level] &&
          (estimate.depth ?? 0) > (best.depth ?? 0));
      if (better) best = estimate;
    }
    if (best === null) return { molecule, level: "unknown", best: null, strength: 0 };
    const detected = best.level !== "none";
    return {
      molecule,
      level: best.level,
      best,
      strength: detected ? Math.min(1, Math.max(0, best.depth ?? 0)) : 0,
    };
  });
}
