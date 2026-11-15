// Curva de luz: componentes sueltos, listos para sumar al visor.
//
// Como integrarlo:
// 1. Al hacer clic en un punto del visor, pedir la curva con
//    `fetchLightcurve({ ra, dec, field })` (y `pmRa`, `pmDec` de /api/resolve si
//    el objeto se mueve). Son los mismos parametros que el espectro.
// 2. Dibujar `<LightcurvePanel lightcurve={documento} initialBand={banda} />`.
// 3. Mover los textos a src/i18n (ver texts.ts).
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
export { formatBandList, LightcurvePanel, type LightcurvePanelProps } from "./LightcurvePanel";
export { LIGHTCURVE_NAMESPACE, useLightcurveTexts } from "./texts";
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
