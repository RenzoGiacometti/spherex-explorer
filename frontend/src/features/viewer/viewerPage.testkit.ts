// Navegador y backend simulados para probar la pantalla del visor con
// Testing Library. jsdom no hace layout ni tiene canvas: aca se le da al visor
// un tamano y un contexto 2D que anota lo que se dibuja. El backend es el de
// src/state/fieldStore.testkit.ts, puesto en lugar del `fetch` global, que es
// el que usa el store de la aplicacion. No usa la red. Solo lo importan los tests.

import { vi } from "vitest";
import { useFieldStore } from "@/state/fieldStore";
import {
  binaryResponse,
  createFakeBackend,
  type EventStream,
  type FakeBackend,
  jsonResponse,
  type RawMeta,
} from "@/state/fieldStore.testkit";
import { useUrlState } from "@/state/urlState";
// El texto de la hoja de estilos, sin aplicarla: jsdom no resuelve variables CSS de una hoja.
import tokensCss from "@/styles/tokens.css?raw";
import { parseCssVariables, resolveCssVariable } from "@/test/designTokens";
import {
  createFakeCanvasContexts,
  type Fake2d,
  type FakeCanvasContexts,
  type FakeImageData,
} from "@/viewer/testSupport";
import { PHONE_QUERY } from "./useMediaQuery";

/** Tamano que se le informa al visor, en pixeles CSS. */
export const VIEWPORT = { width: 800, height: 800 };

/**
 * Variables de color que el visor lee de `:root` para dibujar (el vacio y los
 * dos colores de la trama de flags). jsdom no carga tokens.css: se copian de ahi.
 */
const VIEWER_COLOR_VARIABLES = ["--color-void", "--color-text"] as const;

function installDesignColors(): void {
  const tokens = parseCssVariables(tokensCss);
  for (const name of VIEWER_COLOR_VARIABLES) {
    const value = resolveCssVariable(tokens, name);
    if (value !== undefined) document.documentElement.style.setProperty(name, value);
  }
}

/** ResizeObserver simulado: al observar un elemento le informa enseguida `VIEWPORT`. */
class FakeResizeObserver {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(): void {
    const entry = { contentRect: VIEWPORT } as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }

  unobserve(): void {}

  disconnect(): void {}
}

/**
 * Pone el ResizeObserver, los contextos de canvas simulados y los colores de
 * tokens.css que lee el visor. Lo primero se deshace solo al terminar el test;
 * los colores los quita `resetApp`.
 */
export function installFakeBrowser(): FakeCanvasContexts {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  installDesignColors();
  const contexts = createFakeCanvasContexts();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string,
  ) {
    return contexts.getContext(this, kind);
  } as never);
  return contexts;
}

/** Lleva la barra de direcciones a esa consulta ("?ra=...") y avisa al estado de la URL. */
export function openUrl(search: string): void {
  window.history.replaceState(null, "", `/${search}`);
  useUrlState.getState().syncFromLocation();
}

/** Cierra el campo abierto y vuelve a la entrada. Va en `afterEach`. */
export function resetApp(): void {
  useFieldStore.getState().close();
  openUrl("");
  document.documentElement.removeAttribute("style");
}

/**
 * Hace que la ventana simulada sea un celular: `matchMedia` cumple la consulta
 * de menos de 600 px y ninguna otra. jsdom no tiene `matchMedia`. Se deshace
 * solo al terminar el test.
 */
export function usePhoneViewport(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === PHONE_QUERY,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

/**
 * Valor de los pixeles de un plano de prueba: crece con la epoca y entra en la
 * escala de cualquier detector de las muestras, para que cada epoca quede en un
 * gris distinto.
 */
export function epochValue(epoch: number): number {
  return 0.02 * epoch;
}

/**
 * Backend simulado en lugar del `fetch` global. Los planos valen
 * `epochValue(epoca)` en todos los pixeles, salvo el primero, sin datos (NaN),
 * y el segundo, saturado (+Infinity). El cubo no responde hasta que el test lo
 * libere, para que las otras bandas lleguen plano por plano con esos valores.
 */
export function startBackend(meta: unknown): FakeBackend {
  const backend = createFakeBackend(structuredClone(meta));
  backend.handlers.plane = (_call, epoch, detector) => {
    const shape = backend.state.meta.grid?.shape ?? backend.state.fallbackShape;
    const plane = backend.state.meta.planes?.find(
      (item) => item.epoch === epoch && item.detector === detector,
    );
    if (!shape || !plane || plane.rev === 0) {
      return jsonResponse(
        { error: { code: "not_found", message: "sin plano", retryable: false } },
        404,
      );
    }
    const values = new Float32Array(shape[0] * shape[1]).fill(epochValue(epoch));
    values[0] = Number.NaN;
    values[1] = Number.POSITIVE_INFINITY;
    return binaryResponse(values);
  };
  backend.hold("cube");
  vi.stubGlobal("fetch", backend.fetch);
  return backend;
}

/**
 * Backend de un campo nuevo: el POST responde 202 con el primer documento de
 * la transcripcion y el test maneja el flujo de eventos con `stream`.
 */
export async function startNewField(events: readonly RawEvent[]): Promise<NewField> {
  const first = events[0];
  if (!first) throw new Error("la transcripcion esta vacia");
  const backend = startBackend(first.data);
  backend.state.fallbackShape = [195, 195];
  backend.handlers.field = () =>
    jsonResponse(
      {
        id: backend.state.meta.id,
        status: backend.state.meta.status,
        events_url: `/api/field/${backend.state.meta.id}/events`,
        meta: backend.state.meta,
      },
      202,
    );
  let cursor = 0;

  /** Lleva al documento del backend lo que dice un evento, como haria el backend real. */
  function serverApply(event: RawEvent): void {
    if (event.event === "state" || event.event === "listed") {
      backend.state.meta = event.data as RawMeta;
    } else if (event.event === "plane") {
      const { plane } = event.data as { plane: NonNullable<RawMeta["planes"]>[number] };
      const meta = backend.state.meta;
      backend.state.meta = {
        ...meta,
        planes: meta.planes?.map((item) =>
          item.epoch === plane.epoch && item.detector === plane.detector ? plane : item,
        ),
      };
    }
  }

  async function stream(): Promise<EventStream> {
    await vi.waitFor(() => {
      if (backend.streams.length === 0) throw new Error("todavia no hay conexion a /events");
    });
    return backend.streams[0] as EventStream;
  }

  async function playUntil(id: number): Promise<void> {
    const open = await stream();
    while (cursor < events.length) {
      const event = events[cursor] as RawEvent;
      if (event.id > id) break;
      serverApply(event);
      open.event(event.event, event.data, event.id);
      cursor += 1;
    }
  }

  return { backend, stream, playUntil };
}

/** Un evento de la transcripcion de src/test/fixtures/events-new-field.json. */
export interface RawEvent {
  event: string;
  id: number;
  data: unknown;
}

export interface NewField {
  backend: FakeBackend;
  /** La conexion a /events, cuando el store ya la abrio. */
  stream(): Promise<EventStream>;
  /** Manda los eventos de la transcripcion hasta el que tiene ese `id`, inclusive. */
  playUntil(id: number): Promise<void>;
}

/** Contexto del canvas del visor. */
function viewerContext(contexts: FakeCanvasContexts, root: ParentNode): Fake2d {
  const canvas = root.querySelector("canvas");
  if (canvas === null) throw new Error("el visor no tiene canvas");
  const fake = contexts.fake2d(canvas);
  if (!fake) throw new Error("el visor no pidio un contexto 2D");
  return fake;
}

/**
 * La imagen compuesta que el visor dibujo por ultima vez, con las filas del
 * norte primero. Es lo ultimo que copio con pixeles propios: la capa de la
 * trama de flags, que va encima, se arma con una trama y no los tiene.
 */
export function composedImage(contexts: FakeCanvasContexts, root: ParentNode): FakeImageData {
  const draws = viewerContext(contexts, root).drawImages;
  if (draws.length === 0) throw new Error("el visor no dibujo ninguna imagen");
  for (const drawn of [...draws].reverse()) {
    const image = contexts.fake2d(drawn.source as HTMLCanvasElement)?.lastImageData;
    if (image) return image;
  }
  throw new Error("no hay imagen compuesta");
}

/**
 * La mascara de la trama de flags que el visor dibujo en su ultimo cuadro, con
 * las filas del norte primero: opaca donde va la trama. null si en el ultimo
 * cuadro no hubo trama.
 */
export function hatchMask(contexts: FakeCanvasContexts, root: ParentNode): FakeImageData | null {
  const last = viewerContext(contexts, root).drawImages.at(-1);
  const layer = last ? contexts.fake2d(last.source as HTMLCanvasElement) : undefined;
  // La capa de la trama es la unica que se llena con `createPattern`.
  if (!layer || layer.patterns.length === 0) return null;
  const clipped = layer.drawImages.at(-1);
  const mask = clipped ? contexts.fake2d(clipped.source as HTMLCanvasElement) : undefined;
  return mask?.lastImageData ?? null;
}

/** Pixeles del plano cubiertos por la trama, como "x,y" (`x` hacia el oeste e `y` hacia el norte). */
export function hatchedPixels(mask: FakeImageData | null): string[] {
  if (mask === null) return [];
  const pixels: string[] = [];
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const offset = ((mask.height - 1 - y) * mask.width + x) * 4;
      if (mask.data[offset + 3] === 255) pixels.push(`${x},${y}`);
    }
  }
  return pixels;
}

/** Rojo, verde y azul del pixel (x, y) del plano: `x` hacia el oeste e `y` hacia el norte. */
export function pixelAt(image: FakeImageData, x: number, y: number): [number, number, number] {
  const offset = ((image.height - 1 - y) * image.width + x) * 4;
  return [
    image.data[offset] as number,
    image.data[offset + 1] as number,
    image.data[offset + 2] as number,
  ];
}

/** Ancho, en pixeles CSS, con el que el visor dibujo la imagen por ultima vez. */
export function drawnWidth(contexts: FakeCanvasContexts, root: ParentNode): number {
  const draws = viewerContext(contexts, root).drawImages;
  // La imagen es lo ultimo que se copio con pixeles propios (ver `composedImage`).
  const drawn = [...draws]
    .reverse()
    .find((item) => contexts.fake2d(item.source as HTMLCanvasElement)?.lastImageData);
  if (!drawn) throw new Error("el visor no dibujo ninguna imagen");
  return drawn.width;
}
