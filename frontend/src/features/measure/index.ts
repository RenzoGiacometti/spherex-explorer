// Medidor de movimiento propio (SPEC.md, Etapa 5: "Marcar un objeto por epoca").
//
// La persona hace clic sobre el objeto en cada epoca; el clic se ajusta al
// centroide local o, si la fuente esta saturada, al centro de sus alas. Con
// dos epocas o mas se calcula el desplazamiento, el movimiento propio con su
// error, la trayectoria y la posicion a cinco anios, y se compara con el
// catalogo si el objeto buscado tiene trayectoria en /api/field/{id}/track.
//
//   centroid.ts        centroide con ventana gaussiana
//   wingsFit.ts        ajuste por las alas de una fuente saturada
//   solver.ts          minimos cuadrados no lineales, robustos, para el ajuste
//   snap.ts            del clic a la posicion: elige entre los dos
//   marks.ts           una marca: posicion en el cielo, fecha y error
//   motion.ts          movimiento propio, prediccion y comparacion con el catalogo
//   useMeasure.ts      estado: los clics y lo que se calcula con ellos
//   MeasureLayer.tsx   lo que se dibuja sobre la imagen, y los clics
//   MeasurePanel.tsx   panel con los resultados
//   texts.ts           textos (measure.es.json, measure.en.json)
//   measure.devpage.tsx  pagina de desarrollo, /?dev=measure
//
// Para sumarlo al visor (features/viewer/ViewerPage.tsx):
//
//   const measure = useMeasure(view.current);
//   ...
//   <ImageViewer ...>
//     {(overlay) => (
//       <>
//         <ImageAnnotations overlay={overlay} controller={controller} />
//         <MeasureLayer overlay={overlay} measure={measure} />
//       </>
//     )}
//   </ImageViewer>
//   ...
//   <MeasurePanel measure={measure} />   en la columna derecha

export type { CentroidOptions, CentroidResult, PixelPoint } from "./centroid";
export { windowedCentroid } from "./centroid";
export { MeasureLayer, type MeasureLayerProps } from "./MeasureLayer";
export { MeasurePanel, type MeasurePanelProps } from "./MeasurePanel";
export type { Mark, MarkInput, MarkResult } from "./marks";
export { measureMark } from "./marks";
export type {
  CatalogComparison,
  MotionFit,
  MotionModel,
  MotionPoint,
  SkyVector,
} from "./motion";
export { compareWithTrack, fitMotion, PREDICTION_YEARS } from "./motion";
export type { SnapFailure, SnapMethod, SnapResult } from "./snap";
export { snapToSource } from "./snap";
export type { Measure, MeasureClick, MeasureFailure } from "./useMeasure";
export { useMeasure } from "./useMeasure";
export type { WingsOptions, WingsResult } from "./wingsFit";
export { fitWings } from "./wingsFit";
