import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  installFakeBrowser,
  openUrl,
  resetApp,
  startBackend,
} from "./features/viewer/viewerPage.testkit";
import { i18n, initI18n, setLanguage } from "./i18n";
import { useFieldStore } from "./state/fieldStore";
import type { FakeBackend } from "./state/fieldStore.testkit";
import { useUrlState } from "./state/urlState";
import wiseMeta from "./test/fixtures/meta-wise0855.json";

// La entrada es la esfera celeste, que tiene sus propios tests y dibuja con
// WebGL (jsdom no lo tiene): aca alcanza con saber si es lo que se muestra.
vi.mock("@/features/sphere", () => ({
  SpherePage: () => <main data-testid="entry" />,
}));

const WISE = "?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink";

/** Idiomas preferidos del navegador de la prueba (jsdom viene en ingles). */
function browserPrefers(languages: string[]): void {
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(languages);
}

let backend: FakeBackend;

beforeEach(async () => {
  openUrl("");
  browserPrefers(["es-AR", "es"]);
  initI18n("es");
  await setLanguage("es");
  installFakeBrowser();
  backend = startBackend(wiseMeta);
});

afterEach(() => {
  cleanup();
  resetApp();
});

function viewer(): HTMLElement | null {
  return screen.queryByRole("application", { name: /./ });
}

async function imageShown(): Promise<void> {
  await waitFor(() => expect(screen.getByRole("main").dataset.source).toBe("spherex"));
}

describe("App", () => {
  it("sin coordenadas en la URL muestra la entrada y no pide ningun campo", async () => {
    render(<App />);

    // La entrada se carga en un trozo aparte.
    expect(await screen.findByTestId("entry")).toBeTruthy();
    expect(viewer()).toBeNull();
    expect(backend.calls).toHaveLength(0);
    expect(useFieldStore.getState().phase).toBe("idle");
  });

  it("un link con coordenadas abre el visor y pide el campo", async () => {
    openUrl(WISE);
    render(<App />);

    expect(screen.queryByTestId("entry")).toBeNull();
    expect(screen.getByRole("application", { name: "Imagen del campo" })).toBeTruthy();
    // Los datos salen con el formato de DESIGN.md.
    expect(screen.getAllByText("08h 55m 02s").length).toBeGreaterThan(0);
    expect(screen.getAllByText("−07° 14′ 32″").length).toBeGreaterThan(0);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Parpadeo" }).checked).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("radio", { name: "10 minutos de arco" }).checked,
    ).toBe(true);

    await imageShown();
    expect(backend.requests("field")).toHaveLength(1);
    expect(backend.requests("field")[0]?.body).toEqual({
      ra: 133.7598,
      dec: -7.2422,
      fov: 0.1667,
      band: 6,
    });
    expect(screen.getByRole<HTMLInputElement>("radio", { name: /^B6,/ }).checked).toBe(true);
  });

  it("una sola coordenada no alcanza para abrir el visor", () => {
    openUrl("?ra=133.7598");
    render(<App />);

    expect(screen.getByTestId("entry")).toBeTruthy();
    expect(backend.calls).toHaveLength(0);
  });

  it("el parametro lang de la URL fija el idioma", async () => {
    openUrl(`${WISE}&lang=en`);
    render(<App />);

    expect(await screen.findByRole("region", { name: "Metadata" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to the start page" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
    expect(i18n.language).toBe("en");
    await imageShown();
  });

  it("sin lang usa el idioma del navegador", async () => {
    browserPrefers(["en-US", "en"]);
    openUrl(WISE);
    render(<App />);

    expect(await screen.findByRole("region", { name: "Metadata" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
    await imageShown();
  });

  it("lang manda sobre el idioma del navegador", async () => {
    browserPrefers(["en-US", "en"]);
    openUrl(`${WISE}&lang=es`);
    render(<App />);

    expect(await screen.findByRole("region", { name: "Metadatos" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("es");
    await imageShown();
  });

  it("el selector de idioma del visor cambia los textos y queda en la URL", async () => {
    openUrl(WISE);
    render(<App />);
    await imageShown();

    fireEvent.click(screen.getByRole("radio", { name: "English" }));

    expect(await screen.findByRole("region", { name: "Metadata" })).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("lang")).toBe("en");
    // Con el otro separador decimal: 4.41 en vez de 4,41.
    expect(screen.getByRole("radio", { name: /^B6, 4\.41/ })).toBeTruthy();
    // Cambiar de idioma no vuelve a pedir el campo.
    expect(backend.requests("field")).toHaveLength(1);
  });

  it("pasa de la entrada al visor cuando cambia la URL", async () => {
    render(<App />);
    expect(screen.getByTestId("entry")).toBeTruthy();

    act(() => {
      useUrlState.getState().update({ ra: 133.7598, dec: -7.2422, band: 6 }, { history: "push" });
    });

    expect(await screen.findByRole("application", { name: "Imagen del campo" })).toBeTruthy();
    await imageShown();
    expect(backend.requests("field")).toHaveLength(1);
  });

  it("el campo sigue a la URL una sola vez: otra banda no repite el pedido", async () => {
    openUrl(WISE);
    render(<App />);
    await imageShown();

    fireEvent.click(screen.getByRole("radio", { name: /^B2,/ }));

    expect(useFieldStore.getState().band).toBe(2);
    await waitFor(() =>
      expect(screen.getByRole("main").dataset).toMatchObject({ source: "spherex", epochs: "3" }),
    );
    expect(backend.requests("field")).toHaveLength(1);
    expect(backend.requests("plane", "/plane/3/2")).toHaveLength(1);
  });

  it("volver a la entrada desde el visor cierra el campo", async () => {
    openUrl(WISE);
    render(<App />);
    await imageShown();

    fireEvent.click(screen.getByRole("link", { name: "Volver a la entrada" }));

    expect(await screen.findByTestId("entry")).toBeTruthy();
    expect(viewer()).toBeNull();
    expect(window.location.search).toBe("");
    expect(useFieldStore.getState().phase).toBe("idle");
  });

  it("atras en el historial vuelve a la entrada", async () => {
    render(<App />);
    act(() => {
      useUrlState.getState().update({ ra: 133.7598, dec: -7.2422 }, { history: "push" });
    });
    await imageShown();

    act(() => {
      openUrl("");
    });

    expect(await screen.findByTestId("entry")).toBeTruthy();
    expect(useFieldStore.getState().phase).toBe("idle");
  });

  it("con embed=1 queda la imagen sola, con el enlace al visor completo", async () => {
    openUrl(`${WISE}&embed=1`);
    render(<App />);
    await imageShown();

    expect(screen.getByRole("main").dataset.layout).toBe("embed");
    expect(screen.getByRole("application", { name: "Imagen del campo" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Volver a la entrada" })).toBeNull();
    expect(screen.queryAllByRole("radio")).toEqual([]);
    // El enlace lleva la misma vista, sin `embed`.
    expect(
      screen.getByRole("link", { name: "Abrir en el visor completo" }).getAttribute("href"),
    ).toBe("/?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink");
    expect(backend.requests("field")).toHaveLength(1);
  });

  it("sin embed el visor lleva toda su interfaz", async () => {
    openUrl(WISE);
    render(<App />);
    await imageShown();

    expect(screen.getByRole("main").dataset.layout).toBe("desktop");
    expect(screen.queryByRole("link", { name: "Abrir en el visor completo" })).toBeNull();
    for (const name of ["Banda", "Modo", "Imagen", "Metadatos", "Avisos de calidad"]) {
      expect(screen.getByRole("region", { name }), name).toBeTruthy();
    }
  });
});
