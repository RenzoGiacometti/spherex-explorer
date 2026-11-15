import { useEffect } from "react";
import { EntryPlaceholder } from "@/features/entry/EntryPlaceholder";
import { ViewerPlaceholder } from "@/features/viewer/ViewerPlaceholder";
import { browserLanguages, detectLanguage, setLanguage } from "@/i18n";
import { useUrlState } from "@/state/urlState";

/**
 * Cascaron de la aplicacion. La URL decide que se ve: sin coordenadas, la
 * entrada; con `ra` y `dec`, el visor (SPEC.md, seccion 3.3).
 */
export function App() {
  const showViewer = useUrlState((state) => state.ra !== null && state.dec !== null);
  const urlLanguage = useUrlState((state) => state.lang);

  // El idioma sigue a la URL: `lang` manda y, si falta, decide el navegador.
  useEffect(() => {
    void setLanguage(urlLanguage ?? detectLanguage("", browserLanguages()));
  }, [urlLanguage]);

  return showViewer ? <ViewerPlaceholder /> : <EntryPlaceholder />;
}
