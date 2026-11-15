import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, setLanguage } from "@/i18n";
import { Transport } from "./Transport";

function handlers() {
  return { onPlayingChange: vi.fn(), onPrevious: vi.fn(), onNext: vi.fn() };
}

beforeEach(async () => {
  initI18n("es");
  await setLanguage("es");
});

describe("Transport", () => {
  it("es un grupo con anterior, reproducir y siguiente, en ese orden", () => {
    render(<Transport playing={false} {...handlers()} />);

    const group = screen.getByRole("group", { name: "Reproducción" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Época anterior", "Reproducir", "Época siguiente"]);
  });

  it("el boton central es el relleno y cambia a pausa mientras reproduce", () => {
    const { rerender } = render(<Transport playing={false} {...handlers()} />);

    const play = screen.getByRole("button", { name: "Reproducir" });
    expect(play.getAttribute("data-variant")).toBe("solid");
    expect(play.querySelector("svg")?.getAttribute("data-icon")).toBe("play");
    expect(
      screen.getByRole("button", { name: "Época anterior" }).getAttribute("data-variant"),
    ).toBe("outline");

    rerender(<Transport playing {...handlers()} />);
    const pause = screen.getByRole("button", { name: "Pausar" });
    expect(pause.querySelector("svg")?.getAttribute("data-icon")).toBe("pause");
    expect(screen.queryByRole("button", { name: "Reproducir" })).toBeNull();
  });

  it("avisa cada accion", () => {
    const actions = handlers();
    const { rerender } = render(<Transport playing={false} {...actions} />);

    fireEvent.click(screen.getByRole("button", { name: "Época anterior" }));
    fireEvent.click(screen.getByRole("button", { name: "Época siguiente" }));
    fireEvent.click(screen.getByRole("button", { name: "Reproducir" }));
    expect(actions.onPrevious).toHaveBeenCalledTimes(1);
    expect(actions.onNext).toHaveBeenCalledTimes(1);
    expect(actions.onPlayingChange).toHaveBeenLastCalledWith(true);

    rerender(<Transport playing {...actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Pausar" }));
    expect(actions.onPlayingChange).toHaveBeenLastCalledWith(false);
  });

  it("el boton de reproduccion puede medir 44, 56 o 64 px", () => {
    const { rerender } = render(<Transport playing={false} {...handlers()} />);
    const play = () => screen.getByRole("button", { name: "Reproducir" });

    expect(play().getAttribute("data-size")).toBe("md");
    rerender(<Transport playing={false} playSize="lg" {...handlers()} />);
    expect(play().getAttribute("data-size")).toBe("lg");
    rerender(<Transport playing={false} playSize="xl" {...handlers()} />);
    expect(play().getAttribute("data-size")).toBe("xl");
    // Los de los costados no cambian.
    expect(screen.getByRole("button", { name: "Época siguiente" }).getAttribute("data-size")).toBe(
      "md",
    );
  });

  it("sin tamano pedido, el de reproducir es el que la hoja de estilos agranda en celular", () => {
    // DESIGN.md: en celular el boton de reproduccion mide 56 a 64 px.
    const { rerender } = render(<Transport playing={false} {...handlers()} />);
    const play = () => screen.getByRole("button", { name: "Reproducir" });
    const auto = play().className;

    expect(auto).toContain("playAuto");
    for (const name of ["Época anterior", "Época siguiente"]) {
      expect(screen.getByRole("button", { name }).className).not.toContain("playAuto");
    }

    // Un tamano pedido vale igual en todas las pantallas, tambien el de 44 px.
    for (const playSize of ["md", "lg", "xl"] as const) {
      rerender(<Transport playing={false} playSize={playSize} {...handlers()} />);
      expect(play().className).not.toContain("playAuto");
    }
    rerender(<Transport playing {...handlers()} />);
    expect(screen.getByRole("button", { name: "Pausar" }).className).toBe(auto);
  });

  it("deshabilitado no avisa nada", () => {
    const actions = handlers();
    render(<Transport playing={false} disabled {...actions} />);

    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(actions.onPrevious).not.toHaveBeenCalled();
    expect(actions.onNext).not.toHaveBeenCalled();
    expect(actions.onPlayingChange).not.toHaveBeenCalled();
  });

  it("los nombres salen de i18n y el del grupo se puede reemplazar", async () => {
    await setLanguage("en");
    const { rerender } = render(<Transport playing={false} {...handlers()} />);

    expect(screen.getByRole("group", { name: "Playback" })).toBeTruthy();
    expect(
      screen.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Previous epoch", "Play", "Next epoch"]);

    rerender(<Transport playing label="Blink" {...handlers()} />);
    expect(screen.getByRole("group", { name: "Blink" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });
});
