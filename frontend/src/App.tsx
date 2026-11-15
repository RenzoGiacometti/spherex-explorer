import { useEffect } from "react";
import { DevPageHost } from "@/dev/DevPageHost";
import { SpherePage } from "@/features/sphere";
import { ViewerPage } from "@/features/viewer";
import { browserLanguages, detectLanguage, setLanguage } from "@/i18n";
import { useFieldUrlSync } from "@/state/fieldUrlSync";
import { useUrlState } from "@/state/urlState";

/**
 * Cascaron de la aplicacion. La URL decide que se ve: sin coordenadas, la
 * entrada, que es la esfera celeste (src/features/sphere); con `ra` y `dec`, el
 * visor (SPEC.md, seccion 3.3).
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

  return showViewer ? <ViewerPage /> : <SpherePage />;
}
