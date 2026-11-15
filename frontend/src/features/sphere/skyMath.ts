// Geometria del cielo para la esfera de la entrada (SPEC.md, Etapa 4).
//
// Un solo lugar define las tres convenciones de las que depende la
// orientacion, y tanto la malla de la esfera como los marcadores salen de aca:
//
// 1. Sistema de la escena. Es el ecuatorial (ICRS) con los ejes renombrados
//    para three.js, que usa "Y arriba":
//
//      +X  ascension recta 0h, declinacion 0
//      +Y  polo norte celeste
//      -Z  ascension recta 6h, declinacion 0
//
//    Es una rotacion del sistema ecuatorial, sin espejar: X_escena = X_ec,
//    Y_escena = Z_ec, Z_escena = -Y_ec. Por eso, mirando desde el centro con
//    el norte arriba, el este (ascension recta creciente) queda a la
//    izquierda, igual que en el cielo real.
//
// 2. Textura. El mapa estelar de NASA SVS es una proyeccion equirrectangular
//    centrada en ascension recta 0h, con la ascension recta creciendo hacia la
//    izquierda y el norte arriba (assets/FUENTES.md, con la comprobacion).
//
// 3. Horizonte local. Altitud y azimut (desde el norte hacia el este) pasan a
//    ecuatoriales con la latitud y el tiempo sidereo local.
//
// La orientacion de la camara en la ventana al cielo va como un cuaternion
// (seccion "Cuaterniones"): una orientacion completa, sin un "arriba" de
// referencia que deje de servir en los polos o en el cenit.
//
// Todos los angulos de las funciones publicas van en grados.

export const DEG = Math.PI / 180;

/** Punto del cielo en grados ICRS. */
export interface SkyPosition {
  readonly ra: number;
  readonly dec: number;
}

/** Vector de tres componentes; el marco (escena u horizonte) lo dice cada funcion. */
export type Vec3 = readonly [number, number, number];

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Lleva un angulo a [0, 360). */
export function wrapDegrees(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360;
  return wrapped >= 360 ? 0 : wrapped;
}

/** Diferencia `to - from` por el camino corto, en (-180, 180]. */
export function shortestDelta(from: number, to: number): number {
  const delta = wrapDegrees(to - from);
  return delta > 180 ? delta - 360 : delta;
}

// ---- Escena --------------------------------------------------------------

/** Direccion unitaria, en el sistema de la escena, de un punto del cielo. */
export function raDecToVector(ra: number, dec: number): Vec3 {
  const cosDec = Math.cos(dec * DEG);
  return [cosDec * Math.cos(ra * DEG), Math.sin(dec * DEG), -cosDec * Math.sin(ra * DEG)];
}

/** Punto del cielo al que apunta un vector de la escena (no hace falta que sea unitario). */
export function vectorToRaDec(vector: Vec3): SkyPosition {
  const [x, y, z] = vector;
  const length = Math.hypot(x, y, z);
  if (length === 0) return { ra: 0, dec: 0 };
  return {
    ra: wrapDegrees(Math.atan2(-z, x) / DEG),
    dec: Math.asin(clamp(y / length, -1, 1)) / DEG,
  };
}

export function normalize(vector: Vec3): Vec3 {
  const [x, y, z] = vector;
  const length = Math.hypot(x, y, z);
  return length === 0 ? [1, 0, 0] : [x / length, y / length, z / length];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Separacion angular entre dos puntos del cielo, en grados. */
export function angularSeparation(a: SkyPosition, b: SkyPosition): number {
  const cosine = dot(raDecToVector(a.ra, a.dec), raDecToVector(b.ra, b.dec));
  return Math.acos(clamp(cosine, -1, 1)) / DEG;
}

/**
 * Punto intermedio entre dos direcciones unitarias por el circulo maximo:
 * `t = 0` da `from` y `t = 1` da `to`.
 */
export function slerpDirection(from: Vec3, to: Vec3, t: number): Vec3 {
  const angle = Math.acos(clamp(dot(from, to), -1, 1));
  if (angle < 1e-6) return to;
  const sine = Math.sin(angle);
  // Direcciones casi opuestas: el circulo maximo no esta definido. Se sale por el lado de `to`.
  if (sine < 1e-6) return t < 0.5 ? from : to;
  const a = Math.sin((1 - t) * angle) / sine;
  const b = Math.sin(t * angle) / sine;
  return [a * from[0] + b * to[0], a * from[1] + b * to[1], a * from[2] + b * to[2]];
}

// ---- Textura -------------------------------------------------------------

/**
 * Coordenadas de textura de un punto del cielo: `u` de 0 (borde izquierdo de
 * la imagen) a 1 y `v` de 0 (borde inferior, polo sur) a 1 (polo norte).
 */
export function raDecToTextureUv(ra: number, dec: number): readonly [number, number] {
  const u = (((0.5 - ra / 360) % 1) + 1) % 1;
  return [u, (clamp(dec, -90, 90) + 90) / 180];
}

/** Punto del cielo que le corresponde a una coordenada de textura. Inversa de `raDecToTextureUv`. */
export function textureUvToRaDec(u: number, v: number): SkyPosition {
  return { ra: wrapDegrees((0.5 - u) * 360), dec: v * 180 - 90 };
}

// ---- Tiempo sidereo ------------------------------------------------------

/** Dia juliano (UT) de una fecha. */
export function julianDate(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5;
}

/**
 * Tiempo sidereo medio de Greenwich en grados.
 * Fuente: J. Meeus, "Astronomical Algorithms" (2.a ed.), ecuacion 12.4.
 */
export function greenwichSiderealDeg(date: Date): number {
  const days = julianDate(date) - 2_451_545.0;
  const centuries = days / 36_525;
  return wrapDegrees(
    280.460_618_37 +
      360.985_647_366_29 * days +
      0.000_387_933 * centuries ** 2 -
      centuries ** 3 / 38_710_000,
  );
}

/** Lugar de observacion: latitud y longitud en grados, la longitud positiva hacia el este. */
export interface Observer {
  readonly latitude: number;
  readonly longitude: number;
}

/** Tiempo sidereo local en grados: la ascension recta que esta pasando por el meridiano. */
export function localSiderealDeg(date: Date, longitude: number): number {
  return wrapDegrees(greenwichSiderealDeg(date) + longitude);
}

// ---- Horizonte local -----------------------------------------------------

/** Del sistema ecuatorial (X a RA 0h, Y a RA 6h, Z al polo norte) al de la escena. */
function equatorialToScene(x: number, y: number, z: number): Vec3 {
  return [x, z, -y];
}

/** Ejes del horizonte local (este, norte y cenit) como direcciones de la escena. */
export interface HorizonBasis {
  readonly east: Vec3;
  readonly north: Vec3;
  readonly up: Vec3;
}

/**
 * Ejes del horizonte de un lugar en un instante. El cenit apunta a
 * (RA = tiempo sidereo local, Dec = latitud); el este, al punto del ecuador
 * que esta saliendo (RA = tiempo sidereo + 6h); el norte completa la terna.
 */
export function horizonBasis(observer: Observer, date: Date): HorizonBasis {
  const lst = localSiderealDeg(date, observer.longitude) * DEG;
  const lat = observer.latitude * DEG;
  const [sinLst, cosLst] = [Math.sin(lst), Math.cos(lst)];
  const [sinLat, cosLat] = [Math.sin(lat), Math.cos(lat)];
  return {
    east: equatorialToScene(-sinLst, cosLst, 0),
    north: equatorialToScene(-sinLat * cosLst, -sinLat * sinLst, cosLat),
    up: equatorialToScene(cosLat * cosLst, cosLat * sinLst, sinLat),
  };
}

/** Pasa un vector del marco del horizonte (este, norte, cenit) al de la escena. */
export function horizonToScene(vector: Vec3, basis: HorizonBasis): Vec3 {
  const [e, n, u] = vector;
  return [
    e * basis.east[0] + n * basis.north[0] + u * basis.up[0],
    e * basis.east[1] + n * basis.north[1] + u * basis.up[1],
    e * basis.east[2] + n * basis.north[2] + u * basis.up[2],
  ];
}

/**
 * Altitud y azimut a ascension recta y declinacion. El azimut se mide desde
 * el norte hacia el este (norte 0, este 90).
 */
export function altAzToRaDec(
  altitude: number,
  azimuth: number,
  observer: Observer,
  date: Date,
): SkyPosition {
  const cosAlt = Math.cos(altitude * DEG);
  const horizon: Vec3 = [
    cosAlt * Math.sin(azimuth * DEG),
    cosAlt * Math.cos(azimuth * DEG),
    Math.sin(altitude * DEG),
  ];
  return vectorToRaDec(horizonToScene(horizon, horizonBasis(observer, date)));
}

// ---- Cuaterniones --------------------------------------------------------

/**
 * Cuaternion unitario [x, y, z, w]: una orientacion completa (hacia donde se
 * mira y cuanto esta girada la vista), sin ejes privilegiados.
 */
export type Quat = readonly [number, number, number, number];

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

/** Giro de `degrees` alrededor de un eje de coordenadas (0 = x, 1 = y, 2 = z), a derechas. */
export function axisQuat(axis: 0 | 1 | 2, degrees: number): Quat {
  const half = (degrees * DEG) / 2;
  const sine = Math.sin(half);
  return [axis === 0 ? sine : 0, axis === 1 ? sine : 0, axis === 2 ? sine : 0, Math.cos(half)];
}

/** Producto `a * b`: el giro que aplica primero `b` y despues `a`. */
export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatNormalize(q: Quat): Quat {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (length === 0) return QUAT_IDENTITY;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/** Gira un vector con un cuaternion unitario. */
export function quatRotate(q: Quat, vector: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = vector;
  // v' = v + w t + u x t, con t = 2 (u x v) y u la parte vectorial.
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

function quatDot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/** Angulo, en grados, del giro que lleva de una orientacion a la otra (de 0 a 180). */
export function quatAngle(a: Quat, b: Quat): number {
  // `q` y `-q` son la misma orientacion: por eso el valor absoluto.
  return (2 * Math.acos(Math.min(1, Math.abs(quatDot(a, b))))) / DEG;
}

/**
 * Orientacion intermedia entre dos, por el giro mas corto y a velocidad
 * angular constante: `t = 0` da `from` y `t = 1` da `to`.
 */
export function quatSlerp(from: Quat, to: Quat, t: number): Quat {
  let cosine = quatDot(from, to);
  // Por el camino corto: si hace falta se usa `-to`, que es la misma orientacion.
  const sign = cosine < 0 ? -1 : 1;
  cosine *= sign;
  let a = 1 - t;
  let b = t;
  if (cosine < 0.9999) {
    const angle = Math.acos(cosine);
    const sine = Math.sin(angle);
    a = Math.sin((1 - t) * angle) / sine;
    b = Math.sin(t * angle) / sine;
  }
  b *= sign;
  return quatNormalize([
    a * from[0] + b * to[0],
    a * from[1] + b * to[1],
    a * from[2] + b * to[2],
    a * from[3] + b * to[3],
  ]);
}

/** Con que rapidez la camara sigue al sensor de orientacion (1/s). */
export const ORIENTATION_FOLLOW = 14;

/**
 * Un paso del filtro con el que la camara sigue al sensor: recorre una
 * fraccion de lo que le falta, por el giro mas corto. `q` y `-q` son la misma
 * orientacion, asi que un objetivo que llega con el signo cambiado (pasa cuando
 * beta cruza 180 grados) no mueve la camara.
 */
export function followOrientation(
  current: Quat,
  target: Quat,
  seconds: number,
  rate = ORIENTATION_FOLLOW,
): Quat {
  const blend = seconds <= 0 ? 1 : 1 - Math.exp(-seconds * rate);
  return quatSlerp(current, target, blend);
}

/** Salto entre dos lecturas seguidas, en grados, a partir del cual una lectura es sospechosa. */
export const GATE_JUMP = 60;
/** Dos lecturas sospechosas seguidas que coinciden dentro de estos grados son un giro de verdad. */
export const GATE_CONFIRM = 25;

export interface GatedOrientation {
  /** Orientacion que hay que usar: la lectura, o la anterior si la lectura quedo retenida. */
  readonly orientation: Quat;
  /** La lectura quedo retenida por sospechosa. */
  readonly held: boolean;
}

/**
 * Compuerta contra lecturas sueltas disparatadas del sensor. Nadie gira un
 * telefono 60 grados entre dos lecturas (a 60 por segundo serian 3600 grados
 * por segundo): una lectura asi se retiene y la camara sigue con la anterior.
 * Si la lectura siguiente la confirma era un cambio de verdad (por ejemplo, la
 * pantalla giro) y se acepta, con una lectura de atraso. La comparacion es
 * entre orientaciones, no entre angulos: el signo del cuaternion y las vueltas
 * de alpha, beta y gamma no cuentan como salto.
 */
export function createOrientationGate(
  jump = GATE_JUMP,
  confirm = GATE_CONFIRM,
): (reading: Quat) => GatedOrientation {
  let accepted: Quat | null = null;
  let pending: Quat | null = null;
  return (reading) => {
    if (accepted === null || quatAngle(accepted, reading) <= jump) {
      accepted = reading;
      pending = null;
      return { orientation: reading, held: false };
    }
    if (pending !== null && quatAngle(pending, reading) <= confirm) {
      accepted = reading;
      pending = null;
      return { orientation: reading, held: false };
    }
    pending = reading;
    return { orientation: accepted, held: true };
  };
}

/**
 * Hacia donde mira y donde queda el arriba de una camara con esa orientacion.
 * La camara (three.js) mira hacia su -z y tiene el arriba en su +y.
 */
export function quatPointing(q: Quat): Pointing {
  return { forward: quatRotate(q, [0, 0, -1]), up: quatRotate(q, [0, 1, 0]) };
}

// ---- Orientacion del telefono --------------------------------------------

/**
 * Angulos del evento `deviceorientation` en grados, con `alpha` absoluto:
 * 0 cuando el borde superior del telefono apunta al norte, creciendo al girar
 * en sentido antihorario visto desde arriba.
 */
export interface DeviceAngles {
  readonly alpha: number;
  readonly beta: number;
  readonly gamma: number;
}

/** Hacia donde mira la camara trasera y donde queda el "arriba" de la pantalla. */
export interface Pointing {
  readonly forward: Vec3;
  readonly up: Vec3;
}

/**
 * Orientacion del telefono en el marco del horizonte (este, norte, cenit).
 *
 * Fuente: W3C, "DeviceOrientation Event Specification", seccion 4.1 y ejemplo
 * de la matriz de rotacion: R = Rz(alpha) Rx(beta) Ry(gamma) lleva del marco
 * del dispositivo (x a la derecha de la pantalla, y hacia su borde superior, z
 * saliendo de la pantalla) al de la Tierra (x este, y norte, z arriba). Las
 * columnas de R son los ejes del dispositivo vistos desde la Tierra.
 *
 * `forward` es -z del dispositivo: lo que se ve "a traves" del telefono.
 * `screenAngle` es `screen.orientation.angle`: con la pantalla girada, el
 * "arriba" de lo que se dibuja deja de ser el eje y del dispositivo.
 */
export function deviceToHorizon(angles: DeviceAngles, screenAngle = 0): Pointing {
  const [sinA, cosA] = [Math.sin(angles.alpha * DEG), Math.cos(angles.alpha * DEG)];
  const [sinB, cosB] = [Math.sin(angles.beta * DEG), Math.cos(angles.beta * DEG)];
  const [sinG, cosG] = [Math.sin(angles.gamma * DEG), Math.cos(angles.gamma * DEG)];

  const deviceX: Vec3 = [
    cosA * cosG - sinA * sinB * sinG,
    cosG * sinA + cosA * sinB * sinG,
    -cosB * sinG,
  ];
  const deviceY: Vec3 = [-cosB * sinA, cosA * cosB, sinB];
  const deviceZ: Vec3 = [
    cosG * sinA * sinB + cosA * sinG,
    sinA * sinG - cosA * cosG * sinB,
    cosB * cosG,
  ];

  const [sinS, cosS] = [Math.sin(screenAngle * DEG), Math.cos(screenAngle * DEG)];
  return {
    forward: [-deviceZ[0], -deviceZ[1], -deviceZ[2]],
    up: [
      sinS * deviceX[0] + cosS * deviceY[0],
      sinS * deviceX[1] + cosS * deviceY[1],
      sinS * deviceX[2] + cosS * deviceY[2],
    ],
  };
}

/**
 * Orientacion de la camara, en el marco del horizonte (este, norte, cenit),
 * para un telefono con esos angulos: el giro que lleva los ejes de la camara
 * (x a la derecha de lo que se dibuja, y hacia arriba, -z hacia donde mira) a
 * ese marco.
 *
 * Los tres angulos se componen en un solo paso, R = Rz(alpha) Rx(beta)
 * Ry(gamma) (W3C, "DeviceOrientation Event Specification", seccion 4.1). Por
 * separado tienen saltos (alpha da la vuelta en 360, beta en 180, y con el
 * telefono de canto alpha y gamma dejan de estar definidos), pero el giro
 * compuesto es continuo. La pantalla girada es un giro mas, alrededor del eje
 * z del telefono, en sentido contrario a `screenAngle`.
 */
export function deviceToHorizonQuaternion(angles: DeviceAngles, screenAngle = 0): Quat {
  return quatMultiply(
    quatMultiply(
      quatMultiply(axisQuat(2, angles.alpha), axisQuat(0, angles.beta)),
      axisQuat(1, angles.gamma),
    ),
    axisQuat(2, -screenAngle),
  );
}

/**
 * Giro del marco del horizonte (este, norte, cenit) al de la escena, para un
 * lugar y un instante. Del horizonte al ecuatorial: Rz(90) lleva el este al
 * eje y, Ry(90 - latitud) inclina el cenit desde el polo, y Rz(tiempo sidereo
 * local) lo lleva a su ascension recta. Del ecuatorial a la escena: Rx(-90).
 */
export function horizonToSceneQuaternion(observer: Observer, date: Date): Quat {
  const lst = localSiderealDeg(date, observer.longitude);
  return quatMultiply(
    quatMultiply(
      quatMultiply(axisQuat(0, -90), axisQuat(2, lst)),
      axisQuat(1, 90 - observer.latitude),
    ),
    axisQuat(2, 90),
  );
}

/**
 * Orientacion de la camara en la escena para un telefono, un lugar y un
 * instante: la del telefono compuesta con la del horizonte local. Se le asigna
 * tal cual a la camara, sin pasar por ascension recta y declinacion.
 */
export function deviceToSceneQuaternion(
  angles: DeviceAngles,
  screenAngle: number,
  observer: Observer,
  date: Date,
): Quat {
  return quatNormalize(
    quatMultiply(
      horizonToSceneQuaternion(observer, date),
      deviceToHorizonQuaternion(angles, screenAngle),
    ),
  );
}

/**
 * Orientacion del telefono como direcciones de la escena. Es la misma cuenta
 * que `deviceToSceneQuaternion`, escrita con matrices: los tests comparan una
 * con la otra.
 */
export function deviceToScene(
  angles: DeviceAngles,
  screenAngle: number,
  observer: Observer,
  date: Date,
): Pointing {
  const basis = horizonBasis(observer, date);
  const pointing = deviceToHorizon(angles, screenAngle);
  return {
    forward: horizonToScene(pointing.forward, basis),
    up: horizonToScene(pointing.up, basis),
  };
}
