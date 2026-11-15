// Identidad de un plano dentro del estado del campo.

import type { Plane } from "@/api/types";

/** Clave de un plano en los mapas del estado: "epoca:detector". */
export function planeKey(epoch: number, detector: number): string {
  return `${epoch}:${detector}`;
}

/**
 * Dice si un plano tiene binario para bajar: provisorio (`building`) o
 * definitivo (`ready`, `partial`). Los `pending` y los `empty` no tienen
 * (docs/contrato-cubo.md, seccion 5, "Plano").
 */
export function hasBinary(plane: Pick<Plane, "status" | "rev">): boolean {
  return (
    plane.rev > 0 &&
    (plane.status === "building" || plane.status === "ready" || plane.status === "partial")
  );
}

/** El plano de una epoca y un detector dentro de `planes`, si esta. */
export function findPlane(
  planes: readonly Plane[] | undefined,
  epoch: number,
  detector: number,
): Plane | undefined {
  return planes?.find((plane) => plane.epoch === epoch && plane.detector === detector);
}
