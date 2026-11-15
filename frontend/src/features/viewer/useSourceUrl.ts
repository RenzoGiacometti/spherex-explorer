// El punto elegido, con su panel abierto, en la URL (state/urlState.ts): `sobj`
// si es el objeto buscado o `sra` y `sdec` si es un punto suelto, y `tab` con
// la pestana abierta. Asi el link copiado vuelve a abrir el panel.
//
// Va en los dos sentidos, uno despues del otro:
//
// 1. Al abrir un campo, lo que trae la URL se vuelve a pedir una sola vez,
//    cuando el campo ya tiene grilla (y, para el objeto, cuando /api/resolve ya
//    dijo donde esta). Un clic que llegue antes manda: lo de la URL se descarta.
// 2. Desde ahi, cada cambio del pedido o de la pestana se escribe en la URL,
//    reemplazando la entrada del historial. Cerrar el panel lo saca.
//
// Lo que se escribe sale siempre del pedido, nunca de la URL: cuando la URL
// cambia de campo, el punto del campo anterior no pasa al nuevo.

import { useEffect, useState } from "react";
import { useFieldStore } from "@/state/fieldStore";
import { DEFAULT_TAB, type SourceTabName, type UrlState, useUrlState } from "@/state/urlState";
import type { SpectrumPoint } from "./spectrumClick";
import type { SpectrumController } from "./useSpectrum";

/** Lo que la URL guarda de un punto elegido; con null, nada. */
export function urlPointOf(point: SpectrumPoint | null): Pick<UrlState, "sobj" | "sra" | "sdec"> {
  if (point === null) return { sobj: false, sra: null, sdec: null };
  // El objeto buscado se pide por nombre y no trae pixel: ya tiene su mira (spectrumClick.ts).
  if (point.name !== null && point.pixel === null) return { sobj: true, sra: null, sdec: null };
  return { sobj: false, sra: point.query.ra, sdec: point.query.dec };
}

export interface SourceUrlOptions {
  /** Falso donde el panel de la fuente no se muestra (`embed`): ahi la URL no se toca. */
  readonly enabled: boolean;
  readonly spectrum: SpectrumController;
  readonly tab: SourceTabName;
  setTab(tab: SourceTabName): void;
}

export function useSourceUrl({ enabled, spectrum, tab, setTab }: SourceUrlOptions): void {
  const fieldId = useFieldStore((state) => state.fieldId);
  const gridReady = useFieldStore((state) => state.meta?.grid !== undefined);
  const resolveStatus = useFieldStore((state) => state.target.resolveStatus);
  /** Campo para el que ya se resolvio que hacer con lo que traia la URL. */
  const [settledField, setSettledField] = useState<string | null>(null);
  const settled = fieldId !== null && settledField === fieldId;
  const { state, requestObject, requestPosition } = spectrum;
  const idle = state.status === "idle";

  // biome-ignore lint/correctness/useExhaustiveDependencies: `resolveStatus` no se lee: avisa que /api/resolve respondio
  useEffect(() => {
    if (!enabled || settled || fieldId === null || !gridReady) return;
    const url = useUrlState.getState();
    // Con un pedido ya hecho (un clic que llego antes) no hay nada que reabrir.
    if (idle) {
      if (url.sobj && url.name !== null) {
        const target = useFieldStore.getState().target;
        if (target.resolved !== null) {
          setTab(url.tab);
          const center = target.resolved.field_center;
          requestObject({ name: url.name, ra: center.ra, dec: center.dec });
        } else if (target.name !== null && target.resolveStatus !== "error") {
          // Falta saber donde esta el objeto: se espera la respuesta de /api/resolve.
          return;
        }
      } else if (url.sra !== null && url.sdec !== null) {
        setTab(url.tab);
        requestPosition({ ra: url.sra, dec: url.sdec });
      }
    }
    setSettledField(fieldId);
  }, [
    enabled,
    settled,
    fieldId,
    gridReady,
    resolveStatus,
    idle,
    requestObject,
    requestPosition,
    setTab,
  ]);

  useEffect(() => {
    if (!enabled || !settled) return;
    useUrlState.getState().update({
      ...urlPointOf(state.status === "idle" ? null : state.point),
      tab: state.status === "idle" ? DEFAULT_TAB : tab,
    });
  }, [enabled, settled, state, tab]);
}
