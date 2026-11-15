import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SearchField, type SearchFieldProps } from "./SearchField";

const LABEL = "Buscar por nombre o coordenadas";

function Field({
  initial = "",
  onSubmit = () => {},
  ...rest
}: Partial<SearchFieldProps> & { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <SearchField
      label={LABEL}
      submitLabel="Buscar"
      {...rest}
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
    />
  );
}

function input(): HTMLInputElement {
  return screen.getByRole("searchbox", { name: LABEL }) as HTMLInputElement;
}

describe("SearchField", () => {
  it("es una region de busqueda con la etiqueta visible, el campo y el boton principal", () => {
    render(<Field placeholder="Barnard's Star · 17h 57m 48s +04° 41′ 36″" />);

    const search = screen.getByRole("search", { name: LABEL });
    expect(search.tagName).toBe("FORM");
    expect(screen.getByText(LABEL).tagName).toBe("LABEL");
    expect(input().placeholder).toBe("Barnard's Star · 17h 57m 48s +04° 41′ 36″");

    const button = within(search).getByRole("button", { name: "Buscar" });
    expect(button.getAttribute("type")).toBe("submit");
    expect(button.getAttribute("data-variant")).toBe("primary");
    expect(search.querySelector("svg")?.getAttribute("data-icon")).toBe("search");
  });

  it("repite el ejemplo en un renglon debajo del campo, para el celular, sin anunciarlo dos veces", () => {
    const example = "Barnard's Star · 17h 57m 48s +04° 41′ 36″";
    render(<Field placeholder={example} hint="Un nombre o unas coordenadas." />);

    // En celular el ejemplo no entra en el campo: la hoja de estilos lo saca de
    // ahi y muestra este renglon.
    const line = screen.getByText(example);
    expect(line.tagName).toBe("P");
    // El lector de pantalla ya lo recibe como `placeholder` del campo.
    expect(line.getAttribute("aria-hidden")).toBe("true");
    expect(input().placeholder).toBe(example);
    expect(input().getAttribute("aria-describedby")).not.toContain(line.id || "sin id");
    // Va antes que el texto de ayuda.
    const paragraphs = [...screen.getByRole("search").querySelectorAll("p")];
    expect(paragraphs.map((item) => item.textContent)).toEqual([
      example,
      "Un nombre o unas coordenadas.",
    ]);
  });

  it("sin ejemplo no dibuja ese renglon", () => {
    render(<Field />);
    expect(screen.getByRole("search").querySelectorAll("p")).toHaveLength(0);
  });

  it("avisa cada cambio del texto", () => {
    const onChange = vi.fn();
    render(
      <SearchField
        label={LABEL}
        submitLabel="Buscar"
        value=""
        onChange={onChange}
        onSubmit={() => {}}
      />,
    );

    fireEvent.change(input(), { target: { value: "WISE 0855" } });
    expect(onChange).toHaveBeenCalledWith("WISE 0855");
  });

  it("al enviar entrega el texto sin espacios en las puntas", () => {
    const onSubmit = vi.fn();
    render(<Field onSubmit={onSubmit} />);

    fireEvent.change(input(), { target: { value: "  Barnard's Star " } });
    fireEvent.submit(screen.getByRole("search"));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("Barnard's Star");
  });

  it("el boton envia el formulario", () => {
    const onSubmit = vi.fn();
    render(<Field initial="R Draconis" onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    expect(onSubmit).toHaveBeenCalledWith("R Draconis");
  });

  it("vacio o con solo espacios no envia nada", () => {
    const onSubmit = vi.fn();
    render(<Field onSubmit={onSubmit} />);

    fireEvent.submit(screen.getByRole("search"));
    fireEvent.change(input(), { target: { value: "   " } });
    fireEvent.submit(screen.getByRole("search"));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("con una busqueda en curso deshabilita el boton y no vuelve a enviar", () => {
    const onSubmit = vi.fn();
    render(<Field initial="WISE 0855" onSubmit={onSubmit} busy />);

    const button = screen.getByRole("button", { name: "Buscar" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByRole("search").getAttribute("aria-busy")).toBe("true");

    fireEvent.submit(screen.getByRole("search"));
    expect(onSubmit).not.toHaveBeenCalled();
    // El texto se puede seguir editando.
    expect(input().disabled).toBe(false);
  });

  it("el texto de ayuda queda asociado al campo", () => {
    render(<Field hint="Un nombre de catálogo o unas coordenadas." />);

    const hint = screen.getByText("Un nombre de catálogo o unas coordenadas.");
    expect(input().getAttribute("aria-describedby")).toBe(hint.id);
    expect(input().hasAttribute("aria-invalid")).toBe(false);
  });

  it("el error se anuncia con el icono alert y texto, y marca el campo", () => {
    render(<Field hint="Ayuda" error="No se encontró ningún objeto con ese nombre." />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("No se encontró ningún objeto con ese nombre.");
    expect(alert.querySelector("svg")?.getAttribute("data-icon")).toBe("alert");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(input().getAttribute("aria-describedby")?.split(" ")).toEqual([
      screen.getByText("Ayuda").id,
      alert.id,
    ]);
    // Sin color semantico: nada lleva estilos en linea.
    expect(screen.getByRole("search").querySelector("[style]")).toBeNull();
  });

  it("sin ayuda ni error no declara descripciones", () => {
    render(<Field />);

    expect(input().hasAttribute("aria-describedby")).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("entrega la referencia al campo de texto", () => {
    const ref = createRef<HTMLInputElement>();
    render(<Field inputRef={ref} />);

    expect(ref.current).toBe(input());
  });

  it("dos campos no comparten id", () => {
    render(
      <>
        <Field hint="Primera ayuda" />
        <Field hint="Segunda ayuda" />
      </>,
    );
    const [first, second] = screen.getAllByRole("searchbox");

    expect(first?.id).not.toBe(second?.id);
    expect(first?.getAttribute("aria-describedby")).toBe(screen.getByText("Primera ayuda").id);
    expect(second?.getAttribute("aria-describedby")).toBe(screen.getByText("Segunda ayuda").id);
  });
});
