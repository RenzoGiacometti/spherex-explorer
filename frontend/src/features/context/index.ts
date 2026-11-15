// Contexto de otras misiones (Etapa 3). El visor los monta (features/viewer:
// modo `journey` y capa de Gaia del panel Imagen). La pagina de prueba esta en
// /?dev=context (context.devpage.tsx) y docs/contexto.md explica de donde
// salen los datos. Los textos estan en src/i18n/locales/<idioma>/context.json.
//
//   MissionJourney  control que recorre 2MASS, WISE y las epocas de SPHEREx
//                   en orden de fecha, con el anio a la vista
//   FrameCanvas     la imagen del cuadro actual, con capas encima
//   GaiaLayer       fuentes de Gaia DR3 con su flecha de movimiento propio
//   GaiaControls    prender la capa, largo de las flechas y magnitud limite
//   contextApi      cliente de /api/context y /api/survey

export {
  type ContextApi,
  type ContextApiConfig,
  contextApi,
  createContextApi,
  type FieldGeometry,
} from "./contextApi";
export { FrameCanvas, type FrameCanvasProps, type FrameLayout } from "./FrameCanvas";
export {
  DEFAULT_GAIA_LIMIT,
  GaiaControls,
  type GaiaControlsProps,
  GaiaLayer,
  type GaiaLayerProps,
} from "./GaiaLayer";
export {
  ARROW_YEAR_STEPS,
  arrowPath,
  arrowYearsForStep,
  DEFAULT_ARROW_STEP,
  fastestSource,
  type GaiaMarker,
  gaiaMarkers,
  gaiaPositionAt,
  gaiaTotalMotion,
} from "./gaia";
export {
  type FrameImage,
  type FramePoint,
  type JourneyFrame,
  journeySpanYears,
  MISSIONS,
  type Mission,
  mjdToYear,
  orderFrames,
  spherexFrame,
  stepFrame,
  surveyFrame,
} from "./journey";
export {
  DEFAULT_JOURNEY_INTERVAL_MS,
  frameBandText,
  frameDateText,
  MissionJourney,
  type MissionJourneyProps,
} from "./MissionJourney";
export type {
  ContextDocument,
  ContextIndex,
  GaiaCatalog,
  GaiaInfo,
  LayerTarget,
  SurveyLayer,
  SurveyName,
} from "./schema";
