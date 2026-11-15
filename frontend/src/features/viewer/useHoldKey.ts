// Barra espaciadora del modo "mantener apretado": mientras esta apretada se ve
// la epoca de referencia.

import { useEffect } from "react";

function isSpace(event: KeyboardEvent): boolean {
  return event.key === " " || event.code === "Space";
}

/**
 * Dice si el elemento con el foco ya usa la barra espaciadora para otra cosa:
 * un boton o un enlace la toman como clic, un conmutador cambia de estado y en
 * un campo de texto escribe un espacio. Un boton de radio o un deslizador no
 * hacen nada util con ella, asi que ahi vale como "mantener apretado": es
 * donde queda el foco justo despues de elegir el modo.
 */
function usesSpace(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  switch (target.tagName) {
    case "BUTTON":
    case "A":
    case "TEXTAREA":
    case "SELECT":
    case "SUMMARY":
      return true;
    case "INPUT": {
      const type = (target as HTMLInputElement).type;
      return type !== "radio" && type !== "range";
    }
    default:
      return false;
  }
}

/**
 * Mientras `enabled`, avisa con `onChange(true)` al apretar la barra
 * espaciadora y con `onChange(false)` al soltarla, al perder el foco la
 * ventana y al apagarse. `onChange` tiene que ser estable (useCallback).
 */
export function useHoldKey(enabled: boolean, onChange: (holding: boolean) => void): void {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isSpace(event) || event.ctrlKey || event.altKey || event.metaKey) return;
      if (usesSpace(event.target)) return;
      // Sin esto la pagina se desplaza.
      event.preventDefault();
      if (!event.repeat) onChange(true);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (isSpace(event)) onChange(false);
    };
    const release = (): void => onChange(false);

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
      onChange(false);
    };
  }, [enabled, onChange]);
}
