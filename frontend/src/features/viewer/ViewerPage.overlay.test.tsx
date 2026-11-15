// Lo que la pantalla del visor dibuja sobre la imagen (mira, rastro, contorno
// de saturacion, escala, rosa, modo y banda, rotulo) y el panel de avisos de
// calidad, contra un backend simulado y sin red.

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, setLanguage } from "@/i18n";
import { jsonResponse } from "@/state/fieldStore.testkit";
import { useFieldUrlSync } from "@/state/fieldUrlSync";
import barnardTrack from "@/test/fixtures/barnard/track_name-barnard-s-star.json";
import barnardMeta from "@/test/fixtures/meta-barnard.json";
import epsIndMeta from "@/test/fixtures/meta-epsindb.json";
import wiseMeta from "@/test/fixtures/meta-wise0855.json";
import type { FakeCanvasContexts } from "@/viewer/testSupport";
import { trailOpacity } from "./annotations";
import { ViewerPage } from "./ViewerPage";
import {
  installFakeBrowser,
  openUrl,
  resetApp,
  startBackend,
  VIEWPORT,
} from "./viewerPage.testkit";

const BARNARD_FIELD = "?ra=269.4463&dec=4.7683&fov=0.1667&band=3&mode=blink";
const BARNARD = `${BARNARD_FIELD}&name=Barnard%27s%20Star`;
const WISE = "?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink";
const EPS_IND = "?ra=331.0966&dec=-56.8006&fov=0.1667&band=3&mode=blink";

/** Respuesta de /api/resolve para Barnard, como el ejemplo de la seccion 4.8 del contrato. */
const BARNARD_RESOLVED = {
  query: "Barnard's Star",
  name: "NAME Barnard's star",
  source: "sesame",
  object_type: "BY*",
  j2000: { ra: 269.452077, dec: 4.693365 },
  motion: {
    pm_ra: -801.551,
    pm_dec: 10362.394,
    parallax: 546.976,
    radial_velocity: -110.11,
    per_year_arcsec: 10.39,
  },
  field_center: { ra: 269.4463, dec: 4.7683, epoch: 2026.0 },
  moved_arcsec: 270.4,
};

/** Un objeto sin movimiento propio, en el centro del campo de Barnard. */
const STILL_RESOLVED = {
  query: "Objeto quieto",
  name: "Objeto quieto",
  source: "sesame",
  object_type: null,
  j2000: { ra: 269.4463, dec: 4.7683 },
  motion: null,
  field_center: { ra: 269.4463, dec: 4.7683, epoch: 2026.0 },
  moved_arcsec: 0,
};

/** El cubo base, de 195 pixeles de lado, encuadrado en el visor simulado de 800 px. */
const GRID = 195;
const SCALE = VIEWPORT.width / GRID;

/** De pixel de la grilla a pixel del visor: el centro de la grilla va al centro del visor. */
function toScreen(x: number, y: number): { x: number; y: number } {
  const middle = (GRID - 1) / 2;
  return {
    x: VIEWPORT.width / 2 + (x - middle) * SCALE,
    y: VIEWPORT.height / 2 - (y - middle) * SCALE,
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

/** Abre el visor con un backend que conoce a Barnard y su trayectoria. */
function openViewer(search: string, meta: unknown = barnardMeta) {
  const backend = startBackend(meta);
  backend.handlers.track = (call) =>
    call.query.get("name") === "Barnard's Star"
      ? jsonResponse(barnardTrack)
      : jsonResponse({ name: call.query.get("name") ?? "", positions: [] });
  backend.handlers.resolve = (call) => {
    const name = call.query.get("name");
    if (name === "Barnard's Star") return jsonResponse(BARNARD_RESOLVED);
    if (name === "Objeto quieto") return jsonResponse(STILL_RESOLVED);
    return jsonResponse(
      { error: { code: "not_resolved", message: "desconocido", retryable: false } },
      404,
    );
  };
  openUrl(search);
  const view = render(<Screen />);
  return { backend, ...view };
}

function annotations(kind: string): Element[] {
  return [...page().querySelectorAll(`[data-annotation="${kind}"]`)];
}

function annotation(kind: string): Element {
  const found = annotations(kind);
  if (found.length !== 1) throw new Error(`hay ${found.length} anotaciones "${kind}"`);
  return found[0] as Element;
}

/** Los dos numeros de un `translate(x y)`. */
function translation(element: Element): { x: number; y: number } {
  const match = /^translate\((\S+) (\S+)\)$/.exec(element.getAttribute("transform") ?? "");
  if (!match) throw new Error("la anotacion no esta ubicada con translate");
  return { x: Number(match[1]), y: Number(match[2]) };
}

function circle(element: Element | null | undefined): { x: number; y: number; r: number } {
  if (!element) throw new Error("falta el circulo");
  return {
    x: Number(element.getAttribute("cx")),
    y: Number(element.getAttribute("cy")),
    r: Number(element.getAttribute("r")),
  };
}

function expectAt(actual: { x: number; y: number }, x: number, y: number): void {
  const wanted = toScreen(x, y);
  expect(actual.x).toBeCloseTo(wanted.x, 6);
  expect(actual.y).toBeCloseTo(wanted.y, 6);
}

function texts(element: Element): string[] {
  return [...element.querySelectorAll("text")].map((item) => item.textContent ?? "");
}

function choose(name: string | RegExp): void {
  fireEvent.click(screen.getByRole("radio", { name }));
}

async function reticleReady(): Promise<void> {
  await waitFor(() => expect(annotations("reticle")).toHaveLength(1));
}

describe("ViewerPage: mira y rastro del objeto buscado", () => {
  it("la mira va sobre el objeto en la epoca que se ve, con su nombre y su movimiento por anio", async () => {
    const { backend } = openViewer(BARNARD);
    await shown("3");
    await reticleReady();

    // Posicion esperada en la epoca 3 segun /track (movimiento propio y paralaje).
    const reticle = annotation("reticle");
    expectAt(translation(reticle), 97.355, 99.287);
    expect(reticle.getAttribute("data-epoch")).toBe("3");
    expect(texts(reticle)).toEqual(["Barnard's Star", "10,39″ / año"]);
    expect(backend.requests("track")).toHaveLength(1);
    expect(backend.requests("track")[0]?.query.get("name")).toBe("Barnard's Star");

    // Al elegir otra epoca la mira se va con el objeto.
    choose(/^Época 1, /);
    expectAt(translation(annotation("reticle")), 97.105, 95.954);
    expect(annotation("reticle").getAttribute("data-epoch")).toBe("1");
    choose(/^Época 2, /);
    expectAt(translation(annotation("reticle")), 96.913, 97.797);
    // No hizo falta pedir nada mas.
    expect(backend.requests("track")).toHaveLength(1);
  });

  it("el rastro marca las epocas anteriores, mas tenues cuanto mas viejas", async () => {
    openViewer(BARNARD);
    await shown("3");
    await reticleReady();

    const rings = annotations("trail");
    expect(rings.map((ring) => ring.getAttribute("data-epoch"))).toEqual(["1", "2"]);
    expectAt(circle(rings[0]?.querySelector("circle")), 97.105, 95.954);
    expectAt(circle(rings[1]?.querySelector("circle")), 96.913, 97.797);
    expect(Number(rings[0]?.getAttribute("opacity"))).toBeCloseTo(trailOpacity(2), 9);
    expect(Number(rings[1]?.getAttribute("opacity"))).toBeCloseTo(trailOpacity(1), 9);
    // Anillos de 8 px: radio 4, con el trazo de vacio debajo del claro.
    for (const ring of rings) {
      expect([...ring.querySelectorAll("circle")].map((item) => circle(item).r)).toEqual([4, 4]);
    }

    choose(/^Época 2, /);
    expect(annotations("trail").map((ring) => ring.getAttribute("data-epoch"))).toEqual(["1"]);
    // La primera epoca no tiene anteriores.
    choose(/^Época 1, /);
    expect(annotations("trail")).toEqual([]);
  });

  it("en mantener apretado la mira sigue a la epoca que esta en pantalla", async () => {
    openViewer(`${BARNARD.replace("mode=blink", "mode=hold")}`);
    await shown("3");
    await reticleReady();
    expectAt(translation(annotation("reticle")), 97.355, 99.287);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Mantener para ver B" }));
    expect(page().dataset.epochs).toBe("1");
    expectAt(translation(annotation("reticle")), 97.105, 95.954);
    expect(annotations("trail")).toEqual([]);

    fireEvent.pointerUp(screen.getByRole("button", { name: "Mantener para ver B" }));
    expectAt(translation(annotation("reticle")), 97.355, 99.287);
  });

  it("en una comparacion la mira va en la epoca actual (A)", async () => {
    openViewer(`${BARNARD.replace("mode=blink", "mode=difference")}&epoch=2`);
    await shown("1,2");
    await reticleReady();

    expectAt(translation(annotation("reticle")), 96.913, 97.797);
    expect(annotations("trail").map((ring) => ring.getAttribute("data-epoch"))).toEqual(["1"]);
  });

  it("sigue al acercamiento: en la vista de 5 minutos todo queda al doble de distancia del centro", async () => {
    openViewer(BARNARD.replace("0.1667", "0.0833"));
    await shown("3");
    await reticleReady();

    const wide = toScreen(97.355, 99.287);
    const center = VIEWPORT.width / 2;
    const reticle = translation(annotation("reticle"));
    expect(reticle.x - center).toBeCloseTo(2 * (wide.x - center), 6);
    expect(reticle.y - center).toBeCloseTo(2 * (wide.y - center), 6);
  });

  it("sin nombre en la URL no hay mira ni rastro, y no se pide la trayectoria", async () => {
    const { backend } = openViewer(BARNARD_FIELD);
    await shown("3");
    await waitFor(() => expect(annotations("scale")).toHaveLength(1));

    expect(annotations("reticle")).toEqual([]);
    expect(annotations("trail")).toEqual([]);
    expect(backend.requests("track")).toEqual([]);
    expect(backend.requests("resolve")).toEqual([]);
  });

  it("un objeto sin movimiento propio lleva la mira en el centro del campo y no deja rastro", async () => {
    openViewer(`${BARNARD_FIELD}&name=Objeto%20quieto`);
    await shown("3");
    await reticleReady();

    // `field_center` es el centro de la grilla: el pixel (97, 97).
    const reticle = annotation("reticle");
    expect(translation(reticle).x).toBeCloseTo(VIEWPORT.width / 2, 0);
    expect(translation(reticle).y).toBeCloseTo(VIEWPORT.height / 2, 0);
    // Sin movimiento propio no hay velocidad que mostrar.
    expect(texts(reticle)).toEqual(["Objeto quieto"]);
    expect(annotations("trail")).toEqual([]);
    choose(/^Época 1, /);
    expect(translation(annotation("reticle")).x).toBeCloseTo(VIEWPORT.width / 2, 0);
  });

  it("un nombre que no se pudo resolver no dibuja la mira en cualquier lado", async () => {
    openViewer(`${BARNARD_FIELD}&name=Nadie`);
    await shown("3");
    await waitFor(() => expect(annotations("scale")).toHaveLength(1));
    // La trayectoria llega vacia y no hay `field_center`: no se sabe donde esta.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(annotations("reticle")).toEqual([]);
  });
});

describe("ViewerPage: fuente saturada", () => {
  it("rodea cada region saturada del plano con un contorno claro sobre uno de vacio", async () => {
    openViewer(BARNARD);
    await shown("3");

    // Epoca 3, B3: una region de 177 pixeles (`planes[].saturated[]`).
    const contour = annotation("saturated");
    const [under, over] = [...contour.querySelectorAll("circle")];
    expectAt(circle(under), 97.25, 98.77);
    expectAt(circle(over), 97.25, 98.77);
    expect(circle(under).r).toBeCloseTo(7.51 * SCALE, 6);
    expect(circle(over).r).toBeCloseTo(7.51 * SCALE, 6);
    // El trazo de vacio va debajo: se dibuja primero.
    expect(under?.getAttribute("class")).not.toBe(over?.getAttribute("class"));

    // Al cambiar de epoca el contorno es el de ese plano.
    choose(/^Época 1, /);
    const first = circle(annotation("saturated").querySelector("circle"));
    expectAt(first, 97.54, 95.34);
    expect(first.r).toBeCloseTo(6.96 * SCALE, 6);
  });

  it("el aviso de fuente saturada esta a la vista sobre la imagen y en el panel", async () => {
    openViewer(BARNARD);
    await shown("3");

    const notice = annotation("saturated-notice");
    expect(notice.textContent).toBe("Fuente saturada");
    expect(notice.querySelector('[data-icon="alert"]')).not.toBeNull();

    const panel = screen.getByRole("region", { name: "Avisos de calidad" });
    expect(
      within(panel).getByText(
        "Hay una fuente saturada en 17h 57m 47s +04° 46′ 08″: su centro no tiene medición válida.",
      ),
    ).toBeTruthy();
  });

  it("en una comparacion van los contornos de las dos epocas y sigue siendo una fuente", async () => {
    openViewer(BARNARD);
    await shown("3");

    choose("Diferencia");
    expect(page().dataset.epochs).toBe("1,3");
    const centers = annotations("saturated").map((item) => circle(item.querySelector("circle")));
    expect(centers).toHaveLength(2);
    expectAt(centers[0] as { x: number; y: number }, 97.54, 95.34);
    expectAt(centers[1] as { x: number; y: number }, 97.25, 98.77);
    expect(annotation("saturated-notice").textContent).toBe("Fuente saturada");

    choose("Suma");
    expect(annotations("saturated")).toHaveLength(3);
    expect(annotation("saturated-notice").textContent).toBe("Fuente saturada");
  });

  it("dos regiones en el mismo plano son dos fuentes", async () => {
    const meta = structuredClone(barnardMeta);
    const plane = meta.planes.find((item) => item.epoch === 3 && item.detector === 3);
    plane?.saturated.push({ x: 30, y: 40, radius_px: 2.5, n_pixels: 20 });
    openViewer(BARNARD, meta);
    await shown("3");

    expect(annotations("saturated")).toHaveLength(2);
    expect(annotation("saturated-notice").textContent).toBe("Fuentes saturadas: 2");
  });

  it("un campo sin saturacion no lleva contorno ni aviso", async () => {
    openViewer(WISE, wiseMeta);
    await shown("3");
    await waitFor(() => expect(annotations("scale")).toHaveLength(1));

    expect(annotations("saturated")).toEqual([]);
    expect(annotations("saturated-notice")).toEqual([]);
  });
});

describe("ViewerPage: escala, orientacion, modo y banda", () => {
  it("la barra de escala dice cuanto mide y cambia con el acercamiento", async () => {
    openViewer(BARNARD);
    await shown("3");

    // 3,075 segundos de arco por pixel a 800 / 195 px por pixel: 1 minuto son 80 px.
    const scale = annotation("scale");
    expect(scale.getAttribute("data-arcsec")).toBe("60");
    expect(Number(scale.getAttribute("data-length"))).toBeCloseTo((60 / 3.075) * SCALE, 1);
    expect(texts(scale)).toEqual(["1′"]);

    choose("5 minutos de arco");
    expect(annotation("scale").getAttribute("data-arcsec")).toBe("30");
    expect(Number(annotation("scale").getAttribute("data-length"))).toBeCloseTo(
      (30 / 3.075) * 2 * SCALE,
      1,
    );
    expect(texts(annotation("scale"))).toEqual(["30″"]);
  });

  it("la rosa marca el norte y el este", async () => {
    openViewer(BARNARD);
    await shown("3");
    expect(texts(annotation("compass"))).toEqual(["N", "E"]);
  });

  it("arriba a la izquierda se lee el modo y la banda con su rango", async () => {
    openViewer(BARNARD);
    await shown("3");
    expect(texts(annotation("band"))).toEqual(["Parpadeo", "B3 · 1,63–2,43 µm"]);

    choose("Diferencia");
    expect(texts(annotation("band"))[0]).toBe("Diferencia");
    choose(/^B6,/);
    await shown("1,3");
    expect(texts(annotation("band"))[1]).toBe("B6 · 4,41–5,01 µm");
  });

  it("lo que dicen los dibujos esta tambien en palabras", async () => {
    openViewer(BARNARD);
    await shown("3");
    await reticleReady();

    const summary = screen.getByRole("list", { name: "Sobre la imagen" });
    expect(
      within(summary)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Parpadeo, banda B3 · 1,63–2,43 µm.",
      "Mira sobre Barnard's Star. Movimiento propio: 10,39″ por año. Rastro con sus posiciones en las épocas anteriores: 2.",
      "La barra de escala mide 1′.",
      "Norte arriba y este a la izquierda.",
    ]);
    // Los dibujos no se leen dos veces.
    expect(annotation("reticle").closest("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("sin imagen en pantalla no dibuja nada", async () => {
    // Epsilon Indi B: la epoca 4 no tiene exposiciones en B1.
    openViewer(`${EPS_IND.replace("band=3", "band=1")}&epoch=4`, epsIndMeta);
    expect(await screen.findByText("Esta época no tiene datos en B1.")).toBeTruthy();

    expect(page().dataset.source).toBe("none");
    expect(page().querySelectorAll("[data-annotation]")).toHaveLength(0);
    expect(screen.queryByRole("list", { name: "Sobre la imagen" })).toBeNull();

    // En una epoca con datos vuelven.
    choose(/^Época 3, /);
    await shown("3");
    expect(annotations("scale")).toHaveLength(1);
    expect(annotations("compass")).toHaveLength(1);
  });

  it("el rotulo de un plano provisorio va centrado sobre el borde superior de la imagen", async () => {
    const meta = structuredClone(wiseMeta);
    meta.status = "downloading";
    meta.progress = { ...meta.progress, phase: "downloading" };
    const plane = meta.planes.find((item) => item.epoch === 3 && item.detector === 6);
    if (!plane) throw new Error("la muestra no tiene el plano 3:6");
    Object.assign(plane, { status: "building", rev: 1, n_used: 9, n_exposures: 18 });
    openViewer(WISE, meta);
    await shown("3");

    const tag = annotation("tag") as HTMLElement;
    expect(within(tag).getByText("Provisorio")).toBeTruthy();
    expect(within(tag).getByText("9 / 18 exposiciones")).toBeTruthy();
    // La imagen ocupa el visor entero: su borde superior es el del visor.
    expect(tag.style.left).toBe(`${VIEWPORT.width / 2}px`);
    expect(tag.style.top).toBe("8px");

    // Uno definitivo no lleva rotulo.
    choose(/^Época 2, /);
    expect(annotations("tag")).toEqual([]);
  });
});

describe("ViewerPage: avisos de calidad", () => {
  function panel(): HTMLElement {
    return screen.getByRole("region", { name: "Avisos de calidad" });
  }

  function sentences(): string[] {
    return within(panel())
      .queryAllByRole("listitem")
      .map((item) => item.textContent ?? "");
  }

  /** La cantidad del encabezado: lo que queda del panel sin el titulo ni la lista. */
  function count(): string {
    const heading = within(panel()).getByRole("heading", { name: "Avisos de calidad" });
    return heading.parentElement?.nextElementSibling?.textContent ?? "";
  }

  it("Barnard: la fuente saturada primero y la poca cobertura resumida en una frase", async () => {
    openViewer(BARNARD);
    await shown("3");

    expect(sentences()).toEqual([
      "Hay una fuente saturada en 17h 57m 47s +04° 46′ 08″: su centro no tiene medición válida.",
      "Menos del 90 % de la imagen tiene datos: épocas 1, 2, 3 (B1–B6).",
    ]);
    expect(count()).toBe("2");
    // Icono alert en cada aviso, sin colores de estado.
    for (const item of within(panel()).getAllByRole("listitem")) {
      expect(item.querySelector('[data-icon="alert"]')).not.toBeNull();
    }
  });

  it("Epsilon Indi B: recortes que faltaron, planos sin exposiciones, pocas exposiciones y poca cobertura", async () => {
    openViewer(EPS_IND, epsIndMeta);
    await shown("4");

    expect(sentences()).toEqual([
      "Faltó 1 recorte después de todos los reintentos: época 2 (B6).",
      "Sin exposiciones: época 4 (B1, B4).",
      "Con menos de 5 exposiciones puede haber huecos y gradientes: época 1 (B1, B4).",
      "Menos del 90 % de la imagen tiene datos: épocas 1, 2, 3 (B1–B6); época 4 (B2, B3, B5, B6).",
    ]);
    expect(count()).toBe("4");
  });

  it("en ingles, con sus numeros y su orden de palabras", async () => {
    await setLanguage("en");
    openViewer(EPS_IND, epsIndMeta);
    await shown("4");

    const notices = within(screen.getByRole("region", { name: "Quality notices" }))
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(notices).toEqual([
      "1 cutout is missing after all the retries: epoch 2 (B6).",
      "No exposures: epoch 4 (B1, B4).",
      "With fewer than 5 exposures there may be gaps and gradients: epoch 1 (B1, B4).",
      "Less than 90% of the image has data: epochs 1, 2, 3 (B1–B6); epoch 4 (B2, B3, B5, B6).",
    ]);
  });

  it("los demas avisos del contrato: lista guardada, descarga completa, varios recortes y varias fuentes", async () => {
    const meta = structuredClone(barnardMeta) as { warnings: unknown[] };
    meta.warnings = [
      { code: "full_download", reason: "orden de las extensiones" },
      { code: "stale_exposure_list", listed_at: "2026-11-14T22:05:00Z" },
      {
        code: "cutouts_failed",
        n: 3,
        planes: [
          { epoch: 2, detector: 3 },
          { epoch: 1, detector: 3 },
        ],
      },
      {
        code: "saturated_source",
        ra: 269.44,
        dec: 4.76,
        radius_arcsec: 20,
        epochs: [1],
        detectors: [1],
      },
      {
        code: "saturated_source",
        ra: 269.47,
        dec: 4.79,
        radius_arcsec: 12,
        epochs: [1],
        detectors: [1],
      },
    ];
    openViewer(BARNARD, meta);
    await shown("3");

    expect(sentences()).toEqual([
      "Hay 2 fuentes saturadas en el campo: su centro no tiene medición válida.",
      "Faltaron 3 recortes después de todos los reintentos: épocas 1, 2 (B3).",
      "La lista de exposiciones es una copia guardada el 2026-11-14 22:05 UTC: el archivo de datos no respondió.",
      "Se bajaron archivos completos porque no se pudo cortar la descarga.",
    ]);
    expect(count()).toBe("4");
  });

  it("suma el aviso de una comparacion con una epoca provisoria, adelante de todos", async () => {
    const meta = structuredClone(barnardMeta);
    meta.status = "downloading";
    meta.progress = { ...meta.progress, phase: "downloading" };
    const plane = meta.planes.find((item) => item.epoch === 1 && item.detector === 3);
    if (!plane) throw new Error("la muestra no tiene el plano 1:3");
    Object.assign(plane, { status: "building", rev: 1, n_used: 9 });
    openViewer(BARNARD, meta);
    await shown("3");
    // El parpadeo no compara.
    expect(count()).toBe("2");

    choose("Diferencia");

    expect(sentences()[0]).toBe(
      "Alguna de las épocas comparadas es provisoria: todavía le faltan exposiciones.",
    );
    expect(sentences()).toHaveLength(3);
    expect(count()).toBe("3");
    // No se repite en el panel Modo.
    expect(screen.getAllByText(/Alguna de las épocas comparadas/)).toHaveLength(1);
  });

  it("un campo sin avisos lo dice", async () => {
    const meta = structuredClone(wiseMeta) as { warnings: unknown[] };
    meta.warnings = [];
    openViewer(WISE, meta);
    await shown("3");

    expect(within(panel()).getByText("Sin avisos para este campo.")).toBeTruthy();
    expect(sentences()).toEqual([]);
    expect(count()).toBe("0");
  });

  it("no pide nada al backend: sale de los metadatos del campo", async () => {
    const { backend } = openViewer(BARNARD_FIELD);
    await shown("3");
    const calls = backend.calls.length;
    expect(sentences()).toHaveLength(2);
    expect(backend.calls).toHaveLength(calls);
    expect(contexts).toBeDefined();
    vi.clearAllTimers();
  });
});
