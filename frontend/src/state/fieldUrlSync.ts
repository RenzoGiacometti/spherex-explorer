// Une el estado de la URL con el estado del campo: cada cambio de la URL (un
// link abierto, una busqueda, otra banda, atras y adelante en el historial)
// abre o cierra el campo, cambia la banda y el objeto buscado.
//
// Los cambios que no tocan el campo (modo, epoca, idioma) no generan pedidos:
// `syncWithUrl` no hace nada si el campo, la banda y el nombre son los mismos.

import { useEffect } from "react";
import { type FieldStore, useFieldStore } from "./fieldStore";
import { useUrlState } from "./urlState";

type UrlStoreApi = Pick<typeof useUrlState, "getState" | "subscribe">;

interface FieldStoreApi {
  getState(): Pick<FieldStore, "syncWithUrl">;
}

/**
 * Aplica la URL actual al campo y sigue sus cambios. Devuelve la funcion que
 * corta el seguimiento; cortarlo no cierra el campo abierto.
 */
export function bindFieldToUrl(
  urlStore: UrlStoreApi = useUrlState,
  fieldStore: FieldStoreApi = useFieldStore,
): () => void {
  fieldStore.getState().syncWithUrl(urlStore.getState());
  return urlStore.subscribe((url) => fieldStore.getState().syncWithUrl(url));
}

/** Mantiene el campo al dia con la URL mientras el componente esta montado. */
export function useFieldUrlSync(): void {
  useEffect(() => bindFieldToUrl(), []);
}
