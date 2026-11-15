import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IconButton, IconLink } from "./IconButton";
import styles from "./IconButton.module.css";

describe("IconButton", () => {
  it("el nombre accesible sale de label y el icono queda oculto", () => {
    render(<IconButton icon="share" label="Compartir" />);
    const button = screen.getByRole("button", { name: "Compartir" });

    expect(button.getAttribute("type")).toBe("button");
    expect(button.querySelector("svg")?.getAttribute("data-icon")).toBe("share");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // Sin `pressed` no es un boton de dos estados.
    expect(button.hasAttribute("aria-pressed")).toBe(false);
  });

  it("por defecto es redondo, de 44 px y con borde", () => {
    render(<IconButton icon="share" label="Compartir" />);
    const button = screen.getByRole("button", { name: "Compartir" });

    expect(button.getAttribute("data-variant")).toBe("outline");
    expect(button.getAttribute("data-size")).toBe("md");
    expect(button.getAttribute("data-shape")).toBe("round");
    expect(button.classList.contains(styles.md ?? "")).toBe(true);
    expect(button.classList.contains(styles.square ?? "")).toBe(false);
    expect(button.querySelector("svg")?.getAttribute("width")).toBe("20");
  });

  it("avisa el clic y deshabilitado no", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <IconButton icon="next" label="Época siguiente" onClick={onClick} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Época siguiente" }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<IconButton icon="next" label="Época siguiente" onClick={onClick} disabled />);
    fireEvent.click(screen.getByRole("button", { name: "Época siguiente" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("con pressed informa el estado y, prendido, se dibuja relleno", () => {
    const { rerender } = render(<IconButton icon="layers" label="Capas" pressed={false} />);
    const button = () => screen.getByRole("button", { name: "Capas" });

    expect(button().getAttribute("aria-pressed")).toBe("false");
    expect(button().getAttribute("data-variant")).toBe("outline");

    rerender(<IconButton icon="layers" label="Capas" pressed />);
    expect(button().getAttribute("aria-pressed")).toBe("true");
    expect(button().getAttribute("data-variant")).toBe("solid");
    expect(button().classList.contains(styles.solid ?? "")).toBe(true);
  });

  it("admite relleno, sin borde, cuadrado y los cuatro tamanos", () => {
    const { rerender } = render(
      <IconButton icon="play" label="Reproducir" variant="solid" size="xl" />,
    );
    const button = () => screen.getByRole("button", { name: "Reproducir" });

    expect(button().classList.contains(styles.solid ?? "")).toBe(true);
    expect(button().classList.contains(styles.xl ?? "")).toBe(true);
    expect(button().querySelector("svg")?.getAttribute("width")).toBe("28");

    rerender(<IconButton icon="play" label="Reproducir" variant="bare" size="lg" />);
    expect(button().classList.contains(styles.bare ?? "")).toBe(true);
    expect(button().classList.contains(styles.lg ?? "")).toBe(true);
    expect(button().querySelector("svg")?.getAttribute("width")).toBe("24");

    rerender(<IconButton icon="play" label="Reproducir" size="sm" shape="square" />);
    expect(button().classList.contains(styles.sm ?? "")).toBe(true);
    expect(button().classList.contains(styles.square ?? "")).toBe(true);
    expect(button().getAttribute("data-shape")).toBe("square");
    expect(button().querySelector("svg")?.getAttribute("width")).toBe("18");
  });
});

describe("IconLink", () => {
  it("es un enlace con nombre accesible", () => {
    render(<IconLink icon="back" label="Volver a la entrada" href="/" />);
    const link = screen.getByRole("link", { name: "Volver a la entrada" });

    expect(link.getAttribute("href")).toBe("/");
    expect(link.querySelector("svg")?.getAttribute("data-icon")).toBe("back");
    expect(link.classList.contains(styles.button ?? "")).toBe(true);
  });
});
