// @vitest-environment node
//
// Capa optica (optical.ts): que placas entran al viaje y en que orden, cual
// hace de lado visible en la cortina, y la posicion de la cortina.

import { describe, expect, it } from "vitest";
import {
  CURTAIN_STEPS,
  clampCurtain,
  curtainFromValue,
  curtainKeyStep,
  curtainPercent,
  curtainToValue,
} from "./curtainMath";
import { orderFrames } from "./journey";
import {
  curtainLayer,
  journeyLayers,
  type OpticalDocument,
  type OpticalLayer,
  opticalFrame,
  opticalLayerSchema,
  plateCredit,
  targetOutsideField,
} from "./optical";

const DISPLAY = { vmin: -100, vmax: 5000, median: 0, sigma: 50 };

function layer(overrides: Partial<OpticalLayer>): OpticalLayer {
  return {
    key: "dss2_red",
    survey: "DSS",
    generation: "DSS2",
    band: "R",
    wave_um: 0.65,
    file: "dss2_red.f32",
    mjd: 48423,
    date: "1991-06-16",
    year: 1991.454,
    unit: "plate density",
    native_pixel_scale_arcsec: 1.02,
    display: DISPLAY,
    valid_fraction: 1,
    plate: "SF04022",
    plate_survey: "POSSII-F",
    telescope: "Oschin Schmidt - D",
    emulsion: "IIIaF",
    filter: "RG610",
    exposure_min: 85,
    copyright: "Caltech/Palomar",
    url: "https://archive.stsci.edu/cgi-bin/dss_search",
    date_reliable: true,
    target: null,
    ...overrides,
  };
}

function document(layers: OpticalLayer[]): OpticalDocument {
  return {
    version: 1,
    key: "269.4463_+4.7683_0.1667",
    grid: {
      projection: "TAN",
      crval: [269.4463, 4.7683],
      crpix: [98, 98],
      cdelt: [-3.075 / 3600, 3.075 / 3600],
      shape: [195, 195],
      fov: 0.1667,
      pixel_scale_arcsec: 3.075,
      native_pixel_scale_arcsec: 6.15,
    },
    layers,
    generated_at: "2026-11-15T18:00:00Z",
  };
}

const FIRST = layer({
  key: "dss1",
  generation: "DSS1",
  mjd: 33471,
  date: "1950-07-09",
  year: 1950.517,
  plate: "E164",
  plate_survey: "POSSI-E",
  copyright: "STScI/AURA",
});
const SECOND = layer({});
// La placa de RW Aurigae: segunda generacion con una fecha de 1952 en el encabezado.
const WRONG_DATE = layer({ mjd: 34246, date: "1952-08-22", year: 1952.64, date_reliable: false });

describe("placas que entran al viaje", () => {
  it("van de la mas antigua a la mas nueva", () => {
    expect(journeyLayers(document([SECOND, FIRST])).map((item) => item.key)).toEqual([
      "dss1",
      "dss2_red",
    ]);
  });

  it("una placa con fecha imposible no es una parada", () => {
    expect(journeyLayers(document([WRONG_DATE, FIRST])).map((item) => item.key)).toEqual(["dss1"]);
    expect(journeyLayers(document([WRONG_DATE]))).toEqual([]);
  });

  it("el cuadro de una placa queda antes que 2MASS y lleva la fecha de la placa", () => {
    const frame = opticalFrame(SECOND, [195, 195], new Float32Array(195 * 195));
    expect(frame.mission).toBe("DSS");
    expect(frame.band).toBe("R");
    expect(frame.waveUm).toEqual([0.65]);
    expect(frame.dateStart).toBe("1991-06-16");
    expect(frame.dateEnd).toBe("1991-06-16");
    expect(frame.image?.display).toEqual(DISPLAY);

    const twomass = {
      ...frame,
      id: "twomass_ks",
      mission: "2MASS" as const,
      mjd: 51692,
      year: 2000.4,
    };
    const first = opticalFrame(FIRST, [195, 195], null);
    expect(orderFrames([twomass, frame, first]).map((item) => item.id)).toEqual([
      "dss1",
      "dss2_red",
      "twomass_ks",
    ]);
    // Sin los pixeles todavia, el cuadro existe pero no tiene imagen.
    expect(first.image).toBeNull();
  });

  it("la posicion del objeto solo se informa si caia dentro del campo", () => {
    const inside = layer({ target: { ra: 1, dec: 2, x: 58.4, y: 124.1, in_field: true } });
    const outside = layer({ target: { ra: 1, dec: 2, x: 88.5, y: -20, in_field: false } });
    expect(opticalFrame(inside, [195, 195], null).target).toEqual({ x: 58.4, y: 124.1 });
    expect(opticalFrame(outside, [195, 195], null).target).toBeNull();
    expect(targetOutsideField(outside)).toBe(true);
    expect(targetOutsideField(inside)).toBe(false);
    expect(targetOutsideField(SECOND)).toBe(false);
  });
});

describe("lado visible de la cortina", () => {
  it("prefiere la segunda generacion, aunque su fecha no sea de fiar", () => {
    expect(curtainLayer(document([FIRST, SECOND]))?.key).toBe("dss2_red");
    expect(curtainLayer(document([FIRST, WRONG_DATE]))?.date_reliable).toBe(false);
  });

  it("sin segunda generacion usa la mas nueva que haya", () => {
    expect(curtainLayer(document([FIRST]))?.key).toBe("dss1");
    expect(curtainLayer(document([]))).toBeNull();
  });

  it("el credito lleva la placa, su relevamiento y el titular", () => {
    expect(plateCredit(SECOND)).toEqual({
      plate: "SF04022",
      survey: "POSSII-F",
      owner: "Caltech/Palomar",
    });
  });
});

describe("esquema de una capa", () => {
  it("acepta una capa sin posicion del objeto y la deja en null", () => {
    const { target: _target, ...rest } = SECOND;
    expect(opticalLayerSchema.parse(rest).target).toBeNull();
  });

  it("rechaza una fecha que no es ISO", () => {
    expect(opticalLayerSchema.safeParse({ ...SECOND, date: "16/06/1991" }).success).toBe(false);
  });
});

describe("posicion de la cortina", () => {
  it("se acota entre 0 y 1", () => {
    expect(clampCurtain(-0.2)).toBe(0);
    expect(clampCurtain(0.37)).toBe(0.37);
    expect(clampCurtain(1.4)).toBe(1);
    expect(clampCurtain(Number.NaN)).toBe(0.5);
  });

  it("pasa al valor del control nativo y vuelve sin perder la posicion", () => {
    expect(CURTAIN_STEPS).toBe(1000);
    expect(curtainToValue(0)).toBe(0);
    expect(curtainToValue(0.5)).toBe(500);
    expect(curtainToValue(1)).toBe(1000);
    expect(curtainToValue(0.3337)).toBe(334);
    expect(curtainFromValue(334)).toBeCloseTo(0.334, 10);
    for (const position of [0, 0.125, 0.5, 0.999, 1]) {
      expect(curtainFromValue(curtainToValue(position))).toBeCloseTo(position, 3);
    }
    expect(curtainPercent(0.374)).toBe(37);
    expect(curtainPercent(2)).toBe(100);
  });

  it("las flechas mueven de a 2 %, o de a 10 % con Mayus, sin salirse", () => {
    expect(curtainKeyStep(0.5, "ArrowRight")).toBeCloseTo(0.52, 10);
    expect(curtainKeyStep(0.5, "ArrowLeft")).toBeCloseTo(0.48, 10);
    expect(curtainKeyStep(0.5, "ArrowUp")).toBeCloseTo(0.52, 10);
    expect(curtainKeyStep(0.5, "ArrowDown")).toBeCloseTo(0.48, 10);
    expect(curtainKeyStep(0.5, "ArrowRight", true)).toBeCloseTo(0.6, 10);
    expect(curtainKeyStep(0.99, "ArrowRight")).toBe(1);
    expect(curtainKeyStep(0.01, "ArrowLeft", true)).toBe(0);
    // Las demas teclas quedan para el control nativo.
    expect(curtainKeyStep(0.5, "Home")).toBeNull();
    expect(curtainKeyStep(0.5, "PageUp")).toBeNull();
    expect(curtainKeyStep(0.5, "a")).toBeNull();
  });
});
