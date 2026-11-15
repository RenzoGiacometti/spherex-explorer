// Visor de imagenes: interfaz publica.
//
//   planeImage.ts        plano listo para dibujar (valores y mascara)
//   stretch.ts           estirado y cortes del control de contraste
//   compose.ts           escena y composicion de referencia en CPU
//   colors.ts            colores leidos de las variables CSS de tokens.css
//   view.ts              encuadre, acercamiento, desplazamiento y transformaciones
//   renderer.ts          interfaz comun de los dos dibujos
//   webglRenderer.ts     dibujo con WebGL2
//   canvas2dRenderer.ts  dibujo con canvas 2D, cuando no hay WebGL2
//   ImageViewer.tsx      componente de React que envuelve todo
//   testSupport.ts       contextos de canvas simulados, solo para tests
//   viewer.devpage.tsx   pagina de desarrollo, /?dev=viewer

export type { Rgb, Rgba } from "./colors";
export {
  NO_COLOR,
  NO_DATA_COLOR_VARIABLE,
  parseCssColor,
  readCssColor,
  toCssHex,
  toRgb,
} from "./colors";
export type { ComposeOptions, ImageSize, Scene, SceneHighlight, SceneMode } from "./compose";
export {
  composeScene,
  MAX_SCENE_PLANES,
  SCENE_MODES,
  sameScene,
  sceneError,
  sceneSize,
} from "./compose";
export type { ImageViewerHandle, ImageViewerProps, ViewerOverlay } from "./ImageViewer";
export { ImageViewer } from "./ImageViewer";
export type { MaskValue, PlaneImage } from "./planeImage";
export { MASK_NO_DATA, MASK_SATURATED, MASK_VALID, toPlaneImage } from "./planeImage";
export type {
  Frame,
  PixelSnapshot,
  RendererInfo,
  RendererKind,
  RendererOptions,
  SceneRenderer,
} from "./renderer";
export { createRenderer } from "./renderer";
export type { Cuts, DisplayRange, StretchKind } from "./stretch";
export {
  ASINH_STRETCH_A,
  contrastCuts,
  cutSpan,
  DEFAULT_CONTRAST,
  DEFAULT_STRETCH,
  differenceHalfRange,
  LOG_STRETCH_A,
  MAX_CONTRAST,
  MIN_CONTRAST,
  normalize,
  STRETCH_KINDS,
  stretchSigned,
  stretchUnit,
  stretchValue,
  toByte,
} from "./stretch";
export type {
  Point,
  ScreenRect,
  ViewAction,
  ViewportSize,
  ViewState,
  ViewTransform,
  WheelInput,
} from "./view";
export {
  applyViewAction,
  backingStoreSize,
  clampView,
  fitScale,
  homeView,
  homeZoomForViewFov,
  imageClipRect,
  imageScreenRect,
  imageToScreen,
  KEY_ZOOM_STEP,
  MAX_ZOOM,
  MIN_ZOOM,
  panByScreen,
  pinchView,
  screenToImage,
  svgTransform,
  viewActionForKey,
  viewTransform,
  wheelZoomFactor,
  zoomAround,
  zoomAtCenter,
} from "./view";
