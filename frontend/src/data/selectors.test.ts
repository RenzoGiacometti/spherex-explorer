// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fieldMetaSchema, resolveResponseSchema, trackResponseSchema } from "@/api/schema";
import { isListed, type ListedFieldMeta, type Plane, type PlaneStatus } from "@/api/types";
import type { Band } from "@/state/urlState";
import { resolveBarnard, resolveCoordinates } from "@/test/contractExamples";
import { FRONTEND_DIR } from "@/test/sourceFiles";
import { toPlaneImage } from "@/viewer/planeImage";
import {
  type AuxEntry,
  type FieldState,
  INITIAL_FIELD_STATE,
  type LoadedPlane,
} from "./fieldState";
import { findPlane, planeKey } from "./planeKey";
import {
  selectAnyProvisional,
  selectAuxLayers,
  selectBandInfo,
  selectBandPlanes,
  selectEpochState,
  selectErrorCode,
  selectIsProvisional,
  selectLoadedPlane,
  selectLoadProgress,
  selectPreview,
  selectQueuePosition,
  selectSaturatedRegions,
  selectTargetPosition,
  selectTargetTrail,
  selectTimeline,
  selectWarningCount,
  selectWarningGroups,
  WARNING_ORDER,
} from "./selectors";

const FIXTURES = join(FRONTEND_DIR, "src", "test", "fixtures");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

function sample(name: "wise0855" | "epsindb" | "barnard"): ListedFieldMeta {
  const meta = fieldMetaSchema.parse(fixture(`meta-${name}.json`));
  if (!isListed(meta)) throw new Error(`la muestra ${name} no tiene grilla ni planos`);
  return meta;
}

const IMAGE = toPlaneImage(new Float32Array([1, Number.NaN, 2, 3]), [2, 2]);

/** Un plano bajado, con los metadatos de la muestra o con otro estado y revision. */
function loaded(
  meta: ListedFieldMeta,
  epoch: number,
  detector: number,
  overrides: Partial<Pick<Plane, "status" | "rev" | "saturated">> = {},
): LoadedPlane {
  const plane = findPlane(meta.planes, epoch, detector);
  if (!plane) throw new Error(`la muestra no tiene el plano ${epoch}:${detector}`);
  const snapshot: Plane = { ...plane, ...overrides };
  return {
    epoch,
    detector,
    rev: snapshot.rev,
    status: snapshot.status,
    plane: snapshot,
    image: IMAGE,
  };
}

function withPlanes(entries: LoadedPlane[]): FieldState["planes"] {
  return Object.fromEntries(entries.map((entry) => [planeKey(entry.epoch, entry.detector), entry]));
}

function stateOf(
  meta: FieldState["meta"],
  band: Band,
  overrides: Partial<FieldState> = {},
): FieldState {
  return {
    ...INITIAL_FIELD_STATE,
    phase: "ready",
    fieldId: meta?.id ?? null,
    meta,
    band,
    ...overrides,
  };
}

describe("planos de la banda actual y linea de tiempo", () => {
  const meta = sample("epsindb");

  it("antes de listed no hay epocas", () => {
    const state = stateOf(null, 3, { phase: "requesting" });
    expect(selectBandPlanes(state)).toEqual([]);
    expect(selectTimeline(state)).toEqual([]);
  });

  it("da un plano por epoca de la banda actual, en orden", () => {
    const state = stateOf(meta, 2, {
      planes: withPlanes([loaded(meta, 1, 2), loaded(meta, 3, 2), loaded(meta, 1, 5)]),
    });
    const planes = selectBandPlanes(state);

    expect(planes.map((entry) => entry.epoch.epoch)).toEqual([1, 2, 3, 4]);
    expect(planes.map((entry) => entry.plane?.detector)).toEqual([2, 2, 2, 2]);
    expect(planes.map((entry) => entry.loaded?.epoch ?? null)).toEqual([1, null, 3, null]);
    expect(planes[0]?.loaded?.image).toBe(IMAGE);
  });

  it("marca cada epoca como cargada, provisoria, sin cargar o vacia", () => {
    // Epsilon Indi B, banda 1: la epoca 4 no tiene exposiciones en ese detector.
    const state = stateOf(meta, 1, {
      planes: withPlanes([loaded(meta, 1, 1), loaded(meta, 2, 1, { status: "building", rev: 1 })]),
    });

    expect(selectTimeline(state).map((entry) => [entry.epoch.epoch, entry.state])).toEqual([
      [1, "loaded"],
      [2, "provisional"],
      [3, "unloaded"],
      [4, "empty"],
    ]);
    expect(selectEpochState(state, 2)).toBe("provisional");
    expect(selectEpochState(state, 4)).toBe("empty");
    expect(selectEpochState(state, 9)).toBeNull();
    expect(selectEpochState(state, null)).toBeNull();
  });

  it("un plano partial bajado cuenta como cargado", () => {
    const state = stateOf(meta, 6, { planes: withPlanes([loaded(meta, 2, 6)]) });
    expect(findPlane(meta.planes, 2, 6)?.status).toBe("partial");
    expect(selectEpochState(state, 2)).toBe("loaded");
  });

  it("al cambiar de banda la linea de tiempo es la de la otra banda", () => {
    const planes = withPlanes([loaded(meta, 1, 1), loaded(meta, 4, 2)]);
    expect(selectTimeline(stateOf(meta, 1, { planes })).map((entry) => entry.state)).toEqual([
      "loaded",
      "unloaded",
      "unloaded",
      "empty",
    ]);
    expect(selectTimeline(stateOf(meta, 2, { planes })).map((entry) => entry.state)).toEqual([
      "unloaded",
      "unloaded",
      "unloaded",
      "loaded",
    ]);
  });

  it("dice si la imagen de una epoca es provisoria", () => {
    const statuses: Array<[number, PlaneStatus]> = [
      [1, "building"],
      [2, "ready"],
    ];
    const state = stateOf(meta, 3, {
      planes: withPlanes(
        statuses.map(([epoch, status]) => loaded(meta, epoch, 3, { status, rev: 1 })),
      ),
    });

    expect(selectIsProvisional(state, 1)).toBe(true);
    expect(selectIsProvisional(state, 2)).toBe(false);
    // Sin imagen no hay nada provisorio que avisar.
    expect(selectIsProvisional(state, 3)).toBe(false);
    expect(selectIsProvisional(state, null)).toBe(false);

    expect(selectAnyProvisional(state, [1, 2])).toBe(true);
    expect(selectAnyProvisional(state, [2, 3])).toBe(false);
    expect(selectAnyProvisional(state, [])).toBe(false);
  });

  it("lo provisorio sale de la imagen bajada, no del documento, que puede ir adelante", () => {
    // El documento ya dice `ready` (rev 2) pero la imagen en pantalla es la rev 1.
    const state = stateOf(meta, 3, {
      planes: withPlanes([loaded(meta, 1, 3, { status: "building", rev: 1 })]),
    });
    expect(findPlane(meta.planes, 1, 3)?.status).toBe("ready");
    expect(selectIsProvisional(state, 1)).toBe(true);
    expect(selectLoadedPlane(state, 1)?.rev).toBe(1);
  });

  it("devuelve la misma lista mientras no cambie nada", () => {
    const state = stateOf(meta, 2, { planes: withPlanes([loaded(meta, 1, 2)]) });
    const again = { ...state, error: null };

    expect(selectBandPlanes(again)).toBe(selectBandPlanes(state));
    expect(selectTimeline(again)).toBe(selectTimeline(state));

    const changed = { ...state, planes: withPlanes([loaded(meta, 1, 2), loaded(meta, 2, 2)]) };
    expect(selectTimeline(changed)).not.toBe(selectTimeline(state));
  });

  it("lo que pasa en otra banda o en el avance no cambia las listas de esta banda", () => {
    const first = loaded(meta, 1, 2);
    const state = stateOf(meta, 2, { phase: "loading", planes: withPlanes([first]) });
    const bandPlanes = selectBandPlanes(state);
    const timeline = selectTimeline(state);
    const info = selectBandInfo(state);

    // Un evento `progress`: documento nuevo, mismas epocas y mismos planos.
    const progressed = stateOf({ ...meta, progress: { ...meta.progress, cutouts_done: 12 } }, 2, {
      phase: "loading",
      planes: state.planes,
    });
    expect(selectBandPlanes(progressed)).toBe(bandPlanes);
    expect(selectTimeline(progressed)).toBe(timeline);
    expect(selectBandInfo(progressed)).toBe(info);

    // Un evento `plane` de la banda 5: cambian las listas del documento, no lo de la banda 2.
    const otherBand = stateOf(
      {
        ...meta,
        planes: meta.planes.map((plane) =>
          plane.detector === 5 && plane.epoch === 1 ? { ...plane, rev: plane.rev + 1 } : plane,
        ),
        detectors: meta.detectors.map((detector) =>
          detector.detector === 5
            ? { ...detector, display: { vmin: 0, vmax: 1, median: 0, sigma: 0.1 } }
            : detector,
        ),
      },
      2,
      { phase: "loading", planes: { ...state.planes, [planeKey(1, 5)]: loaded(meta, 1, 5) } },
    );
    expect(selectBandPlanes(otherBand)).toBe(bandPlanes);
    expect(selectTimeline(otherBand)).toBe(timeline);
    expect(selectBandInfo(otherBand)).toBe(info);

    // Un plano nuevo de esta banda si las cambia.
    const sameBand = stateOf(meta, 2, {
      phase: "loading",
      planes: { ...state.planes, [planeKey(2, 2)]: loaded(meta, 2, 2) },
    });
    expect(selectBandPlanes(sameBand)).not.toBe(bandPlanes);
    expect(selectTimeline(sameBand).map((entry) => entry.state)).toEqual([
      "loaded",
      "loaded",
      "unloaded",
      "unloaded",
    ]);
  });
});

describe("avance y cola", () => {
  it("el avance es (cutouts_done + cutouts_failed) / cutouts_total", () => {
    const meta = sample("wise0855");
    const state = stateOf(
      {
        ...meta,
        progress: {
          ...meta.progress,
          phase: "downloading",
          cutouts_total: 258,
          cutouts_done: 33,
          cutouts_failed: 1,
          planes_ready: 2,
        },
      },
      3,
      { phase: "loading" },
    );
    const progress = selectLoadProgress(state);

    expect(progress?.done).toBe(34);
    expect(progress?.total).toBe(258);
    expect(progress?.fraction).toBeCloseTo(34 / 258, 12);
    expect(progress?.cutoutsFailed).toBe(1);
    expect(progress?.phase).toBe("downloading");
    expect(progress?.planesReady).toBe(2);
    expect(progress?.planesTotal).toBe(18);
    expect(selectLoadProgress(state)).toBe(progress);
  });

  it("un campo terminado con un recorte fallido llega al 100 %", () => {
    const progress = selectLoadProgress(stateOf(sample("wise0855"), 3));
    expect(progress?.done).toBe(258);
    expect(progress?.fraction).toBe(1);
  });

  it("antes de listed no se sabe el total y el avance es 0", () => {
    const meta = sample("wise0855");
    const state = stateOf(
      {
        ...meta,
        status: "queued",
        progress: { ...meta.progress, phase: "queued", cutouts_total: 0, cutouts_done: 0 },
      },
      3,
      { phase: "loading" },
    );
    expect(selectLoadProgress(state)?.fraction).toBe(0);
    expect(selectLoadProgress(stateOf(null, 3))).toBeNull();
  });

  it("da la posicion en la cola solo mientras el trabajo espera turno", () => {
    const meta = sample("wise0855");
    const waiting = stateOf(
      {
        ...meta,
        status: "queued",
        progress: { ...meta.progress, phase: "queued", queue_position: 2 },
      },
      3,
      { phase: "loading" },
    );
    expect(selectQueuePosition(waiting)).toBe(2);

    const listing = stateOf(
      {
        ...meta,
        status: "listing",
        progress: { ...meta.progress, phase: "listing", queue_position: 0 },
      },
      3,
      { phase: "loading" },
    );
    expect(selectQueuePosition(listing)).toBeNull();
    expect(selectQueuePosition(stateOf(meta, 3))).toBeNull();
    expect(selectQueuePosition(stateOf(null, 3, { phase: "requesting" }))).toBeNull();
  });
});

describe("avisos agrupados por codigo", () => {
  it("Epsilon Indi B trae 22 low_coverage en un solo grupo", () => {
    const state = stateOf(sample("epsindb"), 3);
    const groups = selectWarningGroups(state);

    expect(groups.map((group) => [group.code, group.count])).toEqual([
      ["cutouts_failed", 1],
      ["plane_empty", 2],
      ["few_exposures", 2],
      ["low_coverage", 22],
    ]);
    const lowCoverage = groups.find((group) => group.code === "low_coverage");
    expect(lowCoverage?.warnings).toHaveLength(22);
    expect(lowCoverage?.warnings.every((warning) => warning.code === "low_coverage")).toBe(true);
    expect(selectWarningCount(state)).toBe(27);
    expect(selectWarningGroups({ ...state, band: 5 })).toBe(groups);
  });

  it("la fuente saturada de Barnard va primero", () => {
    const groups = selectWarningGroups(stateOf(sample("barnard"), 3));
    expect(groups.map((group) => [group.code, group.count])).toEqual([
      ["saturated_source", 1],
      ["low_coverage", 18],
    ]);
  });

  it("el orden cubre todos los codigos del contrato y sin documento no hay avisos", () => {
    expect([...WARNING_ORDER].sort()).toEqual(
      [
        "cutouts_failed",
        "few_exposures",
        "full_download",
        "low_coverage",
        "plane_empty",
        "saturated_source",
        "stale_exposure_list",
      ].sort(),
    );
    expect(selectWarningGroups(stateOf(null, 3))).toEqual([]);
    expect(selectWarningCount(stateOf(null, 3))).toBe(0);
  });
});

describe("plano actual y banda", () => {
  it("da las regiones saturadas del plano de la epoca en la banda actual", () => {
    const meta = sample("barnard");
    const state = stateOf(meta, 3);
    const regions = selectSaturatedRegions(state, 1);

    expect(regions).toEqual(findPlane(meta.planes, 1, 3)?.saturated);
    expect(regions.length).toBeGreaterThan(0);
    expect(regions[0]?.n_pixels).toBeGreaterThanOrEqual(4);
    expect(selectSaturatedRegions(state, null)).toEqual([]);
    expect(selectSaturatedRegions(state, 9)).toEqual([]);
  });

  it("con una imagen bajada usa las regiones de esa revision, que es la que se ve", () => {
    const meta = sample("barnard");
    const provisional = [{ x: 90, y: 91, radius_px: 3, n_pixels: 28 }];
    const state = stateOf(meta, 3, {
      planes: withPlanes([
        loaded(meta, 1, 3, { status: "building", rev: 1, saturated: provisional }),
      ]),
    });
    expect(selectSaturatedRegions(state, 1)).toBe(provisional);
  });

  it("WISE 0855 no tiene regiones saturadas", () => {
    expect(selectSaturatedRegions(stateOf(sample("wise0855"), 6), 2)).toEqual([]);
  });

  it("da el rango de onda y la escala de la banda actual", () => {
    const meta = sample("wise0855");
    const detector = meta.detectors.find((item) => item.detector === 6);
    const info = selectBandInfo(stateOf(meta, 6));

    expect(info).toEqual({
      detector: 6,
      waveMinUm: 4.4115,
      waveMaxUm: 5.0096,
      display: detector?.display,
    });
    expect(info?.display?.vmax).toBeGreaterThan(info?.display?.vmin ?? Number.NaN);
    expect(selectBandInfo(stateOf(meta, 6))).toBe(info);
    expect(selectBandInfo(stateOf(meta, 1))?.waveMinUm).toBe(0.7455);
  });

  it("sin escala todavia, display es null; antes de listed no hay banda", () => {
    const meta = sample("wise0855");
    const withoutDisplay = {
      ...meta,
      detectors: meta.detectors.map(({ display: _display, ...detector }) => detector),
    };
    expect(selectBandInfo(stateOf(withoutDisplay, 3))?.display).toBeNull();
    expect(selectBandInfo(stateOf(null, 3))).toBeNull();
  });
});

describe("capas auxiliares", () => {
  const meta = sample("wise0855");
  const layers = { flags: new Uint32Array(4), coverage: new Uint16Array(4) };

  function aux(overrides: Partial<AuxEntry>): AuxEntry {
    return { status: "ready", rev: 2, layers, layersRev: 2, error: null, ...overrides };
  }

  it("da las capas solo si son de la revision de la imagen que se ve", () => {
    const planes = withPlanes([loaded(meta, 1, 3)]);
    const state = stateOf(meta, 3, { planes, aux: { [planeKey(1, 3)]: aux({}) } });

    expect(selectLoadedPlane(state, 1)?.rev).toBe(2);
    expect(selectAuxLayers(state, 1)).toBe(layers);
    // No se pidieron para esa epoca, o son de otra banda.
    expect(selectAuxLayers(state, 2)).toBeNull();
    expect(selectAuxLayers({ ...state, band: 6 }, 1)).toBeNull();
    expect(selectAuxLayers(state, null)).toBeNull();
  });

  it("no da unas capas viejas debajo de una imagen nueva", () => {
    // La imagen ya es la rev 2 y las capas que hay son las de la rev 1.
    const planes = withPlanes([loaded(meta, 1, 3)]);
    const stale = aux({ rev: 1, layersRev: 1 });
    expect(selectAuxLayers(stateOf(meta, 3, { planes, aux: { [planeKey(1, 3)]: stale } }), 1)).toBe(
      null,
    );
    // Mientras llegan las nuevas, `rev` ya dice 2 pero `layers` sigue siendo de la rev 1.
    const refreshing = aux({ status: "loading", rev: 2, layersRev: 1 });
    expect(
      selectAuxLayers(stateOf(meta, 3, { planes, aux: { [planeKey(1, 3)]: refreshing } }), 1),
    ).toBeNull();
  });

  it("tampoco da unas capas nuevas sobre una imagen que todavia es la anterior, ni sin imagen", () => {
    const provisional = withPlanes([loaded(meta, 1, 3, { status: "building", rev: 1 })]);
    const state = stateOf(meta, 3, { planes: provisional, aux: { [planeKey(1, 3)]: aux({}) } });
    expect(selectAuxLayers(state, 1)).toBeNull();
    expect(selectAuxLayers({ ...state, planes: {} }, 1)).toBeNull();

    const pending = aux({ status: "loading", layers: null, layersRev: null });
    expect(
      selectAuxLayers(
        stateOf(meta, 3, { planes: withPlanes([loaded(meta, 1, 3)]), aux: { "1:3": pending } }),
        1,
      ),
    ).toBeNull();
  });
});

describe("error actual", () => {
  it("da el codigo para traducir, o null", () => {
    expect(selectErrorCode(stateOf(null, 3))).toBeNull();
    expect(
      selectErrorCode(
        stateOf(null, 3, {
          phase: "error",
          error: {
            code: "queue_full",
            source: "request",
            retryable: true,
            retryAfterS: 5,
            retryAt: 5000,
            message: "",
          },
        }),
      ),
    ).toBe("queue_full");
  });
});

describe("vista provisoria", () => {
  const meta = sample("wise0855");
  const preview = { image: IMAGE, shape: [2, 2] as const };

  it("se muestra mientras no hay ninguna imagen de SPHEREx de la banda actual", () => {
    const state = stateOf(meta, 3, { phase: "loading", preview });
    const visible = selectPreview(state);

    expect(visible).toEqual({
      image: IMAGE,
      survey: "WISE",
      band: "W1",
      waveUm: 3.4,
      display: meta.preview.display,
    });
    expect(selectPreview({ ...state })).toBe(visible);
  });

  it("se retira al llegar el primer plano de la banda actual, aunque sea provisorio", () => {
    const planes = withPlanes([loaded(meta, 2, 3, { status: "building", rev: 1 })]);
    expect(selectPreview(stateOf(meta, 3, { phase: "loading", preview, planes }))).toBeNull();
    // En otra banda todavia no hay nada: ahi se sigue viendo.
    expect(selectPreview(stateOf(meta, 6, { phase: "loading", preview, planes }))).not.toBeNull();
  });

  it("se rotula con la banda de preview, no con la que se esta mirando", () => {
    const w2 = { ...meta, preview: { ...meta.preview, band: "W2" as const, wave_um: 4.6 } };
    const visible = selectPreview(stateOf(w2, 3, { preview }));
    expect(visible?.band).toBe("W2");
    expect(visible?.waveUm).toBe(4.6);
  });

  it("no hay vista si no esta bajada o si preview no esta ready", () => {
    expect(selectPreview(stateOf(meta, 3, { preview: null }))).toBeNull();
    const unavailable = { ...meta, preview: { ...meta.preview, status: "unavailable" as const } };
    expect(selectPreview(stateOf(unavailable, 3, { preview }))).toBeNull();
    expect(selectPreview(stateOf(null, 3, { preview }))).toBeNull();
  });
});

describe("posicion del objeto buscado", () => {
  const meta = sample("barnard");
  const track = trackResponseSchema.parse(fixture("barnard/track_name-barnard-s-star.json"));
  const resolved = resolveResponseSchema.parse(resolveBarnard());

  function target(overrides: Partial<FieldState["target"]>): FieldState["target"] {
    return {
      ...INITIAL_FIELD_STATE.target,
      name: "Barnard's Star",
      resolveStatus: "ready",
      resolved,
      ...overrides,
    };
  }

  it("con trayectoria, la mira va en la posicion esperada de cada epoca", () => {
    const state = stateOf(meta, 3, { target: target({ trackStatus: "ready", track }) });

    expect(selectTargetPosition(state, 2)).toEqual({
      x: 96.913,
      y: 97.797,
      ra: 269.4463619,
      dec: 4.7689355,
      inField: true,
      source: "track",
    });
    expect(selectTargetPosition(state, 3)?.y).toBe(99.287);
    expect(selectTargetPosition(state, 2)).toBe(selectTargetPosition(state, 2));
  });

  it("recuerda la posicion de cada epoca por separado", () => {
    const state = stateOf(meta, 3, { target: target({ trackStatus: "ready", track }) });
    const first = selectTargetPosition(state, 1);
    const second = selectTargetPosition(state, 2);

    // Pedir otra epoca en el medio no cambia el objeto de la primera: dos hooks
    // con epocas distintas (la mira de A y la de B) no se pisan.
    expect(selectTargetPosition(state, 1)).toBe(first);
    expect(selectTargetPosition(state, 2)).toBe(second);
    expect(selectTargetPosition(state, 1)).toBe(first);
    expect(first).not.toBe(second);
    // Una epoca que la trayectoria no trae cae en field_center, tambien recordada.
    const outside = selectTargetPosition(state, 9);
    expect(outside?.source).toBe("field_center");
    expect(selectTargetPosition(state, null)).toBe(outside);
    expect(selectTargetPosition(state, 9)).toBe(outside);
    expect(selectTargetPosition(state, 2)).toBe(second);

    // Un cambio del estado que no toca al objeto ni a la grilla tampoco.
    const progressed = { ...state, stream: "open" as const, meta: { ...meta, rev: meta.rev + 1 } };
    expect(selectTargetPosition(progressed, 1)).toBe(first);

    // Una trayectoria nueva si: mismos valores en otro objeto.
    const again = stateOf(meta, 3, {
      target: target({ trackStatus: "ready", track: { ...track } }),
    });
    expect(selectTargetPosition(again, 1)).not.toBe(first);
    expect(selectTargetPosition(again, 1)).toEqual(first);
  });

  it("el rastro da la posicion de cada epoca del campo, con los mismos objetos", () => {
    const state = stateOf(meta, 3, { target: target({ trackStatus: "ready", track }) });
    const trail = selectTargetTrail(state);

    expect(trail.map((item) => item.epoch)).toEqual([1, 2, 3]);
    expect(trail.map((item) => item.position.source)).toEqual(["track", "track", "track"]);
    expect(trail[1]?.position).toBe(selectTargetPosition(state, 2));
    expect(trail[2]?.position.y).toBe(99.287);
    // La lista es la misma mientras no cambie nada, tambien despues de pedir una epoca suelta.
    expect(selectTargetPosition(state, 3)).toBe(trail[2]?.position);
    expect(selectTargetTrail({ ...state, error: null })).toBe(trail);
  });

  it("sin trayectoria el rastro repite field_center; sin nombre o en camino queda vacio", () => {
    const failed = stateOf(meta, 3, {
      target: target({ trackStatus: "error", trackError: "network" }),
    });
    const trail = selectTargetTrail(failed);
    expect(trail.map((item) => item.position.source)).toEqual([
      "field_center",
      "field_center",
      "field_center",
    ]);
    // El objeto no se mueve: es una sola posicion.
    expect(trail[0]?.position).toBe(trail[2]?.position);
    expect(selectTargetPosition(failed, 1)).toBe(trail[0]?.position);

    expect(selectTargetTrail(stateOf(meta, 3))).toEqual([]);
    expect(
      selectTargetTrail(stateOf(meta, 3, { target: target({ trackStatus: "loading" }) })),
    ).toEqual([]);
    expect(
      selectTargetTrail(stateOf(null, 3, { target: target({ trackStatus: "ready", track }) })),
    ).toEqual([]);
  });

  it("sin movimiento propio positions viene vacio y la mira va en field_center", () => {
    const still = resolveResponseSchema.parse({
      ...resolveCoordinates(),
      field_center: { ra: meta.grid.crval[0], dec: meta.grid.crval[1], epoch: 2026.0 },
    });
    const state = stateOf(meta, 3, {
      target: target({
        resolved: still,
        trackStatus: "ready",
        track: { name: "objeto quieto", positions: [] },
      }),
    });
    const position = selectTargetPosition(state, 1);

    expect(position?.source).toBe("field_center");
    // `crval` cae en `crpix`, que cuenta desde 1: el pixel 97 desde 0.
    expect(position?.x).toBeCloseTo(97, 6);
    expect(position?.y).toBeCloseTo(97, 6);
    expect(position?.inField).toBe(true);
  });

  it("mientras la trayectoria esta en camino no hay posicion", () => {
    expect(
      selectTargetPosition(stateOf(meta, 3, { target: target({ trackStatus: "loading" }) }), 1),
    ).toBeNull();
    expect(
      selectTargetPosition(stateOf(meta, 3, { target: target({ trackStatus: "idle" }) }), 1),
    ).toBeNull();
  });

  it("si la trayectoria fallo usa field_center", () => {
    const state = stateOf(meta, 3, {
      target: target({ trackStatus: "error", trackError: "network" }),
    });
    expect(selectTargetPosition(state, 1)?.source).toBe("field_center");
  });

  it("sin nombre en la URL no hay mira", () => {
    expect(selectTargetPosition(stateOf(meta, 3), 1)).toBeNull();
  });
});
