import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, setLanguage } from "@/i18n";
import { formatArcminutes, formatBand, formatWaveRange } from "@/lib/format";
import { VIEW_FOVS } from "@/lib/fov";
import { SegmentedControl, type SegmentedOption } from "./SegmentedControl";
import styles from "./SegmentedControl.module.css";

// Rangos reales de los detectores (detectors[] de los campos de muestra).
const DETECTORS = [
  { detector: 1, min: 0.7455, max: 1.1167 },
  { detector: 2, min: 1.1033, max: 1.6499 },
  { detector: 3, min: 1.6301, max: 2.4346 },
  { detector: 4, min: 2.4027, max: 3.8473 },
  { detector: 5, min: 3.8113, max: 4.43 },
  { detector: 6, min: 4.4115, max: 5.0096 },
];

/** B1 a B6 con su rango; B5 sin datos y B6 deshabilitada. */
function bandOptions(): SegmentedOption<number>[] {
  return DETECTORS.map((item) => ({
    value: item.detector,
    label: formatBand(item.detector),
    detail: formatWaveRange(item.min, item.max, "es"),
    noData: item.detector === 5,
    disabled: item.detector === 6,
  }));
}

function Bands({ onChange }: { onChange?: (value: number) => void }) {
  const [band, setBand] = useState(3);
  return (
    <SegmentedControl
      label="Banda infrarroja"
      columns={3}
      options={bandOptions()}
      value={band}
      onChange={(value) => {
        setBand(value);
        onChange?.(value);
      }}
    />
  );
}

function radio(name: string): HTMLInputElement {
  return screen.getByRole("radio", { name }) as HTMLInputElement;
}

beforeEach(async () => {
  initI18n("es");
  await setLanguage("es");
});

describe("SegmentedControl", () => {
  it("es un grupo con nombre y un boton de radio por opcion", () => {
    render(<Bands />);

    const group = screen.getByRole("group", { name: "Banda infrarroja" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(6);
    expect(radios.filter((item) => item.checked).map((item) => item.value)).toEqual(["3"]);
  });

  it("la celda de banda muestra el nombre y el rango, y los dos forman el nombre accesible", () => {
    render(<Bands />);

    expect(screen.getByText("B3")).toBeTruthy();
    expect(screen.getByText("1,63–2,43")).toBeTruthy();
    expect(radio("B3 1,63–2,43").checked).toBe(true);
    expect(radio("B1 0,75–1,12").checked).toBe(false);
  });

  it("al elegir otra opcion avisa su valor, con su tipo", () => {
    const onChange = vi.fn();
    render(<Bands onChange={onChange} />);

    fireEvent.click(radio("B4 2,40–3,85"));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(4);
    expect(radio("B4 2,40–3,85").checked).toBe(true);
    expect(radio("B3 1,63–2,43").checked).toBe(false);
  });

  it("volver a elegir la opcion actual no avisa nada", () => {
    const onChange = vi.fn();
    render(<Bands onChange={onChange} />);

    fireEvent.click(radio("B3 1,63–2,43"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("una opcion sin datos se atenua, lo dice en su nombre y se puede elegir", () => {
    const onChange = vi.fn();
    render(<Bands onChange={onChange} />);
    const noData = radio("B5 3,81–4,43, sin datos");

    expect(noData.disabled).toBe(false);
    expect(noData.closest("label")?.getAttribute("data-no-data")).toBe("true");
    expect(noData.closest("label")?.classList.contains(styles.noData ?? "")).toBe(true);
    // Las demas no llevan la marca.
    expect(radio("B4 2,40–3,85").closest("label")?.hasAttribute("data-no-data")).toBe(false);

    fireEvent.click(noData);
    expect(onChange).toHaveBeenCalledWith(5);
    expect(noData.checked).toBe(true);
  });

  it("una opcion deshabilitada no se puede elegir", () => {
    const onChange = vi.fn();
    render(<Bands onChange={onChange} />);
    const disabled = radio("B6 4,41–5,01");

    expect(disabled.disabled).toBe(true);
    fireEvent.click(disabled);
    expect(onChange).not.toHaveBeenCalled();
    expect(disabled.checked).toBe(false);
  });

  it("los radios comparten un nombre de grupo: el navegador mueve la seleccion con las flechas", () => {
    render(
      <>
        <Bands />
        <SegmentedControl
          label="Velocidad de reproducción"
          options={[
            { value: 0.5, label: "0,5×" },
            { value: 1, label: "1×" },
            { value: 2, label: "2×" },
          ]}
          value={1}
          onChange={() => {}}
        />
      </>,
    );

    const names = (label: string) =>
      (
        within(screen.getByRole("group", { name: label })).getAllByRole(
          "radio",
        ) as HTMLInputElement[]
      ).map((item) => item.name);
    const bands = new Set(names("Banda infrarroja"));
    const speeds = new Set(names("Velocidad de reproducción"));

    expect(bands.size).toBe(1);
    expect(speeds.size).toBe(1);
    expect([...bands][0]).not.toBe("");
    // Dos controles en la misma pantalla no se mezclan.
    expect([...bands][0]).not.toBe([...speeds][0]);
  });

  it("sin valor no hay ninguna opcion elegida", () => {
    render(
      <SegmentedControl
        label="Modo de comparación"
        options={[
          { value: "blink", label: "Parpadeo" },
          { value: "sum", label: "Suma" },
        ]}
        value={null}
        onChange={() => {}}
      />,
    );

    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.some((item) => item.checked)).toBe(false);
  });

  it("ariaLabel reemplaza el nombre de una celda abreviada", () => {
    render(
      <SegmentedControl
        label="Idioma"
        options={[
          { value: "es", label: "es", ariaLabel: "Español" },
          { value: "en", label: "en", ariaLabel: "English" },
        ]}
        value="es"
        onChange={() => {}}
      />,
    );

    expect(radio("Español").checked).toBe(true);
    expect(radio("English").checked).toBe(false);
    expect(screen.getByText("en")).toBeTruthy();
  });

  it("el campo de vision ofrece 5, 10 y 30 minutos, con el rotulo y el valor a la vista", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Campo de visión"
        showLabel
        valueText="10′ × 10′"
        options={VIEW_FOVS.map((fov) => ({ value: fov, label: formatArcminutes(fov, "es") }))}
        value={0.1667}
        onChange={onChange}
      />,
    );

    expect(screen.getAllByRole("radio").map((item) => item.getAttribute("aria-label"))).toEqual([
      "5′",
      "10′",
      "30′",
    ]);
    expect(radio("10′").checked).toBe(true);
    // El encabezado visible no se anuncia: el nombre ya lo da la leyenda del grupo.
    const header = screen.getByText("10′ × 10′").closest("[aria-hidden]");
    expect(header?.getAttribute("aria-hidden")).toBe("true");
    expect(within(header as HTMLElement).getByText("Campo de visión")).toBeTruthy();

    fireEvent.click(radio("30′"));
    expect(onChange).toHaveBeenCalledWith(0.5);
  });

  it("sin showLabel el rotulo solo queda para los lectores de pantalla", () => {
    render(<Bands />);

    expect(screen.getAllByText("Banda infrarroja")).toHaveLength(1);
    expect(screen.getByText("Banda infrarroja").tagName).toBe("LEGEND");
  });

  it("las columnas de la grilla salen de la propiedad o de la cantidad de opciones", () => {
    const { container, rerender } = render(<Bands />);
    const grid = () => container.querySelector(`.${styles.grid}`) as HTMLElement;

    expect(grid().style.getPropertyValue("--segmented-columns")).toBe("3");

    rerender(
      <SegmentedControl
        label="Velocidad"
        options={[
          { value: 1, label: "1×" },
          { value: 2, label: "2×" },
        ]}
        value={1}
        onChange={() => {}}
      />,
    );
    expect(grid().style.getPropertyValue("--segmented-columns")).toBe("2");
  });

  it("deshabilitado entero no deja elegir nada", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Velocidad"
        options={[
          { value: 1, label: "1×" },
          { value: 2, label: "2×" },
        ]}
        value={1}
        onChange={onChange}
        disabled
      />,
    );

    const group = screen.getByRole("group", { name: "Velocidad" }) as HTMLFieldSetElement;
    expect(group.disabled).toBe(true);
    fireEvent.click(radio("2×"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("el texto de sin datos sale de i18n y se puede reemplazar", async () => {
    await setLanguage("en");
    const { rerender } = render(<Bands />);
    // El rango lo formatea quien arma las opciones; el control solo agrega "no data".
    expect(radio("B5 3,81–4,43, no data")).toBeTruthy();

    rerender(
      <SegmentedControl
        label="Band"
        options={[{ value: 5, label: "B5", noData: true }]}
        value={null}
        onChange={() => {}}
        noDataLabel="no data in this epoch"
      />,
    );
    expect(radio("B5, no data in this epoch")).toBeTruthy();
  });
});
