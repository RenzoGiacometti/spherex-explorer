import { describe, expect, it } from "vitest";
import { PRECOMPUTED_OBJECTS } from "@/features/entry/featured";
import { angularDistanceDeg, nearestField } from "./nearestField";

describe("angularDistanceDeg", () => {
  it("mide sobre un meridiano y sobre el ecuador", () => {
    expect(angularDistanceDeg({ ra: 10, dec: 0 }, { ra: 10, dec: 25 })).toBeCloseTo(25, 9);
    expect(angularDistanceDeg({ ra: 10, dec: 0 }, { ra: 40, dec: 0 })).toBeCloseTo(30, 9);
  });

  it("cruza el meridiano cero por el camino corto", () => {
    expect(angularDistanceDeg({ ra: 359, dec: 0 }, { ra: 1, dec: 0 })).toBeCloseTo(2, 9);
  });

  it("achica la diferencia de ascension recta con el coseno de la declinacion", () => {
    // A 60 grados de declinacion, un grado de ascension recta es medio grado de cielo.
    expect(angularDistanceDeg({ ra: 100, dec: 60 }, { ra: 101, dec: 60 })).toBeCloseTo(0.5, 4);
  });

  it("de polo a polo hay 180 grados", () => {
    expect(angularDistanceDeg({ ra: 0, dec: 90 }, { ra: 200, dec: -90 })).toBeCloseTo(180, 9);
  });
});

describe("nearestField", () => {
  const fields = [
    { id: "a", ra: 10, dec: 0 },
    { id: "b", ra: 50, dec: 0 },
    { id: "c", ra: 350, dec: 0 },
  ];

  it("elige el de menor separacion angular, tambien a traves del meridiano cero", () => {
    expect(nearestField({ ra: 20, dec: 0 }, fields)?.field.id).toBe("a");
    expect(nearestField({ ra: 359, dec: 0 }, fields)?.field.id).toBe("c");
    expect(nearestField({ ra: 2, dec: 0 }, fields)?.field.id).toBe("a");
    expect(nearestField({ ra: 20, dec: 0 }, fields)?.distanceDeg).toBeCloseTo(10, 9);
  });

  it("no ofrece el campo que tiene ese mismo centro", () => {
    const nearest = nearestField({ ra: 10, dec: 0 }, fields);
    expect(nearest?.field.id).toBe("c");
    expect(nearest?.distanceDeg).toBeCloseTo(20, 9);
  });

  it("sin campos no hay nada que ofrecer", () => {
    expect(nearestField({ ra: 10, dec: 0 }, [])).toBeNull();
    expect(nearestField({ ra: 10, dec: 0 }, [{ ra: 10, dec: 0 }])).toBeNull();
  });

  it("cerca de M 42 ofrece M 42, y desde M 42, M 1", () => {
    // Un punto a 6 minutos de arco al norte del centro de M 42.
    const near = nearestField({ ra: 83.8201, dec: -5.2876 }, PRECOMPUTED_OBJECTS);
    expect(near?.field.id).toBe("m-42");
    expect(near?.distanceDeg).toBeCloseTo(0.1, 6);
    // Desde el campo guardado de M 42 el mas cercano es otro: M 1, a 27,4 grados.
    const other = nearestField({ ra: 83.8201, dec: -5.3876 }, PRECOMPUTED_OBJECTS);
    expect(other?.field.id).toBe("m-1");
    expect(other?.distanceDeg).toBeCloseTo(27.4, 1);
  });
});
