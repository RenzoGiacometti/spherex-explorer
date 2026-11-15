import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PHONE_QUERY, useMediaQuery } from "./useMediaQuery";

/** `matchMedia` simulado: una sola consulta, que el test hace cumplir o no. */
function fakeMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  let matches = initial;
  const asked: string[] = [];
  vi.stubGlobal("matchMedia", (query: string) => {
    asked.push(query);
    return {
      get matches() {
        return matches;
      },
      media: query,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    };
  });
  return {
    asked,
    listeners,
    set(next: boolean): void {
      matches = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

function Probe({ query }: { readonly query: string }) {
  return <output>{useMediaQuery(query) ? "si" : "no"}</output>;
}

describe("useMediaQuery", () => {
  it("la consulta de celular es la de DESIGN.md: menos de 600 px", () => {
    expect(PHONE_QUERY).toBe("(max-width: 599px)");
  });

  it("dice si la ventana cumple la consulta", () => {
    const media = fakeMatchMedia(true);
    render(<Probe query={PHONE_QUERY} />);
    expect(screen.getByRole("status").textContent).toBe("si");
    expect(media.asked).toContain(PHONE_QUERY);
  });

  it("se actualiza cuando la ventana cambia de ancho", () => {
    const media = fakeMatchMedia(false);
    render(<Probe query={PHONE_QUERY} />);
    expect(screen.getByRole("status").textContent).toBe("no");

    act(() => media.set(true));
    expect(screen.getByRole("status").textContent).toBe("si");
    act(() => media.set(false));
    expect(screen.getByRole("status").textContent).toBe("no");
  });

  it("al desmontar deja de escuchar", () => {
    const media = fakeMatchMedia(false);
    const view = render(<Probe query={PHONE_QUERY} />);
    expect(media.listeners.size).toBe(1);
    view.unmount();
    expect(media.listeners.size).toBe(0);
  });

  it("donde no hay matchMedia no se cumple ninguna", () => {
    // jsdom no lo implementa.
    expect("matchMedia" in window && typeof window.matchMedia === "function").toBe(false);
    render(<Probe query={PHONE_QUERY} />);
    expect(screen.getByRole("status").textContent).toBe("no");
  });

  it("no falla con un navegador que no avisa los cambios de la consulta", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, media: query }));
    const view = render(<Probe query={PHONE_QUERY} />);
    expect(screen.getByRole("status").textContent).toBe("si");
    expect(() => view.unmount()).not.toThrow();
  });
});
