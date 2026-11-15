// Contexto de otras misiones (Etapa 3). El visor los monta (features/viewer:
// modos `journey` y `curtain`, capa de Gaia del panel Imagen y ficha del objeto
// en el panel de la fuente). Las paginas de prueba estan en /?dev=context,
// /?dev=cortina y /?dev=ficha; docs/contexto.md y docs/contexto-2.md explican
// de donde salen los datos. Los textos estan en src/i18n/locales/<idioma>/
// (context.json, curtain.json, objectCard.json).
//
//   MissionJourney  control que recorre las placas del DSS, 2MASS, WISE y las
//                   epocas de SPHEREx en orden de fecha, con el anio a la vista
//   FrameCanvas     la imagen del cuadro actual, con capas encima
//   GaiaLayer       fuentes de Gaia DR3 con su flecha de movimiento propio
//   GaiaControls    prender la capa, largo de las flechas y magnitud limite
//   Curtain         cortina visible/infrarrojo; OpticalCredit, el credito de la placa
//   ObjectCard      ficha del objeto: distancia y movimiento de la fuente de Gaia
//   contextApi      cliente de /api/context y /api/survey
//   opticalApi      cliente de /api/context/optical y /api/survey/optical

export {
  Curtain,
  type CurtainProps,
  type CurtainSide,
  OpticalCredit,
  type OpticalCreditProps,
} from "./Curtain";
export {
  type ContextApi,
  type ContextApiConfig,
  contextApi,
  createContextApi,
  type FieldGeometry,
} from "./contextApi";
export { clampCurtain, DEFAULT_CURTAIN } from "./curtainMath";
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
export { ObjectCard, type ObjectCardProps } from "./ObjectCard";
export {
  curtainLayer,
  journeyLayers,
  type OpticalApi,
  type OpticalDocument,
  type OpticalLayer,
  opticalApi,
  opticalFrame,
  type PlateCredit,
  plateCredit,
  type TargetOffset,
  targetOffset,
  targetOutsideField,
} from "./optical";
export type {
  ContextDocument,
  ContextIndex,
  GaiaCatalog,
  GaiaInfo,
  LayerTarget,
  SurveyLayer,
  SurveyName,
} from "./schema";
