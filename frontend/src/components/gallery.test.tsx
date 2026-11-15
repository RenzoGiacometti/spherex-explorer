import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, initI18n, setLanguage } from "@/i18n";
import { useUrlState } from "@/state/urlState";
import { devPage } from "./gallery.devpage";
import en from "./gallery.en.json";
import es from "./gallery.es.json";
import { ICON_NAMES } from "./Icon";

const Gallery = devPage.Component;

type Tree = { [key: string]: string | Tree };

/** Claves de un arbol de textos, como rutas con puntos. */
function keyPaths(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return typeof value === "string" ? [path] : keyPaths(value, path);
  });
}

function open(search: string): void {
  window.history.replaceState(null, "", `/${search}`);
  useUrlState.getState().syncFromLocation();
}

beforeEach(async () => {
  // La galeria pide un plano de muestra para el fondo; los tests no usan la red.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("sin red en los tests"))),
  );
  open("?dev=gallery");
  initI18n("es");
  await setLanguage("es");
});

afterEach(() => {
  open("");
});

describe("galeria de componentes", () => {
  it("se dibuja en espanol con todos los paneles", () => {
    render(<Gallery />);

    expect(screen.getByRole("heading", { level: 1, name: es.title })).toBeTruthy();
    for (const title of [
      es.band.title,
      es.mode.title,
      es.image.title,
      es.speed.title,
      es.timeline.title,
      es.buttons.title,
      es.icons.title,
      es.metadata.title,
    ]) {
      expect(screen.getByRole("region", { name: title })).toBeTruthy();
    }
    expect(screen.getAllByRole("region", { name: es.notices.title })).toHaveLength(2);
  });

  it("se dibuja en ingles sin dejar textos en espanol ni claves sin traducir", async () => {
    await setLanguage("en");
    const { container } = render(<Gallery />);

    expect(screen.getByRole("heading", { level: 1, name: en.title })).toBeTruthy();
    expect(screen.getAllByRole("region", { name: en.notices.title })).toHaveLength(2);
    expect(screen.queryByText(es.title)).toBeNull();
    expect(screen.queryByText(es.search.label)).toBeNull();
    // i18next devuelve la clave cuando falta la traduccion.
    const shown = container.textContent ?? "";
    for (const key of keyPaths(en)) {
      if (key.includes(".")) expect(shown, key).not.toContain(key);
    }
    expect(shown).not.toMatch(/\b(timeline|transport|segmented)\.\w+/);
    // Los numeros siguen el idioma: punto decimal y porcentaje sin espacio.
    expect(screen.getByText("1.63–2.43")).toBeTruthy();
    expect(screen.getAllByText("65%").length).toBeGreaterThan(0);
  });

  it("muestra el juego de iconos completo", () => {
    render(<Gallery />);
    const icons = screen.getByRole("region", { name: es.icons.title });

    for (const name of ICON_NAMES) {
      expect(within(icons).getByText(name)).toBeTruthy();
      expect(icons.querySelector(`[data-icon="${name}"]`)).toBeTruthy();
    }
  });

  it("muestra los estados que pide la tarea", () => {
    const { container } = render(<Gallery />);

    // Selector de banda: B1 a B6, una sin datos y una deshabilitada.
    const bands = within(screen.getByRole("group", { name: es.band.group })).getAllByRole(
      "radio",
    ) as HTMLInputElement[];
    expect(bands).toHaveLength(6);
    expect(bands.filter((band) => band.disabled)).toHaveLength(1);
    expect(container.querySelectorAll("[data-no-data]")).toHaveLength(1);

    // Campo de vision: 5, 10 y 30 minutos, sin 1 grado.
    expect(
      within(screen.getByRole("group", { name: es.image.fov }))
        .getAllByRole("radio")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["5′", "10′", "30′"]);

    // Linea de tiempo: 4 y 3 epocas, y una con dos epocas cercanas y una sin
    // datos. Entre las tres estan todos los estados de marca.
    const tracks = [es.timeline.title, es.timeline.threeEpochs, es.timeline.closeEpochs].map(
      (name) => within(screen.getByRole("group", { name })).getAllByRole("radio").length,
    );
    expect(tracks).toEqual([4, 3, 4]);
    for (const state of ["loaded", "provisional", "unloaded", "empty", "current"]) {
      expect(container.querySelector(`[data-state="${state}"]`)).toBeTruthy();
    }
    expect(screen.getByRole("radio", { name: "Época 4, 2026-09, sin datos" })).toBeTruthy();

    // Rotulos de imagen, barra de progreso y avisos agrupados.
    expect(screen.getByText("9 / 18 exposiciones")).toBeTruthy();
    expect(screen.getByText("WISE 3,4 µm")).toBeTruthy();
    expect(screen.getByText("14 / 22 recortes · 64 %")).toBeTruthy();
    expect(screen.getByText("×6")).toBeTruthy();
    expect(screen.getAllByRole("progressbar")).toHaveLength(3);
    expect(screen.getAllByRole("search")).toHaveLength(3);
    expect(screen.getByRole("navigation", { name: es.search.featuredNav })).toBeTruthy();
  });

  it("los controles responden", () => {
    render(<Gallery />);

    fireEvent.click(screen.getByRole("radio", { name: "B4 2,40–3,85" }));
    expect((screen.getByRole("radio", { name: "B4 2,40–3,85" }) as HTMLInputElement).checked).toBe(
      true,
    );

    const track = screen.getByRole("group", { name: es.timeline.title });
    fireEvent.click(within(track).getByRole("radio", { name: "Época 3, 2026-04, provisoria" }));
    expect(screen.getByText("Época 3 de 4")).toBeTruthy();

    fireEvent.change(screen.getByRole("slider", { name: es.image.contrast }), {
      target: { value: "80" },
    });
    expect(screen.getByText("80 %")).toBeTruthy();
  });

  it("el selector de idioma escribe el idioma en la URL", () => {
    render(<Gallery />);

    act(() => {
      fireEvent.click(screen.getByRole("radio", { name: "English" }));
    });

    expect(useUrlState.getState().lang).toBe("en");
    expect(new URLSearchParams(window.location.search).get("lang")).toBe("en");
    // No pierde el parametro que abre la galeria.
    expect(new URLSearchParams(window.location.search).get("dev")).toBe("gallery");
  });
});

describe("textos de la galeria", () => {
  // Que no viajan en el sitio compilado se comprueba en gallery.texts.test.ts.
  it("los registra la pagina al cargarse, en los dos idiomas", () => {
    expect(i18n.getResourceBundle("es", "gallery")).toEqual(es);
    expect(i18n.getResourceBundle("en", "gallery")).toEqual(en);
    expect(i18n.t("title", { ns: "gallery", lng: "en" })).toBe(en.title);
  });
});
