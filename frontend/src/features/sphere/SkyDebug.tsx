import { type RefObject, useEffect, useRef } from "react";
import { useLanguage } from "@/i18n/useLanguage";
import { formatDec, formatRa } from "@/lib/format";
import styles from "./SkyDebug.module.css";
import type { SkySphereHandle } from "./SkySphere";
import { DEG, quatRotate, type Vec3 } from "./skyMath";
import { useSphereTexts } from "./texts";
import type { SkyWindowReading } from "./useSkyWindow";

/** Cambio de direccion entre dos cuadros, en grados, a partir del cual se marca un salto. */
export const DEBUG_JUMP_LIMIT = 20;
/** Tiempo que la marca de salto queda a la vista, en milisegundos. */
const ALERT_MS = 2500;
/** Tiempo despues de la primera lectura del sensor en que no se cuentan saltos, en milisegundos. */
const SENSOR_GRACE_MS = 300;

export interface SkyDebugProps {
  readonly sphereRef: RefObject<SkySphereHandle | null>;
  /** Ultima lectura del sensor de la ventana al cielo, o null si todavia no hubo. */
  readonly readingRef: RefObject<SkyWindowReading | null>;
}

function number(value: number, digits: number): string {
  return value.toFixed(digits);
}

/**
 * Diagnostico de la orientacion de la camara, con `?debug=1`: en chico y sobre
 * el cielo, los angulos del sensor, el cuaternion de la camara, el centro de la
 * vista y cuanto giro la direccion entre este cuadro y el anterior. Si gira mas
 * de 20 grados de un cuadro al otro, el recuadro se marca en rojo y suma un
 * salto. Se actualiza en cada cuadro sin pasar por React.
 */
export function SkyDebug({ sphereRef, readingRef }: SkyDebugProps) {
  const t = useSphereTexts();
  const language = useLanguage();
  const boxRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let handle = 0;
    let previous: Vec3 | null = null;
    let largest = 0;
    let jumps = 0;
    let alertUntil = 0;
    // Al llegar la primera lectura la camara pasa de la vista de arrastre a la
    // del sensor de un cuadro al otro: ese cambio es esperado y no cuenta.
    let sensorSeen = false;
    let graceUntil = 0;

    const tick = (time: number): void => {
      handle = requestAnimationFrame(tick);
      const box = boxRef.current;
      const sphere = sphereRef.current;
      const orientation = sphere?.getOrientation() ?? null;
      const view = sphere?.getView() ?? null;
      if (box === null || orientation === null || view == null) return;

      const reading = readingRef.current;
      if (!sensorSeen && reading !== null) {
        sensorSeen = true;
        graceUntil = time + SENSOR_GRACE_MS;
      }

      const forward = quatRotate(orientation, [0, 0, -1]);
      let jump = 0;
      if (previous !== null && time >= graceUntil) {
        const cosine =
          forward[0] * previous[0] + forward[1] * previous[1] + forward[2] * previous[2];
        jump = Math.acos(Math.min(1, Math.max(-1, cosine))) / DEG;
      }
      previous = forward;
      largest = Math.max(largest, jump);
      if (jump > DEBUG_JUMP_LIMIT) {
        jumps += 1;
        alertUntil = time + ALERT_MS;
      }

      const lines = [
        reading === null
          ? t("debug.noSensor")
          : t("debug.angles", {
              alpha: number(reading.angles.alpha, 1),
              beta: number(reading.angles.beta, 1),
              gamma: number(reading.angles.gamma, 1),
              screen: reading.screenAngle,
            }),
        t("debug.quaternion", {
          x: number(orientation[0], 3),
          y: number(orientation[1], 3),
          z: number(orientation[2], 3),
          w: number(orientation[3], 3),
        }),
        t("debug.center", {
          position: `${formatRa(view.ra, { language })} ${formatDec(view.dec, { language })}`,
        }),
        t("debug.jump", {
          now: number(jump, 1),
          largest: number(largest, 1),
          jumps,
          held: reading?.held ?? 0,
        }),
      ];
      const text = lines.join("\n");
      if (box.textContent !== text) box.textContent = text;
      const alert = String(time < alertUntil);
      if (box.dataset.alert !== alert) box.dataset.alert = alert;
    };

    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [language, readingRef, sphereRef, t]);

  return <pre ref={boxRef} className={styles.debug} data-sky-debug="" aria-hidden="true" />;
}
