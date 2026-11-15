// @vitest-environment node

// Orientacion de la camara en la ventana al cielo (skyMath.ts, "Cuaterniones").
//
// El telefono se barre por recorridos que pasan por el cenit, el nadir y los
// dos polos celestes, y se comprueba que la orientacion de la camara cambia de
// forma continua: tanto la direccion a la que mira como el giro de la vista.
// Los angulos que entrega el navegador si saltan en esos recorridos (alpha da
// la vuelta, beta pasa de 180 a -180, y con el telefono de canto alpha y gamma
// cambian de golpe): el test lo comprueba, para que no pase por casualidad.

import { describe, expect, it } from "vitest";
import {
  axisQuat,
  DEG,
  type DeviceAngles,
  deviceToScene,
  deviceToSceneQuaternion,
  horizonBasis,
  horizonToSceneQuaternion,
  localSiderealDeg,
  type Quat,
  quatAngle,
  quatMultiply,
  quatPointing,
  quatRotate,
  quatSlerp,
  shortestDelta,
  type Vec3,
  vectorToRaDec,
} from "./skyMath";

/** Buenos Aires: el polo sur celeste queda a 34,6 grados sobre el horizonte sur. */
const observer = { latitude: -34.6, longitude: -58.4 };
const date = new Date(Date.UTC(2026, 10, 15, 23, 30, 0));

function angleBetween(a: Vec3, b: Vec3): number {
  const cosine = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.min(1, Math.max(-1, cosine))) / DEG;
}

function expectVector(actual: Vec3, expected: Vec3, digits = 9): void {
  for (const axis of [0, 1, 2] as const) expect(actual[axis]).toBeCloseTo(expected[axis], digits);
}

/**
 * Angulos que entrega el navegador para una orientacion del telefono, dada como
 * el giro de sus ejes al marco del horizonte (este, norte, cenit).
 *
 * Fuente: W3C, "DeviceOrientation Event Specification", seccion 4.1 y el
 * ejemplo que despeja los angulos de la matriz R = Rz(alpha) Rx(beta)
 * Ry(gamma), con alpha en [0, 360), beta en [-180, 180) y gamma en [-90, 90).
 */
function browserAngles(device: Quat): DeviceAngles {
  const x = quatRotate(device, [1, 0, 0]);
  const y = quatRotate(device, [0, 1, 0]);
  const z = quatRotate(device, [0, 0, 1]);
  // r(fila)(columna) de la matriz cuyas columnas son x, y, z.
  const [r11, r21, r31] = x;
  const [r12, r22, r32] = y;
  const r33 = z[2];
  const tiny = 1e-12;
  const asin = (value: number): number => Math.asin(Math.min(1, Math.max(-1, value)));
  const flipped = (): number => {
    const beta = -asin(r32);
    return beta + (beta >= 0 ? -Math.PI : Math.PI);
  };

  let alpha: number;
  let beta: number;
  let gamma: number;
  if (r33 > tiny) {
    alpha = Math.atan2(-r12, r22);
    beta = asin(r32);
    gamma = Math.atan2(-r31, r33);
  } else if (r33 < -tiny) {
    alpha = Math.atan2(r12, -r22);
    beta = flipped();
    gamma = Math.atan2(r31, -r33);
  } else if (r31 > tiny) {
    alpha = Math.atan2(-r12, r22);
    beta = asin(r32);
    gamma = -Math.PI / 2;
  } else if (r31 < -tiny) {
    alpha = Math.atan2(r12, -r22);
    beta = flipped();
    gamma = -Math.PI / 2;
  } else {
    alpha = Math.atan2(r21, r11);
    beta = r32 > 0 ? Math.PI / 2 : -Math.PI / 2;
    gamma = 0;
  }
  if (alpha < 0) alpha += 2 * Math.PI;
  return { alpha: alpha / DEG, beta: beta / DEG, gamma: gamma / DEG };
}

/**
 * Telefono que recorre el meridiano: `turn = 0` mira al horizonte norte, 90 al
 * cenit, 180 al horizonte sur y 270 al nadir. De paso cruza el polo sur
 * celeste (altura igual a la latitud, sobre el sur) y el polo norte (bajo el
 * horizonte norte). `roll` gira el telefono alrededor de la direccion a la que
 * mira: 0 es vertical y 90, apaisado.
 */
function meridianDevice(turn: number, roll: number): Quat {
  return quatMultiply(axisQuat(0, 90 + turn), axisQuat(2, roll));
}

const STEP = 0.5;

interface Sweep {
  readonly name: string;
  readonly roll: (turn: number) => number;
  readonly screenAngle: number;
}

const SWEEPS: readonly Sweep[] = [
  { name: "telefono vertical", roll: () => 0, screenAngle: 0 },
  { name: "telefono inclinado 37 grados", roll: () => 37, screenAngle: 0 },
  { name: "telefono casi de canto", roll: () => 80, screenAngle: 90 },
  { name: "telefono de canto, con la pantalla apaisada", roll: () => 90, screenAngle: 90 },
  { name: "telefono cabeza abajo", roll: () => 180, screenAngle: 180 },
  { name: "telefono que va girando mientras sube", roll: (turn) => turn / 2, screenAngle: 0 },
];

function cameraAt(sweep: Sweep, turn: number): Quat {
  const angles = browserAngles(meridianDevice(turn, sweep.roll(turn)));
  return deviceToSceneQuaternion(angles, sweep.screenAngle, observer, date);
}

describe("cuaterniones", () => {
  it("el giro del horizonte a la escena lleva este, norte y cenit a sus direcciones", () => {
    const q = horizonToSceneQuaternion(observer, date);
    const basis = horizonBasis(observer, date);
    expectVector(quatRotate(q, [1, 0, 0]), basis.east);
    expectVector(quatRotate(q, [0, 1, 0]), basis.north);
    expectVector(quatRotate(q, [0, 0, 1]), basis.up);
  });

  it("la orientacion de la camara coincide con la cuenta hecha con matrices", () => {
    for (const alpha of [0, 73, 180, 291]) {
      for (const beta of [-170, -90, -20, 0, 45, 90, 135, 179]) {
        for (const gamma of [-90, -60, 0, 33, 89]) {
          for (const screenAngle of [0, 90, 180, 270]) {
            const angles = { alpha, beta, gamma };
            const camera = quatPointing(
              deviceToSceneQuaternion(angles, screenAngle, observer, date),
            );
            const reference = deviceToScene(angles, screenAngle, observer, date);
            expectVector(camera.forward, reference.forward);
            expectVector(camera.up, reference.up);
          }
        }
      }
    }
  });

  it("interpolar con la misma orientacion escrita con el signo opuesto no gira nada", () => {
    const q = deviceToSceneQuaternion({ alpha: 40, beta: 120, gamma: -30 }, 0, observer, date);
    const negated: Quat = [-q[0], -q[1], -q[2], -q[3]];
    expect(quatAngle(q, quatSlerp(q, negated, 0.5))).toBeLessThan(1e-6);
  });

  it("interpola a velocidad angular constante por el giro mas corto", () => {
    const from = axisQuat(1, 10);
    const to = axisQuat(1, 250);
    // De 10 a 250 grados el camino corto es de 120 grados, hacia atras.
    expect(quatAngle(from, to)).toBeCloseTo(120, 9);
    expect(quatAngle(from, quatSlerp(from, to, 0.25))).toBeCloseTo(30, 9);
    expect(quatAngle(quatSlerp(from, to, 0.25), axisQuat(1, -20))).toBeLessThan(1e-6);
  });
});

describe("barrido del telefono por el cenit y los polos celestes", () => {
  it("el recorrido pasa por el cenit, el nadir y los dos polos", () => {
    const sweep = SWEEPS[0] as Sweep;
    const lst = localSiderealDeg(date, observer.longitude);
    const lookingAt = (turn: number) => vectorToRaDec(quatPointing(cameraAt(sweep, turn)).forward);

    const zenith = lookingAt(90);
    expect(zenith.dec).toBeCloseTo(observer.latitude, 8);
    expect(shortestDelta(lst, zenith.ra)).toBeCloseTo(0, 8);
    expect(lookingAt(270).dec).toBeCloseTo(-observer.latitude, 8);
    // Polo sur: a 34,6 grados de altura sobre el horizonte sur. Polo norte: igual, bajo el norte.
    // (Cerca de 90 grados la declinacion pierde precision: con 5 decimales es 0,04 segundos de arco.)
    expect(lookingAt(180 - 34.6).dec).toBeCloseTo(-90, 5);
    expect(lookingAt(360 - 34.6).dec).toBeCloseTo(90, 5);
  });

  it("los angulos del navegador saltan en ese recorrido", () => {
    let betaJump = 0;
    let alphaJump = 0;
    for (const sweep of SWEEPS) {
      let previous = browserAngles(meridianDevice(0, sweep.roll(0)));
      for (let turn = STEP; turn <= 360; turn += STEP) {
        const angles = browserAngles(meridianDevice(turn, sweep.roll(turn)));
        betaJump = Math.max(betaJump, Math.abs(angles.beta - previous.beta));
        alphaJump = Math.max(alphaJump, Math.abs(shortestDelta(previous.alpha, angles.alpha)));
        previous = angles;
      }
    }
    expect(betaJump).toBeGreaterThan(300);
    expect(alphaJump).toBeGreaterThan(170);
  });

  for (const sweep of SWEEPS) {
    it(`la camara gira de forma continua: ${sweep.name}`, () => {
      const horizon = horizonToSceneQuaternion(observer, date);
      let previous = cameraAt(sweep, 0);
      let largest = 0;
      for (let turn = STEP; turn <= 360; turn += STEP) {
        const camera = cameraAt(sweep, turn);

        // 1. Es la orientacion que tiene el telefono, mire adonde mire.
        const expected = quatMultiply(
          quatMultiply(horizon, meridianDevice(turn, sweep.roll(turn))),
          axisQuat(2, -sweep.screenAngle),
        );
        expect(quatAngle(camera, expected)).toBeLessThan(1e-5);

        // 2. Entre dos pasos la camara gira lo mismo que el telefono, sin saltos:
        //    la direccion a la que mira y el arriba de la vista se mueven a lo
        //    sumo un paso (y medio paso mas si el telefono ademas va girando).
        const before = quatPointing(previous);
        const after = quatPointing(camera);
        const limit = STEP * 1.5 + 1e-6;
        expect(angleBetween(before.forward, after.forward)).toBeLessThan(STEP + 1e-6);
        expect(angleBetween(before.up, after.up)).toBeLessThan(limit);
        expect(quatAngle(previous, camera)).toBeLessThan(limit);

        largest = Math.max(largest, quatAngle(previous, camera));
        previous = camera;
      }
      // Y gira de verdad: no se queda clavada en ningun tramo.
      expect(largest).toBeGreaterThan(STEP * 0.99);
    });
  }

  it("el suavizado sigue al telefono sin saltos y termina donde termina el telefono", () => {
    // El mismo filtro de la escena: en cada cuadro la camara recorre una fraccion
    // de lo que le falta, interpolando cuaterniones.
    const blend = 0.2;
    for (const sweep of SWEEPS) {
      let camera = cameraAt(sweep, 0);
      let target = camera;
      for (let turn = STEP; turn <= 360; turn += STEP) {
        target = cameraAt(sweep, turn);
        const next = quatSlerp(camera, target, blend);
        // Nunca gira mas rapido que el telefono.
        expect(quatAngle(camera, next)).toBeLessThan(STEP * 1.5 + 1e-6);
        // Y no se atrasa mas que unos pocos pasos, ni siquiera al cruzar un polo.
        expect(quatAngle(next, target)).toBeLessThan((STEP * 1.5) / blend);
        camera = next;
      }
      for (let frame = 0; frame < 80; frame += 1) camera = quatSlerp(camera, target, blend);
      expect(quatAngle(camera, target)).toBeLessThan(1e-4);
    }
  });
});
