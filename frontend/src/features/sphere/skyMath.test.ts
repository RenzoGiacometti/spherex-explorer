// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  altAzToRaDec,
  angularSeparation,
  deviceToHorizon,
  greenwichSiderealDeg,
  horizonBasis,
  localSiderealDeg,
  raDecToTextureUv,
  raDecToVector,
  shortestDelta,
  slerpDirection,
  textureUvToRaDec,
  type Vec3,
  vectorToRaDec,
} from "./skyMath";

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function expectVector(actual: Vec3, expected: Vec3): void {
  for (const axis of [0, 1, 2] as const) expect(actual[axis]).toBeCloseTo(expected[axis], 9);
}

describe("sistema de la escena", () => {
  it("pone RA 0h en +X, el polo norte en +Y y RA 6h en -Z", () => {
    expectVector(raDecToVector(0, 0), [1, 0, 0]);
    expectVector(raDecToVector(0, 90), [0, 1, 0]);
    expectVector(raDecToVector(90, 0), [0, 0, -1]);
  });

  it("visto desde adentro con el norte arriba, el este queda a la izquierda", () => {
    for (const [ra, dec] of [
      [0, 0],
      [133.76, -7.24],
      [269.45, 4.77],
      [248.17, 66.76],
    ] as const) {
      const forward = raDecToVector(ra, dec);
      // Derecha de la camara de three.js: adelante x arriba.
      const right = cross(forward, [0, 1, 0]);
      const east = raDecToVector(ra + 1, dec);
      const north = raDecToVector(ra, dec + 1);
      expect(dot(east, right)).toBeLessThan(0);
      expect(dot(north, [0, 1, 0])).toBeGreaterThan(dot(forward, [0, 1, 0]));
    }
  });

  it("vuelve de vector a coordenadas", () => {
    for (const [ra, dec] of [
      [0, 0],
      [76.9566, 30.4013],
      [331.0966, -56.8006],
      [359.9, 89],
    ] as const) {
      const back = vectorToRaDec(raDecToVector(ra, dec));
      expect(back.ra).toBeCloseTo(ra, 8);
      expect(back.dec).toBeCloseTo(dec, 8);
    }
  });

  it("mide separaciones y diferencias de angulo por el camino corto", () => {
    expect(angularSeparation({ ra: 10, dec: 0 }, { ra: 350, dec: 0 })).toBeCloseTo(20, 9);
    expect(angularSeparation({ ra: 0, dec: 90 }, { ra: 123, dec: 0 })).toBeCloseTo(90, 9);
    expect(shortestDelta(350, 10)).toBeCloseTo(20, 9);
    expect(shortestDelta(10, 350)).toBeCloseTo(-20, 9);
  });

  it("interpola por el circulo maximo", () => {
    const from = raDecToVector(0, 0);
    const to = raDecToVector(90, 0);
    const middle = vectorToRaDec(slerpDirection(from, to, 0.5));
    expect(middle.ra).toBeCloseTo(45, 9);
    expect(middle.dec).toBeCloseTo(0, 9);
    expectVector(slerpDirection(from, to, 0), from);
    expectVector(slerpDirection(from, to, 1), to);
  });
});

describe("textura equirrectangular de NASA SVS", () => {
  it("esta centrada en RA 0h y la ascension recta crece hacia la izquierda", () => {
    expect(raDecToTextureUv(0, 0)).toEqual([0.5, 0.5]);
    expect(raDecToTextureUv(90, 0)[0]).toBeCloseTo(0.25, 12);
    expect(raDecToTextureUv(270, 0)[0]).toBeCloseTo(0.75, 12);
    expect(raDecToTextureUv(179, 0)[0]).toBeLessThan(0.01);
    expect(raDecToTextureUv(181, 0)[0]).toBeGreaterThan(0.99);
  });

  it("tiene el norte arriba: v = 1 es el polo norte", () => {
    expect(raDecToTextureUv(0, 90)[1]).toBe(1);
    expect(raDecToTextureUv(0, -90)[1]).toBe(0);
  });

  it("la malla y los marcadores usan la misma convencion", () => {
    for (const [u, v] of [
      [0.1, 0.2],
      [0.5, 0.5],
      [0.93, 0.81],
    ] as const) {
      const { ra, dec } = textureUvToRaDec(u, v);
      const [backU, backV] = raDecToTextureUv(ra, dec);
      expect(backU).toBeCloseTo(u, 12);
      expect(backV).toBeCloseTo(v, 12);
    }
  });
});

describe("tiempo sidereo", () => {
  // J. Meeus, "Astronomical Algorithms", ejemplos 12.a y 12.b.
  it("coincide con los ejemplos de Meeus", () => {
    // 1987-04-10 0h UT: 13h 10m 46,3668s.
    expect(greenwichSiderealDeg(new Date(Date.UTC(1987, 3, 10)))).toBeCloseTo(197.693195, 5);
    // 1987-04-10 19h 21m 00s UT: 8h 34m 57,0896s.
    expect(greenwichSiderealDeg(new Date(Date.UTC(1987, 3, 10, 19, 21, 0)))).toBeCloseTo(
      128.737873,
      5,
    );
  });

  it("suma la longitud hacia el este", () => {
    const date = new Date(Date.UTC(2026, 10, 15, 3, 0, 0));
    const greenwich = greenwichSiderealDeg(date);
    expect(shortestDelta(greenwich, localSiderealDeg(date, -58.38))).toBeCloseTo(-58.38, 9);
  });
});

describe("horizonte local", () => {
  const date = new Date(Date.UTC(2026, 10, 15, 3, 0, 0));
  const observer = { latitude: -34.6, longitude: -58.38 };
  const lst = localSiderealDeg(date, observer.longitude);

  it("el cenit esta en Dec = latitud y RA = tiempo sidereo local", () => {
    const zenith = altAzToRaDec(90, 0, observer, date);
    expect(zenith.dec).toBeCloseTo(observer.latitude, 8);
    expect(shortestDelta(lst, zenith.ra)).toBeCloseTo(0, 8);
  });

  it("el polo queda sobre el meridiano, a una altura igual a la latitud", () => {
    // En el hemisferio sur, el polo sur celeste esta hacia el sur (azimut 180).
    expect(altAzToRaDec(34.6, 180, observer, date).dec).toBeCloseTo(-90, 6);
    expect(altAzToRaDec(50, 0, { latitude: 50, longitude: 10 }, date).dec).toBeCloseTo(90, 6);
  });

  it("el este del horizonte es el punto del ecuador que esta saliendo", () => {
    const east = altAzToRaDec(0, 90, observer, date);
    expect(east.dec).toBeCloseTo(0, 8);
    expect(shortestDelta(lst, east.ra)).toBeCloseTo(90, 8);
  });

  it("la terna este, norte, cenit es ortonormal y derecha", () => {
    const { east, north, up } = horizonBasis(observer, date);
    expect(dot(east, north)).toBeCloseTo(0, 12);
    expect(dot(east, up)).toBeCloseTo(0, 12);
    expectVector(cross(east, north), up);
  });

  it("reproduce el ejemplo 13.b de Meeus (Venus desde Washington)", () => {
    // 1987-04-10 19:21 UT, longitud 77 03 56 O, latitud 38 55 17 N.
    // Meeus da el azimut 68,0337 desde el sur hacia el oeste: 248,0337 desde el norte.
    const position = altAzToRaDec(
      15.1249,
      248.0337,
      { latitude: 38.92139, longitude: -77.06556 },
      new Date(Date.UTC(1987, 3, 10, 19, 21, 0)),
    );
    // RA 23h 09m 16,641s, Dec -6 43 11,61. Meeus usa el tiempo sidereo aparente; aca va el medio.
    expect(position.ra).toBeCloseTo(347.3193, 1);
    expect(position.dec).toBeCloseTo(-6.7199, 1);
    expect(angularSeparation(position, { ra: 347.3193, dec: -6.7199 })).toBeLessThan(0.02);
  });
});

describe("orientacion del telefono", () => {
  it("apoyado en una mesa con el borde superior al norte, la camara mira al piso", () => {
    const { forward, up } = deviceToHorizon({ alpha: 0, beta: 0, gamma: 0 });
    expectVector(forward, [0, 0, -1]);
    expectVector(up, [0, 1, 0]);
  });

  it("parado frente al norte, la camara mira al norte y arriba es el cenit", () => {
    const { forward, up } = deviceToHorizon({ alpha: 0, beta: 90, gamma: 0 });
    expectVector(forward, [0, 1, 0]);
    expectVector(up, [0, 0, 1]);
  });

  it("alpha crece al girar en sentido antihorario: con 90 la camara mira al oeste", () => {
    const { forward, up } = deviceToHorizon({ alpha: 90, beta: 90, gamma: 0 });
    expectVector(forward, [-1, 0, 0]);
    expectVector(up, [0, 0, 1]);
  });

  it("inclinado hacia atras 45 grados, mira 45 grados sobre el horizonte", () => {
    const { forward } = deviceToHorizon({ alpha: 0, beta: 135, gamma: 0 });
    expectVector(forward, [0, Math.SQRT1_2, Math.SQRT1_2]);
  });

  it("con la pantalla apaisada, arriba es el borde derecho del telefono", () => {
    // Telefono de canto, girado 90 grados en sentido antihorario: el borde superior
    // apunta al norte, el derecho al cenit y la pantalla mira al oeste.
    const { forward, up } = deviceToHorizon({ alpha: 0, beta: 0, gamma: -90 }, 90);
    expectVector(forward, [1, 0, 0]);
    expectVector(up, [0, 0, 1]);
  });
});
