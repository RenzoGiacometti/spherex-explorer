// Curva de luz. El visor la usa asi (features/viewer/useLightcurve.ts y
// SpectrumDock.tsx):
// 1. La pestana "Curva de luz" del panel que abre un clic en la imagen la pide
//    con `fetchLightcurve({ ra, dec, field })` (y `pmRa`, `pmDec`, `epoch` de
//    /api/resolve si es el objeto buscado): los mismos parametros que el espectro.
// 2. El documento se dibuja con `<LightcurvePanel lightcurve={documento} initialBand={banda} />`.
// 3. Los textos estan en src/i18n/locales/<idioma>/lightcurve.json.
//
// Para verlo sin el visor: /?dev=lightcurve con `pnpm dev`
// (lightcurve.devpage.tsx), con las curvas precalculadas de los cinco objetos
// de prueba.

export {
  fetchLightcurve,
  type LightcurveQuery,
  type LightcurveRequestOptions,
  lightcurveUrl,
} from "./api";
export { LightcurveChart, type LightcurveChartProps } from "./LightcurveChart";
export {
  bandHasCurve,
  formatBandList,
  LightcurvePanel,
  type LightcurvePanelProps,
} from "./LightcurvePanel";
export { LIGHTCURVE_NAMESPACE, type LightcurveT } from "./texts";
export {
  detectorsOf,
  type LightcurveBin,
  type LightcurveDocument,
  type LightcurveEpoch,
  type LightcurveMethod,
  type LightcurvePoint,
  type LightcurveSeries,
  type LightcurveVerdict,
  type LightcurveWarning,
  lightcurveSchema,
  parseLightcurve,
  seriesOf,
} from "./types";
