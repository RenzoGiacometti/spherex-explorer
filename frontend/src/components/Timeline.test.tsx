import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EpochLoadState } from "@/data/selectors";
import { initI18n, setLanguage } from "@/i18n";
import { formatMjdDate } from "@/lib/format";
import {
  EPOCH_LEGEND_STATES,
  EPOCH_MARKER_STATES,
  EpochLegend,
  EpochMarker,
  type EpochStatus,
  type TimelineEpoch,
  TimelineTrack,
} from "./Timeline";
import { EPOCH_STOP_WIDTH_PX, MIN_EPOCH_GAP } from "./timelineLayout";

/** Inicio de las cuatro epocas de Epsilon Indi B y de las tres de WISE 0855, en MJD. */
const FOUR = [60789.85552, 60946.96411, 61148.84479, 61305.22691];
const THREE = [60800.70003, 60979.72268, 61151.19793];

function epochs(starts: number[], statuses: EpochStatus[]): TimelineEpoch[] {
  return starts.map((mjd, index) => ({
    epoch: index + 1,
    time: mjd,
    dateLabel: formatMjdDate(mjd).slice(0, 7),
    status: statuses[index] ?? "unloaded",
  }));
}

const FOUR_EPOCHS = epochs(FOUR, ["loaded", "loaded", "provisional", "unloaded"]);
const THREE_EPOCHS = epochs(THREE, ["loaded", "loaded", "provisional"]);

function Track({ initial, onSelect }: { initial: number; onSelect?: (epoch: number) => void }) {
  const [current, setCurrent] = useState(initial);
  return (
    <TimelineTrack
      label="Línea de tiempo"
      epochs={FOUR_EPOCHS}
      current={current}
      onSelect={(epoch) => {
        setCurrent(epoch);
        onSelect?.(epoch);
      }}
    />
  );
}

function radios(): HTMLInputElement[] {
  return screen.getAllByRole("radio") as HTMLInputElement[];
}

/** Estado dibujado de cada marca, en orden. */
function drawnStates(): Array<string | null> {
  return radios().map(
    (radio) =>
      radio.closest("label")?.querySelector("[data-state]")?.getAttribute("data-state") ?? null,
  );
}

beforeEach(async () => {
  initI18n("es");
  await setLanguage("es");
});

describe("EpochMarker", () => {
  it.each(EPOCH_MARKER_STATES)("dibuja el estado %s y es decorativo", (state) => {
    const { container } = render(<EpochMarker state={state} />);
    const marker = container.firstElementChild;

    expect(marker?.getAttribute("data-state")).toBe(state);
    expect(marker?.getAttribute("aria-hidden")).toBe("true");
    expect(marker?.textContent).toBe("");
  });

  it("todos los estados se dibujan distinto", () => {
    const classes = EPOCH_MARKER_STATES.map((state) => {
      const { container } = render(<EpochMarker state={state} />);
      return container.firstElementChild?.getAttribute("class");
    });

    expect(EPOCH_MARKER_STATES).toEqual(["loaded", "provisional", "unloaded", "empty", "current"]);
    expect(new Set(classes).size).toBe(5);
  });

  it("sin datos es una cruz en SVG, sin colores escritos a mano", () => {
    const { container } = render(<EpochMarker state="empty" />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("width")).toBe("8");
    expect(svg?.getAttribute("height")).toBe("8");
    expect(svg?.querySelectorAll("path")).toHaveLength(1);
    for (const shape of svg?.querySelectorAll("circle, path") ?? []) {
      expect(shape.hasAttribute("fill")).toBe(false);
      expect(shape.hasAttribute("stroke")).toBe(false);
    }
  });

  it("la provisoria es un anillo punteado en SVG, sin colores escritos a mano", () => {
    const { container } = render(<EpochMarker state="provisional" />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("width")).toBe("8");
    expect(svg?.getAttribute("height")).toBe("8");
    const circles = [...(svg?.querySelectorAll("circle") ?? [])];
    expect(circles).toHaveLength(2);
    for (const circle of circles) {
      expect(circle.hasAttribute("fill")).toBe(false);
      expect(circle.hasAttribute("stroke")).toBe(false);
    }
  });
});

describe("TimelineTrack", () => {
  it("es un grupo con nombre y una marca por epoca, para 4 y para 3 epocas", () => {
    const { rerender } = render(<Track initial={2} />);

    const group = screen.getByRole("group", { name: "Línea de tiempo" });
    expect(within(group).getAllByRole("radio")).toHaveLength(4);

    rerender(
      <TimelineTrack
        label="Línea de tiempo"
        epochs={THREE_EPOCHS}
        current={1}
        onSelect={() => {}}
      />,
    );
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });

  it("el nombre de cada marca dice la epoca, su fecha y su estado de carga", () => {
    render(<Track initial={2} />);

    expect(radios().map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Época 1, 2025-04, cargada",
      "Época 2, 2025-09, cargada",
      "Época 3, 2026-04, provisoria",
      "Época 4, 2026-09, sin cargar",
    ]);
  });

  it("dibuja los cuatro estados: cargada, actual, provisoria y sin cargar", () => {
    render(<Track initial={2} />);

    expect(drawnStates()).toEqual(["loaded", "current", "provisional", "unloaded"]);
    expect(radios().map((radio) => radio.checked)).toEqual([false, true, false, false]);
  });

  it("la epoca actual conserva el ambar aunque sea provisoria, y su nombre lo sigue diciendo", () => {
    render(
      <TimelineTrack
        label="Línea de tiempo"
        epochs={THREE_EPOCHS}
        current={3}
        onSelect={() => {}}
      />,
    );

    expect(drawnStates()).toEqual(["loaded", "loaded", "current"]);
    const current = screen.getByRole("radio", { name: "Época 3, 2026-04, provisoria" });
    expect((current as HTMLInputElement).checked).toBe(true);
  });

  it("una epoca sin datos en la banda tiene su marca y su nombre, y se puede elegir", () => {
    // Epsilon Indi B en la banda 1: la epoca 4 no tiene exposiciones en ese detector.
    const onSelect = vi.fn();
    render(
      <TimelineTrack
        label="Línea de tiempo"
        epochs={epochs(FOUR, ["loaded", "loaded", "loaded", "empty"])}
        current={1}
        onSelect={onSelect}
      />,
    );

    expect(drawnStates()).toEqual(["current", "loaded", "loaded", "empty"]);
    const empty = screen.getByRole("radio", { name: "Época 4, 2026-09, sin datos" });
    expect((empty as HTMLInputElement).disabled).toBe(false);

    // Como una banda sin datos en la epoca actual: atenuada, pero elegible.
    fireEvent.click(empty);
    expect(onSelect).toHaveBeenCalledWith(4);
  });

  it("la epoca actual va en ambar aunque no tenga datos, y su nombre lo dice", () => {
    render(
      <TimelineTrack
        label="Línea de tiempo"
        epochs={epochs(FOUR, ["loaded", "loaded", "loaded", "empty"])}
        current={4}
        onSelect={() => {}}
      />,
    );

    expect(drawnStates()).toEqual(["loaded", "loaded", "loaded", "current"]);
    expect(
      (screen.getByRole("radio", { name: "Época 4, 2026-09, sin datos" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("acepta tal cual los estados que entrega la capa de datos", () => {
    // Si los vocabularios se separan, esta asignacion deja de compilar.
    const fromSelector: EpochLoadState[] = ["loaded", "provisional", "unloaded", "empty"];
    const forTimeline: EpochStatus[] = fromSelector;
    const back: EpochLoadState[] = forTimeline;

    render(
      <TimelineTrack
        label="Línea de tiempo"
        epochs={epochs(FOUR, forTimeline)}
        current={null}
        onSelect={() => {}}
      />,
    );
    expect(drawnStates()).toEqual(back);
  });

  it("las paradas cuelgan de una caja con alto propio, no del fieldset", () => {
    // Dentro de un fieldset, Chrome y Edge le daban alto 0 a la capa de las
    // paradas y el radio que recibe el toque quedaba de 56 x 0.
    render(<Track initial={2} />);
    const stops = radios()[0]?.closest("label")?.parentElement;
    const rail = stops?.parentElement;

    expect(stops?.tagName).toBe("DIV");
    expect(rail?.tagName).toBe("DIV");
    const track = screen.getByRole("group", { name: "Línea de tiempo" });
    expect(rail?.parentElement).toBe(track);
    expect(track.tagName).toBe("FIELDSET");
    // El ancho de la parada llega a la hoja de estilos desde timelineLayout.ts.
    expect(track.style.getPropertyValue("--epoch-stop-width")).toBe(`${EPOCH_STOP_WIDTH_PX}px`);
  });

  it("muestra el mes de inicio debajo de cada marca", () => {
    render(<Track initial={2} />);

    for (const month of ["2025-04", "2025-09", "2026-04", "2026-09"]) {
      const date = screen.getByText(month);
      // La fecha ya esta en el nombre de la marca: el texto visible no se repite al leer.
      expect(date.getAttribute("aria-hidden")).toBe("true");
      expect(date.closest("label")).toBeTruthy();
    }
  });

  it("ubica las marcas segun su fecha", () => {
    render(<Track initial={2} />);
    const lefts = radios().map((radio) =>
      Number.parseFloat(radio.closest("label")?.style.left ?? ""),
    );
    const span = (FOUR[3] as number) - (FOUR[0] as number);

    expect(lefts[0]).toBe(0);
    expect(lefts[3]).toBe(100);
    expect(lefts[1]).toBeCloseTo((((FOUR[1] as number) - (FOUR[0] as number)) / span) * 100, 2);
    expect(lefts[2]).toBeCloseTo((((FOUR[2] as number) - (FOUR[0] as number)) / span) * 100, 2);
  });

  describe("con dos epocas muy cercanas", () => {
    // Dos pasadas a 61 dias una de otra en un campo de 430 dias.
    const CLOSE = [60800, 60861, 61050, 61230];
    const CLOSE_EPOCHS = epochs(CLOSE, ["loaded", "loaded", "loaded", "loaded"]);

    /** Hace que la pista mida `width` pixeles, como en un navegador. */
    function trackWidth(width: number): void {
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
    }

    function lefts(): number[] {
      return radios().map((radio) => Number.parseFloat(radio.closest("label")?.style.left ?? ""));
    }

    function renderClose() {
      return render(
        <TimelineTrack
          label="Línea de tiempo"
          epochs={CLOSE_EPOCHS}
          current={1}
          onSelect={() => {}}
        />,
      );
    }

    it("sin medir la pista usa la separacion por defecto", () => {
      renderClose();
      expect(lefts()[1]).toBeCloseTo(MIN_EPOCH_GAP * 100, 6);
    });

    it("en una pista angosta separa las marcas el ancho de una parada, para que las fechas no se pisen", () => {
      // La pista de la galeria en un celular de 390 px mide 280; el 16 % son 44,8 px
      // y la fecha mide 46,2.
      trackWidth(280);
      renderClose();
      const positions = lefts();
      const gapPx = (((positions[1] as number) - (positions[0] as number)) / 100) * 280;

      expect(gapPx).toBeCloseTo(EPOCH_STOP_WIDTH_PX, 1);
      expect(gapPx).toBeGreaterThan(46.2);
    });

    it("en una pista ancha la separacion por defecto ya alcanza y no cambia nada", () => {
      trackWidth(494);
      renderClose();
      expect(lefts()[1]).toBeCloseTo(MIN_EPOCH_GAP * 100, 6);
      expect(MIN_EPOCH_GAP * 494).toBeGreaterThan(EPOCH_STOP_WIDTH_PX);
    });

    it("sigue los cambios de tamano de la pista", () => {
      let notify: () => void = () => {};
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: () => void) {
            notify = callback;
          }
          observe(): void {}
          disconnect(): void {}
        },
      );
      const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(494);
      renderClose();
      expect(lefts()[1]).toBeCloseTo(16, 6);

      // La ventana se achica (o el celular gira).
      width.mockReturnValue(250);
      act(() => notify());
      expect(lefts()[1]).toBeCloseTo((EPOCH_STOP_WIDTH_PX / 250) * 100, 2);
    });
  });

  it("al elegir una marca avisa el numero de epoca y pasa a ser la actual", () => {
    const onSelect = vi.fn();
    render(<Track initial={2} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("radio", { name: "Época 4, 2026-09, sin cargar" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(4);
    expect(drawnStates()).toEqual(["loaded", "loaded", "provisional", "current"]);
  });

  it("las marcas comparten un nombre de grupo: el navegador pasa de epoca con las flechas", () => {
    render(<Track initial={2} />);
    const names = new Set(radios().map((radio) => radio.name));

    expect(names.size).toBe(1);
    expect([...names][0]).not.toBe("");
  });

  it("sin epoca actual no hay ninguna marca elegida ni en ambar", () => {
    render(
      <TimelineTrack
        label="Línea de tiempo"
        epochs={THREE_EPOCHS}
        current={null}
        onSelect={() => {}}
      />,
    );

    expect(radios().some((radio) => radio.checked)).toBe(false);
    expect(drawnStates()).toEqual(["loaded", "loaded", "provisional"]);
  });

  it("deshabilitada no deja elegir", () => {
    const onSelect = vi.fn();
    render(
      <TimelineTrack
        label="Línea de tiempo"
        epochs={THREE_EPOCHS}
        current={1}
        onSelect={onSelect}
        disabled
      />,
    );

    fireEvent.click(radios()[2] as HTMLInputElement);
    expect(onSelect).not.toHaveBeenCalled();
    expect((screen.getByRole("group") as HTMLFieldSetElement).disabled).toBe(true);
  });

  it("los nombres salen en ingles con la interfaz en ingles", async () => {
    await setLanguage("en");
    render(<Track initial={2} />);

    expect(radios().map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "Epoch 1, 2025-04, loaded",
      "Epoch 2, 2025-09, loaded",
      "Epoch 3, 2026-04, provisional",
      "Epoch 4, 2026-09, not loaded",
    ]);
  });
});

describe("EpochLegend", () => {
  it("explica los cuatro estados con su marca y su texto", () => {
    render(<EpochLegend />);

    const list = screen.getByRole("list", { name: "Referencias de la línea de tiempo" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "cargada",
      "provisoria",
      "sin cargar",
      "actual",
    ]);
    expect(
      items.map((item) => item.querySelector("[data-state]")?.getAttribute("data-state")),
    ).toEqual(["loaded", "provisional", "unloaded", "current"]);
    expect(EPOCH_LEGEND_STATES).toEqual(["loaded", "provisional", "unloaded", "current"]);
  });

  it("puede mostrar solo algunos estados", () => {
    render(<EpochLegend states={["loaded", "current"]} />);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "cargada",
      "actual",
    ]);
  });

  it("con una epoca sin datos se le suma ese estado, tambien en ingles", async () => {
    const { unmount } = render(<EpochLegend states={EPOCH_MARKER_STATES} />);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "cargada",
      "provisoria",
      "sin cargar",
      "sin datos",
      "actual",
    ]);
    unmount();

    await setLanguage("en");
    render(<EpochLegend states={["unloaded", "empty"]} />);
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "not loaded",
      "no data",
    ]);
  });
});
