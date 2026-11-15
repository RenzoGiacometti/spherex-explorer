import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, setLanguage } from "@/i18n";
import { LanguageSelector } from "./LanguageSelector";

beforeEach(async () => {
  initI18n("es");
  await setLanguage("es");
});

describe("LanguageSelector", () => {
  it("ofrece espanol e ingles, con el idioma activo elegido", () => {
    render(<LanguageSelector value="es" onChange={() => {}} />);

    const group = screen.getByRole("group", { name: "Idioma" });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual(["Español", "English"]);
    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
  });

  it("las celdas muestran el codigo del idioma", () => {
    render(<LanguageSelector value="en" onChange={() => {}} />);

    expect(screen.getByText("es")).toBeTruthy();
    expect(screen.getByText("en")).toBeTruthy();
    expect((screen.getByRole("radio", { name: "English" }) as HTMLInputElement).checked).toBe(true);
  });

  it("avisa el idioma elegido y no cambia nada por su cuenta", () => {
    const onChange = vi.fn();
    render(<LanguageSelector value="es" onChange={onChange} />);

    fireEvent.click(screen.getByRole("radio", { name: "English" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("en");
    // Sin estado propio: sigue mostrando lo que dice `value`.
    expect((screen.getByRole("radio", { name: "Español" }) as HTMLInputElement).checked).toBe(true);
  });

  it("el nombre del grupo sale en el idioma de la interfaz", async () => {
    await setLanguage("en");
    render(<LanguageSelector value="en" onChange={() => {}} />);

    expect(screen.getByRole("group", { name: "Language" })).toBeTruthy();
    // Cada idioma se nombra en su propia lengua.
    expect(screen.getByRole("radio", { name: "Español" })).toBeTruthy();
  });
});
