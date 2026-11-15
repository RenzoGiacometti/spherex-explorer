// Pagina de prueba del recorrido guiado: /?dev=guide con `pnpm dev`.
//
// Es lo mismo que arma App.tsx: sin coordenadas en la URL, la entrada (la
// esfera, que trae el boton que lo inicia); con coordenadas, el visor con la
// tarjeta de los pasos. `dev=guide` se conserva al pasar de una a otra.
//
// Necesita el backend en /api con el campo de WISE 0855 (el real, que lo tiene
// precalculado, o el servidor falso). `&lang=es` o `&lang=en` fijan el idioma.

import type { DevPage } from "@/dev/devPages";
import { SpherePage } from "@/features/sphere";
import { ViewerPage } from "@/features/viewer";
import { useUrlState } from "@/state/urlState";
import { GuideTour } from "./GuideTour";

function GuideDevPage() {
  const showViewer = useUrlState((state) => state.ra !== null && state.dec !== null);
  return (
    <>
      <GuideTour />
      {showViewer ? <ViewerPage /> : <SpherePage />}
    </>
  );
}

export const devPage: DevPage = { Component: GuideDevPage };
