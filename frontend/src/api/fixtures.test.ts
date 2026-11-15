// @vitest-environment node
//
// Cruza los datos de muestra de src/test/fixtures con los esquemas del
// contrato. Los genera el backend (backend/scripts/make_sample_fields.py) y
// los valida con sus modelos; aca pasan por los del frontend. Si el backend y
// el frontend entienden el contrato de forma distinta, falla aca.
//
//   <carpeta>/meta.json                 documento de metadatos
//   <carpeta>/plane_e<E>_d<D>.f32       Float32, ny * nx
//   <carpeta>/aux_e<E>_d<D>.bin.gz      gzip de flags Uint32 y cobertura Uint16
//   <carpeta>/preview.f32               Float32, ny * nx (opcional)
//   <carpeta>/track_<slug>.json         trayectoria de un objeto (opcional)
//   meta-<carpeta>.json                 copia de <carpeta>/meta.json
//   events-new-field.json               eventos SSE de un campo nuevo, en el
//                                       orden en que llegan: [{event, id, data}]
//
// "Cumple el contrato" quiere decir dos cosas: que el esquema lo acepta y que
// no pierde ni cambia nada al leerlo. Lo segundo hace falta porque z.object
// descarta sin avisar las claves que no conoce: un campo que el backend llama
// de otra manera pasaria la validacion y se perderia.
//
// Los datos tienen que estar: si faltan, falla el primer test.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FRONTEND_DIR } from "@/test/sourceFiles";
import { auxByteLength, isInCube, planeByteLength } from "./binary";
import { fieldEventSchemas, fieldMetaSchema, trackResponseSchema } from "./schema";
import {
  type FieldEventData,
  type FieldEventType,
  type FieldMeta,
  isListed,
  type ListedFieldMeta,
  type Plane,
} from "./types";

const FIXTURES_DIR = join(FRONTEND_DIR, "src", "test", "fixtures");
const EVENTS_FILE = join(FIXTURES_DIR, "events-new-field.json");
const GENERATOR = "backend/scripts/make_sample_fields.py";

function findFiles(directory: string, matches: (name: string) => boolean): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findFiles(path, matches);
    return entry.isFile() && matches(entry.name) ? [path] : [];
  });
}

function label(path: string): string {
  return path
    .slice(FRONTEND_DIR.length + 1)
    .split("\\")
    .join("/");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** El valor, o un error que dice que falta. */
function required<Value>(value: Value | undefined, what: string): Value {
  if (value === undefined) throw new Error(`falta ${what}`);
  return value;
}

/**
 * Copia sin las claves en null o undefined. Lo que todavia no existe viaja en
 * null o no viaja, y el esquema lo entrega en undefined o en null: para
 * comparar lo que mando el backend con lo que se leyo, las tres formas son la misma.
 */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null && item !== undefined)
        .map(([key, item]) => [key, withoutNulls(item)]),
    );
  }
  return value;
}

/**
 * Comprueba que `raw` cumple el esquema y que lo leido es lo mismo que mando
 * el backend. `emitted` es lo que se espera leer, cuando no es `raw` tal cual.
 */
function expectLossless(
  schema: z.ZodType,
  raw: unknown,
  where: string,
  emitted: unknown = raw,
): void {
  const parsed = schema.safeParse(raw);
  expect(parsed.success, `${where}\n${parsed.success ? "" : z.prettifyError(parsed.error)}`).toBe(
    true,
  );
  if (parsed.success) {
    expect(
      withoutNulls(parsed.data),
      `${where}: el esquema pierde o cambia algo de lo que manda el backend`,
    ).toEqual(withoutNulls(emitted));
  }
}

const metaFiles = findFiles(FIXTURES_DIR, (name) => name === "meta.json");
const trackFiles = findFiles(FIXTURES_DIR, (name) => /^track_.*\.json$/.test(name));
/** Copias sueltas del documento de metadatos: meta-<carpeta>.json, al lado de las carpetas. */
const flatMetaFiles = existsSync(FIXTURES_DIR)
  ? readdirSync(FIXTURES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^meta-.+\.json$/.test(entry.name))
      .map((entry) => join(FIXTURES_DIR, entry.name))
  : [];

/** Campos de muestra que validan y ya tienen grilla, con su carpeta. */
function listedFields(): Array<{ directory: string; meta: ListedFieldMeta }> {
  return metaFiles.flatMap((path) => {
    const parsed = fieldMetaSchema.safeParse(readJson(path));
    return parsed.success && isListed(parsed.data)
      ? [{ directory: dirname(path), meta: parsed.data }]
      : [];
  });
}

describe("datos de muestra", () => {
  it("estan los datos que genera el backend", () => {
    const hint = `se generan con ${GENERATOR}`;
    expect(metaFiles.length, `no hay ningun <carpeta>/meta.json; ${hint}`).toBeGreaterThan(0);
    expect(trackFiles.length, `no hay ningun track_*.json; ${hint}`).toBeGreaterThan(0);
    expect(flatMetaFiles.length, `no hay ningun meta-<carpeta>.json; ${hint}`).toBeGreaterThan(0);
    expect(existsSync(EVENTS_FILE), `no esta ${label(EVENTS_FILE)}; ${hint}`).toBe(true);
  });

  it.skipIf(metaFiles.length === 0)("cada meta.json cumple el contrato", () => {
    for (const path of metaFiles) {
      expectLossless(fieldMetaSchema, readJson(path), label(path));
    }
  });

  it.skipIf(flatMetaFiles.length === 0)(
    "cada meta-<carpeta>.json cumple el contrato y es el documento de su carpeta",
    () => {
      for (const path of flatMetaFiles) {
        const folder = basename(path).replace(/^meta-(.+)\.json$/, "$1");
        const nested = join(FIXTURES_DIR, folder, "meta.json");

        expectLossless(fieldMetaSchema, readJson(path), label(path));
        expect(existsSync(nested), `${label(path)}: no existe ${label(nested)}`).toBe(true);
        expect(readJson(path), `${label(path)} y ${label(nested)}`).toEqual(readJson(nested));
      }
    },
  );

  it.skipIf(metaFiles.length === 0)(
    "los planos y la vista provisoria pesan 4 bytes por pixel",
    () => {
      for (const { directory, meta } of listedFields()) {
        const expected = planeByteLength(meta.grid.shape);
        const binaries = findFiles(
          directory,
          (name) => /^plane_e\d+_d\d+\.f32$/.test(name) || name === "preview.f32",
        );
        for (const path of binaries) {
          expect(statSync(path).size, label(path)).toBe(expected);
        }
      }
    },
  );

  it.skipIf(metaFiles.length === 0)("las capas auxiliares pesan 6 bytes por pixel", () => {
    for (const { directory, meta } of listedFields()) {
      const expected = auxByteLength(meta.grid.shape);
      for (const path of findFiles(directory, (name) => /^aux_e\d+_d\d+\.bin\.gz$/.test(name))) {
        expect(gunzipSync(readFileSync(path)).byteLength, label(path)).toBe(expected);
      }
    }
  });

  it.skipIf(metaFiles.length === 0)(
    "en un campo terminado los cube_offset siguen el orden de planes",
    () => {
      for (const { directory, meta } of listedFields()) {
        if (meta.status !== "ready" && meta.status !== "partial") continue;

        const size = planeByteLength(meta.grid.shape);
        const inCube = meta.planes.filter(isInCube);
        // El plano i con datos empieza en i * 4 * ny * nx; los vacios no ocupan lugar.
        expect(
          inCube.map((plane) => plane.cube_offset),
          label(join(directory, "meta.json")),
        ).toEqual(inCube.map((_plane, index) => index * size));
        for (const plane of meta.planes.filter((candidate) => !isInCube(candidate))) {
          expect(plane.cube_offset, label(join(directory, "meta.json"))).toBeNull();
        }
      }
    },
  );

  it.skipIf(trackFiles.length === 0)("cada track_*.json cumple el contrato", () => {
    for (const path of trackFiles) {
      expectLossless(trackResponseSchema, readJson(path), label(path));
    }
  });
});

// ---- Transcripcion de eventos (seccion 4.2) ------------------------------

/** Un evento como lo escribe el backend en la transcripcion: nombre, id y `data` ya interpretado. */
const transcriptSchema = z.array(
  z.strictObject({
    event: z.string(),
    id: z.number().int().positive(),
    data: z.unknown(),
  }),
);

type TranscriptEvent = z.infer<typeof transcriptSchema>[number];

function readTranscript(): TranscriptEvent[] {
  return transcriptSchema.parse(readJson(EVENTS_FILE));
}

function isEventType(name: string): name is FieldEventType {
  return Object.hasOwn(fieldEventSchemas, name);
}

/** `data` ya validado de todos los eventos de un tipo, en el orden en que llegaron. */
function dataOf<Type extends FieldEventType>(
  events: TranscriptEvent[],
  type: Type,
): FieldEventData[Type][] {
  return events
    .filter((event) => event.event === type)
    .map((event) => fieldEventSchemas[type].parse(event.data) as FieldEventData[Type]);
}

function planeKey(plane: Pick<Plane, "epoch" | "detector">): string {
  return `e${plane.epoch} d${plane.detector}`;
}

/** Lo que no depende del momento en que se emitio el plano: todo menos la revision y el lugar en /cube. */
function planeContent({ rev: _rev, cube_offset: _cubeOffset, ...content }: Plane) {
  return content;
}

function sortedByJson<Item>(items: readonly Item[]): Item[] {
  return [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** El campo de muestra con el mismo `id`, leido de su meta-<carpeta>.json. */
function sampleField(id: string): ListedFieldMeta {
  const metas: FieldMeta[] = flatMetaFiles.map((path) => fieldMetaSchema.parse(readJson(path)));
  const sample = required(
    metas.find((meta) => meta.id === id),
    `un meta-<carpeta>.json con el id ${id}`,
  );
  if (!isListed(sample)) throw new Error(`el campo de muestra ${id} no tiene grilla ni planos`);
  return sample;
}

describe("transcripcion de eventos de un campo nuevo", () => {
  it("cada evento cumple el esquema de su tipo", () => {
    const events = readTranscript();
    expect(events.length).toBeGreaterThan(0);

    for (const { event, id, data } of events) {
      const where = `${label(EVENTS_FILE)}, evento ${id} (${event})`;
      expect(isEventType(event), `${where}: el contrato no define ese evento`).toBe(true);
      if (!isEventType(event)) continue;

      // `error` es el unico evento que cambia de forma al leerlo: llega como
      // {"error": {...}} y se entrega el objeto de adentro.
      const emitted = event === "error" ? (data as { error?: unknown } | null)?.error : data;
      expectLossless(fieldEventSchemas[event], data, where, emitted);
    }
  });

  it("los ids crecen, state llega primero y done cierra el flujo", () => {
    const events = readTranscript();
    const names = events.map((event) => event.event);

    for (const [index, event] of events.entries()) {
      const previous = events[index - 1];
      if (previous) expect(event.id, `evento numero ${index + 1}`).toBeGreaterThan(previous.id);
    }
    expect(names[0]).toBe("state");
    expect(names.at(-1)).toBe("done");
    // El servidor cierra el flujo despues de `done` o `error`: solo pueden ir al final.
    expect(names.slice(0, -1).filter((name) => name === "done" || name === "error")).toEqual([]);
  });

  it("el primer state es el trabajo en cola, ya con pipeline y vista provisoria", () => {
    const state = required(dataOf(readTranscript(), "state")[0], "el evento state");

    expect(state.status).toBe("queued");
    expect(state.rev).toBe(0);
    expect(isListed(state)).toBe(false);
    expect(state.pipeline).not.toBe("");
    expect(state.progress.phase).toBe("queued");
    expect(state.progress.queue_position).toBeGreaterThanOrEqual(1);
    // Seccion 5: `preview` esta presente desde el primer `state`.
    expect(state.preview.status).toBe("pending");
    expect(state.preview.display).toBeUndefined();
  });

  it("llega al campo de muestra que simula", () => {
    const events = readTranscript();
    const state = required(dataOf(events, "state")[0], "el evento state");
    const listed = required(dataOf(events, "listed")[0], "el evento listed");
    const done = required(dataOf(events, "done")[0], "el evento done");
    const sample = sampleField(state.id);
    if (!isListed(listed)) throw new Error("el evento listed no trae grilla ni planos");

    // `listed`: desde aca se conocen la grilla, las epocas y los planos, todavia sin imagen.
    expect(listed.id).toBe(sample.id);
    expect(listed.grid).toEqual(sample.grid);
    expect(listed.epochs).toEqual(sample.epochs);
    expect(listed.planes.map(planeKey)).toEqual(sample.planes.map(planeKey));
    expect(
      listed.planes.filter((plane) => plane.status !== "pending" && plane.status !== "empty"),
    ).toEqual([]);

    // Cada evento `plane` trae una revision mas alta que la anterior. Quedandose
    // con la ultima de cada plano se llega a los planos del campo terminado.
    const current = new Map(listed.planes.map((plane) => [planeKey(plane), plane]));
    const displays = new Map<number, unknown>();
    for (const { plane, detector_display } of dataOf(events, "plane")) {
      const key = planeKey(plane);
      const previous = required(current.get(key), `el plano ${key} en listed`);
      expect(plane.rev, key).toBeGreaterThan(previous.rev);
      // `cube_offset` es null mientras el trabajo no termina.
      expect(plane.cube_offset, key).toBeNull();
      current.set(key, plane);
      if (detector_display) {
        expect(detector_display.detector, key).toBe(plane.detector);
        const { detector, ...display } = detector_display;
        displays.set(detector, display);
      }
    }
    for (const expected of sample.planes) {
      const key = planeKey(expected);
      const last = required(current.get(key), `el plano ${key}`);
      expect(planeContent(last), key).toEqual(planeContent(expected));
    }
    // La escala de cada detector termina siendo la del campo terminado.
    for (const detector of sample.detectors) {
      expect(displays.get(detector.detector), `B${detector.detector}`).toEqual(detector.display);
    }

    // Los avisos llegan en `listed` o como eventos `warning`.
    const announced = [...listed.warnings, ...dataOf(events, "warning")];
    expect(sortedByJson(announced)).toEqual(sortedByJson(sample.warnings));

    expect(done.status).toBe(sample.status);
    expect(done.rev).toBe(sample.rev);
  });
});
