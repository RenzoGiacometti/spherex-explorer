import {
  type CSSProperties,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import styles from "./DisabledReason.module.css";

/** Separacion entre el control y su ayuda, y margen contra el borde de la ventana. */
const GAP_PX = 8;
const MARGIN_PX = 12;
/** Ancho maximo de la ayuda (DisabledReason.module.css). */
const MAX_WIDTH_PX = 280;
/** Alto libre que hace falta arriba del control para poner la ayuda encima. */
const ROOM_ABOVE_PX = 96;

interface Anchor {
  readonly x: number;
  readonly top: number;
  readonly bottom: number;
}

/** Atributos y eventos que recibe un control deshabilitado con motivo. */
export interface DisabledReasonProps {
  readonly "aria-disabled": true;
  readonly "aria-describedby": string;
  readonly onPointerEnter: (event: PointerEvent<Element>) => void;
  readonly onPointerLeave: (event: PointerEvent<Element>) => void;
  readonly onFocus: (event: FocusEvent<Element>) => void;
  readonly onBlur: () => void;
  readonly onClick: (event: MouseEvent<Element>) => void;
}

export interface DisabledReasonState {
  /**
   * El control esta deshabilitado y dice por que: va con `aria-disabled` en
   * lugar de `disabled`, para que reciba el cursor, el toque y el foco.
   */
  readonly active: boolean;
  /** Lo que se le pone al control cuando `active`; null si no. */
  readonly props: DisabledReasonProps | null;
  /** La ayuda con el motivo: va junto al control (se dibuja sobre `body`). */
  readonly bubble: ReactNode;
}

function bubbleStyle(anchor: Anchor): CSSProperties {
  const width = window.innerWidth;
  const half = MAX_WIDTH_PX / 2 + MARGIN_PX;
  // Centrada sobre el control, sin salirse de la ventana.
  const left = width < half * 2 ? width / 2 : Math.min(Math.max(anchor.x, half), width - half);
  return anchor.top >= ROOM_ABOVE_PX
    ? { left, bottom: window.innerHeight - anchor.top + GAP_PX }
    : { left, top: anchor.bottom + GAP_PX };
}

/** Descripcion accesible del control: la que ya traia y, deshabilitado, el motivo. */
export function describedBy(
  existing: string | undefined,
  reason: DisabledReasonState,
): string | undefined {
  const ids = [existing, reason.props?.["aria-describedby"]].filter(Boolean);
  return ids.length === 0 ? undefined : ids.join(" ");
}

/** Quita los manejadores de eventos: un control deshabilitado no avisa nada. */
export function withoutHandlers<T extends object>(props: T): T {
  return Object.fromEntries(Object.entries(props).filter(([key]) => !/^on[A-Z]/.test(key))) as T;
}

/**
 * Motivo de un control deshabilitado (DESIGN.md, "Control deshabilitado").
 *
 * Un control con `disabled` no recibe eventos ni foco, asi que no puede decir
 * por que no se puede usar. Con un motivo, el control queda con
 * `aria-disabled`: se ve igual (40 % de opacidad) y no hace nada, pero al
 * pasarle el cursor, tocarlo o enfocarlo muestra el motivo, y los lectores de
 * pantalla lo leen como su descripcion (`aria-describedby`).
 *
 * Sin motivo no cambia nada: `active` es false y el control usa `disabled`.
 */
export function useDisabledReason(
  disabled: boolean,
  reason: string | undefined,
): DisabledReasonState {
  const id = useId();
  const active = disabled && reason !== undefined && reason !== "";
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const anchorElement = useRef<Element | null>(null);
  const open = active && anchor !== null;

  const show = useCallback((element: Element) => {
    anchorElement.current = element;
    const rect = element.getBoundingClientRect();
    setAnchor({ x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom });
  }, []);
  const hide = useCallback(() => setAnchor(null), []);

  useEffect(() => {
    if (!active) setAnchor(null);
  }, [active]);

  // Abierta, se cierra con Escape, al tocar otra cosa y al desplazar la pagina.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") hide();
    };
    const onPointerDown = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && anchorElement.current?.contains(target)) return;
      hide();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open, hide]);

  if (!active) return { active: false, props: null, bubble: null };

  const props: DisabledReasonProps = {
    "aria-disabled": true,
    "aria-describedby": id,
    // Con el dedo, entrar y salir pasan juntos al soltar: ahi la abre el toque (clic).
    onPointerEnter: (event) => {
      if (event.pointerType === "mouse") show(event.currentTarget);
    },
    onPointerLeave: (event) => {
      if (event.pointerType === "mouse") hide();
    },
    onFocus: (event) => show(event.currentTarget),
    onBlur: hide,
    onClick: (event) => {
      // No hace lo suyo (enviar el formulario, cambiar de opcion): solo dice el motivo.
      event.preventDefault();
      show(event.currentTarget);
    },
  };

  const bubble =
    typeof document === "undefined"
      ? null
      : createPortal(
          // Oculta sigue siendo la descripcion del control: `aria-describedby` la lee igual.
          <span
            id={id}
            role="tooltip"
            className={styles.bubble}
            hidden={!open}
            style={open ? bubbleStyle(anchor) : undefined}
          >
            {reason}
          </span>,
          document.body,
        );

  return { active: true, props, bubble };
}
