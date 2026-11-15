import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { formatPercent } from "@/lib/format";
import { Slider } from "./Slider";

function Contrast({ onChange }: { onChange?: (value: number) => void }) {
  const [value, setValue] = useState(65);
  return (
    <Slider
      label="Contraste"
      value={value}
      valueText={formatPercent(value / 100, "es")}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe("Slider", () => {
  it("es un control nativo de rango rotulado por su etiqueta visible", () => {
    render(<Contrast />);
    const slider = screen.getByRole("slider", { name: "Contraste" }) as HTMLInputElement;

    // Nativo: flechas, Inicio, Fin y Av/Re Pag funcionan sin codigo propio.
    expect(slider.tagName).toBe("INPUT");
    expect(slider.type).toBe("range");
    expect(slider.value).toBe("65");
    expect(screen.getByLabelText("Contraste")).toBe(slider);
  });

  it("por defecto va de 0 a 100 de a 1, y admite otros limites", () => {
    const { rerender } = render(<Contrast />);
    const slider = () => screen.getByRole("slider") as HTMLInputElement;

    expect([slider().min, slider().max, slider().step]).toEqual(["0", "100", "1"]);

    rerender(
      <Slider label="Corte" value={0.5} min={-2} max={10} step={0.25} onChange={() => {}} />,
    );
    expect([slider().min, slider().max, slider().step]).toEqual(["-2", "10", "0.25"]);
    expect(slider().value).toBe("0.5");
  });

  it("muestra el valor formateado y lo anuncia", () => {
    render(<Contrast />);

    expect(screen.getByText("65 %")).toBeTruthy();
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("65 %");
  });

  it("avisa el valor nuevo como numero", () => {
    const onChange = vi.fn();
    render(<Contrast onChange={onChange} />);
    const slider = screen.getByRole("slider") as HTMLInputElement;

    fireEvent.change(slider, { target: { value: "80" } });

    expect(onChange).toHaveBeenCalledWith(80);
    expect(slider.value).toBe("80");
    expect(screen.getByText("80 %")).toBeTruthy();
    expect(slider.getAttribute("aria-valuetext")).toBe("80 %");
  });

  it("sin valueText no muestra ni anuncia un texto", () => {
    render(<Slider label="Contraste" value={10} onChange={() => {}} />);

    expect(screen.getByRole("slider").hasAttribute("aria-valuetext")).toBe(false);
    expect(screen.queryByText("10")).toBeNull();
  });

  it("deshabilitado queda inactivo", () => {
    render(<Slider label="Contraste" value={10} onChange={() => {}} disabled />);
    expect((screen.getByRole("slider") as HTMLInputElement).disabled).toBe(true);
  });

  it("dos deslizadores no comparten id", () => {
    render(
      <>
        <Slider label="Contraste" value={10} onChange={() => {}} />
        <Slider label="Brillo" value={20} onChange={() => {}} />
      </>,
    );

    expect((screen.getByLabelText("Contraste") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("Brillo") as HTMLInputElement).value).toBe("20");
  });
});
