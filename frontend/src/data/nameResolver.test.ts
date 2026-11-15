// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createApiClient, type FetchLike } from "@/api/client";
import { ApiError } from "@/api/errors";
import { DEFAULT_URL_STATE, normalizeUrlState, type UrlState } from "@/state/urlState";
import { errorBody, resolveBarnard, resolveCoordinates } from "@/test/contractExamples";
import { contractGridShape, sameShape } from "./gridShape";
import { createNameResolver, errorCodeOf, resolveQuery } from "./nameResolver";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Resolucion sobre un fetch simulado que anota los nombres pedidos. */
function resolverWith(respond: (name: string) => Response | Promise<Response>) {
  const names: string[] = [];
  const fetch: FetchLike = async (url) => {
    const name = new URL(url, "http://backend.test").searchParams.get("name") ?? "";
    names.push(name);
    return respond(name);
  };
  return { resolver: createNameResolver(createApiClient({ fetch })), names };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("se esperaba un error y la promesa se resolvio");
}

describe("resolveQuery", () => {
  it("devuelve el estado de URL que abre el campo del objeto: field_center y name", async () => {
    const { resolver, names } = resolverWith(() => json(resolveBarnard()));
    const { resolved, url } = await resolveQuery("  Barnard's Star ", { resolver });

    expect(names).toEqual(["Barnard's Star"]);
    // El centro es la posicion propagada, no la de catalogo (j2000).
    expect(url).toEqual({ ra: 269.4463, dec: 4.7683, name: "NAME Barnard's star", epoch: null });
    expect(resolved.moved_arcsec).toBe(270.4);

    // Ese cambio, aplicado a la URL de otro campo, abre el visor con el objeto.
    const previous: UrlState = { ...DEFAULT_URL_STATE, ra: 10, dec: 20, band: 6, epoch: 2 };
    const next = normalizeUrlState({ ...previous, ...url });
    expect(next).toMatchObject({
      ra: 269.4463,
      dec: 4.7683,
      band: 6,
      epoch: null,
      name: "NAME Barnard's star",
    });
  });

  it("con coordenadas no hay nombre", async () => {
    const { resolver } = resolverWith(() => json(resolveCoordinates()));
    const { url } = await resolveQuery("133.7598 -7.2422", { resolver });
    expect(url).toEqual({ ra: 133.7598, dec: -7.2422, name: null, epoch: null });
  });

  it("un nombre desconocido falla con not_resolved", async () => {
    const { resolver } = resolverWith(() => json(errorBody("not_resolved"), 404));
    const error = await rejection(resolveQuery("no existe", { resolver }));

    expect(error).toBeInstanceOf(ApiError);
    expect(errorCodeOf(error)).toBe("not_resolved");
  });

  it("Sesame caido falla con upstream_unavailable y la red caida con network", async () => {
    const down = resolverWith(() => json(errorBody("upstream_unavailable", true), 503));
    expect(errorCodeOf(await rejection(resolveQuery("Barnard's Star", down)))).toBe(
      "upstream_unavailable",
    );

    const offline = resolverWith(() => Promise.reject(new TypeError("fetch failed")));
    expect(errorCodeOf(await rejection(resolveQuery("Barnard's Star", offline)))).toBe("network");
  });

  it("un texto vacio falla con invalid_request sin gastar un pedido", async () => {
    const { resolver, names } = resolverWith(() => json(resolveBarnard()));
    expect(errorCodeOf(await rejection(resolveQuery("   ", { resolver })))).toBe("invalid_request");
    expect(names).toEqual([]);
  });

  it("deja pasar la cancelacion", async () => {
    const { resolver } = resolverWith(() =>
      Promise.reject(new DOMException("cancelado", "AbortError")),
    );
    const error = await rejection(resolveQuery("Barnard's Star", { resolver }));
    expect((error as Error).name).toBe("AbortError");
    expect(errorCodeOf(error)).toBe("unknown");
  });
});

describe("createNameResolver", () => {
  it("recuerda lo resuelto por el texto buscado y por el nombre principal", async () => {
    const { resolver, names } = resolverWith(() => json(resolveBarnard()));
    const first = await resolver.resolve("Barnard's Star");

    // El visor vuelve a pedir el objeto con el nombre que quedo en la URL.
    expect(await resolver.resolve("NAME Barnard's star")).toBe(first);
    expect(await resolver.resolve("barnard's star ")).toBe(first);
    expect(names).toEqual(["Barnard's Star"]);
  });

  it("no recuerda un fallo: se puede reintentar", async () => {
    let attempts = 0;
    const { resolver, names } = resolverWith(() => {
      attempts += 1;
      return attempts === 1
        ? json(errorBody("upstream_unavailable", true), 503)
        : json(resolveBarnard());
    });

    expect(errorCodeOf(await rejection(resolver.resolve("Barnard's Star")))).toBe(
      "upstream_unavailable",
    );
    expect((await resolver.resolve("Barnard's Star")).name).toBe("NAME Barnard's star");
    expect(names).toHaveLength(2);
  });
});

describe("contractGridShape", () => {
  it("da la grilla de cada escalon del contrato", () => {
    expect(contractGridShape(0.1667)).toEqual([195, 195]);
    expect(contractGridShape(0.0833)).toEqual([195, 195]);
    expect(contractGridShape(0.16667)).toEqual([195, 195]);
    expect(contractGridShape(0.5)).toEqual([293, 293]);
    expect(contractGridShape(0.3)).toEqual([293, 293]);
  });

  it("fuera de los escalones no adivina", () => {
    expect(contractGridShape(1)).toBeNull();
    expect(contractGridShape(0)).toBeNull();
    expect(contractGridShape(Number.NaN)).toBeNull();
  });

  it("compara formas", () => {
    expect(sameShape([195, 195], [195, 195])).toBe(true);
    expect(sameShape([195, 195], [293, 293])).toBe(false);
  });
});
