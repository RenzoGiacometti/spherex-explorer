// Espectro (Etapa 2): componentes sueltos, listos para sumar al visor.
//
// Como integrarlo:
// 1. Al hacer clic en un punto del visor, pedir el espectro con
//    `fetchSpectrum({ ra, dec, field })` (y `pmRa`, `pmDec` de /api/resolve si
//    el objeto se mueve).
// 2. Dibujar `<SpectrumPanel spectrum={documento} />` en un panel del visor.
// 3. Mover los textos a src/i18n (ver texts.ts).
//
// Para verlo sin el visor: /?dev=spectrum con `pnpm dev` (spectrum.devpage.tsx),
// con los espectros precalculados de los cinco objetos de prueba.

export { fetchSpectrum, type SpectrumQuery, type SpectrumRequestOptions, spectrumUrl } from "./api";
export { ChemicalFingerprint, type ChemicalFingerprintProps } from "./ChemicalFingerprint";
export {
  type BandEstimate,
  chemicalFingerprint,
  estimateBand,
  type FingerprintLevel,
  type MoleculeEstimate,
} from "./fingerprint";
export {
  MOLECULE_BANDS,
  MOLECULE_FORMULA,
  MOLECULE_IDS,
  type MoleculeBand,
  type MoleculeId,
} from "./molecules";
export { SpectrumChart, type SpectrumChartProps } from "./SpectrumChart";
export { formatBandList, SpectrumPanel, type SpectrumPanelProps } from "./SpectrumPanel";
export {
  buildSoundPlan,
  canPlaySound,
  playSpectrum,
  type SoundPlan,
  type SoundPlayback,
  type SoundStep,
} from "./sonify";
export { SPECTRUM_NAMESPACE, useSpectrumTexts } from "./texts";
export {
  parseSpectrum,
  type SpectrumBin,
  type SpectrumDetector,
  type SpectrumDocument,
  type SpectrumPoint,
  type SpectrumStatus,
  type SpectrumWarning,
  spectrumSchema,
} from "./types";
