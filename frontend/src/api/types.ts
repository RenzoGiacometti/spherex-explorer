// Tipos del contrato, inferidos de los esquemas de schema.ts. No se escriben a
// mano: si cambia el contrato, se cambia el esquema y los tipos lo siguen.

import type { z } from "zod";
import type {
  detectorDisplaySchema,
  detectorSchema,
  displaySchema,
  doneEventSchema,
  downloadModeSchema,
  epochSchema,
  errorBodySchema,
  errorCodeSchema,
  errorObjectSchema,
  fieldEventSchemas,
  fieldMetaSchema,
  fieldRequestSchema,
  fieldResponseSchema,
  fieldStatusSchema,
  flagSchema,
  gridSchema,
  motionSchema,
  normalizedRequestSchema,
  planeEventSchema,
  planeRefSchema,
  planeSchema,
  planeStatsSchema,
  planeStatusSchema,
  previewBandSchema,
  previewSchema,
  previewStatusSchema,
  priorityRequestSchema,
  progressPhaseSchema,
  progressSchema,
  provenanceSchema,
  queuedEventSchema,
  resolveResponseSchema,
  saturatedRegionSchema,
  skyPositionSchema,
  trackPositionSchema,
  trackResponseSchema,
  warningSchema,
} from "./schema";

// ---- Errores -------------------------------------------------------------

export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ErrorObject = z.infer<typeof errorObjectSchema>;
export type ErrorBody = z.infer<typeof errorBodySchema>;

// ---- Documento de metadatos ---------------------------------------------

export type FieldStatus = z.infer<typeof fieldStatusSchema>;
export type NormalizedRequest = z.infer<typeof normalizedRequestSchema>;
export type Grid = z.infer<typeof gridSchema>;
export type Display = z.infer<typeof displaySchema>;
export type DetectorDisplay = z.infer<typeof detectorDisplaySchema>;
export type Detector = z.infer<typeof detectorSchema>;
export type Epoch = z.infer<typeof epochSchema>;
export type PlaneStatus = z.infer<typeof planeStatusSchema>;
export type PlaneStats = z.infer<typeof planeStatsSchema>;
export type SaturatedRegion = z.infer<typeof saturatedRegionSchema>;
export type Plane = z.infer<typeof planeSchema>;
export type Flag = z.infer<typeof flagSchema>;
export type ProgressPhase = z.infer<typeof progressPhaseSchema>;
export type Progress = z.infer<typeof progressSchema>;
/** Referencia a un plano dentro de un aviso: {epoch, detector}. */
export type PlaneRef = z.infer<typeof planeRefSchema>;
export type FieldWarning = z.infer<typeof warningSchema>;
export type WarningCode = FieldWarning["code"];
/** Un aviso concreto: WarningOf<"saturated_source">. */
export type WarningOf<Code extends WarningCode> = Extract<FieldWarning, { code: Code }>;
export type PreviewStatus = z.infer<typeof previewStatusSchema>;
export type PreviewBand = z.infer<typeof previewBandSchema>;
export type Preview = z.infer<typeof previewSchema>;
export type DownloadMode = z.infer<typeof downloadModeSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type FieldMeta = z.infer<typeof fieldMetaSchema>;

/** Documento de metadatos despues de `listed`: ya trae grilla, detectores, epocas, planos y flags. */
export type ListedFieldMeta = FieldMeta & {
  grid: Grid;
  detectors: Detector[];
  epochs: Epoch[];
  planes: Plane[];
  flags: Flag[];
};

/** Dice si el documento ya paso por `listed` y se puede dibujar. */
export function isListed(meta: FieldMeta): meta is ListedFieldMeta {
  return (
    meta.grid !== undefined &&
    meta.detectors !== undefined &&
    meta.epochs !== undefined &&
    meta.planes !== undefined &&
    meta.flags !== undefined
  );
}

// ---- POST /api/field y /priority ----------------------------------------

/** Cuerpo de POST /api/field, como lo arma el frontend. */
export type FieldRequest = z.input<typeof fieldRequestSchema>;
export type FieldResponse = z.infer<typeof fieldResponseSchema>;
export type PriorityRequest = z.infer<typeof priorityRequestSchema>;

// ---- Eventos SSE ---------------------------------------------------------

export type QueuedEventData = z.infer<typeof queuedEventSchema>;
export type PlaneEventData = z.infer<typeof planeEventSchema>;
export type DoneEventData = z.infer<typeof doneEventSchema>;

/** `data` ya validado de cada evento, por nombre de evento. */
export type FieldEventData = {
  [Type in keyof typeof fieldEventSchemas]: z.output<(typeof fieldEventSchemas)[Type]>;
};

export type FieldEventType = keyof FieldEventData;

/**
 * Evento de GET /api/field/{id}/events ya validado, como union discriminada
 * por `type`:
 *
 *   state     FieldMeta        siempre el primero al conectar o reconectar;
 *                              reemplaza todo lo anterior
 *   queued    {position}       posicion en la cola
 *   preview   Preview          la vista provisoria quedo lista o se descarto
 *   listed    FieldMeta        ya se conocen epocas, detectores y grilla
 *   progress  Progress         avance de la descarga
 *   plane     {plane, detector_display}  revision nueva de un plano
 *   warning   FieldWarning     aviso de calidad
 *   done      {status, rev, elapsed_s}   fin del trabajo
 *   error     ErrorObject      el trabajo no puede continuar; llega como
 *                              {"error": {...}} y se entrega el objeto de adentro
 *
 * Despues de `done` o `error` no llegan mas eventos.
 */
export type FieldEvent = {
  [Type in FieldEventType]: {
    type: Type;
    /** Campo `id` del evento (entero creciente), o null si no vino. */
    id: number | null;
    data: FieldEventData[Type];
  };
}[FieldEventType];

/** Un evento concreto: FieldEventOf<"plane">. */
export type FieldEventOf<Type extends FieldEventType> = Extract<FieldEvent, { type: Type }>;

// ---- /api/resolve y /track ----------------------------------------------

export type SkyCoordinates = z.infer<typeof skyPositionSchema>;
export type Motion = z.infer<typeof motionSchema>;
export type ResolveResponse = z.infer<typeof resolveResponseSchema>;
export type TrackPosition = z.infer<typeof trackPositionSchema>;
export type TrackResponse = z.infer<typeof trackResponseSchema>;
