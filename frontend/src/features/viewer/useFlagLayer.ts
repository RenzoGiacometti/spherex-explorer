// Capa de flags del visor (DESIGN.md, "Capa de flags"; contrato, seccion 4.6).
//
// Al prenderla se piden las capas auxiliares de la imagen que se ve: en
// parpadeo y mantener apretado, las del plano que esta en pantalla; en
// diferencia, rojo/cian y suma, las de cada epoca que entra en la comparacion.
// El store las guarda por plano y las renueva solo cuando el plano cambia de
// revision; `selectAuxLayers` entrega solo las que corresponden a la imagen
// bajada. Por eso al cambiar de epoca, de banda o de revision la capa sigue a
// la imagen: mientras llegan las capas nuevas no se dibuja ninguna.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AuxLayers } from "@/api/binary";
import { planeKey } from "@/data/planeKey";
import { selectAuxLayers } from "@/data/selectors";
import { useFieldStore } from "@/state/fieldStore";
import { countFlags, type FlagCount, flagMask, maskedFlagBits } from "./flags";

/**
 * Estado de la capa:
 * - `off`: apagada.
 * - `idle`: prendida, pero no hay imagen de SPHEREx en pantalla.
 * - `loading`: faltan las capas de alguna de las epocas que se ven.
 * - `ready`: estan todas; `mask` y `present` dicen que hay.
 * - `error`: alguna no se pudo bajar; `retry` las vuelve a pedir.
 */
export type FlagLayerStatus = "off" | "idle" | "loading" | "ready" | "error";

export interface FlagLayer {
  readonly on: boolean;
  setOn(on: boolean): void;
  readonly status: FlagLayerStatus;
  /** Epocas cuyas capas se muestran: las de la imagen que se ve. */
  readonly epochs: readonly number[];
  /**
   * Un byte por pixel: 1 donde algun flag que el pipeline descarta esta
   * encendido en alguna de esas epocas. null si no hay nada que cubrir.
   */
  readonly mask: Uint8Array | null;
  /** Flags presentes en esas epocas, con su cantidad de pixeles. */
  readonly present: readonly FlagCount[];
  /** Vuelve a pedir las capas que no se pudieron bajar. */
  retry(): void;
}

const NO_FLAGS: readonly FlagCount[] = [];

/**
 * Mascara de las capas de un solo plano, guardada con ellas. El parpadeo
 * vuelve a la misma epoca cada pocos cuadros: con la misma mascara el visor no
 * sube de nuevo su textura ni vuelve a armar la trama.
 */
const planeMasks = new WeakMap<AuxLayers, { bits: number; mask: Uint8Array | null }>();

function maskOf(layers: readonly AuxLayers[], bits: number): Uint8Array | null {
  const only = layers[0];
  // En una comparacion la union depende de que epocas entran: se arma cada vez que cambian.
  if (layers.length !== 1 || only === undefined) return flagMask(layers, bits);
  const known = planeMasks.get(only);
  if (known && known.bits === bits) return known.mask;
  const mask = flagMask(layers, bits);
  planeMasks.set(only, { bits, mask });
  return mask;
}

/**
 * Capa de flags de las epocas que se ven en pantalla. `epochs` tiene que ser
 * estable mientras no cambie lo que se ve (sale de `ViewModel.composition`).
 */
export function useFlagLayer(epochs: readonly number[]): FlagLayer {
  const [on, setOn] = useState(false);
  const loadAux = useFieldStore((state) => state.loadAux);
  const band = useFieldStore((state) => state.band);
  const flags = useFieldStore((state) => state.meta?.flags);

  // Una entrada por epoca: sus capas, o null si no estan o son de otra revision.
  const layers = useFieldStore(
    useShallow((state) => (on ? epochs.map((epoch) => selectAuxLayers(state, epoch)) : [])),
  );
  const failed = useFieldStore(
    (state) =>
      on && epochs.some((epoch) => state.aux[planeKey(epoch, state.band)]?.status === "error"),
  );
  // Revision bajada de cada epoca: cuando sube, hay que pedir las capas de la nueva.
  const revisions = useFieldStore((state) =>
    epochs.map((epoch) => state.planes[planeKey(epoch, state.band)]?.rev ?? 0).join(","),
  );
  const shown = epochs.join(",");

  // `band`, `shown` y `revisions` no se leen adentro: avisan que cambio la
  // imagen que se ve y que hay que pedir sus capas. `loadAux` no repite un
  // pedido que ya esta hecho o en camino para la misma revision.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ver el comentario de arriba
  useEffect(() => {
    if (!on) return;
    for (const epoch of epochs) void loadAux(epoch);
  }, [on, loadAux, band, shown, revisions]);

  const retry = useCallback(() => {
    for (const epoch of epochs) void loadAux(epoch);
  }, [epochs, loadAux]);

  const complete = on && epochs.length > 0 && layers.every((item) => item !== null);
  const bits = useMemo(() => maskedFlagBits(flags), [flags]);
  const mask = useMemo(
    () => (complete ? maskOf(layers as readonly AuxLayers[], bits) : null),
    [complete, layers, bits],
  );
  const present = useMemo(
    () => (complete && flags ? countFlags(layers as readonly AuxLayers[], flags) : NO_FLAGS),
    [complete, layers, flags],
  );

  let status: FlagLayerStatus = "off";
  if (on) {
    if (epochs.length === 0) status = "idle";
    else if (complete) status = "ready";
    else status = failed ? "error" : "loading";
  }

  return { on, setOn, status, epochs, mask, present, retry };
}
