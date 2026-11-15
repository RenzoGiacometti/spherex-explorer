// @vitest-environment node
//
// Las cuentas de la ficha del objeto (objectFacts.ts). Los valores de
// referencia son los de catalogo de la estrella de Barnard y de Proxima.

import { describe, expect, it } from "vitest";
import {
  compassPoint,
  DEFAULT_SEARCH_RADIUS_ARCSEC,
  estimateDistance,
  isMotionSignificant,
  LIGHT_YEARS_PER_PARSEC,
  lightYearsFromParallax,
  NEARBY_RADIUS_ARCSEC,
  nearestSource,
  objectFacts,
  parsecsFromParallax,
  roundSignificant,
  transverseVelocity,
  typicalParallaxError,
  visibility,
  yearsToCrossMoon,
} from "./objectFacts";
import type { GaiaCatalog } from "./schema";

/** Grilla base del contrato, centrada en el campo de Barnard. */
const GRID = {
  crval: [269.4463, 4.7683] as [number, number],
  crpix: [98, 98] as [number, number],
  cdelt: [-3.075 / 3600, 3.075 / 3600] as [number, number],
};

/** Catalogo de dos fuentes: Barnard (Gaia DR3, epoca 2016,0) y una estrella de fondo sin movimiento medido. */
const CATALOG: GaiaCatalog = {
  catalog: "gaia_dr3_source",
  ref_epoch: 2016,
  count: 2,
  source_id: ["4472832130942575872", "1"],
  ra: [269.4485025, 269.47],
  dec: [4.7398, 4.78],
  pmra: [-801.551, null],
  pmdec: [10362.394, null],
  parallax: [546.976, null],
  g_mag: [8.19, 19.5],
};

describe("distancia a partir de la paralaje", () => {
  it("invierte la paralaje: Barnard esta a 1,83 parsecs, 5,96 anios luz", () => {
    expect(parsecsFromParallax(546.976)).toBeCloseTo(1.8282, 4);
    expect(lightYearsFromParallax(546.976)).toBeCloseTo(5.963, 3);
  });

  it("Proxima, con 768,07 mas, esta a 4,25 anios luz", () => {
    expect(lightYearsFromParallax(768.07)).toBeCloseTo(4.246, 3);
  });

  it("un parsec son 3,2616 anios luz y una paralaje de 1 mas, 3262", () => {
    expect(LIGHT_YEARS_PER_PARSEC).toBeCloseTo(3.26156, 5);
    expect(lightYearsFromParallax(1)).toBeCloseTo(3261.56, 2);
  });

  it("una paralaje nula o negativa no da distancia", () => {
    expect(parsecsFromParallax(0)).toBeNull();
    expect(lightYearsFromParallax(-0.3)).toBeNull();
  });
});

describe("error tipico de la paralaje segun la magnitud", () => {
  it("vale los puntos de referencia de Gaia", () => {
    expect(typicalParallaxError(12)).toBe(0.03);
    expect(typicalParallaxError(15)).toBe(0.03);
    expect(typicalParallaxError(17)).toBeCloseTo(0.07, 10);
    expect(typicalParallaxError(20)).toBeCloseTo(0.5, 10);
    expect(typicalParallaxError(21)).toBe(1.3);
    expect(typicalParallaxError(22)).toBe(1.3);
  });

  it("entre dos puntos crece siempre, interpolando en escala logaritmica", () => {
    expect(typicalParallaxError(16)).toBeCloseTo(Math.sqrt(0.03 * 0.07), 10);
    let previous = 0;
    for (let g = 15; g <= 21; g += 0.25) {
      const error = typicalParallaxError(g);
      expect(error).toBeGreaterThanOrEqual(previous);
      previous = error;
    }
  });

  it("sin magnitud supone la peor", () => {
    expect(typicalParallaxError(null)).toBe(1.3);
  });
});

describe("que se puede decir de la distancia", () => {
  it("una paralaje bien medida da la distancia sin reparos", () => {
    const estimate = estimateDistance(546.976, 8.19);
    expect(estimate.kind).toBe("measured");
    if (estimate.kind === "measured") expect(estimate.lightYears).toBeCloseTo(5.963, 3);
  });

  it("entre 3 y 5 veces el error, la distancia es orientativa", () => {
    // G = 20: error tipico 0,5 mas. Una paralaje de 2 mas son 4 veces el error.
    const estimate = estimateDistance(2, 20);
    expect(estimate.kind).toBe("rough");
    if (estimate.kind === "rough") expect(estimate.lightYears).toBeCloseTo(1630.8, 1);
  });

  it("por debajo de 3 veces el error solo da un piso", () => {
    // 0,5 mas medidos con 0,5 de error: lo mas que puede valer es 0,5 + 3 x 0,5 = 2 mas.
    const estimate = estimateDistance(0.5, 20);
    expect(estimate.kind).toBe("far");
    if (estimate.kind === "far") expect(estimate.beyondLightYears).toBeCloseTo(1630.8, 1);
  });

  it("una paralaje negativa tambien da un piso, calculado desde cero", () => {
    const estimate = estimateDistance(-0.4, 20);
    expect(estimate.kind).toBe("far");
    if (estimate.kind === "far") expect(estimate.beyondLightYears).toBeCloseTo(2174.4, 1);
  });

  it("la misma paralaje vale mas en una estrella brillante", () => {
    // 0,5 mas: en G = 14 son 17 veces el error; en G = 20, una sola.
    expect(estimateDistance(0.5, 14).kind).toBe("measured");
    expect(estimateDistance(0.5, 20).kind).toBe("far");
  });

  it("sin paralaje no hay nada que decir", () => {
    expect(estimateDistance(null, 18)).toEqual({ kind: "none" });
  });
});

describe("movimiento propio", () => {
  it("da el rumbo en ocho direcciones, con el este a 90 grados del norte", () => {
    expect(compassPoint(0, 1)).toBe("n");
    expect(compassPoint(1, 1)).toBe("ne");
    expect(compassPoint(1, 0)).toBe("e");
    expect(compassPoint(1, -1)).toBe("se");
    expect(compassPoint(0, -1)).toBe("s");
    expect(compassPoint(-1, -1)).toBe("sw");
    expect(compassPoint(-1, 0)).toBe("w");
    expect(compassPoint(-1, 1)).toBe("nw");
    expect(compassPoint(0, 0)).toBeNull();
  });

  it("Barnard va hacia el norte: 4,4 grados al oeste del norte", () => {
    expect(compassPoint(-801.551, 10362.394)).toBe("n");
  });

  it("los limites entre rumbos estan a 22,5 grados", () => {
    const at = (degrees: number) =>
      compassPoint(Math.sin((degrees * Math.PI) / 180), Math.cos((degrees * Math.PI) / 180));
    expect(at(22)).toBe("n");
    expect(at(23)).toBe("ne");
    expect(at(-22)).toBe("n");
    expect(at(-23)).toBe("nw");
    expect(at(179)).toBe("s");
  });

  it("Barnard tarda 173 anios en cruzar el ancho de la Luna llena", () => {
    const total = Math.hypot(-801.551, 10362.394);
    expect(total).toBeCloseTo(10393.35, 1);
    expect(yearsToCrossMoon(total)).toBeCloseTo(173.19, 1);
    expect(yearsToCrossMoon(0)).toBeNull();
  });

  it("una estrella comun, con 5 mas por anio, tarda 360 000 anios", () => {
    expect(yearsToCrossMoon(5)).toBeCloseTo(360000, 6);
  });

  it("un movimiento menor que tres veces el error tipico no se distingue de cero", () => {
    // G = 20: error tipico 0,5 mas/anio, asi que hacen falta 1,5.
    expect(isMotionSignificant(1.4, 20)).toBe(false);
    expect(isMotionSignificant(1.6, 20)).toBe(true);
    // La misma fuente en G = 14 (0,03) se distingue con 0,1.
    expect(isMotionSignificant(0.1, 14)).toBe(true);
    expect(isMotionSignificant(0, 14)).toBe(false);
  });

  it("la velocidad transversal de Barnard es de 90 km/s", () => {
    expect(transverseVelocity(10393.35, 1.8282)).toBeCloseTo(90.07, 1);
  });
});

describe("brillo en luz visible", () => {
  it("clasifica por magnitud G", () => {
    expect(visibility(4.5)).toBe("nakedEye");
    expect(visibility(6)).toBe("nakedEye");
    expect(visibility(8.19)).toBe("binoculars");
    expect(visibility(13)).toBe("smallTelescope");
    expect(visibility(19.5)).toBe("largeTelescope");
  });
});

describe("redondeo a cifras significativas", () => {
  it("redondea al orden de magnitud del numero", () => {
    expect(roundSignificant(173.19, 2)).toBe(170);
    expect(roundSignificant(5.963, 2)).toBe(6);
    expect(roundSignificant(1630.8, 2)).toBe(1600);
    expect(roundSignificant(360000, 2)).toBe(360000);
    expect(roundSignificant(0.00456, 2)).toBeCloseTo(0.0046, 10);
    expect(roundSignificant(0, 2)).toBe(0);
  });
});

describe("fuente mas cercana a un clic", () => {
  it("encuentra a Barnard donde estaba en la fecha de la imagen", () => {
    // En 2016,0 Barnard estaba en dec 4,7398; el centro de la grilla (pixel 97) es dec 4,7683.
    const y2016 = 97 + ((4.7398 - 4.7683) * 3600) / 3.075;
    const x2016 =
      97 - ((269.4485025 - 269.4463) * Math.cos((4.7398 * Math.PI) / 180) * 3600) / 3.075;
    const found = nearestSource(CATALOG, GRID, x2016, y2016, 2016);
    expect(found?.index).toBe(0);
    expect(found?.separationArcsec ?? 99).toBeLessThan(0.05);

    // Diez anios despues se movio 103,6" al norte: 33,7 pixeles mas arriba, y ya no esta donde estaba.
    expect(nearestSource(CATALOG, GRID, x2016, y2016, 2026)).toBeNull();
    const later = nearestSource(CATALOG, GRID, x2016 + 2.6, y2016 + 33.7, 2026);
    expect(later?.index).toBe(0);
    expect(later?.separationArcsec ?? 99).toBeLessThan(1);
  });

  it("no devuelve nada si no hay ninguna fuente dentro del radio", () => {
    expect(nearestSource(CATALOG, GRID, 97, 97, 2016)).toBeNull();
    // Un pixel de la grilla base para "la del clic" y tres para "hay otra cerca".
    expect(DEFAULT_SEARCH_RADIUS_ARCSEC).toBeCloseTo(3.075, 10);
    expect(NEARBY_RADIUS_ARCSEC).toBeCloseTo(9.225, 10);
  });

  it("respeta el radio pedido", () => {
    const y = 97 + ((4.7398 - 4.7683) * 3600) / 3.075;
    const x = 97 - ((269.4485025 - 269.4463) * Math.cos((4.7398 * Math.PI) / 180) * 3600) / 3.075;
    // A 2 pixeles (6,15") del lugar: afuera del radio de "la del clic", adentro del de "hay otra cerca".
    expect(nearestSource(CATALOG, GRID, x + 2, y, 2016)).toBeNull();
    const nearby = nearestSource(CATALOG, GRID, x + 2, y, 2016, NEARBY_RADIUS_ARCSEC);
    expect(nearby?.index).toBe(0);
    expect(nearby?.separationArcsec).toBeCloseTo(6.15, 1);
    // A 4 pixeles (12,3") ya no se avisa nada.
    expect(nearestSource(CATALOG, GRID, x + 4, y, 2016, NEARBY_RADIUS_ARCSEC)).toBeNull();
  });
});

describe("datos de la ficha", () => {
  it("junta distancia, movimiento, velocidad y brillo de una fuente bien medida", () => {
    const facts = objectFacts(CATALOG, 0);
    expect(facts.sourceId).toBe("4472832130942575872");
    expect(facts.distance.kind).toBe("measured");
    expect(facts.motion?.total).toBeCloseTo(10393.35, 1);
    expect(facts.motion?.direction).toBe("n");
    expect(facts.motion?.yearsToCrossMoon).toBeCloseTo(173.19, 1);
    expect(facts.motion?.significant).toBe(true);
    expect(facts.transverseKmS).toBeCloseTo(90.07, 1);
    expect(facts.visibility).toBe("binoculars");
  });

  it("una fuente sin paralaje ni movimiento medidos deja esos datos vacios", () => {
    const facts = objectFacts(CATALOG, 1);
    expect(facts.distance).toEqual({ kind: "none" });
    expect(facts.motion).toBeNull();
    expect(facts.transverseKmS).toBeNull();
    expect(facts.visibility).toBe("largeTelescope");
  });
});
