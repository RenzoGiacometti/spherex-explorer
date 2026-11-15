// @vitest-environment node

// Ventana al cielo apuntando al cenit: la pantalla mira hacia abajo, beta esta
// cerca de 180 grados y los angulos del navegador saltan de un extremo al otro
// del rango aunque el telefono casi no se mueva. Aca se comprueba, con las
// mismas funciones que usa la aplicacion (useSkyWindow.ts y SkyScene.ts), que
// la vista no salta: lecturas a cuaternion, compuerta y filtro de seguimiento.

import { describe, expect, it } from "vitest";
import {
  axisQuat,
  createOrientationGate,
  DEG,
  type DeviceAngles,
  deviceToSceneQuaternion,
  followOrientation,
  horizonBasis,
  type Quat,
  quatAngle,
  quatMultiply,
  quatPointing,
  quatRotate,
  type Vec3,
} from "./skyMath";

const observer = { latitude: -34.6, longitude: -58.4 };
const date = new Date(Date.UTC(2026, 10, 15, 23, 30, 0));
const zenith = horizonBasis(observer, date).up;

/** Cuadros que la escena dibuja entre dos lecturas del sensor. */
const FRAMES_PER_READING = 3;
const FRAME_SECONDS = 1 / 60;

function angleBetween(a: Vec3, b: Vec3): number {
  const cosine = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.min(1, Math.max(-1, cosine))) / DEG;
}

function negate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], -q[3]];
}

/**
 * Angulos que entrega el navegador para una orientacion del telefono (W3C,
 * "DeviceOrientation Event Specification", seccion 4.1): alpha en [0, 360),
 * beta en [-180, 180) y gamma en [-90, 90). Con la pantalla hacia abajo vale la
 * rama del coseno de beta negativo.
 */
function browserAngles(device: Quat): DeviceAngles {
  const x = quatRotate(device, [1, 0, 0]);
  const y = quatRotate(device, [0, 1, 0]);
  const z = quatRotate(device, [0, 0, 1]);
  const asin = (value: number): number => Math.asin(Math.min(1, Math.max(-1, value)));
  let alpha: number;
  let beta: number;
  let gamma: number;
  if (z[2] > 0) {
    alpha = Math.atan2(-y[0], y[1]);
    beta = asin(y[2]);
    gamma = Math.atan2(-x[2], z[2]);
  } else {
    alpha = Math.atan2(y[0], -y[1]);
    beta = -asin(y[2]);
    beta += beta >= 0 ? -Math.PI : Math.PI;
    gamma = Math.atan2(x[2], -z[2]);
  }
  if (alpha < 0) alpha += 2 * Math.PI;
  return { alpha: alpha / DEG, beta: beta / DEG, gamma: gamma / DEG };
}

interface Trace {
  /** Mayor giro de la direccion de la vista entre dos cuadros, en grados. */
  readonly largestStep: number;
  /** Mayor distancia de la vista al cenit, en grados. */
  readonly farthest: number;
  /** Lecturas que la compuerta retuvo. */
  readonly held: number;
  readonly last: Quat;
}

/** Lo que hace la aplicacion con una secuencia de orientaciones del sensor. */
function follow(targets: readonly Quat[]): Trace {
  const gate = createOrientationGate();
  let camera: Quat | null = null;
  let largestStep = 0;
  let farthest = 0;
  let held = 0;
  for (const reading of targets) {
    const gated = gate(reading);
    if (gated.held) held += 1;
    // Primer dato del sensor: la camara lo toma sin transicion (SkyScene.setFreeOrientation).
    if (camera === null) camera = gated.orientation;
    for (let frame = 0; frame < FRAMES_PER_READING; frame += 1) {
      const next: Quat = followOrientation(camera, gated.orientation, FRAME_SECONDS);
      largestStep = Math.max(
        largestStep,
        angleBetween(quatPointing(camera).forward, quatPointing(next).forward),
      );
      farthest = Math.max(farthest, angleBetween(quatPointing(next).forward, zenith));
      camera = next;
    }
  }
  return { largestStep, farthest, held, last: camera ?? targets[0] ?? [0, 0, 0, 1] };
}

function cameraFor(angles: DeviceAngles, screenAngle = 0): Quat {
  return deviceToSceneQuaternion(angles, screenAngle, observer, date);
}

describe("apuntando al cenit, beta cruza 180 grados", () => {
  it("con lecturas escritas a mano, la vista se mueve de a poco y no se va del cenit", () => {
    // El telefono pasa por el cenit de norte a sur: beta sube hasta 180 y sigue desde -180.
    const readings: DeviceAngles[] = [
      { alpha: 30, beta: 174, gamma: 1.5 },
      { alpha: 30, beta: 176, gamma: 1.2 },
      { alpha: 30.2, beta: 178, gamma: 0.8 },
      { alpha: 30.1, beta: 179.6, gamma: 0.4 },
      { alpha: 30, beta: -179.7, gamma: 0.1 },
      { alpha: 29.9, beta: -178, gamma: -0.3 },
      { alpha: 30, beta: -176, gamma: -0.6 },
      { alpha: 30, beta: -174, gamma: -1 },
      // Y vuelve.
      { alpha: 30, beta: -177, gamma: -0.5 },
      { alpha: 30, beta: 179.9, gamma: 0 },
      { alpha: 30, beta: 177, gamma: 0.5 },
    ];
    const targets = readings.map((angles) => cameraFor(angles));

    // Entre dos lecturas la orientacion cambia unos grados, aunque beta salte 360.
    for (let index = 1; index < targets.length; index += 1) {
      expect(quatAngle(targets[index - 1] as Quat, targets[index] as Quat)).toBeLessThan(4);
    }
    const trace = follow(targets);
    expect(trace.largestStep).toBeLessThan(3);
    expect(trace.farthest).toBeLessThan(7);
    expect(trace.held).toBe(0);
  });

  it("dando vueltas alrededor del cenit con el telefono girando, tampoco salta", () => {
    // La direccion describe un cono de 3 grados alrededor del cenit mientras el
    // telefono gira sobre si mismo: alpha da varias vueltas y beta cruza 180
    // cuatro veces por vuelta.
    const targets: Quat[] = [];
    let betaJump = 0;
    let previous: DeviceAngles | null = null;
    for (let step = 0; step <= 720; step += 1) {
      const around = step * 2;
      const tilt = quatMultiply(
        quatMultiply(axisQuat(2, around), axisQuat(0, 3)),
        axisQuat(2, -around),
      );
      // Boca abajo (beta = 180) y girado `step` grados alrededor de la direccion a la que mira.
      const device = quatMultiply(tilt, quatMultiply(axisQuat(0, 180), axisQuat(2, step)));
      const angles = browserAngles(device);
      if (previous !== null) betaJump = Math.max(betaJump, Math.abs(angles.beta - previous.beta));
      previous = angles;
      targets.push(cameraFor(angles));
    }
    // El recorrido sirve de prueba: beta salta de un extremo al otro del rango.
    expect(betaJump).toBeGreaterThan(340);

    const trace = follow(targets);
    expect(trace.largestStep).toBeLessThan(3);
    expect(trace.farthest).toBeLessThan(4);
    expect(trace.held).toBe(0);
  });

  it("con la pantalla apaisada o cabeza abajo da la misma direccion", () => {
    const angles = { alpha: 30, beta: -179.7, gamma: 0.1 };
    const upright = quatPointing(cameraFor(angles, 0)).forward;
    for (const screenAngle of [90, 180, 270]) {
      const turned = quatPointing(cameraFor(angles, screenAngle)).forward;
      // El arco coseno pierde precision cerca de cero: una diezmilesima de grado alcanza.
      expect(angleBetween(upright, turned)).toBeLessThan(1e-4);
    }
  });
});

describe("cuaterniones consecutivos de signo opuesto", () => {
  it("el mismo giro lento, con el signo alternado, no mueve la vista de mas", () => {
    // Un grado por lectura alrededor del cenit, y una lectura si y otra no con
    // el cuaternion negado: es la misma orientacion.
    const plain: Quat[] = [];
    for (let step = 0; step <= 120; step += 1) {
      plain.push(
        cameraFor(browserAngles(quatMultiply(axisQuat(0, 175 + step / 12), axisQuat(2, step)))),
      );
    }
    const alternating = plain.map((q, index) => (index % 2 === 0 ? q : negate(q)));

    const expected = follow(plain);
    const trace = follow(alternating);
    expect(trace.held).toBe(0);
    expect(trace.largestStep).toBeLessThan(2);
    expect(trace.largestStep).toBeCloseTo(expected.largestStep, 9);
    // Termina en la misma orientacion que sin los cambios de signo.
    expect(quatAngle(trace.last, expected.last)).toBeLessThan(1e-6);
  });

  it("seguir a la misma orientacion con el signo cambiado no gira nada", () => {
    const q = cameraFor({ alpha: 200, beta: 179.5, gamma: -2 });
    expect(quatAngle(q, followOrientation(q, negate(q), FRAME_SECONDS))).toBeLessThan(1e-6);
    expect(quatAngle(negate(q), followOrientation(negate(q), q, 0.5))).toBeLessThan(1e-6);
  });
});

describe("compuerta contra lecturas sueltas", () => {
  const steady = cameraFor({ alpha: 30, beta: 179, gamma: 1 });
  const nearby = cameraFor({ alpha: 30, beta: -179, gamma: 1 });
  // Una lectura disparatada: el promedio de 179 y -179 hecho como numeros, que apunta al piso.
  const opposite = cameraFor({ alpha: 30, beta: 0, gamma: 1 });

  it("una lectura suelta hacia el lado opuesto no llega a la camara", () => {
    const trace = follow([steady, steady, opposite, nearby, nearby, nearby]);
    expect(trace.held).toBe(1);
    expect(trace.largestStep).toBeLessThan(2);
    expect(trace.farthest).toBeLessThan(3);
  });

  it("sin la compuerta, esa misma lectura se lleva la vista decenas de grados", () => {
    let camera = steady;
    let largest = 0;
    for (const target of [steady, opposite, nearby]) {
      for (let frame = 0; frame < FRAMES_PER_READING; frame += 1) {
        const next = followOrientation(camera, target, FRAME_SECONDS);
        largest = Math.max(largest, quatAngle(camera, next));
        camera = next;
      }
    }
    expect(largest).toBeGreaterThan(20);
  });

  it("un giro de verdad se acepta con la lectura siguiente", () => {
    const gate = createOrientationGate();
    expect(gate(steady).held).toBe(false);
    // La pantalla giro: 90 grados de golpe, y las lecturas siguientes lo confirman.
    const turned = cameraFor({ alpha: 30, beta: 179, gamma: 1 }, 90);
    expect(gate(turned).held).toBe(true);
    const confirmed = gate(turned);
    expect(confirmed.held).toBe(false);
    expect(quatAngle(confirmed.orientation, turned)).toBeLessThan(1e-9);
  });

  it("el signo del cuaternion no cuenta como salto", () => {
    const gate = createOrientationGate();
    gate(steady);
    expect(gate(negate(steady)).held).toBe(false);
    expect(gate(negate(nearby)).held).toBe(false);
  });
});
