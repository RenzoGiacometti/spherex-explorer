import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { initI18n, setLanguage } from "@/i18n";
import { groupNotices, QualityNotice, QualityNoticeList } from "./QualityNotice";

const SATURATED = "Hay una fuente saturada en el campo.";
const FEW = "Época 1: imagen armada con pocas exposiciones.";
const PROVISIONAL = "Una de las épocas comparadas es provisoria.";

beforeEach(async () => {
  initI18n("es");
  await setLanguage("es");
});

describe("QualityNotice", () => {
  it("es el icono alert mas una frase", () => {
    const { container } = render(<QualityNotice>{SATURATED}</QualityNotice>);

    expect(screen.getByText(SATURATED)).toBeTruthy();
    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("data-icon")).toBe("alert");
    expect(icon?.getAttribute("width")).toBe("18");
    // El icono acompana: lo que se lee es el texto.
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(container.firstElementChild?.tagName).toBe("P");
  });

  it("no usa color semantico: ni estilos en linea ni colores en el icono", () => {
    const { container } = render(<QualityNotice>{SATURATED}</QualityNotice>);

    expect(container.querySelector("[style]")).toBeNull();
    expect(container.querySelector("svg")?.getAttribute("stroke")).toBe("currentColor");
  });

  it("sin repeticiones no muestra cantidad", () => {
    render(<QualityNotice>{SATURATED}</QualityNotice>);
    expect(screen.queryByText(/×/)).toBeNull();
  });

  it("repetido muestra la cantidad y la dice con palabras", () => {
    const { container } = render(<QualityNotice count={6}>{FEW}</QualityNotice>);

    const visible = screen.getByText("×6");
    expect(visible.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("6 veces")).toBeTruthy();
    // Leido de corrido (sin lo decorativo): la frase y la cantidad, separadas.
    const read = container.cloneNode(true) as HTMLElement;
    for (const hidden of read.querySelectorAll("[aria-hidden]")) hidden.remove();
    expect(read.textContent).toBe(`${FEW} 6 veces`);
  });

  it("la cantidad sale en ingles con la interfaz en ingles", async () => {
    await setLanguage("en");
    render(<QualityNotice count={3}>{FEW}</QualityNotice>);
    expect(screen.getByText("3 times")).toBeTruthy();
  });
});

describe("groupNotices", () => {
  it("junta las frases repetidas y conserva el orden de aparicion", () => {
    expect(
      groupNotices([
        { text: SATURATED },
        { text: FEW },
        { text: SATURATED },
        { text: PROVISIONAL },
        { text: FEW },
        { text: FEW },
      ]),
    ).toEqual([
      { key: SATURATED, text: SATURATED, count: 2 },
      { key: FEW, text: FEW, count: 3 },
      { key: PROVISIONAL, text: PROVISIONAL, count: 1 },
    ]);
  });

  it("con clave agrupa aunque las frases difieran, y muestra la primera", () => {
    expect(
      groupNotices([
        { key: "few_exposures", text: "Época 1, B1: pocas exposiciones." },
        { key: "few_exposures", text: "Época 1, B4: pocas exposiciones." },
        { key: "plane_empty", text: "Época 4, B1: sin exposiciones." },
      ]),
    ).toEqual([
      { key: "few_exposures", text: "Época 1, B1: pocas exposiciones.", count: 2 },
      { key: "plane_empty", text: "Época 4, B1: sin exposiciones.", count: 1 },
    ]);
  });

  it("sin avisos no hay grupos", () => {
    expect(groupNotices([])).toEqual([]);
  });
});

describe("QualityNoticeList", () => {
  it("dibuja un renglon por grupo, con su cantidad", () => {
    render(
      <QualityNoticeList
        notices={[
          { text: SATURATED },
          ...Array.from({ length: 6 }, () => ({ text: FEW })),
          { text: PROVISIONAL },
        ]}
      />,
    );

    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0] as HTMLElement).getByText(SATURATED)).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText(FEW)).toBeTruthy();
    expect(within(items[1] as HTMLElement).getByText("×6")).toBeTruthy();
    expect(within(items[0] as HTMLElement).queryByText(/×/)).toBeNull();
    // Cada renglon lleva su icono alert.
    for (const item of items) {
      expect(item.querySelector("svg")?.getAttribute("data-icon")).toBe("alert");
    }
  });

  it("sin avisos muestra el texto de lista vacia, si lo recibe", () => {
    const { container, rerender } = render(<QualityNoticeList notices={[]} />);
    expect(container.firstElementChild).toBeNull();

    rerender(<QualityNoticeList notices={[]} emptyText="Este campo no tiene avisos." />);
    expect(screen.getByText("Este campo no tiene avisos.")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });
});
