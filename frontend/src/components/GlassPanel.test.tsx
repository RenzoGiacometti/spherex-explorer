import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GlassPanel } from "./GlassPanel";
import styles from "./GlassPanel.module.css";

describe("GlassPanel", () => {
  it("con titulo es una seccion con ese nombre y un encabezado de nivel 2", () => {
    render(
      <GlassPanel title="Metadatos" icon="info">
        <p>contenido</p>
      </GlassPanel>,
    );

    const region = screen.getByRole("region", { name: "Metadatos" });
    expect(region.tagName).toBe("SECTION");
    expect(screen.getByRole("heading", { level: 2, name: "Metadatos" })).toBeTruthy();
    expect(screen.getByText("contenido")).toBeTruthy();
    // El icono del encabezado mide 18 px y es decorativo.
    const icon = region.querySelector("svg");
    expect(icon?.getAttribute("data-icon")).toBe("info");
    expect(icon?.getAttribute("width")).toBe("18");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("muestra lo que va a la derecha del encabezado", () => {
    render(<GlassPanel title="Avisos de calidad" icon="alert" aside="3" />);

    expect(screen.getByText("3")).toBeTruthy();
    // La cantidad no forma parte del nombre de la seccion.
    expect(screen.getByRole("region", { name: "Avisos de calidad" })).toBeTruthy();
  });

  it("sin titulo no dibuja encabezado y toma el nombre de label", () => {
    render(<GlassPanel label="Herramientas">x</GlassPanel>);

    expect(screen.getByRole("region", { name: "Herramientas" })).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("sin titulo ni label es un contenedor sin rol", () => {
    const { container } = render(<GlassPanel>x</GlassPanel>);

    expect(screen.queryByRole("region")).toBeNull();
    expect(container.firstElementChild?.tagName).toBe("DIV");
  });

  it("puede dibujarse con otro elemento", () => {
    render(
      <GlassPanel as="nav" label="Herramientas">
        x
      </GlassPanel>,
    );

    expect(screen.getByRole("navigation", { name: "Herramientas" })).toBeTruthy();
  });

  it("el relleno amplio suma su clase y conserva la del panel", () => {
    const { container, rerender } = render(<GlassPanel>x</GlassPanel>);
    const panel = () => container.firstElementChild as HTMLElement;

    expect(panel().classList.contains(styles.panel ?? "")).toBe(true);
    expect(panel().classList.contains(styles.roomy ?? "")).toBe(false);

    rerender(
      <GlassPanel padding="roomy" className="extra">
        x
      </GlassPanel>,
    );
    expect(panel().classList.contains(styles.roomy ?? "")).toBe(true);
    expect(panel().classList.contains("extra")).toBe(true);
  });
});
