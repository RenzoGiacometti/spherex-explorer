// Recorrido guiado "Encontra a WISE 0855": cinco pasos sobre el visor.
//
// Son dos piezas, y ninguna recibe props del resto de la aplicacion:
//
//   <GuideLauncher />   el boton que lo inicia. Va en la pantalla de entrada,
//                       por ejemplo debajo de los destacados.
//   <GuideTour />       la tarjeta con los pasos y el anillo. Va una sola vez,
//                       al lado de la pantalla del visor: en App.tsx,
//                       `<><GuideTour /><ViewerPage /></>`.
//
// Mientras no esten montadas en la aplicacion, el recorrido se prueba en
// /?dev=guide (guide.devpage.tsx), que arma la entrada y el visor con las dos.

export { GuideLauncher, type GuideLauncherProps } from "./GuideLauncher";
export { GuideTour } from "./GuideTour";
export { startTour, useGuideStore } from "./guideStore";
export { TOUR_STEPS, type TourStep } from "./tour";
