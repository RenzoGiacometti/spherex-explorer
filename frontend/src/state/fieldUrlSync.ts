// Une el estado de la URL con el estado del campo: cada cambio de la URL (un
// link abierto, una busqueda, otra banda, atras y adelante en el historial)
// abre o cierra el campo, cambia la banda y el objeto buscado.
//
// Los cambios que no tocan el campo (modo, epoca, idioma) no generan pedidos:
// `syncWithUrl` no hace nada si el campo, la banda y el nombre son los mismos.
//
// Antes de aplicarla, una URL con coordenadas y sin nombre que cae dentro de la
// huella de un campo guardado se lleva a ese campo (`savedFieldPatch`): un link
// con las coordenadas de catalogo de un objeto abre su campo guardado, con la
// mira y el contexto, y no uno casi igual que habria que armar de cero.

import { useEffect } from "react";
import { featuredUrlPatch, savedFieldAt } from "@/features/entry/featured";
import { type FieldStore, useFieldStore } from "./fieldStore";
import { hasField, type UrlState, useUrlState } from "./urlState";

type UrlStoreApi = Pick<typeof useUrlState, "getState" | "subscribe">;

interface FieldStoreApi {
  getState(): Pick<FieldStore, "syncWithUrl">;
}

/** Consulta de la barra de direcciones, para saber que parametros trae escritos. */
function currentSearch(): string {
  return typeof window === "undefined" ? "" : window.location.search;
}

/**
 * Cambio que lleva la URL al campo guardado que contiene su punto, o null si no
 * hace falta: la URL no abre un campo, ya trae un nombre (alguien eligio ese
 * objeto) o el punto no cae en la huella de ningun campo guardado.
 *
 * Van el centro y el nombre del campo guardado, y su banda de apertura salvo
 * que `search` (la consulta tal como esta escrita) ya traiga `band`: una banda
 * pedida a mano se respeta.
 *
 * Tampoco se toca un link completo al campo guardado: su centro exacto con la
 * banda escrita. Ya abre ese campo, y quien lo armo sin nombre lo ve como lo
 * dejo, sin mira.
 */
export function savedFieldPatch(
  url: UrlState,
  search: string,
): Pick<UrlState, "ra" | "dec" | "name" | "band"> | null {
  if (!hasField(url) || url.name !== null) return null;
  const saved = savedFieldAt(url);
  if (saved === null) return null;
  const { ra, dec, name, band } = featuredUrlPatch(saved);
  const bandWritten = new URLSearchParams(search).has("band");
  if (bandWritten && url.ra === ra && url.dec === dec) return null;
  return { ra, dec, name, band: bandWritten ? url.band : band };
}

/**
 * Aplica la URL actual al campo y sigue sus cambios. Devuelve la funcion que
 * corta el seguimiento; cortarlo no cierra el campo abierto.
 *
 * Una URL que hay que llevar a un campo guardado no se aplica: se corrige en la
 * misma entrada del historial, y lo que se aplica es la corregida.
 */
export function bindFieldToUrl(
  urlStore: UrlStoreApi = useUrlState,
  fieldStore: FieldStoreApi = useFieldStore,
  readSearch: () => string = currentSearch,
): () => void {
  /** Corrige la URL si hace falta; dice si lo hizo. */
  function redirect(url: UrlState): boolean {
    const patch = savedFieldPatch(url, readSearch());
    if (patch === null) return false;
    urlStore.getState().update(patch, { history: "replace" });
    return true;
  }

  redirect(urlStore.getState());
  fieldStore.getState().syncWithUrl(urlStore.getState());
  return urlStore.subscribe((url) => {
    // La correccion vuelve a pasar por aca, ya con nombre: esa es la que se aplica.
    if (!redirect(url)) fieldStore.getState().syncWithUrl(url);
  });
}

/** Mantiene el campo al dia con la URL mientras el componente esta montado. */
export function useFieldUrlSync(): void {
  useEffect(() => bindFieldToUrl(), []);
}
