// El listado de exposiciones tarda: el archivo de datos (IRSA) responde lento
// y el backend sigue reintentando durante unos minutos, sin dar el campo por
// fallido. No es un error: el visor lo dice y sigue esperando.
//
// Se sabe de dos maneras:
// - el backend lo informa en `progress.listing_attempt` (2 o mas es un reintento);
// - como respaldo, si el campo lleva mas de 30 s en la fase `listing` (un
//   backend que todavia no manda ese campo, o un primer intento que no vuelve).

import { useEffect, useState } from "react";
import { useFieldStore } from "@/state/fieldStore";

/** Tiempo en la fase `listing` a partir del cual se avisa, en ms. */
export const SLOW_LISTING_MS = 30_000;

export interface SlowListing {
  /** El listado esta tardando: hay que avisarlo. */
  readonly slow: boolean;
  /** Intento que informa el backend (2 o mas); null si no lo informa. */
  readonly attempt: number | null;
}

export function useSlowListing(): SlowListing {
  const listing = useFieldStore(
    (state) => state.phase === "loading" && state.meta?.progress.phase === "listing",
  );
  const attempt = useFieldStore((state) => state.meta?.progress.listing_attempt ?? 0);
  const [late, setLate] = useState(false);

  useEffect(() => {
    if (!listing) return;
    const timer = window.setTimeout(() => setLate(true), SLOW_LISTING_MS);
    return () => {
      window.clearTimeout(timer);
      setLate(false);
    };
  }, [listing]);

  const retrying = attempt >= 2;
  return { slow: listing && (retrying || late), attempt: retrying ? attempt : null };
}
