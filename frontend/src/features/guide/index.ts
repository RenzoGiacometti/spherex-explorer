// Recorrido guiado "Encontra a WISE 0855": seis pasos sobre el visor.
//
// Son dos piezas, y ninguna recibe props del resto de la aplicacion:
//
//   <GuideLauncher />   el boton que lo inicia. Va en la pantalla de entrada
//                       (features/sphere/SpherePage.tsx), sobre el buscador.
//   <GuideTour />       la tarjeta con los pasos y el anillo. Va una sola vez,
//                       al lado de la pantalla del visor: en App.tsx,
//                       `<><GuideTour /><ViewerPage /></>`.
//
// /?dev=guide (guide.devpage.tsx) arma lo mismo sin el resto de la aplicacion.

export { GuideLauncher, type GuideLauncherProps } from "./GuideLauncher";
export { GuideTour } from "./GuideTour";
export { startTour, useGuideStore } from "./guideStore";
export { TOUR_STEPS, type TourStep } from "./tour";
