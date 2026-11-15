// Textos de una epoca que se repiten en la linea de tiempo, el panel Modo y
// los metadatos. Las fechas llegan del backend como texto ISO (AAAA-MM-DD).

import type { Epoch } from "@/api/types";
import { NO_VALUE } from "@/lib/format";

/** Mes de inicio de la epoca, "2025-05": lo que se lee bajo cada marca de la linea de tiempo. */
export function epochMonth(epoch: Epoch): string {
  return epoch.start.slice(0, 7);
}

/** La epoca con ese numero, si el campo la tiene. */
export function findEpoch(
  epochs: readonly Epoch[] | undefined,
  number: number | null,
): Epoch | undefined {
  return number === null ? undefined : epochs?.find((epoch) => epoch.epoch === number);
}

/** Mes de inicio de la epoca con ese numero, o la raya de "sin valor". */
export function epochMonthOf(epochs: readonly Epoch[] | undefined, number: number | null): string {
  const epoch = findEpoch(epochs, number);
  return epoch ? epochMonth(epoch) : NO_VALUE;
}
