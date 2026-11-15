import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { i18n, initI18n, setLanguage } from "./i18n";
import enEntry from "./i18n/locales/en/entry.json";
import en from "./i18n/locales/en/viewer.json";
import esEntry from "./i18n/locales/es/entry.json";
import es from "./i18n/locales/es/viewer.json";
import { useUrlState } from "./state/urlState";

function open(search: string): void {
  window.history.replaceState(null, "", `/${search}`);
  useUrlState.getState().syncFromLocation();
}

/** Idiomas preferidos del navegador de la prueba (jsdom viene en ingles). */
function browserPrefers(languages: string[]): void {
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(languages);
}

beforeEach(async () => {
  open("");
  browserPrefers(["es-AR", "es"]);
  initI18n("es");
  await setLanguage("es");
});

afterEach(() => {
  open("");
});

describe("App", () => {
  it("sin coordenadas en la URL muestra la entrada", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "SPHEREx Explorer" })).toBeTruthy();
    expect(screen.getByText(esEntry.placeholder.body)).toBeTruthy();
    expect(screen.queryByText(es.placeholder.heading)).toBeNull();
  });

  it("con coordenadas en la URL muestra el visor", () => {
    open("?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink");
    render(<App />);

    expect(screen.getByRole("heading", { name: es.placeholder.heading })).toBeTruthy();
    expect(screen.queryByText(esEntry.placeholder.body)).toBeNull();

    // Los datos salen con el formato de DESIGN.md.
    expect(screen.getByText("08h 55m 02s")).toBeTruthy();
    expect(screen.getByText("−07° 14′ 32″")).toBeTruthy();
    expect(screen.getByText("10′")).toBeTruthy();
    expect(screen.getByText("B6")).toBeTruthy();
    expect(screen.getByText(es.mode.blink)).toBeTruthy();
  });

  it("una sola coordenada no alcanza para abrir el visor", () => {
    open("?ra=133.7598");
    render(<App />);

    expect(screen.getByText(esEntry.placeholder.body)).toBeTruthy();
  });

  it("el parametro lang de la URL fija el idioma", async () => {
    open("?ra=133.7598&dec=-7.2422&lang=en");
    render(<App />);

    expect(await screen.findByRole("heading", { name: en.placeholder.heading })).toBeTruthy();
    expect(screen.getByText(en.field.ra)).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
    expect(i18n.language).toBe("en");
  });

  it("sin lang usa el idioma del navegador", async () => {
    browserPrefers(["en-US", "en"]);
    render(<App />);

    expect(await screen.findByText(enEntry.placeholder.body)).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
  });

  it("lang manda sobre el idioma del navegador", async () => {
    browserPrefers(["en-US", "en"]);
    open("?lang=es");
    render(<App />);

    expect(await screen.findByText(esEntry.placeholder.body)).toBeTruthy();
    expect(document.documentElement.lang).toBe("es");
  });

  it("pasa de la entrada al visor cuando cambia la URL", async () => {
    render(<App />);
    expect(screen.getByText(esEntry.placeholder.body)).toBeTruthy();

    act(() => {
      useUrlState.getState().update({ ra: 269.4463, dec: 4.7683 }, { history: "push" });
    });

    expect(await screen.findByRole("heading", { name: es.placeholder.heading })).toBeTruthy();
    expect(screen.getByText("+04° 46′ 06″")).toBeTruthy();
  });

  it("vuelve a la entrada al quitar las coordenadas", async () => {
    open("?ra=269.4463&dec=4.7683");
    render(<App />);
    expect(screen.getByRole("heading", { name: es.placeholder.heading })).toBeTruthy();

    act(() => {
      useUrlState.getState().update({ ra: null, dec: null });
    });

    expect(await screen.findByText(esEntry.placeholder.body)).toBeTruthy();
  });
});
