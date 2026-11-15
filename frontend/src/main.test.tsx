import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import viewer from "./i18n/locales/es/viewer.json";

afterEach(() => {
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
  vi.resetModules();
});

describe("main", () => {
  it("monta la aplicacion en #root con el idioma y el campo de la URL", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, "", "/?ra=133.7598&dec=-7.2422&band=6&lang=es");
    // El visor pide el campo y dibuja en un canvas: aca no hay backend ni canvas.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("sin red en los tests"))),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    await act(async () => {
      await import("./main");
    });

    const root = document.getElementById("root");
    expect(root?.textContent).toContain(viewer.panel.metadata);
    expect(root?.textContent).toContain("08h 55m 02s");
    expect(root?.textContent).toContain("B6");
    expect(document.documentElement.lang).toBe("es");
    // Importa la aplicacion entera, con la bateria corriendo en paralelo: mas de los 5 s por defecto.
  }, 20_000);

  it("falla con un mensaje claro si index.html no tiene #root", async () => {
    await expect(import("./main")).rejects.toThrow("#root");
  });
});
