import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Toggle } from "./Toggle";

function Controlled({ initial = false }: { initial?: boolean }) {
  const [checked, setChecked] = useState(initial);
  return <Toggle label="Píxeles marcados" checked={checked} onChange={setChecked} />;
}

describe("Toggle", () => {
  it("es un conmutador con el rotulo como nombre", () => {
    render(<Toggle label="Píxeles marcados" checked={false} onChange={() => {}} />);
    const toggle = screen.getByRole("switch", { name: "Píxeles marcados" }) as HTMLInputElement;

    expect(toggle.checked).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // Es una casilla nativa: la barra espaciadora la cambia sin codigo propio.
    expect(toggle.tagName).toBe("INPUT");
    expect(toggle.type).toBe("checkbox");
  });

  it("avisa el estado nuevo al hacer clic", () => {
    const onChange = vi.fn();
    const { rerender } = render(<Toggle label="Rastro" checked={false} onChange={onChange} />);

    fireEvent.click(screen.getByRole("switch", { name: "Rastro" }));
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(<Toggle label="Rastro" checked onChange={onChange} />);
    fireEvent.click(screen.getByRole("switch", { name: "Rastro" }));
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("el clic en el rotulo tambien lo cambia", () => {
    render(<Controlled />);
    const toggle = screen.getByRole("switch", { name: "Píxeles marcados" }) as HTMLInputElement;

    fireEvent.click(screen.getByText("Píxeles marcados"));
    expect(toggle.checked).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByText("Píxeles marcados"));
    expect(toggle.checked).toBe(false);
  });

  it("deshabilitado no cambia", () => {
    const onChange = vi.fn();
    render(<Toggle label="Rastro" checked={false} onChange={onChange} disabled />);
    const toggle = screen.getByRole("switch", { name: "Rastro" }) as HTMLInputElement;

    fireEvent.click(toggle);
    expect(toggle.disabled).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});
