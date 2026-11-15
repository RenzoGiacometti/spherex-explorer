// Pagina de prueba del recorrido guiado: /?dev=guide con `pnpm dev`.
//
// Es la aplicacion como queda con el recorrido montado: sin coordenadas en la
// URL, la entrada con el boton que lo inicia; con coordenadas, el visor con la
// tarjeta de los pasos. `dev=guide` se conserva al pasar de una a otra.
//
// Necesita el backend en /api con el campo de WISE 0855 (el real, que lo tiene
// precalculado, o el servidor falso). `&lang=es` o `&lang=en` fijan el idioma.
//
// La entrada no tiene todavia un lugar para el boton, asi que esta pagina lo
// agrega a su columna desde afuera. En la aplicacion va escrito en la pantalla
// de entrada (ver index.ts).

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DevPage } from "@/dev/devPages";
import { EntryPage } from "@/features/entry";
import { ViewerPage } from "@/features/viewer";
import { useUrlState } from "@/state/urlState";
import { GuideLauncher } from "./GuideLauncher";
import { GuideTour } from "./GuideTour";

/** La entrada, con el boton del recorrido al final de su columna. */
function EntryWithLauncher() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const column = hostRef.current?.querySelector("main");
    if (!column) return;
    const element = document.createElement("div");
    column.append(element);
    setSlot(element);
    return () => {
      element.remove();
      setSlot(null);
    };
  }, []);

  return (
    // Sin caja propia: la entrada mide su alto contra el contenedor de la aplicacion.
    <div ref={hostRef} style={{ display: "contents" }}>
      <EntryPage />
      {slot === null ? null : createPortal(<GuideLauncher />, slot)}
    </div>
  );
}

function GuideDevPage() {
  const showViewer = useUrlState((state) => state.ra !== null && state.dec !== null);
  return (
    <>
      <GuideTour />
      {showViewer ? <ViewerPage /> : <EntryWithLauncher />}
    </>
  );
}

export const devPage: DevPage = { Component: GuideDevPage };
