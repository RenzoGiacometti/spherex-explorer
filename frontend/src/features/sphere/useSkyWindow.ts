// Ventana al cielo: el telefono como ventana (SPEC.md, Etapa 4).
//
// Con el sensor de orientacion, la ubicacion y la hora actual se sabe como
// esta orientada la camara trasera respecto del cielo: los tres angulos del
// sensor dan la orientacion del telefono en el horizonte local, y la latitud
// con el tiempo sidereo local la llevan al sistema ecuatorial. Todo va en un
// cuaternion (`deviceToSceneQuaternion`, skyMath.ts) que la escena le asigna a
// la camara tal cual.
//
// Que hace falta, y que pasa si falta (la esfera queda en modo de arrastre y
// la pantalla dice el motivo):
// - Contexto seguro (HTTPS o localhost): sin el, el navegador no entrega ni
//   orientacion ni ubicacion.
// - Permiso de orientacion. Safari de iOS lo pide con
//   DeviceOrientationEvent.requestPermission(), que solo se puede llamar
//   dentro de un gesto de la persona: por eso `start` va en el clic del boton.
// - Orientacion absoluta, referida al norte. Chrome de Android la entrega en
//   el evento `deviceorientationabsolute`; Safari, en `webkitCompassHeading`
//   de `deviceorientation`; otros marcan `absolute` en `deviceorientation`.
//   Una orientacion relativa no sirve: no dice donde esta el norte.
// - Ubicacion (navigator.geolocation). Alcanza con poca precision: un grado de
//   latitud corre el cielo un grado.
//
// Limites conocidos: la brujula da el norte magnetico, no el geografico (la
// diferencia llega a 10 o 20 grados segun el lugar), y sufre cerca de metal.
// Alcanza para encontrar una zona del cielo, no para apuntar a un objeto.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type DeviceAngles,
  deviceToSceneQuaternion,
  type Observer,
  type Quat,
  shortestDelta,
  wrapDegrees,
} from "./skyMath";

export type SkyWindowIssue =
  /** La pagina no esta en un contexto seguro (HTTPS). */
  | "insecure"
  /** No hay sensor de orientacion, o no da una orientacion referida al norte. */
  | "noOrientation"
  | "orientationDenied"
  | "noLocation"
  | "locationDenied"
  | "locationFailed";

export type SkyWindowState =
  | { readonly kind: "off" }
  /** Pidiendo permisos y esperando el primer dato de los sensores. */
  | { readonly kind: "starting" }
  | { readonly kind: "on" }
  /** No se pudo: la esfera sigue en modo de arrastre. */
  | { readonly kind: "unavailable"; readonly issue: SkyWindowIssue };

export interface SkyWindowOptions {
  /** Recibe la orientacion de la camara en cada dato del sensor, y null al salir. */
  readonly onOrientation: (orientation: Quat | null) => void;
  /**
   * Acepta una orientacion relativa como si fuera absoluta. Solo para la pagina
   * de prueba: los sensores simulados de las herramientas de desarrollo no
   * marcan `absolute`.
   */
  readonly allowRelative?: boolean | undefined;
}

export interface SkyWindow {
  readonly state: SkyWindowState;
  /** Pide los permisos y enciende la ventana. Hay que llamarla desde un clic. */
  start(): Promise<void>;
  /** Apaga los sensores y vuelve al modo de arrastre. Tambien borra el aviso. */
  stop(): void;
}

const OFF: SkyWindowState = { kind: "off" };

/** Cuanto se espera el primer dato de orientacion antes de darla por ausente. */
const FIRST_EVENT_TIMEOUT_MS = 3000;
const LOCATION_TIMEOUT_MS = 15_000;
/** Una ubicacion de hace diez minutos sirve igual. */
const LOCATION_MAX_AGE_MS = 600_000;

type PermissionRequest = () => Promise<"granted" | "denied">;

/** `requestPermission` existe solo en Safari de iOS 13 o posterior; no esta en los tipos del DOM. */
function orientationPermissionRequest(): PermissionRequest | null {
  const holder = DeviceOrientationEvent as unknown as { requestPermission?: PermissionRequest };
  return typeof holder.requestPermission === "function"
    ? holder.requestPermission.bind(holder)
    : null;
}

function screenAngle(): number {
  const angle = window.screen?.orientation?.angle;
  if (typeof angle === "number") return angle;
  // Safari anterior a 16.4 no tiene screen.orientation.
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === "number" ? legacy : 0;
}

function locate(): Promise<Observer> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      reject,
      { enableHighAccuracy: false, timeout: LOCATION_TIMEOUT_MS, maximumAge: LOCATION_MAX_AGE_MS },
    );
  });
}

/**
 * Lleva los eventos de orientacion a angulos con `alpha` referido al norte, o
 * null si el evento no alcanza para saberlo.
 */
function createAngleReader(
  allowRelative: boolean,
): (event: DeviceOrientationEvent) => DeviceAngles | null {
  // Safari: `alpha` es relativo a donde estaba el telefono al empezar, y
  // `webkitCompassHeading` da el rumbo del borde superior (0 norte, 90 este).
  // La diferencia entre los dos es fija; se mide cuando el telefono no esta
  // muy inclinado, que es cuando el rumbo es confiable, y se suma siempre.
  let compassOffset: number | null = null;
  let sawAbsoluteEvent = false;

  return (event) => {
    const { alpha, beta, gamma } = event;
    if (alpha === null || beta === null || gamma === null) return null;

    const heading = (event as DeviceOrientationEvent & { webkitCompassHeading?: number })
      .webkitCompassHeading;
    if (typeof heading === "number" && Number.isFinite(heading)) {
      const measured = wrapDegrees(360 - heading - alpha);
      if (compassOffset === null) compassOffset = measured;
      else if (Math.abs(beta) < 70) {
        compassOffset = wrapDegrees(compassOffset + 0.1 * shortestDelta(compassOffset, measured));
      }
      return { alpha: wrapDegrees(alpha + compassOffset), beta, gamma };
    }

    if (event.type === "deviceorientationabsolute" || event.absolute) {
      sawAbsoluteEvent = true;
      return { alpha, beta, gamma };
    }
    // Chrome de Android manda los dos eventos: una vez que llego el absoluto, el relativo no se usa.
    if (allowRelative && !sawAbsoluteEvent) return { alpha, beta, gamma };
    return null;
  };
}

export function useSkyWindow({
  onOrientation,
  allowRelative = false,
}: SkyWindowOptions): SkyWindow {
  const [state, setState] = useState<SkyWindowState>(OFF);
  const onPointingRef = useRef(onOrientation);
  onPointingRef.current = onOrientation;
  /** Apaga los sensores de la sesion en curso; null si no hay ninguna. */
  const teardownRef = useRef<(() => void) | null>(null);
  /** Cambia en cada `start` y `stop`: lo que llega de una sesion vieja se descarta. */
  const sessionRef = useRef(0);

  const stop = useCallback(() => {
    sessionRef.current += 1;
    const wasRunning = teardownRef.current !== null;
    teardownRef.current?.();
    teardownRef.current = null;
    if (wasRunning) onPointingRef.current(null);
    setState(OFF);
  }, []);

  useEffect(
    () => () => {
      sessionRef.current += 1;
      teardownRef.current?.();
      teardownRef.current = null;
    },
    [],
  );

  const start = useCallback(async (): Promise<void> => {
    sessionRef.current += 1;
    const session = sessionRef.current;
    teardownRef.current?.();
    teardownRef.current = null;

    const fail = (issue: SkyWindowIssue): void => {
      if (sessionRef.current !== session) return;
      teardownRef.current?.();
      teardownRef.current = null;
      onPointingRef.current(null);
      setState({ kind: "unavailable", issue });
    };

    if (!window.isSecureContext) return fail("insecure");
    if (typeof DeviceOrientationEvent === "undefined") return fail("noOrientation");
    if (!("geolocation" in navigator)) return fail("noLocation");

    setState({ kind: "starting" });

    // 1. Permiso de orientacion. Va primero y sin esperar nada antes: Safari
    //    solo lo concede dentro del gesto que disparo el clic.
    const requestPermission = orientationPermissionRequest();
    if (requestPermission !== null) {
      let answer: "granted" | "denied";
      try {
        answer = await requestPermission();
      } catch {
        answer = "denied";
      }
      if (sessionRef.current !== session) return;
      if (answer !== "granted") return fail("orientationDenied");
    }

    // 2. Sensores. Se escucha desde ya, para no perder el primer dato mientras
    //    la persona contesta el pedido de ubicacion.
    const readAngles = createAngleReader(allowRelative);
    let observer: Observer | null = null;
    let latest: DeviceAngles | null = null;
    let running = false;

    const apply = (): void => {
      if (observer === null || latest === null) return;
      if (!running) {
        running = true;
        setState({ kind: "on" });
      }
      onPointingRef.current(deviceToSceneQuaternion(latest, screenAngle(), observer, new Date()));
    };
    const onOrientation = (event: DeviceOrientationEvent): void => {
      if (sessionRef.current !== session) return;
      const angles = readAngles(event);
      if (angles === null) return;
      latest = angles;
      apply();
    };
    window.addEventListener("deviceorientationabsolute", onOrientation);
    window.addEventListener("deviceorientation", onOrientation);
    window.addEventListener("orientationchange", apply);
    let firstEventTimer: number | null = null;
    teardownRef.current = () => {
      window.removeEventListener("deviceorientationabsolute", onOrientation);
      window.removeEventListener("deviceorientation", onOrientation);
      window.removeEventListener("orientationchange", apply);
      if (firstEventTimer !== null) window.clearTimeout(firstEventTimer);
    };

    // 3. Ubicacion.
    try {
      observer = await locate();
    } catch (error) {
      const denied = (error as Partial<GeolocationPositionError>).code === 1;
      return fail(denied ? "locationDenied" : "locationFailed");
    }
    if (sessionRef.current !== session) return;
    apply();

    // 4. Una computadora tiene el evento pero no el sensor: si no llega ningun dato, no hay.
    if (!running) {
      firstEventTimer = window.setTimeout(() => {
        firstEventTimer = null;
        if (!running) fail("noOrientation");
      }, FIRST_EVENT_TIMEOUT_MS);
    }
  }, [allowRelative]);

  return { state, start, stop };
}
