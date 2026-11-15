import { lazy, Suspense, useEffect } from "react";
import { DevPageHost } from "@/dev/DevPageHost";
import { GuideTour } from "@/features/guide";
import { ViewerPage } from "@/features/viewer";
import { browserLanguages, detectLanguage, setLanguage } from "@/i18n";
import { useFieldUrlSync } from "@/state/fieldUrlSync";
import { useUrlState } from "@/state/urlState";

// La esfera trae three.js y la textura del cielo: va en un trozo aparte, para que un
// link directo al visor no los descargue.
const SpherePage = lazy(() =>
  import("@/features/sphere").then((module) => ({ default: module.SpherePage })),
);

/**
 * Cascaron de la aplicacion. La URL decide que se ve: sin coordenadas, la
 * entrada, que es la esfera celeste (src/features/sphere); con `ra` y `dec`, el
 * visor (SPEC.md, seccion 3.3). Junto al visor va el recorrido guiado
 * (src/features/guide), que no dibuja nada hasta que se lo inicia desde la
 * entrada.
 */
export function App() {
  const showViewer = useUrlState((state) => state.ra !== null && state.dec !== null);
  const urlLanguage = useUrlState((state) => state.lang);

  // El campo sigue a la URL: un link con coordenadas lo abre, otra banda lo
  // reordena y volver a la entrada lo cierra. Se une una sola vez, aca.
  useFieldUrlSync();

  // El idioma sigue a la URL: `lang` manda y, si falta, decide el navegador.
  useEffect(() => {
    void setLanguage(urlLanguage ?? detectLanguage("", browserLanguages()));
  }, [urlLanguage]);

  // Solo con `pnpm dev`: `/?dev=<id>` abre una pagina de desarrollo (src/dev/devPages.ts).
  const devPage = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).get("dev")
    : null;
  if (devPage) return <DevPageHost id={devPage} />;

  if (showViewer) {
    return (
      <>
        {/* Antes que la pantalla: sus botones son lo primero que encuentra el tabulador. */}
        <GuideTour />
        <ViewerPage />
      </>
    );
  }
  return (
    <Suspense fallback={null}>
      <SpherePage />
    </Suspense>
  );
}
