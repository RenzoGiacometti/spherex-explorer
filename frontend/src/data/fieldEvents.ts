// Aplica los eventos de GET /api/field/{id}/events al documento de metadatos
// (docs/contrato-cubo.md, seccion 4.2). Son funciones puras: reciben el
// documento que tiene el cliente y devuelven el nuevo, sin modificar el anterior.
//
//   state, listed  reemplazan el documento entero, tambien a mitad del flujo
//   queued         posicion en la cola
//   preview        objeto `preview`
//   progress       objeto `progress`
//   plane          el plano y la escala de su detector; se ignora si trae una
//                  revision mas vieja que la que ya se conoce
//   warning        suma un aviso
//   done           estado final, revision del campo y tiempo total
//   error          el trabajo fallo: `status` pasa a `failed`
//
// Antes del primer `state` no hay documento: los demas eventos no tienen sobre
// que aplicarse y se descartan.

import type {
  Detector,
  FieldEvent,
  FieldMeta,
  FieldStatus,
  FieldWarning,
  PlaneEventData,
  ProgressPhase,
} from "@/api/types";

/** Dice si el trabajo termino bien: `ready` o `partial`. */
export function isFinishedStatus(status: FieldStatus): boolean {
  return status === "ready" || status === "partial";
}

/**
 * `status` que corresponde a una fase de `progress`. El evento `progress` no
 * trae `status`, pero el backend los cambia juntos: sin esto el documento
 * quedaria en `queued` hasta `listed` aunque el trabajo ya este listando. No
 * toca un estado final (`ready`, `partial`, `failed`).
 */
function statusForPhase(status: FieldStatus, phase: ProgressPhase): FieldStatus {
  if (status !== "queued" && status !== "listing" && status !== "downloading") return status;
  switch (phase) {
    case "queued":
      return "queued";
    case "listing":
      return "listing";
    case "downloading":
    case "finishing":
      return "downloading";
    default:
      return status;
  }
}

function applyPlane(meta: FieldMeta, { plane, detector_display }: PlaneEventData): FieldMeta {
  // Un evento `plane` antes de `listed` no tiene donde ir: el proximo `state` lo trae.
  if (!meta.planes) return meta;
  const index = meta.planes.findIndex(
    (candidate) => candidate.epoch === plane.epoch && candidate.detector === plane.detector,
  );
  const current = meta.planes[index];
  if (!current) return meta;
  // Los eventos `plane` son idempotentes: gana la revision mas alta.
  if (plane.rev < current.rev) return meta;

  const planes = meta.planes.slice();
  // Ningun evento `plane` trae `cube_offset`: si ya se conocia, se conserva.
  planes[index] =
    plane.rev === current.rev && plane.cube_offset === null
      ? { ...plane, cube_offset: current.cube_offset }
      : plane;

  let detectors: Detector[] | undefined = meta.detectors;
  if (detector_display && detectors) {
    const { detector, ...display } = detector_display;
    detectors = detectors.map((item) => (item.detector === detector ? { ...item, display } : item));
  }
  return { ...meta, planes, detectors };
}

function sameWarning(a: FieldWarning, b: FieldWarning): boolean {
  // Los dos salen del mismo esquema, con las claves en el mismo orden.
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Devuelve el documento despues de aplicar un evento. Con `meta` en null solo
 * `state` y `listed`, que traen el documento entero, producen algo.
 */
export function applyFieldEvent(meta: FieldMeta | null, event: FieldEvent): FieldMeta | null {
  if (event.type === "state" || event.type === "listed") return event.data;
  if (meta === null) return null;

  switch (event.type) {
    case "queued":
      return { ...meta, progress: { ...meta.progress, queue_position: event.data.position } };
    case "preview":
      return { ...meta, preview: event.data };
    case "progress":
      return {
        ...meta,
        status: statusForPhase(meta.status, event.data.phase),
        progress: event.data,
      };
    case "plane":
      return applyPlane(meta, event.data);
    case "warning":
      // Un `state` al reconectar ya trae los avisos anteriores: no se repiten.
      return meta.warnings.some((warning) => sameWarning(warning, event.data))
        ? meta
        : { ...meta, warnings: [...meta.warnings, event.data] };
    case "done":
      return {
        ...meta,
        status: event.data.status,
        rev: event.data.rev,
        progress: {
          ...meta.progress,
          phase: "done",
          queue_position: 0,
          elapsed_s: event.data.elapsed_s,
        },
      };
    case "error":
      // `progress.phase` queda en la fase en la que estaba (seccion 5).
      return { ...meta, status: "failed" };
    default:
      return meta;
  }
}
