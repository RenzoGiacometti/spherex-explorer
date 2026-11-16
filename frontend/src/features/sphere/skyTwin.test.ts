// @vitest-environment node

// El salto de 12 horas de la ventana al cielo, con las lecturas tomadas en un
// Android real con `?debug=1` (15 de noviembre de 2026, 21:28 de Buenos Aires).
//
// Con el telefono apuntando al cielo, a unos 44 grados de altura hacia el
// sudeste, el navegador entrego para la misma postura dos ternas distintas:
//
//   la que corresponde:  alfa 222,9  beta 134,4  gamma -3,9  (centro 04h 24m, -59,8)
//   la invertida:        alfa 222,9  beta -45,6  gamma  3,9  (centro 16h 24m, +59,8)
//
// Las dos describen orientaciones que difieren en media vuelta exacta alrededor
// del eje x del telefono: la camara pasa a mirar al punto opuesto del cielo, y
// la RA del centro cambia 12 horas con la Dec cambiada de signo. No es el cruce
// del polo celeste: ahi la Dec no cambia de signo.

import { describe, expect, it } from "vitest";
import {
  angularSeparation,
  axisQuat,
  cameraInScene,
  createOrientationGate,
  createTwinResolver,
  type DeviceAngles,
  deviceToHorizonQuaternion,
  followOrientation,
  type Quat,
  quatAngle,
  quatMultiply,
  quatPointing,
  type SkyPosition,
  shortestDelta,
  vectorToRaDec,
} from "./skyMath";

/** Donde y cuando se tomaron las capturas. */
const observer = { latitude: -34.6, longitude: -58.4 };
const date = new Date(Date.UTC(2026, 10, 16, 0, 28, 30));

/** Lectura de la primera captura: la camara la siguio y quedo mirando bajo el horizonte. */
const CAPTURE_A: DeviceAngles = { alpha: 223.3, beta: -40.8, gamma: 5.2 };
const CENTER_A: SkyPosition = { ra: 15 * (15 + 45 / 60 + 12 / 3600), dec: 60 + 28 / 60 };
/** Lectura de la segunda captura: invertida, con la camara todavia en la postura real. */
const CAPTURE_B: DeviceAngles = { alpha: 222.9, beta: -45.6, gamma: 3.9 };
const CENTER_B: SkyPosition = { ra: 15 * (4 + 24 / 60 + 29 / 3600), dec: -(59 + 50 / 60) };
/** La misma postura de la segunda captura, como la entrega el navegador cuando no la invierte. */
const TRUE_B: DeviceAngles = { alpha: 222.9, beta: 134.4, gamma: -3.9 };

function device(angles: DeviceAngles): Quat {
  return deviceToHorizonQuaternion(angles, 0);
}

function center(camera: Quat): SkyPosition {
  return vectorToRaDec(quatPointing(camera).forward);
}

/** Lo que hace la ventana al cielo con una serie de lecturas (useSkyWindow.ts y SkyScene.ts). */
function follow(readings: readonly DeviceAngles[], resolveTwins: boolean) {
  const resolve = createTwinResolver();
  const gate = createOrientationGate();
  let camera: Quat | null = null;
  let flipped = 0;
  let largestStep = 0;
  for (const angles of readings) {
    let orientation = device(angles);
    if (resolveTwins) {
      const resolved = resolve(orientation);
      if (resolved.flipped) flipped += 1;
      orientation = resolved.orientation;
    }
    const target = gate(cameraInScene(orientation, 0, observer, date)).orientation;
    if (camera === null) camera = target;
    for (let frame = 0; frame < 3; frame += 1) {
      const next: Quat = followOrientation(camera, target, 1 / 60);
      largestStep = Math.max(largestStep, quatAngle(camera, next));
      camera = next;
    }
  }
  if (camera === null) throw new Error("sin lecturas");
  // Unos cuadros mas, hasta que la camara termina de llegar.
  return { center: center(camera), flipped, largestStep };
}

const times = <T>(count: number, value: T): T[] => Array.from({ length: count }, () => value);

describe("lecturas del Android: la misma postura, informada de dos maneras", () => {
  it("la cuenta reproduce los centros que mostraba el telefono", () => {
    // Captura A: la camara habia seguido a la lectura invertida.
    const shownA = center(cameraInScene(device(CAPTURE_A), 0, observer, date));
    expect(angularSeparation(shownA, CENTER_A)).toBeLessThan(1.5);
    // Captura B: la camara seguia en la postura real, que es la lectura con beta + 180 y -gamma.
    const shownB = center(cameraInScene(device(TRUE_B), 0, observer, date));
    expect(angularSeparation(shownB, CENTER_B)).toBeLessThan(1.5);
  });

  it("las dos ternas difieren en media vuelta exacta alrededor del eje x del telefono", () => {
    const turned = quatMultiply(device(CAPTURE_B), axisQuat(0, 180));
    expect(quatAngle(turned, device(TRUE_B))).toBeLessThan(1e-4);
    expect(quatAngle(device(CAPTURE_B), device(TRUE_B))).toBeCloseTo(180, 4);
  });

  it("la invertida mira al punto opuesto: 12 horas de RA y la Dec con el otro signo", () => {
    const real = center(cameraInScene(device(TRUE_B), 0, observer, date));
    const inverted = center(cameraInScene(device(CAPTURE_B), 0, observer, date));
    // El arco coseno pierde precision cerca de 0 y de 180: cuatro decimales alcanzan.
    expect(Math.abs(shortestDelta(real.ra, inverted.ra))).toBeCloseTo(180, 4);
    expect(inverted.dec).toBeCloseTo(-real.dec, 4);
    expect(angularSeparation(real, inverted)).toBeCloseTo(180, 4);
  });
});

describe("el salto de 12 horas", () => {
  const readings = [...times(4, TRUE_B), ...times(4, CAPTURE_B), ...times(4, TRUE_B)];

  it("sin resolver la inversion, la vista se va al punto opuesto (el defecto)", () => {
    // La compuerta retiene la primera lectura invertida y acepta la segunda.
    const upTo = follow(readings.slice(0, 8), false);
    const real = center(cameraInScene(device(TRUE_B), 0, observer, date));
    // Va camino al punto opuesto: ya se alejo mas de 90 grados, a mas de 30 por cuadro.
    expect(angularSeparation(upTo.center, real)).toBeGreaterThan(90);
    expect(upTo.largestStep).toBeGreaterThan(30);
  });

  it("resolviendola, la vista no se mueve", () => {
    const trace = follow(readings, true);
    const real = center(cameraInScene(device(TRUE_B), 0, observer, date));
    expect(angularSeparation(trace.center, real)).toBeLessThan(0.01);
    expect(trace.largestStep).toBeLessThan(0.01);
    expect(trace.flipped).toBe(4);
  });

  it("si la serie empieza por la invertida, pasa a la que mira al cielo y ahi se queda", () => {
    const trace = follow(
      [...times(3, CAPTURE_B), ...times(6, TRUE_B), ...times(3, CAPTURE_B), ...times(30, TRUE_B)],
      true,
    );
    const real = center(cameraInScene(device(TRUE_B), 0, observer, date));
    expect(angularSeparation(trace.center, real)).toBeLessThan(0.5);
  });
});

describe("lo que no es una inversion queda como llega", () => {
  it("bajar el telefono de a poco hasta mirar al piso no se toca", () => {
    const resolve = createTwinResolver();
    for (let beta = 150; beta >= 20; beta -= 2) {
      const reading = device({ alpha: 222.9, beta, gamma: -3.9 });
      const resolved = resolve(reading);
      expect(resolved.flipped).toBe(false);
      expect(quatAngle(resolved.orientation, reading)).toBeLessThan(1e-4);
    }
  });

  it("una media vuelta alrededor de otro eje no se confunde con la inversion", () => {
    const resolve = createTwinResolver();
    resolve(device(TRUE_B));
    // Alfa girado 180 grados: otra orientacion, que no es la gemela.
    const other = device({ ...TRUE_B, alpha: TRUE_B.alpha + 180 });
    const resolved = resolve(other);
    expect(resolved.flipped).toBe(false);
    expect(quatAngle(resolved.orientation, other)).toBeLessThan(1e-4);
  });
});
