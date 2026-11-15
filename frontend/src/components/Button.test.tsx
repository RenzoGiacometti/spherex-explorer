import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, ButtonLink } from "./Button";
import styles from "./Button.module.css";

describe("Button", () => {
  it("por defecto es un boton secundario que no envia formularios", () => {
    render(<Button>Lugar al azar</Button>);
    const button = screen.getByRole("button", { name: "Lugar al azar" });

    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("data-variant")).toBe("ghost");
    expect(button.classList.contains(styles.ghost ?? "")).toBe(true);
    expect(button.classList.contains(styles.primary ?? "")).toBe(false);
  });

  it("la variante principal usa su propia clase", () => {
    render(<Button variant="primary">Buscar</Button>);
    const button = screen.getByRole("button", { name: "Buscar" });

    expect(button.getAttribute("data-variant")).toBe("primary");
    expect(button.classList.contains(styles.primary ?? "")).toBe(true);
    expect(button.classList.contains(styles.ghost ?? "")).toBe(false);
  });

  it("avisa el clic", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Compartir</Button>);

    fireEvent.click(screen.getByRole("button", { name: "Compartir" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("deshabilitado no avisa el clic", () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Compartir
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Compartir" }) as HTMLButtonElement;

    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("el icono es decorativo: el nombre accesible es solo el texto", () => {
    render(<Button icon="shuffle">Lugar al azar</Button>);
    const button = screen.getByRole("button", { name: "Lugar al azar" });
    const icon = button.querySelector("svg");

    expect(icon?.getAttribute("data-icon")).toBe("shuffle");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("puede enviar un formulario y recibe los atributos nativos", () => {
    render(
      <Button type="submit" className="extra" aria-describedby="ayuda">
        Buscar
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Buscar" });

    expect(button.getAttribute("type")).toBe("submit");
    expect(button.getAttribute("aria-describedby")).toBe("ayuda");
    expect(button.classList.contains("extra")).toBe(true);
    expect(button.classList.contains(styles.button ?? "")).toBe(true);
  });
});

describe("ButtonLink", () => {
  it("es un enlace con el aspecto del boton", () => {
    render(
      <ButtonLink href="/?ra=133.7598&dec=-7.2422" variant="primary">
        Abrir en el visor
      </ButtonLink>,
    );
    const link = screen.getByRole("link", { name: "Abrir en el visor" });

    expect(link.getAttribute("href")).toBe("/?ra=133.7598&dec=-7.2422");
    expect(link.getAttribute("data-variant")).toBe("primary");
    expect(link.classList.contains(styles.primary ?? "")).toBe(true);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
