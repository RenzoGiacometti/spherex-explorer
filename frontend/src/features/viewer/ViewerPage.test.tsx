// La pantalla del visor completa, contra un backend simulado y sin red: los
// modos, la banda, el reproductor, la carga, los errores y la URL.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planeKey } from "@/data/planeKey";
import { initI18n, setLanguage } from "@/i18n";
import { useFieldStore } from "@/state/fieldStore";
import { errorResponse, type FakeBackend } from "@/state/fieldStore.testkit";
import { useFieldUrlSync } from "@/state/fieldUrlSync";
import { useUrlState } from "@/state/urlState";
import newFieldEvents from "@/test/fixtures/events-new-field.json";
import epsIndMeta from "@/test/fixtures/meta-epsindb.json";
import wiseMeta from "@/test/fixtures/meta-wise0855.json";
import type { FakeCanvasContexts } from "@/viewer/testSupport";
import { FRAME_MS } from "./useViewerController";
import { ViewerPage } from "./ViewerPage";
import {
  composedImage,
  drawnWidth,
  installFakeBrowser,
  openUrl,
  pixelAt,
  type RawEvent,
  resetApp,
  startBackend,
  startNewField,
  VIEWPORT,
} from "./viewerPage.testkit";

const WISE = "?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink";
const WISE_B3 = "?ra=133.7598&dec=-7.2422&fov=0.1667&band=3&mode=blink";
const EPS_IND = "?ra=331.0966&dec=-56.8006&fov=0.1667&band=3&mode=blink";

/** Pixeles de los planos de prueba: (0, 0) sin datos, (1, 0) saturado y el resto con valor. */
const NO_DATA = [0, 0] as const;
const SATURATED = [1, 0] as const;
const VALID = [2, 0] as const;

const EVENTS = newFieldEvents as RawEvent[];

/** La pantalla como la monta App: con el campo siguiendo a la URL. */
function Screen() {
  useFieldUrlSync();
  return <ViewerPage />;
}

let contexts: FakeCanvasContexts;

beforeEach(async () => {
  initI18n("es");
  await setLanguage("es");
  contexts = installFakeBrowser();
});

afterEach(() => {
  // Primero se desmonta: cerrar el campo con la pantalla montada la volveria a dibujar.
  cleanup();
  resetApp();
  vi.useRealTimers();
});

function page(): HTMLElement {
  return screen.getByRole("main");
}

/** Espera a que el visor muestre esas epocas ("3", o "1,3" en una comparacion). */
async function shown(epochs: string): Promise<void> {
  await waitFor(() => expect(page().dataset.epochs).toBe(epochs));
}

async function openViewer(search: string, meta: unknown = wiseMeta) {
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

/** Nivel de gris (0 a 255) del pixel con valor de la imagen compuesta. */
function level(root: ParentNode): number {
  return pixelAt(composedImage(contexts, root), ...VALID)[0];
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

describe("ViewerPage: un link con coordenadas", () => {
  it("abre el campo, muestra la ultima epoca y llena la barra y los paneles", async () => {
    const { backend, container } = await openViewer(WISE);

    await shown("3");
    expect(backend.requests("field")).toHaveLength(1);
    expect(backend.requests("field")[0]?.body).toEqual({
      ra: 133.7598,
      dec: -7.2422,
      fov: 0.1667,
      band: 6,
    });
    expect(page().dataset).toMatchObject({ mode: "blink", source: "spherex", scene: "single" });
    // La imagen entera, encuadrada en el visor.
    expect(drawnWidth(contexts, container)).toBeCloseTo(VIEWPORT.width, 6);

    // Barra superior: marca, coordenadas con el formato de DESIGN.md y salida.
    expect(screen.getByText("SkyBlink")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Campo" })).toBeTruthy();
    expect(screen.getAllByText("08h 55m 02s")).toHaveLength(2);
    expect(screen.getAllByText("−07° 14′ 32″")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Volver a la entrada" }).getAttribute("href")).toBe(
      "/",
    );

    // Linea de tiempo con las tres epocas reales y sus fechas.
    const track = screen.getByRole("group", { name: "Épocas" });
    expect(
      within(track)
        .getAllByRole("radio")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual([
      "Época 1, 2025-05, cargada",
      "Época 2, 2025-10, cargada",
      "Época 3, 2026-04, cargada",
    ]);
    expect(radio("Época 3, 2026-04, cargada").checked).toBe(true);
    expect(screen.getByText("Época 3 de 3")).toBeTruthy();

    // Metadatos de la epoca y la banda actuales.
    const metadata = screen.getByRole("region", { name: "Metadatos" });
    for (const text of [
      "2026-04-21 a 2026-05-14",
      "B6 · 4,41–5,01 µm",
      "3,075″",
      "10′ × 10′",
      "21 de 21",
      "SPHEREx / IRSA",
      "Incompleto",
    ]) {
      expect(within(metadata).getByText(text), text).toBeTruthy();
    }

    // El campo de la muestra termino con un recorte menos.
    expect(screen.getByText("Campo incompleto")).toBeTruthy();
    expect(screen.getByText("faltaron 1 de 258 recortes")).toBeTruthy();
  });

  it("el nombre del objeto va como llega, y el modo y la epoca salen de la URL", async () => {
    await openViewer(
      `${WISE.replace("mode=blink", "mode=sum")}&epoch=2&name=WISE%20J085510.83-071442.5`,
    );

    await shown("1,2,3");
    expect(
      screen.getByRole("heading", { level: 1, name: "WISE J085510.83-071442.5" }),
    ).toBeTruthy();
    expect(radio("Suma").checked).toBe(true);
    expect(radio("Época 2, 2025-10, cargada").checked).toBe(true);
    expect(screen.getByText("Época 2 de 3")).toBeTruthy();
  });

  it("la vista de 5 minutos es el mismo cubo acercado al doble", async () => {
    const { backend, container } = await openViewer(WISE.replace("0.1667", "0.0833"));

    await shown("3");
    expect(backend.requests("field")[0]?.body).toMatchObject({ fov: 0.1667 });
    expect(drawnWidth(contexts, container)).toBeCloseTo(2 * VIEWPORT.width, 6);
    expect(radio("5 minutos de arco").checked).toBe(true);
  });
});

describe("ViewerPage: banda", () => {
  it("muestra B1 a B6 con el rango de los metadatos, no una lista fija", async () => {
    const meta = structuredClone(wiseMeta);
    const first = meta.detectors[0];
    if (!first) throw new Error("la muestra no tiene detectores");
    first.wave_min_um = 0.8;
    await openViewer(WISE, meta);
    await shown("3");

    const group = screen.getByRole("group", { name: "Banda infrarroja" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual([
      "B1, de 0,80 µm a 1,12 µm",
      "B2, de 1,10 µm a 1,65 µm",
      "B3, de 1,63 µm a 2,43 µm",
      "B4, de 2,40 µm a 3,85 µm",
      "B5, de 3,81 µm a 4,43 µm",
      "B6, de 4,41 µm a 5,01 µm",
    ]);
    expect(within(group).getByText("0,80–1,12")).toBeTruthy();
    expect(radio(/^B6,/).checked).toBe(true);
  });

  it("cambiar de banda actualiza la URL y el store, sin volver a pedir el campo", async () => {
    const { backend } = await openViewer(WISE);
    await shown("3");

    choose(/^B2,/);

    expect(new URLSearchParams(window.location.search).get("band")).toBe("2");
    expect(useFieldStore.getState().band).toBe(2);
    expect(radio(/^B2,/).checked).toBe(true);
    await waitFor(() => expect(useFieldStore.getState().planes[planeKey(3, 2)]).toBeDefined());
    await shown("3");
    expect(
      within(screen.getByRole("region", { name: "Metadatos" })).getByText(/^B2 · /),
    ).toBeTruthy();
    expect(backend.requests("field")).toHaveLength(1);
  });

  it("una banda sin datos en la epoca actual se ve apagada y se puede elegir igual", async () => {
    // Epsilon Indi B: la epoca 4 no tiene exposiciones en B1 ni en B4.
    await openViewer(`${EPS_IND}&epoch=4`, epsIndMeta);
    await shown("4");

    const names = within(screen.getByRole("group", { name: "Banda infrarroja" }))
      .getAllByRole("radio")
      .map((item) => item.getAttribute("aria-label") ?? "");
    expect(
      names.filter((name) => name.endsWith(", sin datos")).map((name) => name.slice(0, 2)),
    ).toEqual(["B1", "B4"]);
    const empty = radio(/^B1, .*sin datos$/);
    expect(empty.disabled).toBe(false);
    expect(empty.closest("label")?.dataset.noData).toBe("true");

    choose(/^B1, .*sin datos$/);

    expect(new URLSearchParams(window.location.search).get("band")).toBe("1");
    expect(await screen.findByText("Esta época no tiene datos en B1.")).toBeTruthy();
    expect(page().dataset.source).toBe("none");
    expect(radio("Época 4, 2026-09, sin datos").checked).toBe(true);
    // En otra epoca la banda vuelve a tener datos.
    choose(/^Época 3, /);
    await shown("3");
    expect(radio(/^B1,/).getAttribute("aria-label")).not.toContain("sin datos");
  });
});

describe("ViewerPage: modos", () => {
  it("parpadeo: una epoca por vez, con el saturado en blanco y el vacio en negro", async () => {
    const { container } = await openViewer(WISE);
    await shown("3");

    const image = composedImage(contexts, container);
    expect(pixelAt(image, ...NO_DATA)).toEqual([0, 0, 0]);
    expect(pixelAt(image, ...SATURATED)).toEqual([255, 255, 255]);
    const third = level(container);
    expect(third).toBeGreaterThan(0);
    expect(third).toBeLessThan(255);

    // Elegir otra epoca en la linea de tiempo cambia la imagen y la URL.
    choose(/^Época 1, /);
    expect(page().dataset.epochs).toBe("1");
    expect(new URLSearchParams(window.location.search).get("epoch")).toBe("1");
    expect(level(container)).toBeLessThan(third);
    // Sin comparacion no hay epoca de referencia que elegir.
    expect(screen.queryByRole("group", { name: "Época de referencia (B)" })).toBeNull();
  });

  it("diferencia: la epoca actual menos la de referencia, con los saturados enmascarados", async () => {
    const { container } = await openViewer(WISE);
    await shown("3");

    choose("Diferencia");

    expect(new URLSearchParams(window.location.search).get("mode")).toBe("difference");
    // Por defecto A es la ultima epoca y B, entre las bien cubiertas, la mas lejana en
    // fecha: la 2 (21 exposiciones en B6), no la 1 (3). compose.ts recibe B adelante.
    expect(page().dataset).toMatchObject({ scene: "difference", epochs: "2,3" });
    expect(screen.getByText("A 2026-04 · B 2025-10")).toBeTruthy();
    // La referencia y el estirado automaticos no se escriben en la URL.
    expect(new URLSearchParams(window.location.search).get("ref")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("stretch")).toBeNull();
    // La diferencia abre en estirado lineal.
    expect(
      within(screen.getByRole("group", { name: "Estirado" })).getByRole<HTMLInputElement>("radio", {
        name: "Lineal",
      }).checked,
    ).toBe(true);
    const image = composedImage(contexts, container);
    // La epoca 3 es mas brillante que la 2: A menos B da positivo, mas claro que el gris medio.
    expect(pixelAt(image, ...VALID)[0]).toBeGreaterThan(128);
    expect(pixelAt(image, ...SATURATED)).toEqual([0, 0, 0]);
    expect(pixelAt(image, ...NO_DATA)).toEqual([0, 0, 0]);

    // Otra referencia: queda en la URL.
    const reference = screen.getByRole("group", { name: "Época de referencia (B)" });
    expect(
      within(reference).getByRole<HTMLInputElement>("radio", { name: "Época 2, 2025-10" }).checked,
    ).toBe(true);
    // B no puede ser la misma epoca que A: queda deshabilitada (con `aria-disabled`, para decir por que).
    expect(
      within(reference)
        .getByRole("radio", { name: "Época 3, 2026-04" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    fireEvent.click(within(reference).getByRole("radio", { name: "Época 1, 2025-05" }));
    expect(page().dataset.epochs).toBe("1,3");
    expect(new URLSearchParams(window.location.search).get("ref")).toBe("1");

    // Si A pasa a ser la primera, la elegida ya no sirve de referencia: vuelve la
    // automatica (la 3, la mas lejana) y la resta cambia de signo.
    choose(/^Época 1, .*cargada$/);
    expect(page().dataset.epochs).toBe("3,1");
    expect(level(container)).toBeLessThan(128);

    // Fuera de diferencia y rojo/cian vuelve el estirado por defecto, salvo que se elija uno.
    choose("Parpadeo");
    expect(
      within(screen.getByRole("group", { name: "Estirado" })).getByRole<HTMLInputElement>("radio", {
        name: "Arcoseno hiperbólico",
      }).checked,
    ).toBe(true);
    choose("Logarítmico");
    expect(new URLSearchParams(window.location.search).get("stretch")).toBe("log");
    choose("Diferencia");
    expect(
      within(screen.getByRole("group", { name: "Estirado" })).getByRole<HTMLInputElement>("radio", {
        name: "Logarítmico",
      }).checked,
    ).toBe(true);
  });

  it("rojo/cian: A en rojo y B en cian", async () => {
    const { container } = await openViewer(WISE);
    await shown("3");

    choose("Rojo/cian");

    // B por defecto es la epoca 2: bien cubierta y la mas lejana en fecha a la 3.
    expect(page().dataset).toMatchObject({ scene: "redcyan", epochs: "3,2" });
    const image = composedImage(contexts, container);
    const [red, green, blue] = pixelAt(image, ...VALID);
    // A (epoca 3) es mas brillante que B (epoca 2): gana el rojo.
    expect(red).toBeGreaterThan(green);
    expect(green).toBe(blue);
    expect(pixelAt(image, ...SATURATED)).toEqual([0, 0, 0]);
  });

  it("suma: promedio de todas las epocas con datos de la banda", async () => {
    const { container } = await openViewer(WISE);
    await shown("3");
    const third = level(container);
    choose(/^Época 1, /);
    const first = level(container);

    choose("Suma");

    expect(page().dataset).toMatchObject({ scene: "sum", epochs: "1,2,3" });
    expect(screen.getByText("Promedio de las épocas con imagen: 3.")).toBeTruthy();
    const image = composedImage(contexts, container);
    const mean = pixelAt(image, ...VALID)[0];
    expect(mean).toBeGreaterThan(first);
    expect(mean).toBeLessThan(third);
    // Alcanza con que este saturado en una epoca.
    expect(pixelAt(image, ...SATURATED)).toEqual([255, 255, 255]);
    expect(pixelAt(image, ...NO_DATA)).toEqual([0, 0, 0]);
  });

  it("mantener apretado: se ve A y, con el boton o la barra espaciadora, B", async () => {
    await openViewer(WISE);
    await shown("3");

    choose("Mantener apretado");
    expect(page().dataset).toMatchObject({ mode: "hold", scene: "single", epochs: "3" });

    const button = screen.getByRole("button", { name: "Mantener para ver B" });
    fireEvent.pointerDown(button);
    // B por defecto: la epoca 2, bien cubierta y la mas lejana en fecha a la 3.
    expect(page().dataset.epochs).toBe("2");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    fireEvent.pointerUp(button);
    expect(page().dataset.epochs).toBe("3");
    // Si el puntero se va del boton sin soltar, tambien vuelve a A.
    fireEvent.pointerDown(button);
    fireEvent.pointerLeave(button);
    expect(page().dataset.epochs).toBe("3");

    // La barra espaciadora, con el foco donde quedo al elegir el modo.
    const modeRadio = radio("Mantener apretado");
    const notCancelled = fireEvent.keyDown(modeRadio, { key: " ", code: "Space" });
    expect(notCancelled).toBe(false);
    expect(page().dataset.epochs).toBe("2");
    fireEvent.keyUp(modeRadio, { key: " ", code: "Space" });
    expect(page().dataset.epochs).toBe("3");

    // Sobre otro boton la barra es de ese boton.
    fireEvent.keyDown(screen.getByRole("button", { name: "Época siguiente" }), {
      key: " ",
      code: "Space",
    });
    expect(page().dataset.epochs).toBe("3");

    // Sobre la imagen, apretar y arrastrar sigue siendo para desplazar.
    fireEvent.pointerDown(screen.getByRole("application", { name: "Imagen del campo" }));
    expect(page().dataset.epochs).toBe("3");

    // Si la ventana pierde el foco con la barra apretada, se suelta.
    fireEvent.keyDown(document.body, { key: " ", code: "Space" });
    expect(page().dataset.epochs).toBe("2");
    fireEvent.blur(window);
    expect(page().dataset.epochs).toBe("3");
  });

  it("fuera de mantener apretado la barra espaciadora no hace nada", async () => {
    await openViewer(WISE);
    await shown("3");

    const notCancelled = fireEvent.keyDown(document.body, { key: " ", code: "Space" });

    expect(notCancelled).toBe(true);
    expect(page().dataset.epochs).toBe("3");
  });

  it("avisa cuando alguna de las epocas comparadas es provisoria", async () => {
    const notice = "Alguna de las épocas comparadas es provisoria: todavía le faltan exposiciones.";
    // La referencia automatica evita la epoca provisoria (pocas exposiciones): se la elige en la URL.
    await openViewer(`${WISE}&ref=1`, loadingMeta());
    await shown("3");
    expect(radio("Época 1, 2025-05, provisoria")).toBeTruthy();
    // El parpadeo no compara.
    expect(screen.queryByText(notice)).toBeNull();

    for (const mode of ["Diferencia", "Rojo/cian", "Suma", "Mantener apretado"]) {
      choose(mode);
      expect(screen.getByText(notice), mode).toBeTruthy();
    }

    // Con una referencia definitiva el aviso se va.
    choose("Diferencia");
    choose("Época 2, 2025-10");
    expect(page().dataset.epochs).toBe("2,3");
    expect(screen.queryByText(notice)).toBeNull();
  });

  it("un plano provisorio se rotula con sus exposiciones", async () => {
    await openViewer(`${WISE}&epoch=1`, loadingMeta());
    await shown("1");

    expect(screen.getByText("Provisorio")).toBeTruthy();
    expect(screen.getByText("3 / 7 exposiciones")).toBeTruthy();

    choose(/^Época 2, /);
    expect(screen.queryByText("Provisorio")).toBeNull();
  });

  it("sin otra epoca con imagen los modos de comparacion lo dicen y muestran la actual", async () => {
    const meta = structuredClone(wiseMeta);
    for (const plane of meta.planes) {
      if (plane.detector === 6 && plane.epoch !== 3) {
        Object.assign(plane, { status: "empty", rev: 0, n_used: 0, n_exposures: 0 });
      }
    }
    await openViewer(WISE, meta);
    await shown("3");

    choose("Diferencia");

    expect(screen.getByText("Hace falta otra época con imagen para comparar.")).toBeTruthy();
    expect(page().dataset).toMatchObject({ scene: "single", epochs: "3" });
    choose("Mantener apretado");
    expect(
      screen.getByRole("button", { name: "Mantener para ver B" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });
});

describe("ViewerPage: reproductor", () => {
  function tick(ms: number): void {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  it("recorre las epocas con imagen sin reescribir la URL, y al pausar deja la que se ve", async () => {
    await openViewer(WISE);
    await shown("3");
    vi.useFakeTimers();
    const replace = vi.spyOn(window.history, "replaceState");

    fireEvent.click(screen.getByRole("button", { name: "Reproducir" }));

    expect(page().dataset.playing).toBe("true");
    expect(screen.getByRole("button", { name: "Pausar" })).toBeTruthy();
    expect(page().dataset.epochs).toBe("3");
    tick(FRAME_MS);
    expect(page().dataset.epochs).toBe("1");
    expect(radio(/^Época 1, /).checked).toBe(true);
    tick(FRAME_MS);
    expect(page().dataset.epochs).toBe("2");
    tick(FRAME_MS);
    expect(page().dataset.epochs).toBe("3");
    tick(FRAME_MS);
    expect(page().dataset.epochs).toBe("1");
    // Cuatro cuadros y la direccion sigue igual.
    expect(replace).not.toHaveBeenCalled();
    expect(new URLSearchParams(window.location.search).get("epoch")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pausar" }));

    expect(page().dataset.playing).toBeUndefined();
    expect(page().dataset.epochs).toBe("1");
    expect(new URLSearchParams(window.location.search).get("epoch")).toBe("1");
    tick(5 * FRAME_MS);
    expect(page().dataset.epochs).toBe("1");
  });

  it("la velocidad cambia cuanto dura cada epoca: 0,5x, 1x y 2x", async () => {
    await openViewer(WISE);
    await shown("3");
    vi.useFakeTimers();
    const speeds = screen.getByRole("group", { name: "Velocidad de reproducción" });
    expect(
      within(speeds)
        .getAllByRole("radio")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["0,5×", "1×", "2×"]);
    expect(radio("1×").checked).toBe(true);

    choose("2×");
    fireEvent.click(screen.getByRole("button", { name: "Reproducir" }));
    tick(FRAME_MS / 2);
    expect(page().dataset.epochs).toBe("1");
    tick(FRAME_MS / 2);
    expect(page().dataset.epochs).toBe("2");

    choose("0,5×");
    tick(FRAME_MS);
    expect(page().dataset.epochs).toBe("2");
    tick(FRAME_MS);
    expect(page().dataset.epochs).toBe("3");
  });

  it("anterior y siguiente pasan de epoca: en pausa por la URL, reproduciendo sin tocarla", async () => {
    await openViewer(WISE);
    await shown("3");
    const epochInUrl = () => new URLSearchParams(window.location.search).get("epoch");

    fireEvent.click(screen.getByRole("button", { name: "Época anterior" }));
    expect(page().dataset.epochs).toBe("2");
    expect(epochInUrl()).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Época siguiente" }));
    fireEvent.click(screen.getByRole("button", { name: "Época siguiente" }));
    // De la ultima vuelve a la primera.
    expect(page().dataset.epochs).toBe("1");
    expect(epochInUrl()).toBe("1");

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Reproducir" }));
    fireEvent.click(screen.getByRole("button", { name: "Época siguiente" }));
    expect(page().dataset.epochs).toBe("2");
    expect(epochInUrl()).toBe("1");
  });

  it("elegir una epoca o cambiar de modo detiene la reproduccion", async () => {
    await openViewer(WISE);
    await shown("3");
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "Reproducir" }));
    choose(/^Época 2, /);
    expect(page().dataset.playing).toBeUndefined();
    expect(new URLSearchParams(window.location.search).get("epoch")).toBe("2");

    fireEvent.click(screen.getByRole("button", { name: "Reproducir" }));
    expect(page().dataset.playing).toBe("true");
    choose("Diferencia");
    expect(page().dataset.playing).toBeUndefined();
    // Fuera del parpadeo no hay nada que reproducir; anterior y siguiente siguen andando.
    expect(screen.getByRole("button", { name: "Reproducir" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Época siguiente" }).disabled,
    ).toBe(false);
  });

  it("al cambiar de banda sigue reproduciendo con las epocas de la banda nueva", async () => {
    await openViewer(EPS_IND, epsIndMeta);
    await shown("4");
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "Reproducir" }));
    choose(/^B1,/);
    // B1 no tiene la epoca 4: mientras llegan sus imagenes no se muestra una que no existe.
    await vi.waitFor(() => {
      expect(useFieldStore.getState().planes[planeKey(3, 1)]).toBeDefined();
    });
    const seen = new Set<string | undefined>();
    for (let frame = 0; frame < 6; frame += 1) {
      tick(FRAME_MS);
      seen.add(page().dataset.epochs);
    }
    expect([...seen].sort()).toEqual(["1", "2", "3"]);
  });
});

describe("ViewerPage: imagen", () => {
  it("el contraste y el estirado cambian como se ve, sin pedir nada al backend", async () => {
    const { backend, container } = await openViewer(WISE);
    await shown("3");
    const calls = backend.calls.length;
    const before = level(container);

    const slider = screen.getByRole("slider", { name: "Contraste" });
    expect(slider.getAttribute("aria-valuetext")).toBe("50 %");
    fireEvent.change(slider, { target: { value: "70" } });
    expect(slider.getAttribute("aria-valuetext")).toBe("70 %");
    // Mas contraste baja el corte alto: el mismo valor queda mas claro.
    const contrasted = level(container);
    expect(contrasted).toBeGreaterThan(before);

    expect(radio("Arcoseno hiperbólico").checked).toBe(true);
    choose("Lineal");
    expect(level(container)).toBeLessThan(contrasted);
    choose("Logarítmico");
    expect(level(container)).toBeGreaterThan(contrasted);
    expect(backend.calls).toHaveLength(calls);
  });

  it("campo de vision: 5 acerca el mismo cubo y 30 pide el escalon amplio", async () => {
    const { backend, container } = await openViewer(`${WISE}&epoch=2`);
    await shown("2");

    choose("5 minutos de arco");
    expect(new URLSearchParams(window.location.search).get("fov")).toBe("0.0833");
    expect(drawnWidth(contexts, container)).toBeCloseTo(2 * VIEWPORT.width, 6);
    expect(screen.getByText("5′ × 5′")).toBeTruthy();
    expect(backend.requests("field")).toHaveLength(1);

    choose("30 minutos de arco");
    const params = new URLSearchParams(window.location.search);
    expect(params.get("fov")).toBe("0.5");
    // Otro campo tiene otras epocas: la elegida ya no vale.
    expect(params.get("epoch")).toBeNull();
    await waitFor(() => expect(backend.requests("field")).toHaveLength(2));
    expect(backend.requests("field")[1]?.body).toMatchObject({ fov: 0.5, band: 6 });
  });
});

describe("ViewerPage: carga de un campo nuevo", () => {
  it("muestra cada estado: pidiendo, en cola, listando, bajando y terminado", async () => {
    const field = await startNewField(EVENTS);
    field.backend.hold("field");
    openUrl(WISE_B3);
    render(<Screen />);

    // Pidiendo: todavia no respondio el POST.
    const requesting = await screen.findByRole("progressbar", { name: "Pidiendo el campo" });
    expect(requesting.getAttribute("aria-valuenow")).toBeNull();
    expect(page().dataset.source).toBe("none");
    expect(screen.getByText("Esperando la primera imagen.")).toBeTruthy();
    // Sin metadatos las bandas van sin rango: no hay una lista fija.
    expect(radio("B3").checked).toBe(true);
    field.backend.release("field");

    // En cola, con su posicion.
    await field.playUntil(1);
    const queued = await screen.findByRole("progressbar", { name: "En cola" });
    expect(queued.getAttribute("aria-valuetext")).toBe("Posición 1");
    expect(queued.getAttribute("aria-valuenow")).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Metadatos" })).getByText("En cola"),
    ).toBeTruthy();

    // Buscando exposiciones.
    await field.playUntil(3);
    expect(await screen.findByRole("progressbar", { name: "Buscando exposiciones" })).toBeTruthy();

    // Bajando, con recortes y porcentaje.
    await field.playUntil(9);
    const loading = await screen.findByRole("progressbar", { name: "Cargando datos" });
    await waitFor(() =>
      expect(loading.getAttribute("aria-valuetext")).toBe("11 / 258 recortes · 4 %"),
    );
    expect(loading.getAttribute("aria-valuenow")).toBe("4");
    // Desde `listed` la linea de tiempo y las bandas son las reales.
    expect(radio(/^B3, de 1,63/).checked).toBe(true);
    expect(radio("Época 3, 2026-04, sin cargar")).toBeTruthy();

    // Terminado: este campo queda incompleto por un recorte.
    await field.playUntil(82);
    expect(await screen.findByText("Campo incompleto")).toBeTruthy();
    expect(screen.getByText("faltaron 1 de 258 recortes")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    await shown("3");
    expect(radio("Época 3, 2026-04, cargada").checked).toBe(true);
  });

  it("mientras no hay imagen de SPHEREx muestra la vista provisoria, rotulada", async () => {
    const field = await startNewField(EVENTS);
    openUrl(WISE_B3);
    const { container } = render(<Screen />);

    await field.playUntil(4);

    await waitFor(() => expect(page().dataset.source).toBe("preview"));
    expect(page().dataset.epochs).toBeUndefined();
    expect(screen.getByText("Vista provisoria")).toBeTruthy();
    expect(screen.getByText("WISE 3,4 µm")).toBeTruthy();
    expect(screen.getByText("No es una imagen de SPHEREx.")).toBeTruthy();
    // Se dibuja con su propia escala: la vista de prueba vale 7 en todos los pixeles.
    const gray = level(container);
    expect(gray).toBeGreaterThan(0);
    expect(gray).toBeLessThan(255);
    expect(screen.queryByText("Esperando la primera imagen.")).toBeNull();
  });

  it("la primera imagen se ve apenas llega, aunque sea provisoria, y retira la vista de WISE", async () => {
    const field = await startNewField(EVENTS);
    openUrl(WISE_B3);
    render(<Screen />);
    await field.playUntil(4);
    await waitFor(() => expect(page().dataset.source).toBe("preview"));

    // Llega la provisoria de la epoca 1 en B3, con 1 de 3 exposiciones.
    await field.playUntil(8);

    await shown("1");
    expect(page().dataset.source).toBe("spherex");
    expect(screen.queryByText("Vista provisoria")).toBeNull();
    expect(screen.getByText("Provisorio")).toBeTruthy();
    expect(screen.getByText("1 / 3 exposiciones")).toBeTruthy();
    expect(radio("Época 1, 2025-05, provisoria").checked).toBe(true);
    expect(radio("Época 2, 2025-10, sin cargar")).toBeTruthy();
    // La carga sigue, con su barra.
    expect(screen.getByRole("progressbar", { name: "Cargando datos" })).toBeTruthy();

    // Al llegar las demas, la actual pasa a ser la ultima.
    await field.playUntil(12);
    await shown("3");
    expect(radio("Época 3, 2026-04, provisoria").checked).toBe(true);
  });

  it("una epoca elegida que todavia no llego lo dice en vez de mostrar otra", async () => {
    const field = await startNewField(EVENTS);
    openUrl(`${WISE_B3}&epoch=3`);
    render(<Screen />);

    await field.playUntil(8);

    expect(await screen.findByText("La imagen de esta época todavía no llegó.")).toBeTruthy();
    expect(page().dataset.source).toBe("none");
    await field.playUntil(12);
    await shown("3");
  });
});

describe("ViewerPage: errores", () => {
  function failWith(backend: FakeBackend, response: () => Response): void {
    backend.handlers.field = response;
  }

  it("cola llena: muestra la espera y habilita el reintento cuando pasa", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const backend = startBackend(wiseMeta);
    const original = backend.handlers.field;
    failWith(backend, () =>
      errorResponse("queue_full", 429, { retryable: true, headers: { "Retry-After": "5" } }),
    );
    openUrl(WISE);
    render(<Screen />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Hay muchos pedidos en espera.")).toBeTruthy();
    expect(within(alert).getByText("Se puede reintentar en 5 s.")).toBeTruthy();
    const retry = within(alert).getByRole<HTMLButtonElement>("button", { name: "Reintentar" });
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Campo sin cargar")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(within(alert).getByText("Se puede reintentar en 2 s.")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(within(alert).queryByText(/Se puede reintentar/)).toBeNull();
    expect(retry.disabled).toBe(false);
    expect(retry.getAttribute("aria-disabled")).toBeNull();

    backend.handlers.field = original;
    fireEvent.click(retry);
    await shown("3");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(backend.requests("field")).toHaveLength(2);
  });

  it("sin cobertura: lo dice y no ofrece reintentar", async () => {
    const backend = startBackend(wiseMeta);
    failWith(backend, () => errorResponse("no_coverage", 404));
    openUrl(WISE);
    render(<Screen />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("SPHEREx todavía no observó esa zona del cielo.")).toBeTruthy();
    expect(within(alert).queryByRole("button", { name: "Reintentar" })).toBeNull();
    // Lo que si ofrece son las salidas: el campo guardado mas cercano, con su
    // distancia, y el recorrido guiado (que aca no, porque es el de este campo).
    expect(within(alert).getByText(/campo guardado más cercano es Wolf 359, a 33,4°/)).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Abrir Wolf 359" })).toBeTruthy();
    expect(within(alert).queryByRole("button", { name: "Abrir el recorrido guiado" })).toBeNull();
    // Los controles siguen a mano para elegir otro campo de vision o volver.
    expect(radio("10 minutos de arco").checked).toBe(true);
    expect(screen.getByRole("link", { name: "Volver a la entrada" })).toBeTruthy();
  });

  it("el archivo no responde: ofrece reintentar y vuelve a pedir el campo", async () => {
    const backend = startBackend(wiseMeta);
    const original = backend.handlers.field;
    failWith(backend, () => errorResponse("upstream_unavailable", 503, { retryable: true }));
    openUrl(WISE);
    render(<Screen />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("El archivo de datos no responde.")).toBeTruthy();
    backend.handlers.field = original;
    fireEvent.click(within(alert).getByRole("button", { name: "Reintentar" }));

    await shown("3");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("red caida: ofrece reintentar", async () => {
    const backend = startBackend(wiseMeta);
    failWith(backend, () => {
      throw new TypeError("Failed to fetch");
    });
    openUrl(WISE);
    render(<Screen />);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("No se pudo conectar con el servidor.")).toBeTruthy();
    expect(
      within(alert).getByRole<HTMLButtonElement>("button", { name: "Reintentar" }).disabled,
    ).toBe(false);
  });

  it("si el trabajo falla a mitad de camino, las imagenes que llegaron siguen a la vista", async () => {
    const field = await startNewField(EVENTS);
    openUrl(WISE_B3);
    render(<Screen />);
    await field.playUntil(12);
    await shown("3");

    const stream = await field.stream();
    stream.event("error", {
      error: { code: "upstream_unavailable", message: "IRSA no responde", retryable: true },
    });

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("El archivo de datos no responde.")).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Reintentar" })).toBeTruthy();
    expect(page().dataset).toMatchObject({ source: "spherex", epochs: "3" });
    expect(screen.getByText("Carga interrumpida")).toBeTruthy();
  });

  it("una imagen que no se pudo bajar se avisa y se puede reintentar", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = startBackend(wiseMeta);
    const original = backend.handlers.plane;
    backend.handlers.plane = (call, epoch, detector) =>
      epoch === 3 ? errorResponse("not_found", 404) : original(call, epoch, detector);
    openUrl(WISE);
    render(<Screen />);

    expect(await screen.findByText("Imágenes que no se pudieron bajar: 1.")).toBeTruthy();
    // Mientras tanto se ve la ultima epoca que si llego.
    await shown("2");

    backend.handlers.plane = original;
    fireEvent.click(screen.getByRole("button", { name: "Reintentar la descarga" }));

    await shown("3");
    expect(screen.queryByText(/no se pudieron bajar/)).toBeNull();
  });
});

describe("ViewerPage: barra superior", () => {
  it("volver a la entrada quita el campo de la URL y deja una entrada en el historial", async () => {
    await openViewer(`${WISE}&lang=es`);
    await shown("3");
    const push = vi.spyOn(window.history, "pushState");

    const back = screen.getByRole("link", { name: "Volver a la entrada" });
    expect(back.getAttribute("href")).toBe("/?lang=es");
    fireEvent.click(back);

    expect(window.location.search).toBe("?lang=es");
    expect(push).toHaveBeenCalledTimes(1);
    expect(useUrlState.getState().ra).toBeNull();
    expect(useFieldStore.getState().phase).toBe("idle");
  });

  it("el selector de idioma escribe el idioma en la URL", async () => {
    await openViewer(WISE);
    await shown("3");

    choose("English");

    expect(new URLSearchParams(window.location.search).get("lang")).toBe("en");
    expect(useUrlState.getState().lang).toBe("en");
  });
});
