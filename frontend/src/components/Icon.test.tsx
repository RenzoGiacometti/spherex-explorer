import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ICON_NAMES, Icon } from "./Icon";

// Que el juego sea el de DESIGN.md se comprueba en Icon.design.test.ts.

describe("Icon", () => {
  it("incluye los que usan los paneles del visor y la entrada", () => {
    for (const name of [
      "alert",
      "play",
      "pause",
      "prev",
      "next",
      "search",
      "close",
      "layers",
    ] as const) {
      expect(ICON_NAMES).toContain(name);
    }
  });

  it.each(ICON_NAMES)("%s es un SVG de linea con el color del texto", (name) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("data-icon")).toBe(name);
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg?.getAttribute("stroke")).toBe("currentColor");
    expect(svg?.getAttribute("fill")).toBe("none");
    expect(svg?.getAttribute("stroke-width")).toBe("1.5");
    expect(svg?.getAttribute("stroke-linecap")).toBe("round");
    expect(svg?.getAttribute("stroke-linejoin")).toBe("round");
    // Tiene trazos y ninguno lleva relleno ni color propio.
    const shapes = [...(svg?.querySelectorAll("path, circle, rect") ?? [])];
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) {
      expect(shape.hasAttribute("fill")).toBe(false);
      expect(shape.hasAttribute("stroke")).toBe(false);
    }
  });

  it("sin nombre accesible es decorativo: queda oculto para los lectores de pantalla", () => {
    const { container } = render(<Icon name="alert" />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("focusable")).toBe("false");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("con nombre accesible es una imagen con ese nombre", () => {
    render(<Icon name="alert" label="Aviso" />);
    const image = screen.getByRole("img", { name: "Aviso" });

    expect(image.hasAttribute("aria-hidden")).toBe(false);
    expect(image.querySelector("title")?.textContent).toBe("Aviso");
  });

  it("respeta el lado pedido y por defecto mide 20 px", () => {
    const { container, rerender } = render(<Icon name="search" />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("20");
    expect(container.querySelector("svg")?.getAttribute("height")).toBe("20");

    rerender(<Icon name="search" size={18} />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("18");
  });

  it("suma la clase que recibe", () => {
    const { container } = render(<Icon name="search" className="extra" />);
    expect(container.querySelector("svg")?.classList.contains("extra")).toBe(true);
  });
});
