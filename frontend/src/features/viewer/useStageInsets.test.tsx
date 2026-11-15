import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { useStageInsets } from "./useStageInsets";

type Box = Pick<DOMRect, "left" | "top" | "width" | "height">;

/** jsdom no hace layout: se le da a cada elemento el rectangulo que tendria en pantalla. */
function place(element: HTMLElement, box: Box): void {
  element.getBoundingClientRect = () =>
    ({
      ...box,
      x: box.left,
      y: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      toJSON: () => box,
    }) as DOMRect;
}

interface ProbeProps {
  readonly viewer: Box;
  readonly stage: Box;
}

function Probe({ viewer, stage }: ProbeProps) {
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const insets = useStageInsets(viewerRef, stageRef);
  return (
    <>
      <div
        ref={(element) => {
          viewerRef.current = element;
          if (element) place(element, viewer);
        }}
      />
      <div
        ref={(element) => {
          stageRef.current = element;
          if (element) place(element, stage);
        }}
      />
      <output data-testid="insets">{insets ? JSON.stringify(insets) : "sin medir"}</output>
    </>
  );
}

function measured(): unknown {
  const text = screen.getByTestId("insets").textContent ?? "";
  return text === "sin medir" ? undefined : JSON.parse(text);
}

const WINDOW: Box = { left: 0, top: 0, width: 1440, height: 900 };

describe("useStageInsets", () => {
  it("mide cuanto del visor queda fuera de la zona libre, de cada lado", () => {
    // La celda libre de la grilla de escritorio en una ventana de 1440 x 900.
    render(<Probe viewer={WINDOW} stage={{ left: 340, top: 80, width: 740, height: 622 }} />);

    expect(measured()).toEqual({ top: 80, right: 360, bottom: 198, left: 340 });
  });

  it("si el visor y la zona libre coinciden, los margenes son cero", () => {
    const box = { left: 0, top: 64, width: 390, height: 390 };
    render(<Probe viewer={box} stage={box} />);

    expect(measured()).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it("donde no hay layout no informa margenes", () => {
    render(<Probe viewer={WINDOW} stage={{ left: 0, top: 0, width: 0, height: 0 }} />);

    expect(measured()).toBeUndefined();
  });

  it("vuelve a medir cuando cambia el tamano de la ventana", () => {
    const stage = { left: 340, top: 80, width: 740, height: 622 };
    const { container } = render(<Probe viewer={WINDOW} stage={stage} />);
    expect(measured()).toMatchObject({ bottom: 198 });

    // La linea de tiempo crecio 40 px: la zona libre se achica.
    const stageElement = container.querySelectorAll("div")[1] as HTMLElement;
    place(stageElement, { ...stage, height: 582 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(measured()).toMatchObject({ top: 80, bottom: 238 });
  });

  it("con ResizeObserver sigue a los dos elementos y deja de seguirlos al desmontar", () => {
    const observed: Element[] = [];
    const disconnect = vi.fn();
    let notify: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          notify = callback;
        }
        observe(element: Element): void {
          observed.push(element);
        }
        unobserve(): void {}
        disconnect = disconnect;
      },
    );
    const stage = { left: 340, top: 80, width: 740, height: 622 };
    const { container, unmount } = render(<Probe viewer={WINDOW} stage={stage} />);
    const [viewerElement, stageElement] = [...container.querySelectorAll("div")];
    expect(observed).toEqual([viewerElement, stageElement]);

    place(stageElement as HTMLElement, { ...stage, top: 100, height: 602 });
    act(() => notify?.());
    expect(measured()).toMatchObject({ top: 100, bottom: 198 });

    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
