// La capa de flags de la pantalla del visor: el conmutador, la trama sobre la
// imagen y la lista de flags presentes, contra un backend simulado y sin red.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, setLanguage } from "@/i18n";
import {
  binaryResponse,
  errorResponse,
  type FakeBackend,
  type RawMeta,
} from "@/state/fieldStore.testkit";
import { useFieldUrlSync } from "@/state/fieldUrlSync";
import newFieldEvents from "@/test/fixtures/events-new-field.json";
import epsIndMeta from "@/test/fixtures/meta-epsindb.json";
import wiseMeta from "@/test/fixtures/meta-wise0855.json";
import type { FakeCanvasContexts } from "@/viewer/testSupport";
import { ViewerPage } from "./ViewerPage";
import {
  composedImage,
  hatchedPixels,
  hatchMask,
  installFakeBrowser,
  openUrl,
  pixelAt,
  type RawEvent,
  resetApp,
  startBackend,
  startNewField,
} from "./viewerPage.testkit";

const WISE = "?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink";
const WISE_B3 = "?ra=133.7598&dec=-7.2422&fov=0.1667&band=3&mode=blink";
const EPS_IND = "?ra=331.0966&dec=-56.8006&fov=0.1667&band=3&mode=blink";

const EVENTS = newFieldEvents as RawEvent[];

// Bits de `flags[]` de las muestras (el encabezado de los archivos de SPHEREx).
const TRANSIENT = 1 << 0;
const OVERFLOW = 1 << 1;
const HOT = 1 << 10;
/** Informativo: el procesamiento no descarta los pixeles que lo tienen. */
const SOURCE = 1 << 21;
const BLOOM = 1 << 26;

type Mark = readonly [x: number, y: number, bits: number];

/** Flags de cada epoca en las capas simuladas. */
const MARKS: Record<number, readonly Mark[]> = {
  1: [[9, 2, TRANSIENT]],
  2: [],
  3: [
    [5, 0, OVERFLOW | BLOOM],
    [6, 0, HOT],
    [7, 0, SOURCE],
  ],
};

function auxResponse(shape: readonly [number, number], marks: readonly Mark[]): Response {
  const [height, width] = shape;
  const size = height * width;
  const bytes = new ArrayBuffer(6 * size);
  const flags = new Uint32Array(bytes, 0, size);
  for (const [x, y, bits] of marks) flags[y * width + x] = bits >>> 0;
  return binaryResponse(bytes);
}

/** Hace que /aux responda con esas marcas por epoca, en cualquier banda. */
function serveMarks(backend: FakeBackend, marks: Record<number, readonly Mark[]> = MARKS): void {
  backend.handlers.aux = (_call, epoch) => {
    const shape = backend.state.meta.grid?.shape ?? backend.state.fallbackShape ?? [195, 195];
    return auxResponse(shape, marks[epoch] ?? []);
  };
}

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
  cleanup();
  resetApp();
});

function page(): HTMLElement {
  return screen.getByRole("main");
}

async function shown(epochs: string): Promise<void> {
  await waitFor(() => expect(page().dataset.epochs).toBe(epochs));
}

async function flags(status: string): Promise<void> {
  await waitFor(() => expect(page().dataset.flags).toBe(status));
}

function openViewer(search: string, meta: unknown = wiseMeta) {
  const backend = startBackend(meta);
  serveMarks(backend);
  openUrl(search);
  const view = render(<Screen />);
  return { backend, ...view };
}

function toggle(): HTMLInputElement {
  return screen.getByRole("switch", { name: "Capa de flags" }) as HTMLInputElement;
}

function choose(name: string | RegExp): void {
  fireEvent.click(screen.getByRole("radio", { name }));
}

/** Pedidos de capas auxiliares, como "epoca/detector". */
function auxRequests(backend: FakeBackend): string[] {
  return backend.requests("aux").map((call) => call.path.replace(/^.*\/aux\//, ""));
}

/** Pixeles bajo la trama en lo ultimo que dibujo el visor. */
function hatched(root: ParentNode): string[] {
  return hatchedPixels(hatchMask(contexts, root));
}

/** La lista de flags: nombre, cantidad y descripcion de cada renglon. */
function listed(): Array<{ name: string; hatched: string; pixels: string; description: string }> {
  const list = screen.queryByRole("list", { name: "Flags presentes" });
  if (list === null) return [];
  return within(list)
    .getAllByRole("listitem")
    .map((item) => {
      const [name, pixels, description] = [...item.querySelectorAll(":scope > span")];
      return {
        name: name?.textContent ?? "",
        hatched: item.querySelector("svg")?.getAttribute("data-hatched") ?? "",
        pixels: pixels?.textContent ?? "",
        description: description?.textContent ?? "",
      };
    });
}

describe("ViewerPage: capa de flags", () => {
  it("apagada no pide capas, no dibuja trama y no lista nada", async () => {
    const { backend, container } = openViewer(WISE);
    await shown("3");

    expect(toggle().checked).toBe(false);
    expect(page().dataset.flags).toBe("off");
    expect(auxRequests(backend)).toEqual([]);
    expect(hatchMask(contexts, container)).toBeNull();
    expect(listed()).toEqual([]);
  });

  it("al prenderla pide las capas del plano que se ve y cubre los pixeles que el procesamiento descarta", async () => {
    const { backend, container } = openViewer(WISE);
    await shown("3");
    const before = pixelAt(composedImage(contexts, container), 5, 0);

    fireEvent.click(toggle());

    expect(toggle().checked).toBe(true);
    await flags("ready");
    expect(auxRequests(backend)).toEqual(["3/6"]);
    // OVERFLOW y BLOOM en (5, 0) y HOT en (6, 0). SOURCE, en (7, 0), no se descarta: sin trama.
    expect(hatched(container)).toEqual(["5,0", "6,0"]);
    // La trama va encima: la imagen de abajo es la misma.
    expect(pixelAt(composedImage(contexts, container), 5, 0)).toEqual(before);
  });

  it("lista los flags presentes en ese plano con su nombre, su descripcion y sus pixeles", async () => {
    openViewer(WISE);
    await shown("3");

    fireEvent.click(toggle());
    await flags("ready");

    expect(listed()).toEqual([
      {
        name: "OVERFLOW",
        hatched: "true",
        pixels: "con trama 1 px",
        // La interfaz esta en espanol: la descripcion sale de la tabla del idioma, no del encabezado.
        description: "Desborde detectado durante la lectura en rampa (SUR)",
      },
      { name: "HOT", hatched: "true", pixels: "con trama 1 px", description: "Píxel caliente" },
      {
        name: "SOURCE",
        hatched: "false",
        pixels: "sin trama 1 px",
        description: "Píxel asociado a una fuente conocida",
      },
      {
        name: "BLOOM",
        hatched: "true",
        pixels: "con trama 1 px",
        description: "Píxel que forma parte de un desborde de carga (blooming)",
      },
    ]);
    // De que epoca son y que significa la trama.
    expect(screen.getByText("época 3")).toBeTruthy();
    expect(
      screen.getByText("La trama cubre los píxeles que el procesamiento descarta."),
    ).toBeTruthy();
  });

  it("al apagarla se va la trama y la lista, y no se pide nada mas", async () => {
    const { backend, container } = openViewer(WISE);
    await shown("3");
    fireEvent.click(toggle());
    await flags("ready");

    fireEvent.click(toggle());

    expect(page().dataset.flags).toBe("off");
    expect(hatchMask(contexts, container)).toBeNull();
    expect(listed()).toEqual([]);
    choose(/^Época 1, /);
    expect(page().dataset.epochs).toBe("1");
    expect(auxRequests(backend)).toEqual(["3/6"]);
  });

  it("sigue a la imagen al cambiar de epoca", async () => {
    const { backend, container } = openViewer(WISE);
    await shown("3");
    fireEvent.click(toggle());
    await flags("ready");

    choose(/^Época 1, /);

    // Mientras llegan las capas de la epoca 1 no queda la trama de la 3.
    expect(page().dataset.epochs).toBe("1");
    expect(hatchMask(contexts, container)).toBeNull();
    expect(screen.getByText("Cargando los flags.")).toBeTruthy();
    await flags("ready");
    expect(auxRequests(backend)).toEqual(["3/6", "1/6"]);
    expect(hatched(container)).toEqual(["9,2"]);
    expect(listed().map((item) => item.name)).toEqual(["TRANSIENT"]);
    expect(screen.getByText("época 1")).toBeTruthy();

    // Las que ya se bajaron no se piden otra vez.
    choose(/^Época 3, /);
    expect(page().dataset.flags).toBe("ready");
    expect(hatched(container)).toEqual(["5,0", "6,0"]);
    expect(auxRequests(backend)).toEqual(["3/6", "1/6"]);
  });

  it("un plano sin pixeles marcados lo dice y no lleva trama", async () => {
    const { container } = openViewer(`${WISE}&epoch=2`);
    await shown("2");

    fireEvent.click(toggle());
    await flags("ready");

    expect(screen.getByText("Esta imagen no tiene píxeles marcados.")).toBeTruthy();
    expect(hatchMask(contexts, container)).toBeNull();
    expect(listed()).toEqual([]);
  });

  it("sigue a la imagen al cambiar de banda", async () => {
    const { backend, container } = openViewer(WISE);
    await shown("3");
    fireEvent.click(toggle());
    await flags("ready");

    choose(/^B2,/);

    await waitFor(() => expect(auxRequests(backend)).toEqual(["3/6", "3/2"]));
    await flags("ready");
    expect(hatched(container)).toEqual(["5,0", "6,0"]);
  });

  it("en una comparacion cubre lo de todas las epocas que entran", async () => {
    // Con la epoca 1 de referencia (la automatica seria la 2, mejor cubierta).
    const { backend, container } = openViewer(`${WISE}&ref=1`);
    await shown("3");
    fireEvent.click(toggle());
    await flags("ready");

    choose("Diferencia");

    expect(page().dataset.epochs).toBe("1,3");
    await flags("ready");
    expect([...auxRequests(backend)].sort()).toEqual(["1/6", "3/6"]);
    expect(hatched(container)).toEqual(["5,0", "6,0", "9,2"]);
    expect(listed().map((item) => `${item.name} ${item.pixels}`)).toEqual([
      "TRANSIENT con trama 1 px",
      "OVERFLOW con trama 1 px",
      "HOT con trama 1 px",
      "SOURCE sin trama 1 px",
      "BLOOM con trama 1 px",
    ]);
    expect(screen.getByText("épocas 1, 3")).toBeTruthy();

    // En suma entran las tres.
    choose("Suma");
    await flags("ready");
    expect([...auxRequests(backend)].sort()).toEqual(["1/6", "2/6", "3/6"]);
    expect(screen.getByText("épocas 1, 2, 3")).toBeTruthy();
  });

  it("en mantener apretado muestra los flags de la epoca que esta en pantalla", async () => {
    const { container } = openViewer(`${WISE.replace("mode=blink", "mode=hold")}&ref=1`);
    await shown("3");
    fireEvent.click(toggle());
    await flags("ready");
    expect(hatched(container)).toEqual(["5,0", "6,0"]);

    const hold = screen.getByRole("button", { name: "Mantener para ver B" });
    fireEvent.pointerDown(hold);
    expect(page().dataset.epochs).toBe("1");
    await flags("ready");
    expect(hatched(container)).toEqual(["9,2"]);

    fireEvent.pointerUp(hold);
    expect(hatched(container)).toEqual(["5,0", "6,0"]);
  });

  it("mientras las capas estan en camino lo dice, sin trama", async () => {
    const { backend, container } = openViewer(WISE);
    await shown("3");
    backend.hold("aux");

    fireEvent.click(toggle());

    await flags("loading");
    expect(screen.getByText("Cargando los flags.")).toBeTruthy();
    expect(hatchMask(contexts, container)).toBeNull();
    backend.release("aux");
    await flags("ready");
    expect(screen.queryByText("Cargando los flags.")).toBeNull();
    expect(hatched(container)).toEqual(["5,0", "6,0"]);
  });

  it("si las capas no se pueden bajar lo avisa y deja reintentar", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { backend, container } = openViewer(WISE);
    await shown("3");
    backend.handlers.aux = () => errorResponse("not_found", 404);

    fireEvent.click(toggle());

    await flags("error");
    expect(screen.getByText("No se pudieron cargar los flags.")).toBeTruthy();
    expect(hatchMask(contexts, container)).toBeNull();
    // No insiste solo.
    expect(auxRequests(backend)).toEqual(["3/6"]);

    serveMarks(backend);
    const control = toggle().closest("[data-flags]") as HTMLElement;
    fireEvent.click(within(control).getByRole("button", { name: "Reintentar" }));

    await flags("ready");
    expect(auxRequests(backend)).toEqual(["3/6", "3/6"]);
    expect(hatched(container)).toEqual(["5,0", "6,0"]);
    expect(screen.queryByText("No se pudieron cargar los flags.")).toBeNull();
  });

  it("sin imagen de SPHEREx en pantalla no pide nada y explica por que", async () => {
    // Epsilon Indi B: la epoca 4 no tiene exposiciones en B1.
    const { backend } = openViewer(`${EPS_IND.replace("band=3", "band=1")}&epoch=4`, epsIndMeta);
    await screen.findByText("Esta época no tiene datos en B1.");

    fireEvent.click(toggle());

    expect(page().dataset.flags).toBe("idle");
    expect(
      screen.getByText("Los flags se ven cuando hay una imagen de SPHEREx en pantalla."),
    ).toBeTruthy();
    expect(auxRequests(backend)).toEqual([]);

    // Al pasar a una epoca con imagen, la capa ya esta prendida.
    choose(/^Época 3, /);
    await shown("3");
    await flags("ready");
    expect(auxRequests(backend)).toEqual(["3/1"]);
  });

  it("la barra espaciadora sobre el conmutador lo cambia: no es la de mantener apretado", async () => {
    openViewer(WISE.replace("mode=blink", "mode=hold"));
    await shown("3");

    const notCancelled = fireEvent.keyDown(toggle(), { key: " ", code: "Space" });

    // El visor no se queda con la tecla del control.
    expect(notCancelled).toBe(true);
    expect(page().dataset.epochs).toBe("3");
  });
});

describe("ViewerPage: capa de flags mientras el campo carga", () => {
  /** Como el backend real mientras carga: `flags[]` solo esta al dia en GET /meta. */
  function serveFlagList(backend: FakeBackend): void {
    backend.state.meta = { ...backend.state.meta, flags: wiseMeta.flags } as RawMeta;
  }

  /** Marcas distintas segun la revision vigente del plano 1 de B3. */
  function serveByRevision(backend: FakeBackend): void {
    backend.handlers.aux = (_call, epoch, detector) => {
      const plane = backend.state.meta.planes?.find(
        (item) => item.epoch === epoch && item.detector === detector,
      );
      const marks: Mark[] = plane?.rev === 1 ? [[4, 4, HOT]] : [[8, 8, HOT]];
      return auxResponse([195, 195], marks);
    };
  }

  it("pide la lista de flags a /meta, que por el flujo llega vacia", async () => {
    const field = await startNewField(EVENTS);
    serveByRevision(field.backend);
    openUrl(`${WISE_B3}&epoch=1`);
    const { container } = render(<Screen />);
    await field.playUntil(8);
    await shown("1");
    serveFlagList(field.backend);
    expect(field.backend.requests("meta")).toEqual([]);

    fireEvent.click(toggle());

    await flags("ready");
    expect(field.backend.requests("meta")).toHaveLength(1);
    expect(hatched(container)).toEqual(["4,4"]);
    expect(listed().map((item) => item.name)).toEqual(["HOT"]);
  });

  it("cuando el plano cambia de revision la capa sigue a la imagen nueva", async () => {
    const field = await startNewField(EVENTS);
    serveByRevision(field.backend);
    openUrl(`${WISE_B3}&epoch=1`);
    const { container } = render(<Screen />);
    await field.playUntil(8);
    await shown("1");
    serveFlagList(field.backend);
    fireEvent.click(toggle());
    await flags("ready");
    // La provisoria, con 1 de 3 exposiciones.
    expect(screen.getByText("1 / 3 exposiciones")).toBeTruthy();
    expect(hatched(container)).toEqual(["4,4"]);
    expect(auxRequests(field.backend)).toEqual(["1/3"]);

    // Llega la definitiva de la epoca 1.
    await field.playUntil(14);

    await waitFor(() => expect(auxRequests(field.backend)).toEqual(["1/3", "1/3"]));
    await waitFor(() => expect(screen.queryByText("Provisorio")).toBeNull());
    await flags("ready");
    // Las capas son las de la revision nueva, no las de la provisoria.
    expect(hatched(container)).toEqual(["8,8"]);
  });
});
