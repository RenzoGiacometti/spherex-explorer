// Los otros dos armados de la pantalla del visor: el modo embed (`embed=1`) y
// el celular (menos de 600 px), contra un backend simulado y sin red.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, setLanguage } from "@/i18n";
import { errorResponse } from "@/state/fieldStore.testkit";
import { useFieldUrlSync } from "@/state/fieldUrlSync";
import { useUrlState } from "@/state/urlState";
import newFieldEvents from "@/test/fixtures/events-new-field.json";
import barnardMeta from "@/test/fixtures/meta-barnard.json";
import wiseMeta from "@/test/fixtures/meta-wise0855.json";
import { FRAME_MS } from "./useViewerController";
import { ViewerPage } from "./ViewerPage";
import {
  installFakeBrowser,
  openUrl,
  type RawEvent,
  resetApp,
  startBackend,
  startNewField,
  usePhoneViewport,
} from "./viewerPage.testkit";

const WISE = "?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink";
const WISE_B3 = "?ra=133.7598&dec=-7.2422&fov=0.1667&band=3&mode=blink";
const BARNARD = "?ra=269.4463&dec=4.7683&fov=0.1667&band=3&mode=blink";

const EVENTS = newFieldEvents as RawEvent[];

function Screen() {
  useFieldUrlSync();
  return <ViewerPage />;
}

beforeEach(async () => {
  initI18n("es");
  await setLanguage("es");
  installFakeBrowser();
});

afterEach(() => {
  cleanup();
  resetApp();
  vi.useRealTimers();
});

function page(): HTMLElement {
  return screen.getByRole("main");
}

async function shown(epochs: string): Promise<void> {
  await waitFor(() => expect(page().dataset.epochs).toBe(epochs));
}

function openViewer(search: string, meta: unknown = wiseMeta) {
  const backend = startBackend(meta);
  openUrl(search);
  const view = render(<Screen />);
  return { backend, ...view };
}

function radio(name: string | RegExp): HTMLInputElement {
  return screen.getByRole("radio", { name }) as HTMLInputElement;
}

function choose(name: string | RegExp): void {
  fireEvent.click(radio(name));
}

function tick(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Documento de WISE 0855 a medio cargar: la epoca 1 de B6 todavia es provisoria. */
function loadingMeta(): unknown {
  const meta = structuredClone(wiseMeta);
  meta.status = "downloading";
  meta.progress = { ...meta.progress, phase: "downloading", cutouts_done: 120, planes_ready: 9 };
  const plane = meta.planes.find((item) => item.epoch === 1 && item.detector === 6);
  if (!plane) throw new Error("la muestra no tiene el plano 1:6");
  Object.assign(plane, { status: "building", rev: 1, n_used: 3, n_exposures: 7 });
  return meta;
}

describe("ViewerPage: modo embed", () => {
  const EMBED = `${WISE}&embed=1`;

  it("muestra solo la imagen con sus anotaciones y lo minimo para reproducir", async () => {
    openViewer(EMBED);
    await shown("3");

    expect(page().dataset.layout).toBe("embed");
    expect(screen.getByRole("application", { name: "Imagen del campo" })).toBeTruthy();
    // Nada de la interfaz de alrededor: ni barra, ni paneles, ni selectores.
    expect(screen.queryByRole("link", { name: "Volver a la entrada" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    for (const name of ["Banda", "Modo", "Imagen", "Metadatos", "Avisos de calidad"]) {
      expect(screen.queryByRole("region", { name }), name).toBeNull();
    }
    expect(screen.queryAllByRole("radio")).toEqual([]);
    expect(screen.queryByRole("switch")).toBeNull();

    // El transporte y que epoca se ve.
    for (const name of ["Época anterior", "Reproducir", "Época siguiente"]) {
      expect(screen.getByRole("button", { name }), name).toBeTruthy();
    }
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.getByText("Época 3 de 3")).toBeTruthy();
    expect(screen.getByText("2026-04-21 a 2026-05-14")).toBeTruthy();

    // Las anotaciones siguen sobre la imagen.
    await waitFor(() => expect(page().querySelector('[data-annotation="scale"]')).not.toBeNull());
    expect(page().querySelector('[data-annotation="compass"]')).not.toBeNull();
    expect(page().querySelector('[data-annotation="band"]')?.textContent).toContain("B6");
  });

  it("el enlace abre el visor completo con la misma vista, en otra pestana", async () => {
    openViewer(`${EMBED}&lang=es&name=WISE%200855`);
    await shown("3");

    const link = screen.getByRole("link", { name: "Abrir en el visor completo" });
    expect(link.getAttribute("href")).toBe(
      "/?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink&name=WISE+0855&lang=es",
    );
    // Dentro de un iframe no tiene que sacar de su lugar a la pagina que lo aloja.
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");

    // Sigue a lo que se hace con el transporte.
    fireEvent.click(screen.getByRole("button", { name: "Época anterior" }));
    expect(page().dataset.epochs).toBe("2");
    expect(link.getAttribute("href")).toContain("epoch=2");
    expect(link.getAttribute("href")).not.toContain("embed");
    // La URL del marco conserva `embed`.
    expect(new URLSearchParams(window.location.search).get("embed")).toBe("1");
    expect(page().dataset.layout).toBe("embed");
  });

  it("reproduce las epocas", async () => {
    openViewer(EMBED);
    await shown("3");
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "Reproducir" }));

    expect(page().dataset.playing).toBe("true");
    tick(FRAME_MS);
    expect(page().dataset.epochs).toBe("1");
    expect(screen.getByText("Época 1 de 3")).toBeTruthy();
    tick(FRAME_MS);
    expect(page().dataset.epochs).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Pausar" }));
    expect(page().dataset.playing).toBeUndefined();
  });

  it("respeta el modo de la URL y, en mantener apretado, suma su boton", async () => {
    openViewer(`${WISE.replace("mode=blink", "mode=difference")}&embed=1`);
    // B por defecto: la epoca 2, bien cubierta y la mas lejana en fecha a la 3.
    await shown("2,3");
    expect(page().dataset.scene).toBe("difference");
    expect(screen.queryByRole("button", { name: "Mantener para ver B" })).toBeNull();
    cleanup();
    resetApp();

    installFakeBrowser();
    openViewer(`${WISE.replace("mode=blink", "mode=hold")}&embed=1`);
    await shown("3");
    const hold = screen.getByRole("button", { name: "Mantener para ver B" });
    fireEvent.pointerDown(hold);
    expect(page().dataset.epochs).toBe("2");
    fireEvent.pointerUp(hold);
    expect(page().dataset.epochs).toBe("3");
  });

  it("mientras el campo carga muestra el avance, y despues lo retira", async () => {
    const field = await startNewField(EVENTS);
    openUrl(`${WISE_B3}&embed=1`);
    render(<Screen />);

    await field.playUntil(9);
    const loading = await screen.findByRole("progressbar", { name: "Cargando datos" });
    await waitFor(() =>
      expect(loading.getAttribute("aria-valuetext")).toBe("11 / 258 recortes · 4 %"),
    );
    // La primera imagen ya esta, rotulada como provisoria.
    await shown("1");
    expect(screen.getByText("Provisorio")).toBeTruthy();

    await field.playUntil(82);
    await waitFor(() => expect(screen.queryByRole("progressbar")).toBeNull());
    expect(screen.queryByText("Campo incompleto")).toBeNull();
    await shown("3");
  });

  it("un error del campo se ve igual, con su reintento", async () => {
    const backend = startBackend(wiseMeta);
    const original = backend.handlers.field;
    backend.handlers.field = () => errorResponse("upstream_unavailable", 503, { retryable: true });
    openUrl(EMBED);
    render(<Screen />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("El archivo de datos no responde.")).toBeTruthy();
    backend.handlers.field = original;
    fireEvent.click(within(alert).getByRole("button", { name: "Reintentar" }));
    await shown("3");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("embed manda sobre el ancho: en un marco angosto sigue siendo embed", async () => {
    usePhoneViewport();
    openViewer(EMBED);
    await shown("3");
    expect(page().dataset.layout).toBe("embed");
    expect(screen.getByRole("link", { name: "Abrir en el visor completo" })).toBeTruthy();
  });
});

describe("ViewerPage: celular", () => {
  beforeEach(() => {
    usePhoneViewport();
  });

  function tools(): HTMLElement {
    return screen.getByRole("button", { name: "Herramientas" });
  }

  function drawer(): HTMLElement | null {
    return screen.queryByRole("dialog", { name: "Herramientas" });
  }

  it("arriba solo van la salida, el objeto y la cantidad de avisos", async () => {
    openViewer(`${BARNARD}&name=Barnard%27s%20Star`, barnardMeta);
    await shown("3");

    expect(page().dataset.layout).toBe("phone");
    const banner = screen.getByRole("banner");
    expect(within(banner).getByRole("link", { name: "Volver a la entrada" })).toBeTruthy();
    expect(within(banner).getByRole("heading", { level: 1, name: "Barnard's Star" })).toBeTruthy();
    expect(within(banner).getByText("17h 57m 47s")).toBeTruthy();
    expect(within(banner).getByText("+04° 46′ 06″")).toBeTruthy();
    // Barnard tiene dos avisos: la fuente saturada y la poca cobertura.
    const notices = within(banner).getByRole("button", { name: "Avisos de calidad: 2" });
    expect(notices.getAttribute("aria-expanded")).toBe("false");
    expect(notices.textContent).toBe("2");
    // Ningun otro control: el idioma esta en el cajon.
    expect(within(banner).getAllByRole("button")).toHaveLength(1);
    expect(within(banner).queryAllByRole("radio")).toEqual([]);
    expect(within(banner).queryByText("SPHEREx Explorer")).toBeNull();
  });

  it("los controles frecuentes estan a la vista: modo, banda, epocas y transporte", async () => {
    openViewer(WISE);
    await shown("3");

    const modes = screen.getByRole("group", { name: "Modo de comparación" });
    expect(
      within(modes)
        .getAllByRole("radio")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual([
      "Parpadeo",
      "Diferencia",
      "Suma",
      "Rojo/cian",
      "Mantener apretado",
      "Viaje entre misiones",
    ]);

    // Las seis bandas en una fila: el nombre solo a la vista, el rango para quien escucha.
    const bands = screen.getByRole("group", { name: "Banda infrarroja" });
    expect(within(bands).getAllByRole("radio")).toHaveLength(6);
    expect(radio(/^B6, de 4,41 µm a 5,01 µm$/).checked).toBe(true);
    expect(within(bands).queryByText("4,41–5,01")).toBeNull();

    expect(
      within(screen.getByRole("group", { name: "Épocas" })).getAllByRole("radio"),
    ).toHaveLength(3);
    for (const name of ["Época anterior", "Reproducir", "Época siguiente", "Herramientas"]) {
      expect(screen.getByRole("button", { name }), name).toBeTruthy();
    }
    expect(screen.getByText("Época 3 de 3")).toBeTruthy();
    expect(screen.getByText("Campo incompleto")).toBeTruthy();

    // Lo que no es frecuente no esta hasta abrir el cajon.
    expect(drawer()).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    for (const name of ["Imagen", "Metadatos", "Avisos de calidad"]) {
      expect(screen.queryByRole("region", { name }), name).toBeNull();
    }

    // Y siguen andando.
    choose("Suma");
    expect(page().dataset).toMatchObject({ mode: "sum", epochs: "1,2,3" });
    choose(/^B2,/);
    expect(new URLSearchParams(window.location.search).get("band")).toBe("2");
  });

  it("la velocidad es un boton que pasa por 0,5, 1 y 2", async () => {
    openViewer(WISE);
    await shown("3");
    vi.useFakeTimers();

    const speed = screen.getByRole("button", { name: "Velocidad de reproducción: 1×. Cambiar" });
    expect(speed.textContent).toBe("1×");
    fireEvent.click(speed);
    expect(speed.getAttribute("aria-label")).toBe("Velocidad de reproducción: 2×. Cambiar");
    expect(speed.textContent).toBe("2×");

    // Con 2x cada epoca dura la mitad.
    fireEvent.click(screen.getByRole("button", { name: "Reproducir" }));
    tick(FRAME_MS / 2);
    expect(page().dataset.epochs).toBe("1");
    tick(FRAME_MS / 2);
    expect(page().dataset.epochs).toBe("2");

    fireEvent.click(speed);
    expect(speed.textContent).toBe("0,5×");
    fireEvent.click(speed);
    expect(speed.textContent).toBe("1×");
  });

  it("el cajon de herramientas trae lo demas: imagen, flags, avisos, metadatos e idioma", async () => {
    openViewer(WISE);
    await shown("3");
    tools().focus();
    expect(tools().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(tools());

    const sheet = drawer();
    if (sheet === null) throw new Error("el cajon no se abrio");
    // El foco pasa al cajon.
    expect(document.activeElement).toBe(
      within(sheet).getByRole("heading", { name: "Herramientas" }),
    );
    expect(
      within(sheet)
        .getAllByRole("region")
        .map((region) => within(region).getAllByRole("heading")[0]?.textContent),
    ).toEqual(["Imagen", "Avisos de calidad", "Metadatos", "Referencias", "Idioma"]);
    expect(within(sheet).getByRole("slider", { name: "Contraste" })).toBeTruthy();
    expect(within(sheet).getByRole("group", { name: "Estirado" })).toBeTruthy();
    expect(within(sheet).getByRole("group", { name: "Campo de visión" })).toBeTruthy();
    expect(within(sheet).getByRole("switch", { name: "Capa de flags" })).toBeTruthy();
    expect(within(sheet).getByText("B6 · 4,41–5,01 µm")).toBeTruthy();
    expect(
      within(sheet).getByRole("list", { name: "Referencias de la línea de tiempo" }),
    ).toBeTruthy();

    // Los controles de abajo quedan tapados, sin verse ni recibir el foco.
    const covered = page().querySelector("[data-covered]");
    expect(covered?.getAttribute("data-covered")).toBe("true");
    expect(covered?.contains(tools())).toBe(true);
    expect(tools().getAttribute("aria-expanded")).toBe("true");

    // Siguen funcionando desde el cajon.
    fireEvent.change(within(sheet).getByRole("slider", { name: "Contraste" }), {
      target: { value: "70" },
    });
    expect(
      within(sheet).getByRole("slider", { name: "Contraste" }).getAttribute("aria-valuetext"),
    ).toBe("70 %");
    fireEvent.click(within(sheet).getByRole("switch", { name: "Capa de flags" }));
    await waitFor(() => expect(page().dataset.flags).toBe("ready"));

    // Al cerrar, el foco vuelve al boton que lo abrio.
    fireEvent.click(within(sheet).getByRole("button", { name: "Cerrar las herramientas" }));
    expect(drawer()).toBeNull();
    expect(page().querySelector("[data-covered]")).toBeNull();
    expect(document.activeElement).toBe(tools());
    // Lo elegido en el cajon queda.
    expect(page().dataset.flags).toBe("ready");
  });

  it("el acceso a los avisos abre el cajon con los avisos arriba, y Escape lo cierra", async () => {
    openViewer(BARNARD, barnardMeta);
    await shown("3");
    const notices = screen.getByRole("button", { name: "Avisos de calidad: 2" });
    notices.focus();

    fireEvent.click(notices);

    const sheet = drawer();
    if (sheet === null) throw new Error("el cajon no se abrio");
    expect(
      within(sheet)
        .getAllByRole("region")
        .map((region) => within(region).getAllByRole("heading")[0]?.textContent)
        .slice(0, 2),
    ).toEqual(["Avisos de calidad", "Imagen"]);
    expect(
      within(sheet).getByText(
        "Hay una fuente saturada en 17h 57m 47s +04° 46′ 08″: su centro no tiene medición válida.",
      ),
    ).toBeTruthy();
    expect(notices.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(within(sheet).getByRole("heading", { name: "Herramientas" }), {
      key: "Escape",
    });

    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(notices);
  });

  it("la fuente saturada se avisa sobre la imagen, sin abrir nada", async () => {
    openViewer(BARNARD, barnardMeta);
    await shown("3");

    expect(drawer()).toBeNull();
    const notice = page().querySelector('[data-annotation="saturated-notice"]');
    expect(notice?.textContent).toBe("Fuente saturada");
    expect(notice?.querySelector('[data-icon="alert"]')).not.toBeNull();
  });

  it("un campo sin avisos no lleva el acceso", async () => {
    const meta = structuredClone(wiseMeta) as { warnings: unknown[] };
    meta.warnings = [];
    openViewer(WISE, meta);
    await shown("3");

    expect(screen.queryByRole("button", { name: /Avisos de calidad/ })).toBeNull();
    expect(within(screen.getByRole("banner")).queryAllByRole("button")).toEqual([]);
  });

  it("el idioma se cambia desde el cajon", async () => {
    openViewer(WISE);
    await shown("3");
    fireEvent.click(tools());

    choose("English");

    expect(new URLSearchParams(window.location.search).get("lang")).toBe("en");
    expect(useUrlState.getState().lang).toBe("en");
  });

  it("los modos que comparan suman la epoca de referencia y el boton de mantener", async () => {
    openViewer(WISE);
    await shown("3");
    expect(screen.queryByRole("group", { name: "Época de referencia (B)" })).toBeNull();

    choose("Diferencia");
    const reference = screen.getByRole("group", { name: "Época de referencia (B)" });
    expect(
      within(reference)
        .getAllByRole("radio")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["Época 1, 2025-05", "Época 2, 2025-10", "Época 3, 2026-04"]);
    // A la vista, el numero solo: la fecha de cada epoca esta en la linea de tiempo.
    expect(within(reference).queryByText("2025-05")).toBeNull();
    expect(screen.getByText("Época B")).toBeTruthy();
    fireEvent.click(within(reference).getByRole("radio", { name: "Época 2, 2025-10" }));
    expect(page().dataset.epochs).toBe("2,3");

    choose("Mantener apretado");
    const hold = screen.getByRole("button", { name: "Mantener para ver B" });
    fireEvent.pointerDown(hold);
    expect(page().dataset.epochs).toBe("2");
    fireEvent.pointerUp(hold);
    expect(page().dataset.epochs).toBe("3");
  });

  it("una comparacion con una epoca provisoria avisa donde se compara y cuenta en los avisos", async () => {
    const notice = "Alguna de las épocas comparadas es provisoria: todavía le faltan exposiciones.";
    // La referencia automatica evita la epoca provisoria: se la elige en la URL.
    openViewer(`${WISE}&ref=1`, loadingMeta());
    await shown("3");
    const before = screen.getByRole("button", { name: /^Avisos de calidad: / });
    const count = Number(before.textContent);
    expect(screen.queryByText(notice)).toBeNull();

    choose("Diferencia");

    expect(screen.getByText(notice)).toBeTruthy();
    expect(screen.getByRole("button", { name: `Avisos de calidad: ${count + 1}` })).toBeTruthy();
  });

  it("un campo nuevo muestra el avance en la linea de tiempo", async () => {
    const field = await startNewField(EVENTS);
    openUrl(WISE_B3);
    render(<Screen />);

    await field.playUntil(9);

    const loading = await screen.findByRole("progressbar", { name: "Cargando datos" });
    await waitFor(() =>
      expect(loading.getAttribute("aria-valuetext")).toBe("11 / 258 recortes · 4 %"),
    );
    await shown("1");
    expect(screen.getByText("Provisorio")).toBeTruthy();
  });
});
