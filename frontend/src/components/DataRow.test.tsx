import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatDec, formatRa } from "@/lib/format";
import { DataGroup, DataRow } from "./DataRow";

describe("DataGroup y DataRow", () => {
  it("arman una lista de descripcion con un termino y un valor por fila", () => {
    const { container } = render(
      <DataGroup>
        <DataRow label="AR (J2000)" value={formatRa(331.0966)} />
        <DataRow label="Dec (J2000)" value={formatDec(-56.8006)} />
      </DataGroup>,
    );

    expect(container.querySelector("dl")).toBeTruthy();
    const terms = screen.getAllByRole("term");
    const values = screen.getAllByRole("definition");
    expect(terms.map((term) => term.textContent)).toEqual(["AR (J2000)", "Dec (J2000)"]);
    expect(values.map((value) => value.textContent)).toEqual(["22h 04m 23s", "−56° 48′ 02″"]);
    // Cada fila agrupa su termino con su valor.
    expect(terms[0]?.parentElement).toBe(values[0]?.parentElement);
    expect(terms[0]?.parentElement?.parentElement?.tagName).toBe("DL");
  });

  it("el valor puede ser un nodo", () => {
    render(
      <DataGroup>
        <DataRow label="Banda" value={<span data-testid="valor">B3</span>} />
      </DataGroup>,
    );

    expect(screen.getByTestId("valor").closest("dd")).toBeTruthy();
  });

  it("solo con truncate deja el texto completo en title", () => {
    render(
      <DataGroup>
        <DataRow label="Objeto" value="WISEA J085510.74-071442.5" truncate />
        <DataRow label="Fuente" value="SPHEREx" />
      </DataGroup>,
    );

    const [object, source] = screen.getAllByRole("definition");
    expect(object?.getAttribute("title")).toBe("WISEA J085510.74-071442.5");
    expect(source?.hasAttribute("title")).toBe(false);
  });

  it("suma la clase que recibe el grupo", () => {
    const { container } = render(<DataGroup className="extra" />);
    expect(container.querySelector("dl")?.classList.contains("extra")).toBe(true);
  });
});
