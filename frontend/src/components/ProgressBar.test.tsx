import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatPercent } from "@/lib/format";
import { ProgressBar } from "./ProgressBar";
import styles from "./ProgressBar.module.css";

function fill(bar: HTMLElement): HTMLElement {
  return bar.firstElementChild as HTMLElement;
}

describe("ProgressBar", () => {
  it("es una barra de progreso con la etiqueta como nombre y el conteo como texto", () => {
    const text = `14 / 22 recortes · ${formatPercent(14 / 22, "es")}`;
    render(<ProgressBar label="Cargando datos" value={14 / 22} valueText={text} />);

    const bar = screen.getByRole("progressbar", { name: "Cargando datos" });
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-valuenow")).toBe("64");
    expect(bar.getAttribute("aria-valuetext")).toBe("14 / 22 recortes · 64 %");
    // La etiqueta y el conteo tambien estan a la vista.
    expect(screen.getByText("Cargando datos")).toBeTruthy();
    expect(screen.getByText("14 / 22 recortes · 64 %")).toBeTruthy();
  });

  it("el ancho del avance sigue al valor", () => {
    const { rerender } = render(<ProgressBar label="Cargando datos" value={0.25} />);
    const bar = () => screen.getByRole("progressbar");

    expect(fill(bar()).style.getPropertyValue("--progress-value")).toBe("25%");
    rerender(<ProgressBar label="Cargando datos" value={1} />);
    expect(fill(bar()).style.getPropertyValue("--progress-value")).toBe("100%");
    expect(bar().getAttribute("aria-valuenow")).toBe("100");
  });

  it("lleva a 0 y a 100 los valores fuera de rango o que no son numeros", () => {
    const { rerender } = render(<ProgressBar label="Cargando datos" value={1.7} />);
    const now = () => screen.getByRole("progressbar").getAttribute("aria-valuenow");

    expect(now()).toBe("100");
    rerender(<ProgressBar label="Cargando datos" value={-0.2} />);
    expect(now()).toBe("0");
    rerender(<ProgressBar label="Cargando datos" value={Number.NaN} />);
    expect(now()).toBe("0");
  });

  it("con avance desconocido no informa un valor", () => {
    render(<ProgressBar label="En cola" value={null} valueText="Posición 2" />);
    const bar = screen.getByRole("progressbar", { name: "En cola" });

    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.getAttribute("aria-valuetext")).toBe("Posición 2");
    expect(fill(bar).classList.contains(styles.indeterminate ?? "")).toBe(true);
  });

  it("con avance conocido no usa el dibujo de avance desconocido", () => {
    render(<ProgressBar label="Cargando datos" value={0.5} />);
    expect(
      fill(screen.getByRole("progressbar")).classList.contains(styles.indeterminate ?? ""),
    ).toBe(false);
  });

  it("sin conteo no dibuja el texto de la derecha", () => {
    const { container } = render(<ProgressBar label="Cargando datos" value={0.5} />);

    expect(screen.getByRole("progressbar").hasAttribute("aria-valuetext")).toBe(false);
    expect(container.querySelectorAll("span")).toHaveLength(1);
  });
});
