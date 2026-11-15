import { useCallback, useSyncExternalStore } from "react";

/** Ancho de celular de DESIGN.md ("Responsive Behavior"): menos de 600 px. */
export const PHONE_QUERY = "(max-width: 599px)";

function matches(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/**
 * Dice si la ventana cumple una consulta de medios de CSS, y se actualiza
 * cuando deja de cumplirla o empieza a hacerlo. Donde no hay `matchMedia`
 * devuelve false.
 *
 * Sirve para lo que una hoja de estilos no puede hacer: en el celular el visor
 * arma otra pantalla, con los controles frecuentes abajo y el resto en un cajon.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      // Un navegador viejo no tiene `addEventListener` en la consulta: queda con lo que midio al abrir.
      list.addEventListener?.("change", notify);
      return () => list.removeEventListener?.("change", notify);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => matches(query),
    () => false,
  );
}
