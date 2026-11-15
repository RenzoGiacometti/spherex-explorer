// Un interruptor de la esfera guardado en la URL: `?const=1`.
//
// El estado compartido de la URL (src/state/urlState.ts) escribe sus claves y
// deja como estan las que no conoce, asi que un parametro propio de la esfera
// sobrevive a los cambios de idioma y a abrir un campo. Si mas adelante otra
// pantalla necesita leerlo, el lugar para mudarlo es ese modulo.

import { useCallback, useEffect, useState } from "react";

function readFlag(name: string): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get(name) === "1";
}

/** Valor de un interruptor de la URL y la funcion que lo cambia (sin sumar historial). */
export function useUrlFlag(name: string): readonly [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => readFlag(name));

  // Atras y adelante del navegador: la URL manda.
  useEffect(() => {
    const sync = (): void => setValue(readFlag(name));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [name]);

  const set = useCallback(
    (next: boolean): void => {
      const params = new URLSearchParams(window.location.search);
      if (next) params.set(name, "1");
      else params.delete(name);
      const text = params.toString();
      const search = text === "" ? "" : `?${text}`;
      const url = `${window.location.pathname}${search}${window.location.hash}`;
      window.history.replaceState(window.history.state, "", url);
      setValue(next);
    },
    [name],
  );

  return [value, set];
}
