// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Epoch, Plane, PlaneStatus } from "@/api/types";
import type { BandPlane } from "@/data/selectors";
import { type PlaneImage, toPlaneImage } from "@/viewer/planeImage";
import {
  defaultStretchForMode,
  deriveView,
  pickReferenceEpoch,
  stepEpoch,
  type ViewSelection,
} from "./viewModel";

type Kind = "ready" | "building" | "pending" | "empty";

const images = new Map<number, PlaneImage>();

/** Imagen de una epoca: siempre el mismo objeto, para comparar por identidad. */
function image(epoch: number): PlaneImage {
  let known = images.get(epoch);
  if (!known) {
    known = toPlaneImage(new Float32Array([epoch]), [1, 1]);
    images.set(epoch, known);
  }
  return known;
}

function entry(number: number, kind: Kind): BandPlane {
  const epoch: Epoch = {
    epoch: number,
    start: "2025-05-05",
    end: "2025-05-06",
    mjd_start: 60800 + number,
    mjd_end: 60801 + number,
    mjd_mean: 60800.5 + number,
    n_exposures: 20,
  };
  const status: PlaneStatus = kind;
  const plane: Plane = {
    epoch: number,
    detector: 3,
    status,
    rev: kind === "ready" ? 2 : kind === "building" ? 1 : 0,
    n_exposures: kind === "empty" ? 0 : 20,
    n_used: kind === "ready" ? 20 : kind === "building" ? 10 : 0,
    n_failed: 0,
    mjd_mean: null,
    stats: null,
    saturated: [],
    cube_offset: null,
  };
  const hasImage = kind === "ready" || kind === "building";
  return {
    epoch,
    plane,
    loaded: hasImage
      ? { epoch: number, detector: 3, rev: plane.rev, status, plane, image: image(number) }
      : null,
  };
}

function entries(...kinds: Kind[]): BandPlane[] {
  return kinds.map((kind, index) => entry(index + 1, kind));
}

/** Las mismas epocas con otra cantidad de exposiciones en el plano de la banda. */
function withExposures(list: readonly BandPlane[], exposures: readonly number[]): BandPlane[] {
  return list.map((item, index) => ({
    ...item,
    plane: item.plane ? { ...item.plane, n_exposures: exposures[index] ?? 0 } : null,
  }));
}

function view(selection: Partial<ViewSelection> & Pick<ViewSelection, "entries">) {
  return deriveView({
    mode: "blink",
    urlEpoch: null,
    frameEpoch: null,
    chosenReference: null,
    holding: false,
    ...selection,
  });
}

describe("deriveView: epocas A y B", () => {
  it("por defecto A es la ultima con imagen y B la primera", () => {
    const result = view({ entries: entries("ready", "ready", "ready") });
    expect(result.current).toBe(3);
    expect(result.reference).toBe(1);
    expect(result.imageEpochs).toEqual([1, 2, 3]);
  });

  it("mientras carga, A es la ultima imagen que llego", () => {
    // La primera imagen se ve apenas llega, aunque no sea la de la ultima epoca.
    expect(view({ entries: entries("building", "pending", "pending") }).current).toBe(1);
    expect(view({ entries: entries("building", "ready", "pending") }).current).toBe(2);
  });

  it("sin ninguna imagen, A es la ultima epoca que va a tener datos", () => {
    const result = view({ entries: entries("pending", "pending", "empty") });
    expect(result.current).toBe(2);
    expect(result.reference).toBe(1);
    expect(result.composition).toBeNull();
    expect(result.missing).toBe("pending");
  });

  it("la epoca de la URL manda, tenga imagen o no", () => {
    const list = entries("ready", "ready", "ready", "empty");
    expect(view({ entries: list, urlEpoch: 2 }).current).toBe(2);
    const empty = view({ entries: list, urlEpoch: 4 });
    expect(empty.current).toBe(4);
    expect(empty.composition).toBeNull();
    expect(empty.missing).toBe("empty");
  });

  it("una epoca de la URL que el campo no tiene no fija nada", () => {
    expect(view({ entries: entries("ready", "ready", "ready"), urlEpoch: 9 }).current).toBe(3);
  });

  it("B es la elegida, salvo que sea A o no exista", () => {
    const list = entries("ready", "ready", "ready");
    expect(view({ entries: list, chosenReference: 2 }).reference).toBe(2);
    expect(view({ entries: list, chosenReference: 3 }).reference).toBe(1);
    expect(view({ entries: list, chosenReference: 7 }).reference).toBe(1);
    // Si A pasa a ser la primera, B es la mas lejana en fecha: la ultima.
    expect(view({ entries: list, urlEpoch: 1 }).reference).toBe(3);
  });

  it("por defecto B es una epoca bien cubierta, la mas lejana en fecha a A", () => {
    // WISE 0855 en B6: 3, 21 y 21 exposiciones. La epoca 1 es la mas lejana, pero ruidosa.
    const wise = withExposures(entries("ready", "ready", "ready"), [3, 21, 21]);
    expect(view({ entries: wise }).reference).toBe(2);
    expect(view({ entries: wise, urlEpoch: 2 }).reference).toBe(3);
    // Con la epoca 1 como actual, la 3 es bien cubierta y la mas lejana.
    expect(view({ entries: wise, urlEpoch: 1 }).reference).toBe(3);
  });

  it("por defecto B sale de las epocas con imagen mientras el campo carga", () => {
    // La epoca 2 es la mejor cubierta pero su imagen todavia no llego.
    const loading = withExposures(entries("ready", "pending", "ready"), [3, 21, 21]);
    expect(view({ entries: loading }).reference).toBe(1);
  });

  it("antes de `listed` no hay epocas", () => {
    const result = view({ entries: [] });
    expect(result).toMatchObject({
      current: null,
      reference: null,
      displayed: null,
      composition: null,
      missing: "waiting",
    });
  });
});

describe("pickReferenceEpoch", () => {
  const candidate = (epoch: number, mjd: number, exposures: number) => ({ epoch, mjd, exposures });

  it("descarta las epocas con menos de la mitad de las exposiciones de la mejor", () => {
    // Epocas 1 y 2 de WISE 0855 en B6, vistas desde la 3 (MJD 61161,9).
    const list = [candidate(1, 60801.2, 3), candidate(2, 60991.3, 21)];
    expect(pickReferenceEpoch(list, 61161.9)).toBe(2);
  });

  it("entre las bien cubiertas elige la mas lejana en fecha, antes o despues", () => {
    const list = [candidate(1, 60800, 20), candidate(2, 60990, 30), candidate(4, 61300, 30)];
    expect(pickReferenceEpoch(list, 61160)).toBe(1);
    expect(pickReferenceEpoch(list, 60850)).toBe(4);
  });

  it("la mitad justa alcanza y una exposicion menos no", () => {
    expect(pickReferenceEpoch([candidate(1, 60800, 10), candidate(2, 61000, 20)], 61100)).toBe(1);
    expect(pickReferenceEpoch([candidate(1, 60800, 9), candidate(2, 61000, 20)], 61100)).toBe(2);
  });

  it("a igual distancia gana la de mas exposiciones y despues la mas antigua", () => {
    expect(pickReferenceEpoch([candidate(1, 60900, 15), candidate(3, 61100, 20)], 61000)).toBe(3);
    expect(pickReferenceEpoch([candidate(1, 60900, 20), candidate(3, 61100, 20)], 61000)).toBe(1);
  });

  it("sin exposiciones en ninguna igual elige la mas lejana", () => {
    expect(pickReferenceEpoch([candidate(1, 60800, 0), candidate(2, 61000, 0)], 61100)).toBe(1);
  });

  it("sin fecha actual gana la mejor cubierta, y sin candidatas no hay referencia", () => {
    expect(pickReferenceEpoch([candidate(1, 60800, 12), candidate(2, 61000, 20)], null)).toBe(2);
    expect(pickReferenceEpoch([], 61000)).toBeNull();
  });
});

describe("defaultStretchForMode", () => {
  it("lineal en diferencia y rojo/cian, asinh en los demas", () => {
    expect(defaultStretchForMode("difference")).toBe("linear");
    expect(defaultStretchForMode("redcyan")).toBe("linear");
    for (const mode of ["blink", "sum", "hold", "journey"] as const) {
      expect(defaultStretchForMode(mode), mode).toBe("asinh");
    }
  });
});

describe("deriveView: que se dibuja en cada modo", () => {
  const list = entries("ready", "ready", "ready");

  it("parpadeo: la epoca actual sola", () => {
    const result = view({ entries: list, mode: "blink", urlEpoch: 2 });
    expect(result.composition).toEqual({ mode: "single", planes: [image(2)], epochs: [2] });
    expect(result.displayed).toBe(2);
    expect(result.issue).toBeNull();
    expect(result.missing).toBeNull();
  });

  it("parpadeo reproduciendo: el cuadro del reproductor, sin tocar A", () => {
    const result = view({ entries: list, mode: "blink", frameEpoch: 1 });
    expect(result.composition?.epochs).toEqual([1]);
    expect(result.displayed).toBe(1);
    expect(result.current).toBe(3);
  });

  it("un cuadro sin imagen no se muestra: queda la epoca actual", () => {
    const result = view({ entries: entries("ready", "pending", "ready"), frameEpoch: 2 });
    expect(result.displayed).toBe(3);
    expect(result.composition?.epochs).toEqual([3]);
  });

  it("diferencia: A menos B, con B adelante como pide compose.ts", () => {
    const result = view({ entries: list, mode: "difference" });
    expect(result.composition).toEqual({
      mode: "difference",
      planes: [image(1), image(3)],
      epochs: [1, 3],
    });
  });

  it("rojo/cian: A en rojo (primero) y B en cian", () => {
    const result = view({ entries: list, mode: "redcyan", urlEpoch: 2, chosenReference: 3 });
    expect(result.composition).toEqual({
      mode: "redcyan",
      planes: [image(2), image(3)],
      epochs: [2, 3],
    });
  });

  it("suma: todas las epocas con imagen", () => {
    const result = view({ entries: entries("ready", "empty", "building", "ready"), mode: "sum" });
    expect(result.composition).toEqual({
      mode: "sum",
      planes: [image(1), image(3), image(4)],
      epochs: [1, 3, 4],
    });
  });

  it("mantener apretado: A y, mientras se mantiene, B", () => {
    expect(view({ entries: list, mode: "hold" }).composition?.epochs).toEqual([3]);
    const held = view({ entries: list, mode: "hold", holding: true });
    expect(held.composition).toEqual({ mode: "single", planes: [image(1)], epochs: [1] });
    // La linea de tiempo sigue marcando A.
    expect(held.displayed).toBe(3);
  });

  it("fuera del modo, mantener apretado no cambia nada", () => {
    expect(view({ entries: list, mode: "blink", holding: true }).composition?.epochs).toEqual([3]);
  });
});

describe("deriveView: cuando no se puede comparar", () => {
  it("sin otra epoca con imagen se ve A sola y se avisa", () => {
    const list = entries("pending", "pending", "ready");
    for (const mode of ["difference", "redcyan", "hold"] as const) {
      const result = view({ entries: list, mode });
      expect(result.issue, mode).toBe("missing-reference");
      expect(result.composition, mode).toEqual({ mode: "single", planes: [image(3)], epochs: [3] });
    }
    // Mantener apretado sin B sigue mostrando A.
    expect(view({ entries: list, mode: "hold", holding: true }).composition?.epochs).toEqual([3]);
  });

  it("si A no tiene imagen, avisa y no dibuja una comparacion", () => {
    const result = view({
      entries: entries("ready", "ready", "empty"),
      mode: "difference",
      urlEpoch: 3,
    });
    expect(result.issue).toBe("missing-current");
    expect(result.composition).toBeNull();
    expect(result.missing).toBe("empty");
  });

  it("el parpadeo y la suma no comparan de a dos: no tienen ese aviso", () => {
    const list = entries("pending", "pending", "ready");
    expect(view({ entries: list, mode: "blink" }).issue).toBeNull();
    expect(view({ entries: list, mode: "sum" }).issue).toBeNull();
  });

  it("suma sin ninguna imagen", () => {
    expect(view({ entries: entries("pending", "empty"), mode: "sum" }).missing).toBe("pending");
    expect(view({ entries: entries("empty", "empty"), mode: "sum" }).missing).toBe("empty");
  });
});

describe("deriveView: aviso de epoca provisoria", () => {
  const list = entries("building", "ready", "ready");

  it("avisa si alguna de las dos epocas comparadas es provisoria", () => {
    for (const mode of ["difference", "redcyan", "hold"] as const) {
      expect(view({ entries: list, mode }).provisional, mode).toBe(true);
      expect(view({ entries: list, mode, chosenReference: 2 }).provisional, mode).toBe(false);
    }
    expect(view({ entries: list, mode: "difference", urlEpoch: 1 }).provisional).toBe(true);
  });

  it("en suma alcanza con una provisoria entre todas", () => {
    expect(view({ entries: list, mode: "sum" }).provisional).toBe(true);
    expect(view({ entries: entries("ready", "ready"), mode: "sum" }).provisional).toBe(false);
  });

  it("el parpadeo no compara: lo provisorio va en el rotulo de la imagen", () => {
    expect(view({ entries: list, mode: "blink", urlEpoch: 1 }).provisional).toBe(false);
  });
});

describe("stepEpoch", () => {
  it("recorre las epocas con imagen y da la vuelta", () => {
    const list = entries("ready", "empty", "ready", "ready");
    expect(stepEpoch(list, 1, 1)).toBe(3);
    expect(stepEpoch(list, 3, 1)).toBe(4);
    expect(stepEpoch(list, 4, 1)).toBe(1);
    expect(stepEpoch(list, 1, -1)).toBe(4);
    expect(stepEpoch(list, 3, -1)).toBe(1);
  });

  it("desde una epoca sin imagen va a la mas cercana en ese sentido", () => {
    const list = entries("ready", "empty", "ready", "ready");
    expect(stepEpoch(list, 2, 1)).toBe(3);
    expect(stepEpoch(list, 2, -1)).toBe(1);
  });

  it("si ninguna tiene imagen recorre todas", () => {
    const list = entries("pending", "pending", "pending");
    expect(stepEpoch(list, 1, 1)).toBe(2);
    expect(stepEpoch(list, 3, 1)).toBe(1);
  });

  it("sin epoca de partida arranca por una punta, y sin epocas no hay donde ir", () => {
    const list = entries("ready", "ready", "ready");
    expect(stepEpoch(list, null, 1)).toBe(1);
    expect(stepEpoch(list, null, -1)).toBe(3);
    expect(stepEpoch([], 1, 1)).toBeNull();
  });
});
