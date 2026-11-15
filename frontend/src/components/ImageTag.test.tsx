import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatWavelength } from "@/lib/format";
import { ImageTag } from "./ImageTag";

describe("ImageTag", () => {
  it("plano provisorio: la palabra y el dato con las exposiciones", () => {
    const { container } = render(<ImageTag label="Provisorio" value="9 / 18 exposiciones" />);

    expect(screen.getByText("Provisorio")).toBeTruthy();
    expect(screen.getByText("9 / 18 exposiciones")).toBeTruthy();
    // Leido de corrido (sin lo decorativo), la palabra y el dato quedan separados.
    const read = container.cloneNode(true) as HTMLElement;
    for (const hidden of read.querySelectorAll("[aria-hidden]")) hidden.remove();
    expect(read.textContent).toBe("Provisorio 9 / 18 exposiciones");
  });

  it("el punto medio es decorativo", () => {
    render(<ImageTag label="Provisorio" value="9 / 18 exposiciones" />);
    expect(screen.getByText("·").getAttribute("aria-hidden")).toBe("true");
  });

  it("vista de otro relevamiento: banda y segunda linea aclaratoria", () => {
    render(
      <ImageTag
        label="Vista provisoria"
        value={`WISE ${formatWavelength(3.4, "es", 1)}`}
        note="No es una imagen de SPHEREx."
      />,
    );

    expect(screen.getByText("Vista provisoria")).toBeTruthy();
    expect(screen.getByText("WISE 3,4 µm")).toBeTruthy();
    const note = screen.getByText("No es una imagen de SPHEREx.");
    expect(note.tagName).toBe("P");
    // La aclaracion va en su propio renglon, fuera de la pildora.
    expect(note.contains(screen.getByText("Vista provisoria"))).toBe(false);
  });

  it("sin dato no dibuja el separador, y sin nota no dibuja la segunda linea", () => {
    const { container } = render(<ImageTag label="Provisorio" />);

    expect(screen.queryByText("·")).toBeNull();
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("suma la clase que recibe, para ubicarlo sobre la imagen", () => {
    const { container } = render(<ImageTag label="Provisorio" className="arriba" />);
    expect(container.firstElementChild?.classList.contains("arriba")).toBe(true);
  });
});
