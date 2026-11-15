// La entrada sin WebGL, que es como la ve jsdom: no hay esfera, y quedan a la
// vista el buscador, "Lugar al azar" y los objetos destacados como links. Sin
// esfera no hay acercamiento: elegir un lugar abre su campo en el momento.
//
// Los tests del buscador son los de la entrada anterior (EntryPage), que usaba
// la misma logica (src/features/entry/useObjectSearch.ts).

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient, type FetchLike } from "@/api/client";
import type { ResolveResponse } from "@/api/types";
import { createNameResolver, type NameResolver } from "@/data/nameResolver";
import { initI18n, setLanguage } from "@/i18n";
import enEntry from "@/i18n/locales/en/entry.json";
import enErrors from "@/i18n/locales/en/errors.json";
import esEntry from "@/i18n/locales/es/entry.json";
import esErrors from "@/i18n/locales/es/errors.json";
import { DEFAULT_URL_STATE, parseUrlState, useUrlState } from "@/state/urlState";
import { SpherePage } from "./SpherePage";
import enSphere from "./sphere.en.json";
import esSphere from "./sphere.es.json";
import { PRECOMPUTED_FIELDS, SKY_TARGETS, type SkyTarget } from "./targets";

// ---- Respuestas de /api/resolve --------------------------------------------
//
// Son las del servidor falso del backend (backend/app/fake.py), que responde
// con las respuestas reales de Sesame guardadas, copiadas el 15 de noviembre
// de 2026.

const BARNARD = {
  query: "Barnard's Star",
  name: "NAME Barnard's star",
  source: "sesame",
  object_type: "BY*",
  j2000: { ra: 269.452077, dec: 4.693365 },
  motion: {
    pm_ra: -801.551,
    pm_dec: 10362.394,
    parallax: 546.9759,
    radial_velocity: -110.11,
    per_year_arcsec: 10.39,
  },
  field_center: { ra: 269.4463, dec: 4.7683, epoch: 2026.0 },
  moved_arcsec: 270.4,
};

const WISE_0855 = {
  query: "WISE J085510.83-071442.5",
  name: "WISEA J085510.74-071442.5",
  source: "sesame",
  object_type: "BD*",
  j2000: { ra: 133.818908, dec: -7.247048 },
  motion: {
    pm_ra: -8123.7,
    pm_dec: 673.2,
    parallax: 439.0,
    radial_velocity: null,
    per_year_arcsec: 8.15,
  },
  field_center: { ra: 133.7598, dec: -7.2422, epoch: 2026.0 },
  moved_arcsec: 211.7,
};

function coordinates(query: string, ra: number, dec: number) {
  return {
    query,
    name: null,
    source: "coordinates",
    object_type: null,
    j2000: { ra, dec },
    motion: null,
    field_center: { ra, dec, epoch: 2026.0 },
    moved_arcsec: 0.0,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(code: string, status: number, retryable = false): Response {
  return json({ error: { code, message: `${code} simulado`, retryable } }, status);
}

// ---- Backend simulado ------------------------------------------------------

interface FakeBackend {
  resolver: NameResolver;
  /** Valor de `name` de cada pedido a /api/resolve, en orden. */
  names: string[];
  /** Senal de cancelacion de cada pedido. */
  signals: Array<AbortSignal | null>;
}

/** Resolucion de nombres sobre un `fetch` simulado, que se corta como el de verdad al cancelar. */
function backend(respond: (name: string) => Response | Promise<Response>): FakeBackend {
  const names: string[] = [];
  const signals: Array<AbortSignal | null> = [];
  const fetch: FetchLike = (url, init) => {
    const address = new URL(url, "http://backend.test");
    expect(address.pathname).toBe("/api/resolve");
    names.push(address.searchParams.get("name") ?? "");
    const signal = init?.signal ?? null;
    signals.push(signal);
    return new Promise<Response>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      Promise.resolve(respond(address.searchParams.get("name") ?? "")).then(resolve, reject);
    });
  };
  return { resolver: createNameResolver(createApiClient({ fetch })), names, signals };
}

/** Respuesta que el test entrega cuando quiere. */
function deferred(): { promise: Promise<Response>; resolve: (response: Response) => void } {
  let resolve: (response: Response) => void = () => {};
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// ---- Ayudas ----------------------------------------------------------------

const EXAMPLE = "Barnard's Star · 269.4463 +4.7683";

function open(search: string): void {
  window.history.replaceState(null, "", `/${search}`);
  useUrlState.getState().syncFromLocation();
}

function input(): HTMLInputElement {
  return screen.getByRole("searchbox", { name: esEntry.search.label }) as HTMLInputElement;
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: esEntry.search.submit }) as HTMLButtonElement;
}

function randomButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: esSphere.random }) as HTMLButtonElement;
}

function searchFor(text: string): void {
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.submit(screen.getByRole("search"));
}

/** Texto que se le anuncia al lector de pantalla: el ultimo `status`, despues de los avisos. */
function announced(): string {
  return screen.getAllByRole("status").at(-1)?.textContent ?? "";
}

/** Estado de la URL sin las acciones del store. */
function urlState() {
  return parseUrlState(window.location.search);
}

/**
 * Hace clic en un link y dice si la pagina se hizo cargo (true) o lo dejo para
 * el navegador (false). jsdom no navega: el clic se frena despues de mirarlo.
 */
function clickLink(link: HTMLElement, init: MouseEventInit = {}): boolean {
  let handledByPage = false;
  const afterPage = (event: Event) => {
    handledByPage = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", afterPage, { once: true });
  fireEvent.click(link, init);
  return handledByPage;
}

beforeEach(async () => {
  open("");
  initI18n("es");
  await setLanguage("es");
  // Un navegador sin WebGL: el contexto no se puede crear, y three.js y la esfera lo avisan.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  open("");
});

// ---- Lo que se ve ----------------------------------------------------------

describe("SpherePage sin WebGL", () => {
  it("muestra la marca, el selector de idioma, el aviso, el buscador y los destacados", () => {
    render(<SpherePage />);

    // Barra superior: la marca, escrita como es, y el idioma.
    const topbar = screen.getByRole("banner");
    expect(within(topbar).getByText("SPHEREx Explorer")).toBeTruthy();
    const language = within(topbar).getByRole("group", { name: "Idioma" });
    const radios = within(language).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual(["Español", "English"]);
    expect(radios.map((radio) => radio.checked)).toEqual([true, false]);

    // Una sola region principal: dice que no hay esfera y deja todo lo demas a mano.
    const main = screen.getByRole("main");
    expect(within(main).getByText(esSphere.status.noWebgl)).toBeTruthy();
    expect(within(main).getByRole("search")).toBeTruthy();
    expect(within(main).getByRole("navigation", { name: esSphere.markers.nav })).toBeTruthy();
    expect(randomButton().disabled).toBe(false);
    // La unica lista de destacados es la de links: la de marcadores no tiene donde ubicarse.
    expect(screen.getAllByRole("navigation")).toHaveLength(1);
  });

  it("el buscador tiene etiqueta visible y un ejemplo en grados que abre el campo precalculado", () => {
    render(<SpherePage />);

    const search = screen.getByRole("search", { name: esEntry.search.label });
    expect(within(search).getByText(esEntry.search.label).tagName).toBe("LABEL");
    expect(input().placeholder).toBe(EXAMPLE);
    expect(input().value).toBe("");
    expect(submitButton().type).toBe("submit");
    expect(submitButton().disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(announced()).toBe("");
  });

  it("Lugar al azar abre un campo precalculado, tambien los que no tienen marcador", () => {
    // Con el azar al final de la lista sale el ultimo campo precalculado.
    render(<SpherePage random={() => 0.999} />);
    const before = window.history.length;

    fireEvent.click(randomButton());

    const last = PRECOMPUTED_FIELDS[PRECOMPUTED_FIELDS.length - 1] as SkyTarget;
    expect(SKY_TARGETS).not.toContain(last);
    expect(window.location.search).toContain(`?ra=${last.ra}&dec=${last.dec}&fov=0.1667&band=3`);
    expect(window.history.length).toBe(before + 1);
    expect(announced()).toBe(`Abriendo ${last.label}…`);
  });

  // ---- Destacados ----------------------------------------------------------

  describe("destacados", () => {
    const LINKS = [
      [
        "Barnard's Star",
        "/?ra=269.4463&dec=4.7683&fov=0.1667&band=3&mode=blink&name=Barnard%27s+Star",
      ],
      [
        "Epsilon Indi B",
        "/?ra=331.0966&dec=-56.8006&fov=0.1667&band=3&mode=blink&name=Epsilon+Indi+B",
      ],
      [
        "WISE 0855",
        "/?ra=133.7598&dec=-7.2422&fov=0.1667&band=6&mode=blink&name=WISE+J085510.83-071442.5",
      ],
      ["RW Aurigae", "/?ra=76.9566&dec=30.4013&fov=0.1667&band=1&mode=blink&name=RW+Aurigae"],
      ["R Draconis", "/?ra=248.1672&dec=66.755&fov=0.1667&band=3&mode=blink&name=R+Draconis"],
    ] as const;

    function links(): HTMLAnchorElement[] {
      const nav = screen.getByRole("navigation", { name: esSphere.markers.nav });
      return within(nav).getAllByRole("link") as HTMLAnchorElement[];
    }

    it("los cinco objetos de prueba son links completos al visor", () => {
      render(<SpherePage />);

      expect(links().map((link) => [link.textContent, link.getAttribute("href")])).toEqual(LINKS);
    });

    it.each([
      ["Barnard's Star", 269.4463, 4.7683, 3, "Barnard's Star"],
      ["Epsilon Indi B", 331.0966, -56.8006, 3, "Epsilon Indi B"],
      ["WISE 0855", 133.7598, -7.2422, 6, "WISE J085510.83-071442.5"],
      ["RW Aurigae", 76.9566, 30.4013, 1, "RW Aurigae"],
      ["R Draconis", 248.1672, 66.755, 3, "R Draconis"],
    ] as const)("%s abre su campo sin recargar la pagina", (label, ra, dec, band, name) => {
      render(<SpherePage />);
      const before = window.history.length;
      const link = screen.getByRole("link", { name: label });
      const href = link.getAttribute("href");

      expect(clickLink(link)).toBe(true);

      const expected = { ...DEFAULT_URL_STATE, ra, dec, fov: 0.1667, band, mode: "blink", name };
      expect(urlState()).toEqual(expected);
      expect(useUrlState.getState()).toMatchObject(expected);
      // El link y el clic llevan al mismo lugar.
      expect(`/${window.location.search}`).toBe(href);
      // Es una entrada nueva del historial: Atras vuelve a la entrada.
      expect(window.history.length).toBe(before + 1);
    });

    it.each([
      ["Ctrl", { ctrlKey: true }],
      ["Cmd", { metaKey: true }],
      ["Mayus", { shiftKey: true }],
      ["el boton del medio", { button: 1 }],
    ] as const)("con %s el link queda para el navegador", (_name, init) => {
      render(<SpherePage />);

      expect(clickLink(screen.getByRole("link", { name: "WISE 0855" }), init)).toBe(false);
      expect(urlState()).toEqual(DEFAULT_URL_STATE);
    });

    it("conservan el idioma pedido en la URL", () => {
      open("?lang=en");
      render(<SpherePage />);

      for (const [index, link] of links().entries()) {
        expect(link.getAttribute("href")).toBe(`${LINKS[index]?.[1]}&lang=en`);
      }
      clickLink(screen.getByRole("link", { name: "R Draconis" }));
      expect(urlState()).toMatchObject({ ra: 248.1672, dec: 66.755, lang: "en" });
    });
  });

  // ---- Buscar --------------------------------------------------------------

  describe("buscar", () => {
    it("por nombre: abre el campo en la posicion propagada, con el nombre buscado", async () => {
      const answer = deferred();
      const fake = backend(() => answer.promise);
      render(<SpherePage resolver={fake.resolver} />);
      const before = window.history.length;

      searchFor("  Barnard's Star ");

      // Resolviendo: se dice, y no se puede volver a enviar ni pedir otro lugar.
      expect(fake.names).toEqual(["Barnard's Star"]);
      expect(announced()).toBe("Buscando Barnard's Star…");
      expect(submitButton().disabled).toBe(true);
      expect(randomButton().disabled).toBe(true);
      expect(screen.getByRole("search").getAttribute("aria-busy")).toBe("true");
      expect(urlState()).toEqual(DEFAULT_URL_STATE);

      answer.resolve(json(BARNARD));

      await waitFor(() => expect(useUrlState.getState().ra).toBe(269.4463));
      // field_center, a 4,5 minutos de arco de la posicion de catalogo (j2000).
      expect(window.location.search).toBe(
        "?ra=269.4463&dec=4.7683&fov=0.1667&band=3&mode=blink&name=Barnard%27s+Star",
      );
      expect(urlState()).toEqual({
        ...DEFAULT_URL_STATE,
        ra: 269.4463,
        dec: 4.7683,
        fov: 0.1667,
        band: 3,
        mode: "blink",
        name: "Barnard's Star",
      });
      expect(window.history.length).toBe(before + 1);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("el boton y la tecla Enter envian lo mismo", async () => {
      const fake = backend(() => json(BARNARD));
      render(<SpherePage resolver={fake.resolver} />);

      fireEvent.change(input(), { target: { value: "Barnard's Star" } });
      fireEvent.click(submitButton());

      await waitFor(() => expect(useUrlState.getState().dec).toBe(4.7683));
      expect(fake.names).toEqual(["Barnard's Star"]);
    });

    it("por coordenadas: pasa por /api/resolve y abre el campo sin nombre", async () => {
      const fake = backend((name) => json(coordinates(name, 133.7598, -7.2422)));
      render(<SpherePage resolver={fake.resolver} />);

      searchFor("133.7598 -7.2422");

      await waitFor(() => expect(useUrlState.getState().ra).toBe(133.7598));
      expect(fake.names).toEqual(["133.7598 -7.2422"]);
      expect(window.location.search).toBe("?ra=133.7598&dec=-7.2422&fov=0.1667&band=3&mode=blink");
      expect(urlState().name).toBeNull();
    });

    it("unas coordenadas copiadas de la interfaz se mandan con el signo menos del teclado", async () => {
      const fake = backend((name) => json(coordinates(name, 133.7583, -7.2422)));
      render(<SpherePage resolver={fake.resolver} />);

      // Asi muestra el visor una declinacion negativa: con U+2212.
      searchFor("08h 55m 02s −07° 14′ 32″");

      await waitFor(() => expect(useUrlState.getState().dec).toBe(-7.2422));
      expect(fake.names).toEqual(["08h 55m 02s -07° 14′ 32″"]);
    });

    it("el apodo de un destacado se busca por su nombre de catalogo", async () => {
      const fake = backend((name) =>
        name === "WISE J085510.83-071442.5" ? json(WISE_0855) : errorResponse("not_resolved", 404),
      );
      render(<SpherePage resolver={fake.resolver} />);

      searchFor("wise 0855");

      await waitFor(() => expect(useUrlState.getState().ra).toBe(133.7598));
      expect(fake.names).toEqual(["WISE J085510.83-071442.5"]);
      // El visor vuelve a resolver `name`: tiene que ser el que el catalogo conoce.
      expect(urlState()).toMatchObject({
        dec: -7.2422,
        name: "WISE J085510.83-071442.5",
        // Buscar abre en la banda por defecto; el destacado, en la 6.
        band: 3,
      });
    });

    it("abre con la vista, la banda y el modo por defecto aunque la URL traiga otros", async () => {
      open("?fov=0.5&band=6&mode=sum&epoch=2&lang=en&embed=1");
      const fake = backend(() => json(BARNARD));
      render(<SpherePage resolver={fake.resolver} />);

      searchFor("Barnard's Star");

      await waitFor(() => expect(useUrlState.getState().ra).toBe(269.4463));
      expect(urlState()).toEqual({
        ra: 269.4463,
        dec: 4.7683,
        fov: 0.1667,
        band: 3,
        mode: "blink",
        epoch: null,
        name: "Barnard's Star",
        // El idioma y el modo embed son de la pagina, no del campo: se conservan.
        embed: true,
        lang: "en",
      });
    });

    it("vacio o con solo espacios no pide nada", () => {
      const fake = backend(() => json(BARNARD));
      render(<SpherePage resolver={fake.resolver} />);

      fireEvent.submit(screen.getByRole("search"));
      searchFor("   ");

      expect(fake.names).toEqual([]);
      expect(announced()).toBe("");
      expect(screen.queryByRole("alert")).toBeNull();
    });

    // ---- Fallos ------------------------------------------------------------

    const NOT_RESOLVED = `${esErrors.code.not_resolved} ${esEntry.search.advice.not_resolved}`;
    // Lo caido es el servicio de nombres: no sale el texto generico del archivo de datos.
    const NAME_SERVICE_DOWN = esEntry.search.nameServiceDown.replace(
      "{{coordinates}}",
      "269.4463 +4.7683",
    );

    it.each([
      ["nombre no encontrado", () => errorResponse("not_resolved", 404), NOT_RESOLVED],
      [
        "servicio de nombres caido",
        () => errorResponse("upstream_unavailable", 503, true),
        NAME_SERVICE_DOWN,
      ],
      ["red caida", () => Promise.reject(new TypeError("Failed to fetch")), esErrors.code.network],
      [
        "texto que el backend rechaza",
        () => errorResponse("invalid_request", 422),
        esErrors.code.invalid_request,
      ],
      [
        "respuesta fuera del contrato",
        () => json({ ra: 1, dec: 2 }),
        esErrors.code.invalid_response,
      ],
      [
        "error sin el cuerpo del contrato",
        () => new Response("Bad Gateway", { status: 502 }),
        esErrors.code.unknown,
      ],
    ] as const)(
      "%s: avisa con su texto y devuelve el foco al campo",
      async (_case, respond, message) => {
        const fake = backend(respond);
        render(<SpherePage resolver={fake.resolver} />);

        // La persona envio con el boton: el foco estaba ahi.
        fireEvent.change(input(), { target: { value: "Barnad Star" } });
        submitButton().focus();
        fireEvent.click(submitButton());

        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toBe(message);
        expect(document.activeElement).toBe(input());
        expect(input().getAttribute("aria-invalid")).toBe("true");
        expect(input().getAttribute("aria-describedby")).toBe(alert.id);
        // El texto queda para corregirlo, y se puede volver a enviar.
        expect(input().value).toBe("Barnad Star");
        expect(submitButton().disabled).toBe(false);
        expect(screen.getByRole("search").getAttribute("aria-busy")).toBe("false");
        expect(announced()).toBe("");
        // No se abrio ningun campo.
        expect(urlState()).toEqual(DEFAULT_URL_STATE);
        expect(fake.names).toEqual(["Barnad Star"]);
      },
    );

    it("el aviso del servicio de nombres invita a probar con coordenadas y no nombra al archivo de datos", async () => {
      const fake = backend(() => errorResponse("upstream_unavailable", 503, true));
      render(<SpherePage resolver={fake.resolver} />);

      searchFor("M 31");

      const text = (await screen.findByRole("alert")).textContent ?? "";
      expect(text).toContain("coordenadas");
      expect(text).toContain("269.4463 +4.7683");
      expect(text).not.toContain(esErrors.code.upstream_unavailable);
    });

    it("despues de un fallo pasajero se puede reintentar con el mismo texto", async () => {
      let attempt = 0;
      const fake = backend(() => {
        attempt += 1;
        return attempt === 1 ? errorResponse("upstream_unavailable", 503, true) : json(BARNARD);
      });
      render(<SpherePage resolver={fake.resolver} />);

      searchFor("Barnard's Star");
      expect((await screen.findByRole("alert")).textContent).toBe(NAME_SERVICE_DOWN);

      fireEvent.submit(screen.getByRole("search"));
      // Mientras reintenta no queda el error anterior a la vista.
      expect(screen.queryByRole("alert")).toBeNull();
      expect(announced()).toBe("Buscando Barnard's Star…");

      await waitFor(() => expect(useUrlState.getState().ra).toBe(269.4463));
      expect(fake.names).toEqual(["Barnard's Star", "Barnard's Star"]);
    });

    it("al corregir el texto se borra el error", async () => {
      const fake = backend(() => errorResponse("not_resolved", 404));
      render(<SpherePage resolver={fake.resolver} />);

      searchFor("Barnad Star");
      await screen.findByRole("alert");

      fireEvent.change(input(), { target: { value: "Barnard Star" } });

      expect(screen.queryByRole("alert")).toBeNull();
      expect(input().hasAttribute("aria-invalid")).toBe(false);
      expect(input().value).toBe("Barnard Star");
    });

    it("al cambiar el texto mientras busca se cancela el pedido y su respuesta no abre nada", async () => {
      const answer = deferred();
      const fake = backend(() => answer.promise);
      render(<SpherePage resolver={fake.resolver} />);

      searchFor("Barnard's Star");
      expect(fake.signals[0]?.aborted).toBe(false);

      fireEvent.change(input(), { target: { value: "Barnard's Sta" } });

      expect(fake.signals[0]?.aborted).toBe(true);
      expect(submitButton().disabled).toBe(false);
      expect(announced()).toBe("");

      // La respuesta llega igual, tarde: no se navega ni se muestra un error.
      await act(async () => {
        answer.resolve(json(BARNARD));
        await answer.promise;
      });
      expect(urlState()).toEqual(DEFAULT_URL_STATE);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("al elegir un destacado mientras busca gana el destacado", async () => {
      const answer = deferred();
      const fake = backend(() => answer.promise);
      render(<SpherePage resolver={fake.resolver} />);

      searchFor("Barnard's Star");
      clickLink(screen.getByRole("link", { name: "R Draconis" }));
      expect(fake.signals[0]?.aborted).toBe(true);

      await act(async () => {
        answer.resolve(json(BARNARD));
        await answer.promise;
      });
      expect(urlState()).toMatchObject({ ra: 248.1672, dec: 66.755, name: "R Draconis" });
    });

    it("una respuesta que llega despues de cancelar no abre nada, aunque no se haya cortado", async () => {
      // Una resolucion que no mira la senal: lo ya resuelto sale de la memoria sin pasar por fetch.
      let deliver: (response: ResolveResponse) => void = () => {};
      const answered = new Promise<ResolveResponse>((done) => {
        deliver = done;
      });
      const resolver: NameResolver = { resolve: () => answered };
      render(<SpherePage resolver={resolver} />);

      searchFor("Barnard's Star");
      clickLink(screen.getByRole("link", { name: "R Draconis" }));

      await act(async () => {
        deliver(BARNARD as ResolveResponse);
        await answered;
      });
      expect(urlState()).toMatchObject({ ra: 248.1672, dec: 66.755, name: "R Draconis" });
    });

    it("al salir de la entrada no queda ningun pedido en camino", () => {
      const fake = backend(() => deferred().promise);
      const { unmount } = render(<SpherePage resolver={fake.resolver} />);

      searchFor("Barnard's Star");
      unmount();

      expect(fake.signals[0]?.aborted).toBe(true);
    });
  });

  // ---- Idioma --------------------------------------------------------------

  describe("idioma", () => {
    it("elegir un idioma lo lleva a la URL, que es de donde lo toma la aplicacion", () => {
      render(<SpherePage />);
      const before = window.history.length;

      fireEvent.click(screen.getByRole("radio", { name: "English" }));

      expect(window.location.search).toBe("?lang=en");
      expect(useUrlState.getState().lang).toBe("en");
      // Cambiar de idioma no suma una entrada al historial.
      expect(window.history.length).toBe(before);
    });

    it("en ingles todos los textos salen del ingles", async () => {
      await setLanguage("en");
      const fake = backend((name) =>
        name === "M 31"
          ? errorResponse("upstream_unavailable", 503, true)
          : errorResponse("not_resolved", 404),
      );
      render(<SpherePage resolver={fake.resolver} />);

      expect(screen.getByText(enSphere.status.noWebgl)).toBeTruthy();
      expect(screen.getByRole("navigation", { name: enSphere.markers.nav })).toBeTruthy();
      expect(screen.getByRole("button", { name: enSphere.random })).toBeTruthy();
      expect((screen.getByRole("radio", { name: "English" }) as HTMLInputElement).checked).toBe(
        true,
      );
      // Los nombres propios no se traducen ni cambian de escritura.
      expect(screen.getByRole("link", { name: "Barnard's Star" })).toBeTruthy();

      const field = screen.getByRole("searchbox", { name: enEntry.search.label });
      fireEvent.change(field, { target: { value: "Barnad Star" } });
      fireEvent.click(screen.getByRole("button", { name: enEntry.search.submit }));

      expect(announced()).toBe("Searching for Barnad Star…");
      expect((await screen.findByRole("alert")).textContent).toBe(
        `${enErrors.code.not_resolved} ${enEntry.search.advice.not_resolved}`,
      );
      expect(document.activeElement).toBe(field);

      fireEvent.change(field, { target: { value: "M 31" } });
      fireEvent.submit(screen.getByRole("search"));
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toBe(
          enEntry.search.nameServiceDown.replace("{{coordinates}}", "269.4463 +4.7683"),
        ),
      );
    });
  });
});
