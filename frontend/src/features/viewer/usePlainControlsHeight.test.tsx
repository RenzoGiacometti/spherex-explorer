import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plainControlsHeight, usePlainControlsHeight } from "./usePlainControlsHeight";

/** jsdom no hace layout: se le da a cada elemento el lugar que tendria en pantalla. */
function place(element: Element, top: number, height: number): void {
  element.getBoundingClientRect = () =>
    ({
      x: 12,
      y: top,
      left: 12,
      top,
      width: 366,
      height,
      right: 378,
      bottom: top + height,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** Separacion entre los controles y entre las piezas del panel Modo, como en el celular. */
const GAP = 8;
const STRIP_GAP = 4;
const STRIP_PADDING = 5;

interface ControlsOptions {
  /** Altos de lo que el modo suma arriba del selector de modos (referencia, mantener, avisos). */
  readonly extras?: readonly number[];
  /** Cuanto se desplazaron los controles dentro de su zona. */
  readonly scrollTop?: number;
  /** Donde empieza la zona de controles en la pantalla. */
  readonly top?: number;
}

/**
 * Los controles del celular con sus cajas: el boton de la curva (44), la tira de Medir (54), el
 * panel Modo (lo que sume el modo y, abajo, los modos, 140), las bandas (54) y la linea de
 * tiempo (178,578125). En el parpadeo suman 512,578125 px, como R Draconis a 390 px de ancho.
 */
function buildControls({
  extras = [],
  scrollTop = 0,
  top = 319.421875,
}: ControlsOptions = {}): HTMLElement {
  const controls = document.createElement("div");
  let y = top - scrollTop;
  const add = (tag: string, height: number): HTMLElement => {
    const element = document.createElement(tag);
    place(element, y, height);
    controls.append(element);
    y += height + GAP;
    return element;
  };

  add("div", 44);
  add("section", 54);

  const stripTop = y;
  let inner = stripTop + STRIP_PADDING;
  const pieces: HTMLElement[] = [];
  for (const height of extras) {
    const extra = document.createElement("div");
    place(extra, inner, height);
    pieces.push(extra);
    inner += height + STRIP_GAP;
  }
  const modes = document.createElement("fieldset");
  for (const value of ["blink", "difference", "sum", "redcyan", "hold"]) {
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.value = value;
    modes.append(radio);
  }
  place(modes, inner, 140);
  pieces.push(modes);
  const strip = add("section", inner + 140 + STRIP_PADDING - stripTop);
  strip.append(...pieces);

  // Las bandas tambien son radios: no se confunden con los modos.
  const bands = add("section", 54);
  const band = document.createElement("fieldset");
  const bandRadio = document.createElement("input");
  bandRadio.type = "radio";
  bandRadio.value = "3";
  band.append(bandRadio);
  bands.append(band);

  add("footer", 178.578125);
  return controls;
}

const PLAIN = 512.578125;

describe("plainControlsHeight", () => {
  it("en el parpadeo es el alto de todos los controles", () => {
    expect(plainControlsHeight(buildControls())).toBe(PLAIN);
  });

  it("en rojo/cian y diferencia descuenta la epoca de referencia", () => {
    expect(plainControlsHeight(buildControls({ extras: [44] }))).toBe(PLAIN);
  });

  it("en mantener apretado descuenta tambien el boton, y los avisos de la comparacion", () => {
    expect(plainControlsHeight(buildControls({ extras: [44, 44] }))).toBe(PLAIN);
    expect(plainControlsHeight(buildControls({ extras: [27.5, 31.25, 44, 44] }))).toBe(PLAIN);
  });

  it("da lo mismo con los controles desplazados o en otro lugar de la pantalla", () => {
    expect(plainControlsHeight(buildControls({ extras: [44], scrollTop: 48 }))).toBe(PLAIN);
    expect(plainControlsHeight(buildControls({ extras: [44, 44], top: 262 }))).toBe(PLAIN);
    // Un desplazamiento con fracciones deja restos de coma flotante: se lleva a la grilla de layout.
    expect(plainControlsHeight(buildControls({ extras: [44], scrollTop: 12.3333 }))).toBe(PLAIN);
  });

  it("sin el selector de modos no descuenta nada", () => {
    const controls = buildControls({ extras: [44] });
    for (const radio of controls.querySelectorAll('input[value="blink"]')) radio.remove();
    expect(plainControlsHeight(controls)).toBe(PLAIN + 44 + STRIP_GAP);
  });

  it("sin controles o sin layout no hay medida", () => {
    expect(plainControlsHeight(document.createElement("div"))).toBeNull();
    const controls = document.createElement("div");
    controls.append(document.createElement("section"), document.createElement("footer"));
    expect(plainControlsHeight(controls)).toBeNull();
  });
});

interface ProbeProps {
  readonly enabled: boolean;
  /** Alto de la linea de tiempo, el ultimo de los controles. Se lee en cada dibujo. */
  readonly sizes: { timeline: number };
}

function Probe({ enabled, sizes }: ProbeProps) {
  const controlsRef = useRef<HTMLDivElement | null>(null);
  const height = usePlainControlsHeight(controlsRef, enabled);
  return (
    <>
      <div ref={controlsRef} data-testid="controls">
        <section
          ref={(element) => {
            if (element) place(element, 100, 150);
          }}
        />
        <footer
          ref={(element) => {
            if (element) place(element, 258, sizes.timeline);
          }}
        />
      </div>
      <output data-testid="height">{height === null ? "sin medir" : String(height)}</output>
    </>
  );
}

function measured(): string {
  return screen.getByTestId("height").textContent ?? "";
}

describe("usePlainControlsHeight", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mide antes de pintar y sigue a lo que cambia de un dibujo a otro", () => {
    const { rerender } = render(<Probe enabled sizes={{ timeline: 178 }} />);
    expect(measured()).toBe("336");

    // Termino la carga y el estado ocupa un renglon mas.
    rerender(<Probe enabled sizes={{ timeline: 200 }} />);
    expect(measured()).toBe("358");
  });

  it("apagado no informa nada, aunque ya haya medido", () => {
    const sizes = { timeline: 178 };
    const { rerender } = render(<Probe enabled={false} sizes={sizes} />);
    expect(measured()).toBe("sin medir");

    rerender(<Probe enabled sizes={sizes} />);
    expect(measured()).toBe("336");
    rerender(<Probe enabled={false} sizes={sizes} />);
    expect(measured()).toBe("sin medir");
  });

  it("con ResizeObserver sigue a los controles y a cada uno de sus hijos", () => {
    const observed: Element[][] = [];
    const disconnect = vi.fn();
    let notify: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly targets: Element[] = [];
        constructor(callback: () => void) {
          notify = callback;
          observed.push(this.targets);
        }
        observe(element: Element): void {
          this.targets.push(element);
        }
        unobserve(): void {}
        disconnect = disconnect;
      },
    );
    const sizes = { timeline: 178 };
    const { unmount } = render(<Probe enabled sizes={sizes} />);
    const controls = screen.getByTestId("controls");
    expect(observed.at(-1)).toEqual([controls, ...controls.children]);

    // La ventana se angosto y un renglon de la linea de tiempo se partio en dos.
    sizes.timeline = 194;
    place(controls.lastElementChild as Element, 258, sizes.timeline);
    act(() => notify?.());
    expect(measured()).toBe("352");

    const before = disconnect.mock.calls.length;
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(before + 1);
  });
});
