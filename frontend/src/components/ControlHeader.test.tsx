import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ControlHeader } from "./ControlHeader";

describe("ControlHeader", () => {
  it("muestra el rotulo y el valor", () => {
    render(<ControlHeader label="Campo de visión" value="10′ × 10′" />);

    expect(screen.getByText("Campo de visión").tagName).toBe("SPAN");
    expect(screen.getByText("10′ × 10′")).toBeTruthy();
  });

  it("sin valor solo dibuja el rotulo", () => {
    const { container } = render(<ControlHeader label="Contraste" />);
    expect(container.querySelectorAll("span")).toHaveLength(1);
  });

  it("con htmlFor el rotulo es la etiqueta del control", () => {
    render(
      <>
        <ControlHeader label="Contraste" value="65 %" htmlFor="contraste" />
        <input id="contraste" type="range" readOnly />
      </>,
    );

    expect(screen.getByText("Contraste").tagName).toBe("LABEL");
    expect(screen.getByLabelText("Contraste")).toBe(screen.getByRole("slider"));
  });

  it("con id el rotulo puede nombrar a otro elemento", () => {
    render(
      <>
        <ControlHeader label="Velocidad" id="velocidad" />
        <ul aria-labelledby="velocidad" />
      </>,
    );

    expect(screen.getByRole("list", { name: "Velocidad" })).toBeTruthy();
  });
});
