import { type ComponentType, useEffect, useState } from "react";
import { devPageIds, findDevPage } from "./devPages";

interface DevPageHostProps {
  readonly id: string;
}

/**
 * Muestra la pagina de desarrollo pedida con `/?dev=<id>`. Si no existe, lista
 * los identificadores disponibles.
 */
export function DevPageHost({ id }: DevPageHostProps) {
  const [Page, setPage] = useState<ComponentType | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPage(null);
    const loader = findDevPage(id);
    setMissing(loader === null);
    if (loader !== null) {
      void loader().then((module) => {
        // Se guarda dentro de una funcion: React llamaria al componente si se lo pasa directo.
        if (!cancelled) setPage(() => module.devPage.Component);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (missing) {
    return <pre data-dev-page="missing">{devPageIds().join("\n")}</pre>;
  }
  return Page === null ? null : <Page />;
}
