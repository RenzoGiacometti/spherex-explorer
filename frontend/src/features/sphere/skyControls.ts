// Gestos de la esfera: arrastre con inercia, pellizco, rueda y teclado.
//
// Los eventos se escuchan en el escenario, que contiene al canvas y a los
// marcadores: un arrastre puede empezar sobre un marcador. Para que eso no
// termine abriendo el objeto, el clic que sigue a un arrastre se descarta.

import type { SkyScene } from "./SkyScene";
import { clamp } from "./skyMath";

/** Pixeles que hay que mover el puntero para que un toque pase a ser un arrastre. */
const DRAG_THRESHOLD = 4;
/** Ventana, en milisegundos, de las muestras con las que se mide la velocidad al soltar. */
const VELOCITY_WINDOW = 90;
/** Paso de las flechas del teclado, como fraccion del campo de vision. */
const KEY_STEP = 0.08;
const KEY_ZOOM = 1.15;

interface PointerState {
  x: number;
  y: number;
}

interface Sample {
  readonly t: number;
  readonly x: number;
  readonly y: number;
}

export interface SkyControlsOptions {
  /** Primera vez que la persona toca la esfera (arrastre, rueda o teclado). */
  readonly onInteract?: () => void;
  /** Empieza o termina un arrastre, para cambiar el cursor. */
  readonly onDragChange?: (dragging: boolean) => void;
}

export interface SkyControls {
  /** Apagados, los gestos no mueven la vista (ventana al cielo: manda el sensor). */
  setEnabled(enabled: boolean): void;
  detach(): void;
}

export function attachSkyControls(
  element: HTMLElement,
  scene: SkyScene,
  options: SkyControlsOptions = {},
): SkyControls {
  const pointers = new Map<number, PointerState>();
  let enabled = true;
  let dragging = false;
  let travelled = 0;
  let pinchDistance = 0;
  let suppressClick = false;
  let samples: Sample[] = [];
  let interacted = false;

  function interact(): void {
    scene.stopMotion();
    if (interacted) return;
    interacted = true;
    options.onInteract?.();
  }

  function setDragging(value: boolean): void {
    if (dragging === value) return;
    dragging = value;
    options.onDragChange?.(value);
  }

  function distanceBetweenPointers(): number {
    const [first, second] = [...pointers.values()];
    if (first === undefined || second === undefined) return 0;
    return Math.hypot(first.x - second.x, first.y - second.y);
  }

  function onPointerDown(event: PointerEvent): void {
    if (!enabled) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    suppressClick = false;
    if (pointers.size === 1) {
      travelled = 0;
      samples = [{ t: event.timeStamp, x: event.clientX, y: event.clientY }];
      // Tocar frena la inercia y la deriva, aunque despues no se arrastre.
      interact();
    } else {
      pinchDistance = distanceBetweenPointers();
      samples = [];
    }
  }

  function onPointerMove(event: PointerEvent): void {
    const pointer = pointers.get(event.pointerId);
    if (pointer === undefined) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (!enabled) return;

    if (pointers.size >= 2) {
      const distance = distanceBetweenPointers();
      if (pinchDistance > 0 && distance > 0) scene.zoomBy(pinchDistance / distance);
      pinchDistance = distance;
      suppressClick = true;
      return;
    }

    travelled += Math.hypot(dx, dy);
    if (!dragging) {
      if (travelled < DRAG_THRESHOLD) return;
      setDragging(true);
      suppressClick = true;
      // Con la captura el arrastre sigue aunque el puntero salga de la ventana.
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // El puntero ya no existe (se solto entre dos eventos): no hay nada que capturar.
      }
    }
    scene.rotateByPixels(dx, dy);
    samples.push({ t: event.timeStamp, x: event.clientX, y: event.clientY });
    if (samples.length > 12) samples.shift();
  }

  function onPointerEnd(event: PointerEvent): void {
    if (!pointers.delete(event.pointerId)) return;
    if (pointers.size > 0) {
      // Quedo un dedo despues de un pellizco: sigue como arrastre, sin salto.
      pinchDistance = 0;
      samples = [];
      return;
    }
    if (dragging && enabled && event.type === "pointerup") {
      const recent = samples.filter((sample) => event.timeStamp - sample.t <= VELOCITY_WINDOW);
      const first = recent[0];
      const last = recent[recent.length - 1];
      if (first !== undefined && last !== undefined && last.t > first.t) {
        const seconds = (last.t - first.t) / 1000;
        scene.fling((last.x - first.x) / seconds, (last.y - first.y) / seconds);
      }
    }
    setDragging(false);
    samples = [];
  }

  function onClickCapture(event: MouseEvent): void {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  function onWheel(event: WheelEvent): void {
    if (!enabled) return;
    event.preventDefault();
    interact();
    // deltaMode 1 son lineas: se llevan a pixeles aproximados.
    const delta = event.deltaMode === 1 ? event.deltaY * 32 : event.deltaY;
    scene.zoomBy(Math.exp(clamp(delta, -240, 240) * 0.0015));
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!enabled || event.target !== element) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = scene.getView().fov * KEY_STEP;
    switch (event.key) {
      case "ArrowLeft":
        scene.rotateByDegrees(step, 0);
        break;
      case "ArrowRight":
        scene.rotateByDegrees(-step, 0);
        break;
      case "ArrowUp":
        scene.rotateByDegrees(0, step);
        break;
      case "ArrowDown":
        scene.rotateByDegrees(0, -step);
        break;
      case "+":
      case "=":
        scene.zoomBy(1 / KEY_ZOOM);
        break;
      case "-":
      case "_":
        scene.zoomBy(KEY_ZOOM);
        break;
      default:
        return;
    }
    event.preventDefault();
    interact();
  }

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerEnd);
  element.addEventListener("pointercancel", onPointerEnd);
  element.addEventListener("click", onClickCapture, true);
  element.addEventListener("wheel", onWheel, { passive: false });
  element.addEventListener("keydown", onKeyDown);

  return {
    setEnabled(value) {
      enabled = value;
      if (!value) {
        setDragging(false);
        samples = [];
      }
    },
    detach() {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerEnd);
      element.removeEventListener("pointercancel", onPointerEnd);
      element.removeEventListener("click", onClickCapture, true);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("keydown", onKeyDown);
      pointers.clear();
    },
  };
}
