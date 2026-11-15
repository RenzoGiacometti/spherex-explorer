// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  doneEventData,
  errorBody,
  FIELD_ID,
  minimalQueuedMeta,
  pendingPreview,
  planeEventData,
  progressEventData,
  queuedMeta,
  readyMeta,
  resolveBarnard,
  resolveCoordinates,
  trackBarnard,
} from "@/test/contractExamples";
import {
  errorBodySchema,
  errorEventSchema,
  fieldEventSchemas,
  fieldMetaSchema,
  fieldRequestSchema,
  fieldResponseSchema,
  planeSchema,
  previewSchema,
  priorityRequestSchema,
  progressSchema,
  provenanceSchema,
  resolveResponseSchema,
  trackResponseSchema,
  warningSchema,
} from "./schema";
import {
  type FieldMeta,
  type FieldWarning,
  isListed,
  type PreviewBand,
  type Progress,
} from "./types";

function withField(base: Record<string, unknown>, patch: Record<string, unknown>) {
  return { ...base, ...patch };
}

function withoutField(base: Record<string, unknown>, key: string) {
  const { [key]: _removed, ...rest } = base;
  return rest;
}

/** Los contadores de `progress` en cero, como los manda el backend mientras no aplican. */
const ZERO_COUNTERS = {
  queue_position: 0,
  cutouts_total: 0,
  cutouts_done: 0,
  cutouts_failed: 0,
  cutouts_cached: 0,
  planes_total: 0,
  planes_ready: 0,
  elapsed_s: 0,
};

describe("documento de metadatos", () => {
  it("acepta el ejemplo completo del contrato sin perder ni cambiar nada", () => {
    const meta = fieldMetaSchema.parse(readyMeta());
    expect(meta).toEqual(readyMeta());
    expect(isListed(meta)).toBe(true);
  });

  it("acepta un trabajo recien encolado, como lo manda el backend", () => {
    const meta = fieldMetaSchema.parse(queuedMeta());
    expect(meta.status).toBe("queued");
    expect(meta.pipeline).toBe("1");
    expect(meta.rev).toBe(0);
    expect(meta.grid).toBeUndefined();
    expect(meta.planes).toBeUndefined();
    expect(meta.provenance).toBeUndefined();
    expect(meta.warnings).toEqual([]);
    expect(meta.progress).toStrictEqual({ ...ZERO_COUNTERS, phase: "queued", queue_position: 1 });
    // La vista provisoria esta desde el primer momento, todavia sin escala.
    expect(meta.preview.status).toBe("pending");
    expect(meta.preview.band).toBe("W1");
    expect(meta.preview.display).toBeUndefined();
    expect(isListed(meta)).toBe(false);
  });

  it("rechaza la forma minima de la seccion 4.1, que el backend no produce", () => {
    const result = fieldMetaSchema.safeParse(minimalQueuedMeta());
    expect(result.success).toBe(false);
    // Le falta exactamente lo que la seccion 5 da por presente.
    expect(result.error?.issues.map((issue) => issue.path.join(".")).sort()).toEqual([
      "pipeline",
      "preview",
    ]);
  });

  it("exige pipeline y preview en cualquier estado, y no los acepta en null", () => {
    for (const base of [queuedMeta(), readyMeta()]) {
      for (const key of ["pipeline", "preview"]) {
        const label = `${String(base.status)} sin ${key}`;
        expect(fieldMetaSchema.safeParse(withoutField(base, key)).success, label).toBe(false);
        expect(fieldMetaSchema.safeParse(withField(base, { [key]: null })).success, label).toBe(
          false,
        );
      }
    }
    expect(fieldMetaSchema.safeParse(withField(queuedMeta(), { pipeline: "" })).success).toBe(
      false,
    );
  });

  it("trata null igual que ausente en lo que todavia no existe", () => {
    const meta = fieldMetaSchema.parse(
      withField(queuedMeta(), {
        rev: null,
        grid: null,
        detectors: null,
        epochs: null,
        planes: null,
        flags: null,
        warnings: null,
        provenance: null,
      }),
    );
    expect(meta.grid).toBeUndefined();
    expect(meta.detectors).toBeUndefined();
    expect(meta.provenance).toBeUndefined();
    expect(meta.rev).toBe(0);
    expect(meta.warnings).toEqual([]);
  });

  it("acepta la procedencia recien listada, sin modo de descarga ni fecha de armado", () => {
    const provenance = provenanceSchema.parse({
      source: "SPHEREx / IRSA",
      collections: ["spherex_dr1", "spherex_qr3"],
      listed_at: "2026-11-15T06:21:10Z",
      list_stale: false,
      download_mode: null,
      built_at: null,
    });
    expect(provenance.listed_at).toBe("2026-11-15T06:21:10Z");
    expect(provenance.download_mode).toBeUndefined();
    expect(provenance.built_at).toBeUndefined();
  });

  it("exige listed_at en la procedencia", () => {
    const provenance = readyMeta().provenance as Record<string, unknown>;
    expect(provenanceSchema.parse(provenance)).toEqual(provenance);
    expect(provenanceSchema.safeParse(withoutField(provenance, "listed_at")).success).toBe(false);
    expect(provenanceSchema.safeParse(withField(provenance, { listed_at: null })).success).toBe(
      false,
    );
    expect(
      fieldMetaSchema.safeParse(
        withField(readyMeta(), { provenance: withoutField(provenance, "listed_at") }),
      ).success,
    ).toBe(false);
  });

  it("descarta las claves que el contrato no nombra", () => {
    const meta = fieldMetaSchema.parse(withField(readyMeta(), { campo_nuevo: 1 }));
    expect(meta).not.toHaveProperty("campo_nuevo");
  });

  it("acepta todos los estados del campo y rechaza los demas", () => {
    for (const status of ["queued", "listing", "downloading", "ready", "partial", "failed"]) {
      expect(fieldMetaSchema.safeParse(withField(queuedMeta(), { status })).success, status).toBe(
        true,
      );
    }
    expect(fieldMetaSchema.safeParse(withField(queuedMeta(), { status: "done" })).success).toBe(
      false,
    );
  });

  it("rechaza un id que no son 16 caracteres hexadecimales", () => {
    for (const id of ["", "f3a91c0e52d47b1", "F3A91C0E52D47B18", "f3a91c0e52d47b18x", 12]) {
      expect(fieldMetaSchema.safeParse(withField(queuedMeta(), { id })).success, String(id)).toBe(
        false,
      );
    }
  });

  it("rechaza una grilla con forma o proyeccion invalidas", () => {
    const base = readyMeta();
    const grid = base.grid as Record<string, unknown>;
    for (const patch of [
      { shape: [195] },
      { shape: [195, 0] },
      { shape: [195.5, 195] },
      { projection: "SIN" },
      { crval: [269.4463] },
      { cdelt: ["a", "b"] },
    ]) {
      const result = fieldMetaSchema.safeParse(withField(base, { grid: { ...grid, ...patch } }));
      expect(result.success, JSON.stringify(patch)).toBe(false);
    }
  });

  it("rechaza un detector fuera de 1 a 6", () => {
    const base = readyMeta();
    const detector = (base.detectors as Record<string, unknown>[])[0];
    for (const value of [0, 7, 1.5, "1"]) {
      const result = fieldMetaSchema.safeParse(
        withField(base, { detectors: [{ ...detector, detector: value }] }),
      );
      expect(result.success, String(value)).toBe(false);
    }
  });

  it("acepta un detector sin escala todavia", () => {
    const base = readyMeta();
    const { display: _display, ...detector } =
      (base.detectors as Record<string, unknown>[])[0] ?? {};
    const meta = fieldMetaSchema.parse(withField(base, { detectors: [detector] }));
    expect(meta.detectors?.[0]?.display).toBeUndefined();
  });

  it("rechaza fechas de epoca que no son AAAA-MM-DD", () => {
    const base = readyMeta();
    const epoch = (base.epochs as Record<string, unknown>[])[0];
    for (const start of ["2025-8-15", "15/08/2025", "2025-08-15T00:00:00Z", 60902]) {
      const result = fieldMetaSchema.safeParse(withField(base, { epochs: [{ ...epoch, start }] }));
      expect(result.success, String(start)).toBe(false);
    }
  });
});

describe("plano", () => {
  const ready = (readyMeta().planes as Record<string, unknown>[])[0] ?? {};

  it("acepta los cinco estados", () => {
    for (const status of ["pending", "building", "ready", "partial", "empty"]) {
      expect(planeSchema.safeParse({ ...ready, status }).success, status).toBe(true);
    }
    expect(planeSchema.safeParse({ ...ready, status: "done" }).success).toBe(false);
  });

  it("acepta un plano pendiente sin estadisticas, con null o sin la clave", () => {
    const pending = {
      epoch: 2,
      detector: 4,
      status: "pending",
      rev: 0,
      n_exposures: 20,
      n_used: 0,
      n_failed: 0,
    };
    const expected = { ...pending, mjd_mean: null, stats: null, saturated: [], cube_offset: null };

    expect(planeSchema.parse(pending)).toEqual(expected);
    expect(
      planeSchema.parse({
        ...pending,
        mjd_mean: null,
        stats: null,
        saturated: null,
        cube_offset: null,
      }),
    ).toEqual(expected);
  });

  it("acepta un plano vacio", () => {
    const plane = planeSchema.parse({
      epoch: 4,
      detector: 1,
      status: "empty",
      rev: 1,
      n_exposures: 0,
      n_used: 0,
      n_failed: 0,
      mjd_mean: null,
      stats: null,
      saturated: [],
      cube_offset: null,
    });
    expect(plane.status).toBe("empty");
    expect(plane.cube_offset).toBeNull();
  });

  it("rechaza contadores negativos o con decimales", () => {
    for (const patch of [{ rev: -1 }, { n_used: 1.5 }, { n_exposures: -3 }, { cube_offset: -4 }]) {
      expect(planeSchema.safeParse({ ...ready, ...patch }).success, JSON.stringify(patch)).toBe(
        false,
      );
    }
  });

  it("rechaza fracciones fuera de 0 a 1 en las estadisticas", () => {
    const stats = ready.stats as Record<string, unknown>;
    expect(
      planeSchema.safeParse({ ...ready, stats: { ...stats, valid_fraction: 1.2 } }).success,
    ).toBe(false);
  });
});

describe("avisos", () => {
  const examples: Record<FieldWarning["code"], Record<string, unknown>> = {
    saturated_source: {
      code: "saturated_source",
      ra: 269.44604,
      dec: 4.7674,
      radius_arcsec: 14.1,
      epochs: [1, 2, 3],
      detectors: [1, 2, 3, 4, 5, 6],
    },
    plane_empty: { code: "plane_empty", epoch: 4, detector: 1 },
    few_exposures: { code: "few_exposures", epoch: 1, detector: 4, n: 3 },
    low_coverage: { code: "low_coverage", epoch: 2, detector: 5, valid_fraction: 0.88 },
    cutouts_failed: {
      code: "cutouts_failed",
      n: 3,
      planes: [
        { epoch: 1, detector: 2 },
        { epoch: 3, detector: 6 },
      ],
    },
    stale_exposure_list: { code: "stale_exposure_list", listed_at: "2026-11-14T22:10:00Z" },
    full_download: { code: "full_download", reason: "extension order changed" },
  };

  it("acepta los siete avisos del contrato", () => {
    for (const [code, example] of Object.entries(examples)) {
      const parsed = warningSchema.parse(example);
      expect(parsed, code).toEqual(example);
    }
  });

  it("es una union discriminada por code", () => {
    const warning = warningSchema.parse(examples.few_exposures);
    // Si esto compila, el tipo se estrecha con `code`.
    const n = warning.code === "few_exposures" ? warning.n : -1;
    expect(n).toBe(3);
  });

  it("rechaza un code desconocido", () => {
    expect(warningSchema.safeParse({ code: "cosmic_ray", epoch: 1 }).success).toBe(false);
  });

  it("rechaza un aviso al que le faltan parametros", () => {
    expect(warningSchema.safeParse({ code: "few_exposures", epoch: 1, detector: 4 }).success).toBe(
      false,
    );
    expect(warningSchema.safeParse({ code: "saturated_source", ra: 1, dec: 2 }).success).toBe(
      false,
    );
  });

  it("los planos de cutouts_failed son objetos {epoch, detector}, no pares", () => {
    const pairs = warningSchema.safeParse({
      code: "cutouts_failed",
      n: 2,
      planes: [
        [1, 2],
        [3, 6],
      ],
    });
    expect(pairs.success).toBe(false);

    for (const plane of [{ epoch: 1 }, { epoch: 0, detector: 2 }, { epoch: 1, detector: 7 }]) {
      expect(
        warningSchema.safeParse({ code: "cutouts_failed", n: 1, planes: [plane] }).success,
        JSON.stringify(plane),
      ).toBe(false);
    }
    expect(warningSchema.parse({ code: "cutouts_failed", n: 0, planes: [] })).toEqual({
      code: "cutouts_failed",
      n: 0,
      planes: [],
    });
  });

  it("acepta la fecha con Z, con desplazamiento, sin zona y con fracciones de segundo", () => {
    for (const listed_at of [
      "2026-11-14T22:10:00Z",
      "2026-11-14T22:10:00+00:00",
      "2026-11-14T22:10:00",
      "2026-11-14T22:10:00.123456Z",
      "2026-11-14T22:10:00.123456+00:00",
    ]) {
      expect(
        warningSchema.safeParse({ code: "stale_exposure_list", listed_at }).success,
        listed_at,
      ).toBe(true);
    }
    for (const listed_at of ["ayer", "2026-11-14", 61358.9]) {
      expect(
        warningSchema.safeParse({ code: "stale_exposure_list", listed_at }).success,
        String(listed_at),
      ).toBe(false);
    }
  });
});

describe("progress", () => {
  it("entrega todos los contadores tal como los manda el backend", () => {
    const progress = readyMeta().progress;
    expect(progressSchema.parse(progress)).toStrictEqual(progress);
  });

  it("los contadores que los ejemplos de la seccion 4.2 omiten valen 0", () => {
    // El evento `progress` del ejemplo no trae queue_position.
    expect(progressSchema.parse(progressEventData())).toStrictEqual({
      ...progressEventData(),
      queue_position: 0,
    });
    // El `state` del ejemplo trae solo la fase y la posicion en la cola.
    expect(progressSchema.parse({ phase: "queued", queue_position: 1 })).toStrictEqual({
      ...ZERO_COUNTERS,
      phase: "queued",
      queue_position: 1,
    });
    expect(progressSchema.parse({ phase: "listing" })).toStrictEqual({
      ...ZERO_COUNTERS,
      phase: "listing",
    });
  });

  it("los contadores son numeros, sin ausencias que manejar", () => {
    const progress: Progress = progressSchema.parse(progressEventData());
    // Este objeto no compila si algun contador es opcional. Los dos del
    // reintento del listado si lo son: solo acompanan a la fase `listing`.
    const counters: Record<
      Exclude<keyof Progress, "phase" | "listing_attempt" | "retry_in_s">,
      number
    > = {
      queue_position: progress.queue_position,
      cutouts_total: progress.cutouts_total,
      cutouts_done: progress.cutouts_done,
      cutouts_failed: progress.cutouts_failed,
      cutouts_cached: progress.cutouts_cached,
      planes_total: progress.planes_total,
      planes_ready: progress.planes_ready,
      elapsed_s: progress.elapsed_s,
    };
    expect(Object.values(counters).every((value) => typeof value === "number")).toBe(true);
  });

  it("acepta el intento del listado y la espera hasta el proximo, que son opcionales", () => {
    const retrying = progressSchema.parse({ phase: "listing", listing_attempt: 2, retry_in_s: 12 });
    expect(retrying.listing_attempt).toBe(2);
    expect(retrying.retry_in_s).toBe(12);
    const first = progressSchema.parse({ phase: "listing", listing_attempt: 1, retry_in_s: null });
    expect(first.listing_attempt).toBe(1);
    expect(first.retry_in_s).toBeNull();
    expect(progressSchema.parse({ phase: "listing" }).listing_attempt).toBeUndefined();
  });

  it("rechaza contadores en null, negativos o con decimales", () => {
    for (const patch of [
      { queue_position: null },
      { cutouts_total: null },
      { elapsed_s: null },
      { cutouts_done: -1 },
      { planes_ready: 1.5 },
      { cutouts_failed: "0" },
      { elapsed_s: -0.1 },
    ]) {
      expect(
        progressSchema.safeParse({ ...progressEventData(), ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it("acepta las cinco fases y rechaza las demas", () => {
    for (const phase of ["queued", "listing", "downloading", "finishing", "done"]) {
      expect(progressSchema.safeParse({ phase }).success, phase).toBe(true);
    }
    expect(progressSchema.safeParse({ phase: "ready" }).success).toBe(false);
    expect(progressSchema.safeParse({}).success).toBe(false);
  });
});

describe("preview", () => {
  it("acepta la vista pendiente: relevamiento y banda definidos, todavia sin escala", () => {
    const preview = previewSchema.parse(pendingPreview());
    expect(preview).toEqual({
      status: "pending",
      survey: "WISE",
      band: "W1",
      wave_um: 3.4,
      hips: "identificador HiPS usado",
    });
    expect(preview.display).toBeUndefined();
  });

  it("acepta la vista lista del ejemplo del contrato", () => {
    const example = readyMeta().preview;
    expect(previewSchema.parse(example)).toStrictEqual(example);
  });

  it("acepta la vista descartada, con la escala en null o sin la clave", () => {
    const unavailable = { ...pendingPreview(), status: "unavailable", band: "W2", wave_um: 4.6 };
    const preview = previewSchema.parse(unavailable);
    expect(preview.status).toBe("unavailable");
    expect(preview.band).toBe("W2");
    expect(preview.display).toBeUndefined();
    expect(previewSchema.parse(withoutField(unavailable, "display")).display).toBeUndefined();
  });

  it("exige survey, band, wave_um y hips, y no los acepta en null", () => {
    // La forma minima que antes pasaba: el backend no la produce.
    expect(previewSchema.safeParse({ status: "pending" }).success).toBe(false);
    for (const key of ["survey", "band", "wave_um", "hips"]) {
      expect(previewSchema.safeParse(withoutField(pendingPreview(), key)).success, key).toBe(false);
      expect(
        previewSchema.safeParse(withField(pendingPreview(), { [key]: null })).success,
        key,
      ).toBe(false);
    }
  });

  it("la banda es W1 o W2", () => {
    for (const band of ["W1", "W2"]) {
      expect(previewSchema.safeParse(withField(pendingPreview(), { band })).success, band).toBe(
        true,
      );
    }
    for (const band of ["W3", "w1", "3.4", "", 1]) {
      expect(
        previewSchema.safeParse(withField(pendingPreview(), { band })).success,
        String(band),
      ).toBe(false);
    }
    // No compila si `band` vuelve a ser un texto cualquiera o puede faltar.
    const band: PreviewBand = previewSchema.parse(pendingPreview()).band;
    const waves: Record<"W1" | "W2", number> = { W1: 3.4, W2: 4.6 };
    expect(waves[band]).toBe(3.4);
  });

  it("rechaza un estado desconocido", () => {
    expect(previewSchema.safeParse({ status: "loading" }).success).toBe(false);
  });
});

describe("POST /api/field", () => {
  it("acepta el pedido del ejemplo y los campos opcionales", () => {
    expect(fieldRequestSchema.parse({ ra: 269.4463, dec: 4.7683, fov: 0.1667, band: 3 })).toEqual({
      ra: 269.4463,
      dec: 4.7683,
      fov: 0.1667,
      band: 3,
    });
    expect(fieldRequestSchema.parse({ ra: 10, dec: -20 })).toEqual({ ra: 10, dec: -20 });
    expect(fieldRequestSchema.parse({ ra: 10, dec: -20, refresh: true }).refresh).toBe(true);
  });

  it("rechaza un pedido fuera de rango", () => {
    for (const request of [
      { ra: 10, dec: 91 },
      { ra: 10, dec: 0, fov: 1 },
      { ra: 10, dec: 0, fov: 0.01 },
      { ra: 10, dec: 0, band: 7 },
      { ra: 10, dec: 0, band: 2.5 },
      { ra: Number.NaN, dec: 0 },
      { dec: 0 },
    ]) {
      expect(fieldRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false);
    }
  });

  it("acepta la respuesta de un campo terminado", () => {
    const response = fieldResponseSchema.parse({
      id: FIELD_ID,
      status: "ready",
      events_url: `/api/field/${FIELD_ID}/events`,
      meta: readyMeta(),
    });
    expect(response.meta.planes).toHaveLength(1);
    expect(response.events_url).toBe(`/api/field/${FIELD_ID}/events`);
  });

  it("acepta la respuesta de un campo recien encolado", () => {
    const response = fieldResponseSchema.parse({
      id: FIELD_ID,
      status: "queued",
      events_url: `/api/field/${FIELD_ID}/events`,
      meta: queuedMeta(),
    });
    expect(response.meta.grid).toBeUndefined();
  });

  it("rechaza una respuesta sin meta", () => {
    expect(
      fieldResponseSchema.safeParse({
        id: FIELD_ID,
        status: "queued",
        events_url: `/api/field/${FIELD_ID}/events`,
      }).success,
    ).toBe(false);
  });

  it("valida el cuerpo de /priority", () => {
    expect(priorityRequestSchema.parse({ band: 6 })).toEqual({ band: 6 });
    expect(priorityRequestSchema.safeParse({ band: 0 }).success).toBe(false);
  });
});

describe("errores", () => {
  it("acepta los siete codigos del contrato", () => {
    for (const code of [
      "invalid_request",
      "not_resolved",
      "not_found",
      "not_ready",
      "no_coverage",
      "queue_full",
      "upstream_unavailable",
    ]) {
      const body = errorBodySchema.parse(errorBody(code, true));
      expect(body.error).toEqual({ code, message: "detalle para el log", retryable: true });
    }
  });

  it("rechaza un codigo desconocido o un cuerpo con otra forma", () => {
    expect(errorBodySchema.safeParse(errorBody("teapot")).success).toBe(false);
    expect(errorBodySchema.safeParse({ detail: "Not Found" }).success).toBe(false);
    expect(errorBodySchema.safeParse(null).success).toBe(false);
  });

  it("tolera que falten message y retryable", () => {
    expect(errorBodySchema.parse({ error: { code: "not_found" } }).error).toEqual({
      code: "not_found",
      message: "",
      retryable: false,
    });
  });

  it("el evento error llega envuelto en {error: ...} y se entrega el objeto de adentro", () => {
    const expected = { code: "upstream_unavailable", message: "IRSA", retryable: true };
    expect(errorEventSchema.parse({ error: expected })).toEqual(expected);
    expect(fieldEventSchemas.error.parse(errorBody("no_coverage"))).toEqual({
      code: "no_coverage",
      message: "detalle para el log",
      retryable: false,
    });
  });

  it("rechaza un evento error suelto, sin la clave error", () => {
    const loose = { code: "upstream_unavailable", message: "IRSA", retryable: true };
    expect(errorEventSchema.safeParse(loose).success).toBe(false);
    expect(fieldEventSchemas.error.safeParse(loose).success).toBe(false);
    expect(errorEventSchema.safeParse({ error: { ...loose, code: "teapot" } }).success).toBe(false);
  });
});

describe("eventos SSE", () => {
  it("hay un esquema por cada evento del contrato", () => {
    expect(Object.keys(fieldEventSchemas).sort()).toEqual(
      [
        "state",
        "queued",
        "preview",
        "listed",
        "progress",
        "plane",
        "warning",
        "done",
        "error",
      ].sort(),
    );
  });

  it("state y listed llevan el documento de metadatos", () => {
    expect(fieldEventSchemas.state.parse(queuedMeta()).status).toBe("queued");
    const listed: FieldMeta = fieldEventSchemas.listed.parse(readyMeta());
    expect(isListed(listed)).toBe(true);
  });

  it("preview lleva el objeto preview completo", () => {
    expect(fieldEventSchemas.preview.parse(readyMeta().preview)).toStrictEqual(readyMeta().preview);
    expect(fieldEventSchemas.preview.safeParse({ status: "ready" }).success).toBe(false);
  });

  it("queued lleva la posicion", () => {
    expect(fieldEventSchemas.queued.parse({ position: 2 })).toEqual({ position: 2 });
    expect(fieldEventSchemas.queued.safeParse({ position: -1 }).success).toBe(false);
  });

  it("plane lleva el plano y la escala del detector", () => {
    const data = fieldEventSchemas.plane.parse(planeEventData());
    expect(data.plane.detector).toBe(3);
    expect(data.plane.cube_offset).toBeNull();
    expect(data.detector_display).toEqual({
      detector: 3,
      vmin: -0.08,
      vmax: 9.8,
      median: 0.002,
      sigma: 0.041,
    });
  });

  it("plane acepta un plano provisorio", () => {
    const example = planeEventData();
    const plane = { ...(example.plane as Record<string, unknown>), status: "building", n_used: 9 };
    const data = fieldEventSchemas.plane.parse({ ...example, plane });
    expect(data.plane.status).toBe("building");
    expect(data.plane.n_used).toBe(9);
  });

  it("done solo admite ready o partial", () => {
    expect(fieldEventSchemas.done.parse(doneEventData())).toEqual(doneEventData());
    expect(
      fieldEventSchemas.done.safeParse({ ...doneEventData(), status: "partial" }).success,
    ).toBe(true);
    expect(fieldEventSchemas.done.safeParse({ ...doneEventData(), status: "failed" }).success).toBe(
      false,
    );
  });
});

describe("/api/resolve", () => {
  it("acepta el ejemplo de Barnard", () => {
    expect(resolveResponseSchema.parse(resolveBarnard())).toEqual(resolveBarnard());
  });

  it("acepta coordenadas: name y motion en null", () => {
    const resolved = resolveResponseSchema.parse(resolveCoordinates());
    expect(resolved.source).toBe("coordinates");
    expect(resolved.name).toBeNull();
    expect(resolved.motion).toBeNull();
  });

  it("acepta un objeto con movimiento propio pero sin paralaje ni velocidad radial", () => {
    const example = resolveBarnard();
    const motion = {
      ...(example.motion as Record<string, unknown>),
      parallax: null,
      radial_velocity: null,
    };
    const resolved = resolveResponseSchema.parse({ ...example, motion });
    expect(resolved.motion?.parallax).toBeNull();
    expect(resolved.motion?.radial_velocity).toBeNull();
  });

  it("rechaza una respuesta sin field_center", () => {
    const { field_center: _fieldCenter, ...rest } = resolveBarnard();
    expect(resolveResponseSchema.safeParse(rest).success).toBe(false);
  });
});

describe("/track", () => {
  it("acepta el ejemplo del contrato", () => {
    expect(trackResponseSchema.parse(trackBarnard())).toEqual(trackBarnard());
  });

  it("acepta positions vacio", () => {
    expect(trackResponseSchema.parse({ name: "RW Aur", positions: [] }).positions).toEqual([]);
  });
});
