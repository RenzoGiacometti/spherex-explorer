// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fieldEventSchemas, fieldMetaSchema } from "@/api/schema";
import {
  type FieldEvent,
  type FieldEventType,
  type FieldMeta,
  isListed,
  type Plane,
} from "@/api/types";
import { FRONTEND_DIR } from "@/test/sourceFiles";
import { applyFieldEvent, isFinishedStatus } from "./fieldEvents";

const FIXTURES = join(FRONTEND_DIR, "src", "test", "fixtures");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

/** Eventos de un campo nuevo (WISE 0855), ya validados, en el orden en que llegan. */
function transcript(): FieldEvent[] {
  const raw = fixture("events-new-field.json") as Array<{
    event: FieldEventType;
    id: number;
    data: unknown;
  }>;
  return raw.map(
    ({ event, id, data }) =>
      ({ type: event, id, data: fieldEventSchemas[event].parse(data) }) as FieldEvent,
  );
}

function sample(): FieldMeta {
  return fieldMetaSchema.parse(fixture("meta-wise0855.json"));
}

function applyAll(events: readonly FieldEvent[], start: FieldMeta | null = null): FieldMeta | null {
  return events.reduce(applyFieldEvent, start);
}

function eventOf<Type extends FieldEventType>(
  events: readonly FieldEvent[],
  type: Type,
  index = 0,
): Extract<FieldEvent, { type: Type }> {
  const found = events.filter((event) => event.type === type)[index];
  if (!found) throw new Error(`la transcripcion no tiene el evento ${type} numero ${index}`);
  return found as Extract<FieldEvent, { type: Type }>;
}

/** Lo que no depende del momento: todo menos el lugar en /cube, que solo trae el `state` final. */
function withoutOffset({ cube_offset: _offset, ...plane }: Plane) {
  return plane;
}

describe("applyFieldEvent con la secuencia de un campo nuevo", () => {
  it("sin el state final llega al mismo campo, salvo lo que solo trae ese state", () => {
    const events = transcript();
    const finalStateIndex = events.map((event) => event.type).lastIndexOf("state");
    const followed = applyAll(events.filter((_event, index) => index !== finalStateIndex));
    const expected = sample();

    if (followed === null || !isListed(followed) || !isListed(expected)) {
      throw new Error("el documento seguido por eventos no tiene grilla ni planos");
    }
    expect(followed.status).toBe(expected.status);
    expect(followed.rev).toBe(expected.rev);
    expect(followed.grid).toEqual(expected.grid);
    expect(followed.epochs).toEqual(expected.epochs);
    expect(followed.planes.map(withoutOffset)).toEqual(expected.planes.map(withoutOffset));
    // La escala de cada detector es la del ultimo evento `plane` de ese detector.
    expect(followed.detectors).toEqual(expected.detectors);
    expect(followed.warnings).toHaveLength(expected.warnings.length);
    expect(followed.warnings).toEqual(expect.arrayContaining(expected.warnings));
    expect(followed.preview).toEqual(expected.preview);
    expect(followed.progress.phase).toBe("done");
    expect(followed.progress.cutouts_done).toBe(expected.progress.cutouts_done);
    expect(followed.progress.cutouts_failed).toBe(expected.progress.cutouts_failed);

    // Lo que ningun evento `plane` trae: sin el `state` final hay que pedir /meta.
    expect(followed.flags).toEqual([]);
    expect(followed.planes.every((plane) => plane.cube_offset === null)).toBe(true);
  });

  it("con todos los eventos el documento es el state final con el resultado de done", () => {
    const events = transcript();
    const done = eventOf(events, "done");
    const finalState = eventOf(events, "state", 1);
    const followed = applyAll(events);

    expect(followed).toEqual({
      ...finalState.data,
      status: done.data.status,
      rev: done.data.rev,
      progress: {
        ...finalState.data.progress,
        phase: "done",
        queue_position: 0,
        elapsed_s: done.data.elapsed_s,
      },
    });
    expect(followed && isFinishedStatus(followed.status)).toBe(true);
  });

  it("no modifica el documento anterior", () => {
    const events = transcript();
    const listedIndex = events.findIndex((event) => event.type === "listed");
    const listed = applyAll(events.slice(0, listedIndex + 1));
    const frozen = structuredClone(listed);

    applyAll(events.slice(listedIndex + 1), listed);
    expect(listed).toEqual(frozen);
  });
});

describe("applyFieldEvent, evento por evento", () => {
  const events = transcript();
  const queued = eventOf(events, "state").data;
  const listed = eventOf(events, "listed").data;
  const firstPlane = eventOf(events, "plane", 0);

  it("antes del primer state no hay documento y los demas eventos se descartan", () => {
    expect(applyFieldEvent(null, eventOf(events, "progress"))).toBeNull();
    expect(applyFieldEvent(null, firstPlane)).toBeNull();
    expect(applyFieldEvent(null, eventOf(events, "state"))).toBe(queued);
  });

  it("todo state reemplaza el documento, tambien a mitad del flujo", () => {
    const midway = applyAll(events.slice(0, 30));
    const replaced = applyFieldEvent(midway, { type: "state", id: 99, data: queued });
    expect(replaced).toBe(queued);
  });

  it("queued cambia la posicion en la cola", () => {
    const next = applyFieldEvent(queued, { type: "queued", id: 2, data: { position: 3 } });
    expect(next?.progress.queue_position).toBe(3);
    expect(next?.progress.phase).toBe("queued");
  });

  it("progress reemplaza el avance y lleva status a la fase que informa", () => {
    const listing = applyFieldEvent(queued, eventOf(events, "progress", 0));
    expect(listing?.progress.phase).toBe("listing");
    expect(listing?.status).toBe("listing");

    const finishing = applyFieldEvent(listed, {
      type: "progress",
      id: 80,
      data: { ...listed.progress, phase: "finishing" },
    });
    expect(finishing?.status).toBe("downloading");
  });

  it("progress no toca el status de un trabajo que ya termino", () => {
    const finished: FieldMeta = { ...listed, status: "partial" };
    const next = applyFieldEvent(finished, eventOf(events, "progress", 3));
    expect(next?.status).toBe("partial");
  });

  it("preview reemplaza el objeto preview", () => {
    const preview = eventOf(events, "preview");
    const next = applyFieldEvent(queued, preview);
    expect(next?.preview).toEqual(preview.data);
    expect(next?.preview.status).toBe("ready");
  });

  it("plane reemplaza el plano y actualiza la escala de su detector", () => {
    const next = applyFieldEvent(listed, firstPlane);
    const { plane, detector_display } = firstPlane.data;

    expect(next?.planes?.find((item) => item.epoch === plane.epoch && item.detector === 3)).toEqual(
      plane,
    );
    expect(next?.detectors?.find((item) => item.detector === 3)?.display).toEqual({
      vmin: detector_display?.vmin,
      vmax: detector_display?.vmax,
      median: detector_display?.median,
      sigma: detector_display?.sigma,
    });
    // Los demas detectores siguen sin escala.
    expect(next?.detectors?.find((item) => item.detector === 4)?.display).toBeUndefined();
  });

  it("plane con una revision mas vieja que la conocida se ignora", () => {
    const provisional = applyFieldEvent(listed, firstPlane);
    const definitive = eventOf(events, "plane", 3);
    expect(definitive.data.plane.epoch).toBe(firstPlane.data.plane.epoch);
    expect(definitive.data.plane.rev).toBeGreaterThan(firstPlane.data.plane.rev);

    const current = applyFieldEvent(provisional, definitive);
    const afterOld = applyFieldEvent(current, firstPlane);
    expect(afterOld).toBe(current);
  });

  it("plane repetido con la misma revision no pierde el cube_offset ya conocido", () => {
    const finalState = eventOf(events, "state", 1).data;
    const definitive = eventOf(events, "plane", 3);
    const next = applyFieldEvent(finalState, definitive);
    const { epoch, detector } = definitive.data.plane;
    const find = (meta: FieldMeta | null) =>
      meta?.planes?.find((item) => item.epoch === epoch && item.detector === detector);

    expect(find(next)?.cube_offset).toBe(find(finalState)?.cube_offset);
    expect(find(next)?.cube_offset).not.toBeNull();
  });

  it("plane sin detector_display deja la escala como estaba", () => {
    const withDisplay = applyFieldEvent(listed, firstPlane);
    const next = applyFieldEvent(withDisplay, {
      type: "plane",
      id: 50,
      data: {
        plane: { ...firstPlane.data.plane, rev: firstPlane.data.plane.rev + 1 },
        detector_display: undefined,
      },
    });
    expect(next?.detectors).toEqual(withDisplay?.detectors);
  });

  it("warning suma el aviso una sola vez", () => {
    const warning = eventOf(events, "warning");
    const once = applyFieldEvent(listed, warning);
    const twice = applyFieldEvent(once, warning);

    expect(once?.warnings).toHaveLength(listed.warnings.length + 1);
    expect(once?.warnings.at(-1)).toEqual(warning.data);
    expect(twice).toBe(once);
  });

  it("done deja el estado final, la revision del campo y la fase done", () => {
    const done = eventOf(events, "done");
    const next = applyFieldEvent(listed, done);

    expect(next?.status).toBe(done.data.status);
    expect(next?.rev).toBe(done.data.rev);
    expect(next?.progress.phase).toBe("done");
    expect(next?.progress.elapsed_s).toBe(done.data.elapsed_s);
  });

  it("error deja el trabajo en failed y la fase donde estaba", () => {
    const next = applyFieldEvent(listed, {
      type: "error",
      id: 20,
      data: { code: "upstream_unavailable", message: "IRSA no responde", retryable: true },
    });
    expect(next?.status).toBe("failed");
    expect(next?.progress.phase).toBe(listed.progress.phase);
  });
});
