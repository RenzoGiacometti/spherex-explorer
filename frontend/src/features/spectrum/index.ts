// Espectro (Etapa 2). El visor lo usa asi (features/viewer/useSpectrum.ts y
// SpectrumDock.tsx):
// 1. Un clic en la imagen pide el espectro con `fetchSpectrum({ ra, dec, field })`
//    (y `pmRa`, `pmDec`, `epoch` de /api/resolve si es el objeto buscado).
// 2. El documento se dibuja con `<SpectrumPanel spectrum={documento} />`.
// 3. Los textos estan en src/i18n/locales/<idioma>/spectrum.json.
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
export {
  formatBandList,
  SNAP_NOTICE_MIN_ARCSEC,
  SpectrumPanel,
  type SpectrumPanelProps,
} from "./SpectrumPanel";
export {
  buildSoundPlan,
  canPlaySound,
  playSpectrum,
  type SoundPlan,
  type SoundPlayback,
  type SoundStep,
} from "./sonify";
export { SPECTRUM_NAMESPACE, type SpectrumT } from "./texts";
export {
  parseSpectrum,
  type SpectrumBin,
  type SpectrumDetector,
  type SpectrumDocument,
  type SpectrumNearest,
  type SpectrumPoint,
  type SpectrumStatus,
  type SpectrumWarning,
  spectrumSchema,
} from "./types";
